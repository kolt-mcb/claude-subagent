/**
 * claude-subagent — a Claude Code–style Agent (Task) tool for pi.
 *
 * Philosophy (mirrors Claude Code, not pi-subagents):
 * - Subagents run with a minimal purpose-built system prompt: base + agent
 *   definition + notes + environment. They do NOT inherit the parent's system
 *   prompt, project context, skills, or conversation history.
 * - The task prompt is passed verbatim as the user message.
 * - Subagents cannot spawn subagents (child runs with --no-extensions).
 * - The subagent's final assistant text is returned as the tool result.
 *
 * Agent types: built-in `general-purpose`, plus custom agents discovered from
 * Claude Code's own locations: <cwd>/.claude/agents/*.md and ~/.claude/agents/*.md
 * (frontmatter: name, description, tools, model, color; body = agent system prompt).
 *
 * Children run as long-lived pi processes in RPC mode (--mode rpc): JSONL
 * commands on stdin, events on stdout. One prompt() is one run; the process
 * survives between runs, so background agents and teammates retain context
 * and accept follow-ups (send_message) without resuming session files. A
 * child-side ask_user tool (injected via -e) lets agents block on a question;
 * it surfaces as an extension_ui_request event, renders as a needs-input
 * state in the widget/manager, and the user's answer flows back as an
 * extension_ui_response.
 *
 * Live progress flows through onUpdate partial results: execute() puts
 * structured progress in the partial's `details` and renderResult draws the
 * running view from it (branching on options.isPartial). This is the only
 * channel that reaches the renderer — ToolRenderContext.state is not
 * accessible from execute().
 *
 * Background mode (run_in_background: true): the tool returns immediately,
 * running agents render in a bottom widget (ctx.ui.setWidget), and the final
 * report is delivered back to the session as a custom message when the child
 * completes (pi.sendMessage with triggerTurn). Reports landing close together
 * smart-join into one batch (one wake-up turn for N completions). Users can
 * also dispatch background agents themselves via /dispatch or the alt+a
 * manager, watch any agent's conversation in a live-following transcript
 * overlay (x x stops it), and read each agent's context utilization in the
 * widget (the child reports its own percent via get_session_stats).
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, TruncatedText, hyperlink, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CHILD_ENV = "CLAUDE_STYLE_SUBAGENT_CHILD";
const WIDGET_KEY = "claude-subagent-jobs";
const RESULT_MESSAGE_TYPE = "claude-subagent-result";
const TEAMMATE_MESSAGE_TYPE = "claude-subagent-teammate-message";
const RECENT_TOOLS_LIMIT = 5;
const SESSIONS_DIR = path.join(os.homedir(), ".claude-subagent", "sessions");
const TEAMMATES_DIR = path.join(os.homedir(), ".claude-subagent", "teammates");
const ASK_USER_TOOL_PATH = path.join(os.homedir(), ".claude-subagent", "ask-user-tool.js");
/** How long a finished background session stays alive (and message-able) before reaping. */
const DONE_SESSION_GRACE_MS = 5 * 60 * 1000;
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const REPORT_POLL_MS = 2000;
const REPORT_WATCH_EXPIRY_MS = 4 * 60 * 60 * 1000;
const DEFAULT_CHILD_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_CHILD_TIMEOUT_MS = 10 * 1000;
const MAX_CHILD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Smart join: background reports finishing close together deliver as one turn. */
const REPORT_JOIN_DEBOUNCE_MS = 2000;
const REPORT_JOIN_MAX_MS = 10 * 1000;
/** Live transcript viewer refresh cadence. */
const TRANSCRIPT_REFRESH_MS = 1000;

function pruneOldSessions(): void {
	const now = Date.now();
	for (const dir of [SESSIONS_DIR, TEAMMATES_DIR]) {
		try {
			for (const entry of fs.readdirSync(dir)) {
				const target = path.join(dir, entry);
				try {
					if (now - fs.statSync(target).mtimeMs > SESSION_RETENTION_MS) {
						fs.rmSync(target, { recursive: true, force: true });
					}
				} catch {
					// Skip entries that vanish or can't be stat'd.
				}
			}
		} catch {
			// Dir may not exist yet.
		}
	}
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// ---------------------------------------------------------------------------
// Prompt blocks — extracted verbatim from Claude Code v2.1.172, with two
// adaptations for pi: pi's bash persists cwd (so the cwd-reset rationale is
// dropped, the absolute-paths rule kept), and tool names are lowercased.
// ---------------------------------------------------------------------------

const BASE_PROMPT =
	"You are an agent for pi, an interactive CLI coding agent. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.";

const GENERAL_PURPOSE_PROMPT = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

const NOTES_BLOCK = `Notes:
- Please only use absolute file paths, never relative paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.
- Do NOT write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.
- If you hit a decision only the user can make (ambiguous requirements, a destructive action needing approval), use the ask_user tool to ask and wait for the answer. Use it sparingly — prefer proceeding with sensible assumptions and noting them in your report.`;

// Explore/Plan prompts extracted from Claude Code v2.1.172 (QS5/I0f), with
// tool references adapted to pi (find/grep via bash; read for known paths).

const EXPLORE_PROMPT = `You are a file search specialist for pi, an interactive CLI coding agent. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no write, touch, or file creation of any kind)
- Modifying existing files (no edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use \`find\` via bash for broad file pattern matching
- Use \`grep\` via bash for searching file contents with regex
- Use read when you know the specific file path you need to read
- Use bash ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)
- NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;

const EXPLORE_DESCRIPTION = `Fast read-only search agent for locating code. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.`;

const PLAN_PROMPT = `You are a software architect and planning specialist for pi, an interactive CLI coding agent. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no write, touch, or file creation of any kind)
- Modifying existing files (no edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using \`find\`, \`grep\`, and read
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use bash ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)
   - NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`;

const PLAN_DESCRIPTION = "Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.";

function isGitRepo(cwd: string): boolean {
	let dir = cwd;
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

function shellLine(): string {
	const shell = process.env.SHELL || "unknown";
	const name = shell.includes("zsh") ? "zsh" : shell.includes("bash") ? "bash" : shell;
	return `Shell: ${name}`;
}

function buildEnvBlock(cwd: string, model: string | undefined): string {
	const modelLine = model ? `\nYou are powered by the model ${model}.` : "";
	return `Here is useful information about the environment you are running in:
<env>
Working directory: ${cwd}
Is directory a git repo: ${isGitRepo(cwd) ? "Yes" : "No"}
Platform: ${process.platform}
${shellLine()}
OS Version: ${os.release()}
</env>${modelLine}`;
}

// ---------------------------------------------------------------------------
// Agent type discovery (.claude/agents/*.md, Claude Code's own format)
// ---------------------------------------------------------------------------

interface AgentType {
	name: string;
	description: string;
	prompt: string; // replaces the general-purpose strengths/guidelines block
	/** When true, `prompt` is the complete agent prompt (no BASE_PROMPT prefix). */
	standalone?: boolean;
	tools?: string[];
	model?: string;
	color?: string;
	/** Wall-clock limit for the child process, from `timeout:` frontmatter (seconds). */
	timeoutMs?: number;
	source: string;
}

function parseTimeoutMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number.parseInt(value, 10);
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Math.min(Math.max(seconds * 1000, MIN_CHILD_TIMEOUT_MS), MAX_CHILD_TIMEOUT_MS);
}

function parseFrontmatter(src: string): { attrs: Record<string, string>; body: string } | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
	if (!match) return null;
	const attrs: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
		if (kv) attrs[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	return { attrs, body: match[2].trim() };
}

function loadAgentsFromDir(dir: string, source: string, into: Map<string, AgentType>): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		try {
			const raw = fs.readFileSync(path.join(dir, entry), "utf-8");
			const parsed = parseFrontmatter(raw);
			if (!parsed || !parsed.body) continue;
			const name = parsed.attrs.name || path.basename(entry, ".md");
			if (into.has(name)) continue; // project agents win over user agents
			into.set(name, {
				name,
				description: parsed.attrs.description || `Custom agent from ${source}`,
				prompt: parsed.body,
				tools: parsed.attrs.tools ? parsed.attrs.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
				model: parsed.attrs.model && parsed.attrs.model !== "inherit" ? parsed.attrs.model : undefined,
				color: parsed.attrs.color || undefined,
				timeoutMs: parseTimeoutMs(parsed.attrs.timeout),
				source,
			});
		} catch {
			// Unreadable agent files are skipped; discovery is best-effort.
		}
	}
}

function discoverAgentTypes(cwd: string): Map<string, AgentType> {
	const agents = new Map<string, AgentType>();
	loadAgentsFromDir(path.join(cwd, ".claude", "agents"), "project", agents);
	loadAgentsFromDir(path.join(os.homedir(), ".claude", "agents"), "user", agents);
	agents.set("general-purpose", {
		name: "general-purpose",
		description:
			"General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
		prompt: GENERAL_PURPOSE_PROMPT,
		source: "built-in",
	});
	agents.set("Explore", {
		name: "Explore",
		description: EXPLORE_DESCRIPTION,
		prompt: EXPLORE_PROMPT,
		standalone: true,
		tools: ["read", "bash"],
		color: "green",
		source: "built-in",
	});
	agents.set("Plan", {
		name: "Plan",
		description: PLAN_DESCRIPTION,
		prompt: PLAN_PROMPT,
		standalone: true,
		tools: ["read", "bash"],
		color: "blue",
		source: "built-in",
	});
	return agents;
}

function assembleSystemPrompt(agent: AgentType, cwd: string, model: string | undefined): string {
	const agentPrompt = agent.standalone ? agent.prompt : `${BASE_PROMPT}\n\n${agent.prompt}`;
	return [agentPrompt, NOTES_BLOCK, buildEnvBlock(cwd, model)].join("\n\n");
}

/**
 * Map an agent definition's tools list to pi builtins. Claude Code agent
 * files name Claude tools (Read, Grep, Glob, Bash…); pi only has these four,
 * and passing an unknown name to `pi --tools` hangs the child process.
 */
const PI_BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write"]);
const CLAUDE_TOOL_MAP: Record<string, string> = {
	read: "read",
	bash: "bash",
	edit: "edit",
	write: "write",
	grep: "bash",
	glob: "bash",
	ls: "bash",
	find: "bash",
};

function sanitizeTools(tools: string[] | undefined): string[] | undefined {
	if (!tools?.length) return undefined;
	const mapped = new Set<string>();
	for (const tool of tools) {
		const target = CLAUDE_TOOL_MAP[tool.toLowerCase()];
		if (target && PI_BUILTIN_TOOLS.has(target)) mapped.add(target);
	}
	// If nothing maps, fall back to the full toolset rather than a hang.
	return mapped.size > 0 ? [...mapped] : undefined;
}

// ---------------------------------------------------------------------------
// ask_user child extension — written to disk and loaded into every child via
// `-e` (which works alongside --no-extensions). Its ctx.ui calls surface in
// the parent as extension_ui_request events on the RPC stream; the parent
// shows them to the user and replies with extension_ui_response. Plain JS
// with no imports so it loads in any project regardless of installed deps.
// ---------------------------------------------------------------------------

const ASK_USER_TOOL_SOURCE = `export default function askUser(pi) {
	pi.registerTool({
		name: "ask_user",
		label: "AskUser",
		description:
			"Ask the user a question and wait for their answer. Use ONLY when you are blocked on a decision you cannot resolve yourself (ambiguous requirements, a destructive action needing approval). The user may take a while to answer. Provide options for a fixed choice list, or omit it for a free-text answer.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "The question to ask the user" },
				options: { type: "array", items: { type: "string" }, description: "Optional fixed choices" },
			},
			required: ["question"],
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let answer;
			if (Array.isArray(params.options) && params.options.length > 0) {
				answer = await ctx.ui.select(params.question, params.options.map(String));
			} else {
				answer = await ctx.ui.input(params.question, "answer for the subagent");
			}
			if (answer === undefined || answer === "") {
				return { content: [{ type: "text", text: "(the user dismissed the question without answering; proceed with your best judgment)" }] };
			}
			return { content: [{ type: "text", text: answer }] };
		},
	});
}
`;

function ensureAskUserTool(): string {
	fs.mkdirSync(path.dirname(ASK_USER_TOOL_PATH), { recursive: true });
	try {
		if (fs.readFileSync(ASK_USER_TOOL_PATH, "utf-8") === ASK_USER_TOOL_SOURCE) return ASK_USER_TOOL_PATH;
	} catch {
		// Missing or unreadable — rewrite below.
	}
	fs.writeFileSync(ASK_USER_TOOL_PATH, ASK_USER_TOOL_SOURCE);
	return ASK_USER_TOOL_PATH;
}

/**
 * Child-side structured_output tool for workflow agents with a schema. The
 * parent reads the call's args off the child's tool_execution_start event;
 * terminate ends the run as soon as the result is submitted.
 */
const STRUCTURED_OUTPUT_TOOL_PATH = path.join(os.homedir(), ".claude-subagent", "structured-output-tool.js");
const STRUCTURED_OUTPUT_TOOL_SOURCE = `export default function structuredOutput(pi) {
	pi.registerTool({
		name: "structured_output",
		label: "StructuredOutput",
		description:
			"Submit your final structured result. Call this exactly once, when the task is complete: the result argument must be a single JSON value matching the schema given in your instructions. This ends your run — do not produce the result as plain text.",
		parameters: {
			type: "object",
			properties: {
				result: { description: "The final result value matching the requested schema" },
			},
			required: ["result"],
		},
		async execute(_id, _params) {
			return { content: [{ type: "text", text: "Structured output recorded." }], terminate: true };
		},
	});
}
`;

function ensureStructuredOutputTool(): string {
	fs.mkdirSync(path.dirname(STRUCTURED_OUTPUT_TOOL_PATH), { recursive: true });
	try {
		if (fs.readFileSync(STRUCTURED_OUTPUT_TOOL_PATH, "utf-8") === STRUCTURED_OUTPUT_TOOL_SOURCE) return STRUCTURED_OUTPUT_TOOL_PATH;
	} catch {
		// Missing or unreadable — rewrite below.
	}
	fs.writeFileSync(STRUCTURED_OUTPUT_TOOL_PATH, STRUCTURED_OUTPUT_TOOL_SOURCE);
	return STRUCTURED_OUTPUT_TOOL_PATH;
}

// ---------------------------------------------------------------------------
// TUI rendering — Claude Code style
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// The spinner frame is derived from the clock at render time, but no timer
// forces renders: pi re-renders only on real events (child tool starts, turn
// ends, keystrokes), and each of those renders picks up a fresh frame. A
// repaint timer here is tempting but wrong — pi has no periodic render loop
// of its own, and forced repaints fight terminal scrollback (pi-tui falls
// back to a full render that clears scrollback when a changed line is above
// the viewport).
const SPINNER_FRAME_MS = 100;

/** Claude Code agent frontmatter colors → ANSI foreground codes. */
const AGENT_COLOR_ANSI: Record<string, string> = {
	red: "31",
	green: "32",
	yellow: "33",
	blue: "34",
	purple: "35",
	magenta: "35",
	cyan: "36",
	orange: "38;5;208",
	pink: "38;5;212",
};

interface AgentDetails {
	status: "running" | "done" | "launched";
	agentType: string;
	description: string;
	model?: string;
	color?: string;
	currentTool?: string;
	recentTools?: string[];
	toolCount: number;
	tokens: number;
	contextPercent?: number;
	turns?: number;
	exitCode?: number;
	sessionFile?: string;
	/** tmux pane id when launched as a pane teammate. */
	pane?: string;
	/** Name when launched as an in-process teammate. */
	teammateName?: string;
}

function spinnerFrame(seed: number): string {
	return SPINNER_FRAMES[Math.abs(seed) % SPINNER_FRAMES.length]!;
}

function clockSpinner(): number {
	return Math.floor(Date.now() / SPINNER_FRAME_MS);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

type AnyTheme = Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];

function typeLabel(theme: AnyTheme, name: string, color: string | undefined): string {
	const ansi = color ? AGENT_COLOR_ANSI[color.toLowerCase()] : undefined;
	const colored = ansi ? `\x1b[${ansi}m${name}\x1b[39m` : theme.fg("toolTitle", name);
	return theme.bold(colored);
}

function statsSuffix(theme: AnyTheme, toolCount: number, tokens: number): string {
	const stats: string[] = [];
	if (toolCount > 0) stats.push(`${toolCount} tool use${toolCount === 1 ? "" : "s"}`);
	if (tokens > 0) stats.push(`${formatTokens(tokens)} tokens`);
	return stats.length ? theme.fg("dim", ` · ${stats.join(" · ")}`) : "";
}

/** Context utilization badge, color-stepped: <70% dim, 70–85% warning, ≥85% error. */
function contextBadge(theme: AnyTheme, percent: number | undefined): string {
	if (percent === undefined) return "";
	const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
	return theme.fg(color, ` · ${percent}% ctx`);
}

function agentHeader(theme: AnyTheme, glyph: string, typeName: string, color: string | undefined, desc: string | undefined, suffix: string): string {
	const descLabel = desc ? ` ${theme.fg("dim", `(${desc})`)}` : "";
	return `${glyph} ${typeLabel(theme, typeName, color)}${descLabel}${suffix}`;
}

/**
 * One line wrapped in an OSC 8 hyperlink (ctrl/cmd+click opens it in the
 * terminal). Truncates the text BEFORE applying the link envelope so a
 * narrow terminal can't sever the closing sequence and bleed the link
 * into subsequent rows.
 */
class LinkLine {
	private readonly text: string;
	private readonly url: string;
	constructor(text: string, url: string) {
		this.text = text;
		this.url = url;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [hyperlink(truncateToWidth(this.text, width), this.url)];
	}
}

function sessionLink(theme: AnyTheme, sessionFile: string): LinkLine {
	return new LinkLine(theme.fg("dim", `   session: ${shortenPath(sessionFile)}`), `file://${sessionFile}`);
}

// ---------------------------------------------------------------------------
// Unified session roster: every live RPC child — synchronous subagents,
// background agents, and in-process teammates — is one AgentSession. The
// widget and the alt+a manager render from this registry. (Pane teammates
// live in tmux and keep their own registry below.)
// ---------------------------------------------------------------------------

type SessionState = "working" | "needs-input" | "idle" | "done" | "failed";

interface AgentSession {
	name: string;
	kind: "sync" | "background" | "teammate";
	agentType: string;
	description: string;
	color?: string;
	model?: string;
	state: SessionState;
	child: RpcChild;
	sessionFile: string;
	startedAt: number;
	currentTool?: string;
	queue: string[];
	pendingUi?: UiRequest;
	lastReply?: string;
	/** Teammate asked to be shut down; awaiting lead approval. */
	shutdownRequested: boolean;
	/** Shutdown decided; tear down when the current run settles. */
	shutdown: boolean;
	reaper?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, AgentSession>();

function uniqueSessionName(base: string): string {
	const slug = base.replace(/^@/, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "agent";
	if (!sessions.has(slug)) return slug;
	for (let i = 2; ; i++) {
		if (!sessions.has(`${slug}-${i}`)) return `${slug}-${i}`;
	}
}

const STATE_ORDER: Record<SessionState, number> = { "needs-input": 0, working: 1, idle: 2, done: 3, failed: 4 };

function sortedSessions(): AgentSession[] {
	return [...sessions.values()].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.startedAt - b.startedAt);
}

function sessionLabel(s: AgentSession): string {
	return s.kind === "teammate" ? `@${s.name}` : s.name;
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

function updateWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (sessions.size === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	const list = sortedSessions();
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
		const c = new Container();
		const needsInput = list.filter((s) => s.state === "needs-input").length;
		const anyBusy = list.some((s) => s.state === "working");
		const glyph = needsInput > 0 ? theme.fg("warning", "?") : anyBusy ? theme.fg("accent", spinnerFrame(clockSpinner())) : theme.fg("dim", "●");
		const inputNote = needsInput > 0 ? `${theme.fg("warning", `${needsInput} need${needsInput === 1 ? "s" : ""} input`)} ${theme.fg("dim", "·")} ` : "";
		c.addChild(new TruncatedText(`${glyph} ${theme.bold(String(list.length))} agent${list.length === 1 ? "" : "s"} ${theme.fg("dim", "·")} ${inputNote}${theme.fg("dim", "alt+a manages")}`, 1, 0));
		for (let i = 0; i < list.length; i++) {
			const s = list[i]!;
			const stats = statsSuffix(theme, s.child.toolCount, s.child.tokens);
			let stateNote: string;
			switch (s.state) {
				case "needs-input":
					stateNote = theme.fg("warning", ` · needs input: ${s.pendingUi?.title ?? "question"}`);
					break;
				case "working":
					stateNote = theme.fg("dim", ` · ${s.currentTool ?? "working…"}`);
					break;
				case "idle":
					stateNote = s.shutdownRequested
						? theme.fg("warning", " · requests shutdown")
						: theme.fg("dim", ` · idle${s.queue.length ? ` (${s.queue.length} queued)` : ""}`);
					break;
				case "done":
					stateNote = theme.fg("dim", " · done");
					break;
				case "failed":
					stateNote = theme.fg("error", " · failed");
					break;
			}
			const branch = theme.fg("dim", i === list.length - 1 ? "└" : "├");
			const turns = s.child.turns > 0 ? theme.fg("dim", ` · ↻${s.child.turns}`) : "";
			const elapsed = theme.fg("dim", ` · ${formatDuration(Date.now() - s.startedAt)}`);
			c.addChild(
				new TruncatedText(
					`${branch} ${typeLabel(theme, sessionLabel(s), s.color)} ${theme.fg("dim", `(${s.description})`)}${stats}${turns}${contextBadge(theme, s.child.contextPercent)}${elapsed}${stateNote}`,
					1,
					0,
				),
			);
		}
		return c;
	});
}

// ---------------------------------------------------------------------------
// Teammates: interactive pi sessions in tmux split panes
// ---------------------------------------------------------------------------

interface Teammate {
	name: string;
	agentType: string;
	description: string;
	color?: string;
	paneId: string;
	startedAt: number;
	reportPath: string;
	reportDelivered: boolean;
	stopWatching: () => void;
}

const teammates = new Map<string, Teammate>();
let teammateCounter = 0;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function tmuxRun(args: string[]): { ok: boolean; out: string; err: string } {
	const result = spawnSync("tmux", args, { encoding: "utf-8" });
	if (result.error) return { ok: false, out: "", err: result.error.message };
	return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

function tmuxTarget(): string | undefined {
	return process.env.CLAUDE_SUBAGENT_TMUX_TARGET || undefined;
}

function insideTmux(): boolean {
	return Boolean(process.env.TMUX) || Boolean(tmuxTarget());
}

function listLivePanes(): Set<string> | undefined {
	const result = tmuxRun(["list-panes", "-a", "-F", "#{pane_id}"]);
	if (!result.ok) return undefined;
	return new Set(result.out.split("\n").filter(Boolean));
}

/** Drop registry entries whose tmux pane no longer exists. */
function pruneDeadTeammates(): void {
	if (teammates.size === 0) return;
	const live = listLivePanes();
	if (!live) return;
	for (const [paneId, mate] of teammates) {
		if (!live.has(paneId)) {
			mate.stopWatching();
			teammates.delete(paneId);
		}
	}
}

function buildTeammatePrompt(name: string, agent: AgentType, reportPath: string): string {
	const role = agent.name === "general-purpose" ? "" : `\n\n## Role\n\n${agent.prompt}`;
	return `# Teammate Mode

You are teammate '${name}' — an agent spawned into a tmux split pane by the main pi session to work on an assigned task in parallel with it.

- Begin your assigned task immediately.
- The user may focus this pane and chat with you directly; collaborate normally.
- When the assigned task is complete, use the write tool to save your final report to exactly this path:
  ${reportPath}
  The main session watches that file and delivers your report back to it — this is the expected reporting channel (an exception to any rule against writing report files).
- After writing the report, remain available in this pane for follow-ups.
- Do not spawn additional agents or teammates.${role}`;
}

/**
 * Watch for the teammate's report file. fs.watchFile fires only on CHANGE,
 * not per poll interval — so each change arms a settle timer and the read
 * happens once writes stop (a partially written report just re-arms it).
 * Self-expires after a few hours.
 */
function watchReport(reportPath: string, onReport: (text: string) => void): () => void {
	let delivered = false;
	let settle: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (settle) clearTimeout(settle);
		settle = undefined;
		fs.unwatchFile(reportPath, poll);
		clearTimeout(expiry);
	};
	const deliver = () => {
		if (delivered) return;
		let text: string;
		try {
			text = fs.readFileSync(reportPath, "utf-8");
		} catch {
			return; // Not readable yet; the next change re-arms the settle timer.
		}
		if (!text.trim()) return;
		delivered = true;
		stop();
		onReport(text);
	};
	const poll = (curr: fs.Stats) => {
		if (delivered || curr.size <= 0) return;
		if (settle) clearTimeout(settle);
		settle = setTimeout(deliver, 1500);
		settle.unref?.();
	};
	fs.watchFile(reportPath, { interval: REPORT_POLL_MS }, poll);
	const expiry = setTimeout(stop, REPORT_WATCH_EXPIRY_MS);
	expiry.unref?.();
	return stop;
}

// ---------------------------------------------------------------------------
// In-process teammates (Claude's primary teammate form, mapped to pi): a
// named, persistent, conversational AgentSession whose RPC child stays
// alive between turns, retaining its context. Replies are relayed into the
// parent session as @name rows; send_message delivers follow-ups.
// ---------------------------------------------------------------------------

function buildInProcessBlock(name: string): string {
	return `# Teammate Mode (in-process)

You are teammate '@${name}', working alongside the main pi session on assigned tasks.

- Each reply you produce is relayed to the main session as a message from @${name}; your final message each turn IS your report for that turn.
- You may receive follow-up messages that continue this same conversation — retain and build on your context.
- Stay focused on your assigned work; be concise in replies.
- When your work is fully complete and you expect no further follow-ups, you may request shutdown by ending your reply with the marker SHUTDOWN_REQUEST on its own line. The lead decides whether to approve; until then, remain available.`;
}

function sanitizeTeammateName(raw: string): string {
	return raw.replace(/^@/, "").replace(/[^\w.-]/g, "-").slice(0, 32) || "teammate";
}

interface ChildProgress {
	currentTool?: string;
	recentTools: string[];
	toolCount: number;
	tokens: number;
	contextPercent?: number;
}

/** Outcome of one prompt run (agent_start → agent_end) inside an RPC child. */
interface RunOutcome {
	finalText: string;
	toolCount: number;
	turns: number;
	usage: { input: number; output: number; cost: number };
	error?: string;
	/** Args.result of the child's structured_output call, if it made one. */
	structuredOutput?: unknown;
}

/** An interactive UI request forwarded from a child's ask_user tool. */
interface UiRequest {
	id: string;
	method: "select" | "input" | "confirm";
	title: string;
	message?: string;
	options?: string[];
}

type UiResponsePayload = { value: string } | { confirmed: boolean } | { cancelled: true };

interface RpcChildCallbacks {
	onProgress: (p: ChildProgress) => void;
	onUiRequest?: (req: UiRequest) => void;
	/** Fired once when the child process exits, after any pending run settles. */
	onExit?: () => void;
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function toolArgsPreview(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const key of ["command", "path", "file_path", "filePath", "pattern", "query", "url", "prompt", "description"]) {
		const v = a[key];
		if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").trim().slice(0, 80);
	}
	return "";
}

/**
 * A long-lived pi child in RPC mode (`--mode rpc`): JSONL commands on stdin,
 * events on stdout. One prompt() call is one run (agent_start → agent_end);
 * the process stays alive between runs, retaining its conversation, so
 * follow-up prompts continue the same context without resuming a session
 * file. ask_user calls from the child arrive as extension_ui_request events
 * and are answered with respondUi(); the run timeout is suspended while a
 * question is pending so a slow human answer can't kill the child.
 */
class RpcChild {
	/** Totals across all runs, for display. */
	toolCount = 0;
	tokens = 0;
	turns = 0;
	recentTools: string[] = [];
	alive = true;
	/**
	 * Context utilization 0–100 as the child itself reports it (via
	 * get_session_stats after each assistant message), so custom providers
	 * work too. Undefined until the first report or when the child can't say.
	 */
	contextPercent: number | undefined;

	private proc: ReturnType<typeof spawn>;
	private readonly callbacks: RpcChildCallbacks;
	private readonly timeoutMs: number;
	private buf = "";
	private stderrTail = "";
	private lastTool: string | undefined;
	private exited = false;
	private run?: {
		resolve: (outcome: RunOutcome) => void;
		outcome: RunOutcome;
		timer?: ReturnType<typeof setTimeout>;
		timedOut: boolean;
		abortReason?: string;
	};

	constructor(args: string[], cwd: string, timeoutMs: number, callbacks: RpcChildCallbacks) {
		this.callbacks = callbacks;
		this.timeoutMs = timeoutMs;
		this.proc = spawn("pi", ["--mode", "rpc", ...args], {
			cwd,
			env: { ...process.env, [CHILD_ENV]: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout?.on("data", (chunk: Buffer) => {
			this.buf += chunk.toString("utf-8");
			const lines = this.buf.split("\n");
			this.buf = lines.pop() ?? "";
			for (const line of lines) this.processLine(line);
		});
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-2000);
		});
		// A write racing the child's death surfaces as an async EPIPE on stdin;
		// without a listener that's an uncaught exception in the parent.
		this.proc.stdin?.on("error", () => {});
		this.proc.on("error", (err) => {
			this.settleOnExit(`Failed to spawn pi: ${err.message}`);
		});
		this.proc.on("close", (code) => {
			if (this.buf.trim()) this.processLine(this.buf);
			this.settleOnExit(undefined, code ?? 1);
		});
	}

	/** Send one user message and resolve when its run completes. Never rejects. */
	prompt(message: string): Promise<RunOutcome> {
		if (!this.alive) {
			return Promise.resolve({ finalText: "", toolCount: 0, turns: 0, usage: { input: 0, output: 0, cost: 0 }, error: "Subagent process has exited." });
		}
		return new Promise((resolve) => {
			this.run = {
				resolve,
				outcome: { finalText: "", toolCount: 0, turns: 0, usage: { input: 0, output: 0, cost: 0 } },
				timedOut: false,
			};
			this.armTimer();
			this.send({ type: "prompt", message });
		});
	}

	respondUi(id: string, payload: UiResponsePayload): void {
		this.send({ type: "extension_ui_response", id, ...payload });
		this.armTimer(); // question answered — the run clock starts again
	}

	/** Kill the child. A pending run settles with `reason` (or an exit error). */
	kill(reason?: string): void {
		if (this.run && reason) this.run.abortReason = reason;
		this.alive = false;
		this.proc.kill("SIGTERM");
		setTimeout(() => this.proc.kill("SIGKILL"), 3000).unref?.();
	}

	private send(obj: Record<string, unknown>): void {
		try {
			this.proc.stdin?.write(`${JSON.stringify(obj)}\n`);
		} catch {
			// Child gone; the close handler settles any pending run.
		}
	}

	private armTimer(): void {
		if (!this.run) return;
		this.clearTimer();
		this.run.timer = setTimeout(() => {
			if (this.run) this.run.timedOut = true;
			this.kill();
		}, this.timeoutMs);
		this.run.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.run?.timer) clearTimeout(this.run.timer);
		if (this.run) this.run.timer = undefined;
	}

	private settleRun(): void {
		const run = this.run;
		if (!run) return;
		this.clearTimer();
		this.run = undefined;
		run.resolve(run.outcome);
	}

	private settleOnExit(spawnError?: string, exitCode?: number): void {
		if (this.exited) return;
		this.exited = true;
		this.alive = false;
		const run = this.run;
		if (run) {
			const o = run.outcome;
			if (spawnError) {
				o.error = spawnError;
			} else if (run.abortReason && !o.finalText) {
				o.error = run.abortReason;
			} else if (run.timedOut && !o.finalText) {
				// A late buffered final text would have cleared the error;
				// the timeout verdict must survive unless real output exists.
				o.error = `Timed out after ${formatDuration(this.timeoutMs)}.`;
			} else if (exitCode !== undefined && exitCode !== 0 && !o.finalText && !o.error) {
				o.error = `Subagent exited with code ${exitCode}.${this.stderrTail ? ` stderr: ${this.stderrTail.trim()}` : ""}`;
			} else if (!o.finalText && !o.error) {
				o.error = "Subagent exited before completing the task.";
			}
			this.settleRun();
		}
		this.callbacks.onExit?.();
	}

	private emitProgress(): void {
		this.callbacks.onProgress({
			currentTool: this.lastTool,
			recentTools: [...this.recentTools],
			toolCount: this.toolCount,
			tokens: this.tokens,
			contextPercent: this.contextPercent,
		});
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		let evt: {
			type?: string;
			id?: string;
			method?: string;
			title?: string;
			options?: string[];
			command?: string;
			success?: boolean;
			error?: string;
			toolName?: string;
			args?: unknown;
			data?: { contextUsage?: { percent?: number | null } };
			message?: { role?: string; content?: unknown; usage?: { input?: number; output?: number; cost?: { total?: number } }; errorMessage?: string };
		};
		try {
			evt = JSON.parse(line);
		} catch {
			return;
		}
		const run = this.run;
		if (evt.type === "tool_execution_start") {
			this.toolCount++;
			if (run) run.outcome.toolCount++;
			if (run && evt.toolName === "structured_output") {
				run.outcome.structuredOutput = (evt.args as { result?: unknown } | undefined)?.result;
			}
			const preview = toolArgsPreview(evt.args);
			this.lastTool = preview ? `${evt.toolName ?? "tool"}: ${preview}` : evt.toolName ?? "tool";
			this.recentTools.push(this.lastTool);
			if (this.recentTools.length > RECENT_TOOLS_LIMIT) this.recentTools.shift();
			this.emitProgress();
		} else if (evt.type === "message_end" && evt.message?.role === "assistant") {
			this.turns++;
			const u = evt.message.usage;
			if (u) this.tokens += (u.input || 0) + (u.output || 0);
			// The child computes utilization against its actual model's window
			// (custom providers included) — ask it rather than guessing here.
			this.send({ type: "get_session_stats", id: "ctx" });
			if (run) {
				run.outcome.turns++;
				if (u) {
					run.outcome.usage.input += u.input || 0;
					run.outcome.usage.output += u.output || 0;
					run.outcome.usage.cost += u.cost?.total || 0;
				}
				if (evt.message.errorMessage) run.outcome.error = evt.message.errorMessage;
				const text = extractText(evt.message.content);
				if (text.trim()) {
					run.outcome.finalText = text;
					run.outcome.error = undefined;
				}
			}
			this.emitProgress();
		} else if (evt.type === "agent_end") {
			this.settleRun();
		} else if (evt.type === "response" && evt.command === "get_session_stats") {
			const pct = evt.data?.contextUsage?.percent;
			const next = typeof pct === "number" ? Math.min(100, Math.round(pct)) : undefined;
			if (next !== this.contextPercent) {
				this.contextPercent = next;
				this.emitProgress();
			}
		} else if (evt.type === "response" && evt.command === "prompt" && evt.success === false) {
			if (run) {
				run.outcome.error = evt.error || "The subagent rejected the prompt.";
				this.settleRun();
			}
		} else if (evt.type === "extension_ui_request" && evt.id) {
			const method = evt.method;
			if (method === "select" || method === "input" || method === "confirm") {
				this.clearTimer(); // waiting on the user, not the child
				this.callbacks.onUiRequest?.({
					id: evt.id,
					method,
					title: evt.title ?? "Question from subagent",
					message: (evt as { message?: string }).message,
					options: evt.options,
				});
			}
			// Non-interactive methods (notify, setWidget, …) need no response
			// and have no UI surface here; ignore them.
		}
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function claudeSubagent(pi: ExtensionAPI): void {
	// Children run with --no-extensions, but guard anyway in case a config
	// force-loads this extension into a child.
	if (process.env[CHILD_ENV]) return;

	pruneOldSessions();
	const cwd = process.cwd();
	// Snapshot for the static tool description only; execute() re-discovers
	// fresh per call and uses its own map for lookup and error messages.
	const typeList = [...discoverAgentTypes(cwd).values()]
		.map((a) => `- ${a.name}: ${a.description}${a.tools ? ` (Tools: ${a.tools.join(", ")})` : " (Tools: *)"}`)
		.join("\n");

	const parameters = {
		type: "object",
		properties: {
			description: {
				type: "string",
				description: "A short (3-5 word) description of the task",
			},
			prompt: {
				type: "string",
				description: "The task for the agent to perform",
			},
			subagent_type: {
				type: "string",
				description: "The type of specialized agent to use for this task (default: general-purpose)",
			},
			model: {
				type: "string",
				description: "Optional model override for this agent. If omitted, uses the agent definition's model, or pi's default.",
			},
			run_in_background: {
				type: "boolean",
				description: "Set to true to run this agent in the background. The tool returns immediately and the agent's report is delivered as a message when it completes.",
			},
			name: {
				type: "string",
				description: "Spawn a persistent, named teammate instead of a one-shot subagent. It works on the task, replies as @name messages, keeps its context, and accepts follow-ups via the send_message tool.",
			},
			pane: {
				type: "boolean",
				description: "With name: spawn the teammate as an interactive pi session in a tmux split pane the user can chat with directly, instead of in-process. Requires pi to be running inside tmux.",
			},
			teammate: {
				type: "boolean",
				description: "Deprecated alias for pane.",
			},
		},
		required: ["description", "prompt"],
		additionalProperties: false,
	};

	interface AgentParams {
		description: string;
		prompt: string;
		subagent_type?: string;
		model?: string;
		run_in_background?: boolean;
		teammate?: boolean;
		pane?: boolean;
		name?: string;
	}

	const askUserPath = ensureAskUserTool();

	function buildChildArgs(
		sessionFile: string,
		promptPath: string,
		model: string | undefined,
		tools: string[] | undefined,
		structuredOutput?: boolean,
	): string[] {
		const args = ["--session", sessionFile, "--no-extensions", "-e", askUserPath, "--no-skills", "--system-prompt", promptPath];
		if (structuredOutput) args.push("-e", ensureStructuredOutputTool());
		if (model) args.push("--model", model);
		// A --tools allowlist filters extension tools too, so ask_user must be
		// listed explicitly or restricted agents would lose it.
		if (tools?.length) {
			args.push("--tools", [...tools, "ask_user", ...(structuredOutput ? ["structured_output"] : [])].join(","));
		}
		return args;
	}

	function makeSessionDir(base: string, name: string): string {
		const dir = path.join(base, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	interface CreateSessionOptions {
		kind: AgentSession["kind"];
		name: string;
		agent: AgentType;
		typeName: string;
		description: string;
		model?: string;
		sessionFile: string;
		promptPath: string;
		ctx: ExtensionContext;
		onProgress?: (p: ChildProgress) => void;
		/** Inject the structured_output tool (workflow agents with a schema). */
		structuredOutput?: boolean;
	}

	function createSession(opts: CreateSessionOptions): AgentSession {
		const session: AgentSession = {
			name: opts.name,
			kind: opts.kind,
			agentType: opts.typeName,
			description: opts.description,
			color: opts.agent.color,
			model: opts.model,
			state: "working",
			child: undefined as unknown as RpcChild,
			sessionFile: opts.sessionFile,
			startedAt: Date.now(),
			queue: [],
			shutdownRequested: false,
			shutdown: false,
		};
		session.child = new RpcChild(
			buildChildArgs(opts.sessionFile, opts.promptPath, opts.model, sanitizeTools(opts.agent.tools), opts.structuredOutput),
			cwd,
			opts.agent.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS,
			{
				onProgress: (p) => {
					session.currentTool = p.currentTool;
					opts.onProgress?.(p);
					updateWidget(opts.ctx);
				},
				onUiRequest: (req) => {
					if (!opts.ctx.hasUI) {
						// Headless parent: nobody can answer; unblock the child
						// immediately rather than letting it wait forever.
						session.child.respondUi(req.id, { cancelled: true });
						return;
					}
					session.pendingUi = req;
					session.state = "needs-input";
					opts.onProgress?.({
						currentTool: `needs input: ${req.title}`,
						recentTools: [...session.child.recentTools],
						toolCount: session.child.toolCount,
						tokens: session.child.tokens,
						contextPercent: session.child.contextPercent,
					});
					updateWidget(opts.ctx);
					opts.ctx.ui.notify(`${sessionLabel(session)} needs input: ${req.title} — alt+a to answer`, "warning");
				},
				onExit: () => {
					if (!sessions.has(session.name) || session.shutdown || session.kind === "sync") return;
					if (session.state === "working" || session.state === "needs-input") return; // the pending run's settle handler reports it
					// Died while idle/done: mark failed and let the reaper collect it.
					session.state = "failed";
					armReaper(session, opts.ctx);
					updateWidget(opts.ctx);
				},
			},
		);
		sessions.set(session.name, session);
		updateWidget(opts.ctx);
		return session;
	}

	/** Finished background sessions linger briefly for follow-ups, then go away. */
	function armReaper(session: AgentSession, ctx: ExtensionContext): void {
		if (session.kind !== "background") return;
		if (session.reaper) clearTimeout(session.reaper);
		session.reaper = setTimeout(() => {
			if ((session.state === "done" || session.state === "failed") && session.queue.length === 0) {
				destroySession(session, ctx);
			}
		}, DONE_SESSION_GRACE_MS);
		session.reaper.unref?.();
	}

	function destroySession(session: AgentSession, ctx: ExtensionContext): void {
		if (session.reaper) clearTimeout(session.reaper);
		const wasWorking = session.state === "working" || session.state === "needs-input";
		session.shutdown = true;
		session.queue.length = 0;
		sessions.delete(session.name);
		session.child.kill("Shut down by the user.");
		if (session.kind === "background" && wasWorking) {
			// User-initiated cancellation shouldn't wake the model; it sees the
			// notice on the next turn instead.
			pi.sendMessage(
				{
					customType: RESULT_MESSAGE_TYPE,
					content: `Background agent '${session.description}' (${session.agentType}) was cancelled by the user.`,
					display: true,
					details: {
						agentType: session.agentType,
						description: session.description,
						color: session.color,
						toolCount: session.child.toolCount,
						tokens: session.child.tokens,
						durationMs: Date.now() - session.startedAt,
						ok: false,
						cancelled: true,
						sessionFile: session.sessionFile,
					},
				},
				{ deliverAs: "nextTurn" },
			);
		}
		updateWidget(ctx);
	}

	/** Deliver a turn's outcome to the parent session as an @name message. */
	function makeReplyDeliver(session: AgentSession): (outcome: RunOutcome, durationMs: number) => void {
		return (outcome, durationMs) => {
			const failed = Boolean(outcome.error && !outcome.finalText);
			let reply = failed ? `(turn failed: ${outcome.error})` : outcome.finalText.trim() || "(no reply)";
			const shutdownMarker = /^\s*SHUTDOWN_REQUEST\s*$/m;
			if (!failed && session.kind === "teammate" && shutdownMarker.test(reply)) {
				session.shutdownRequested = true;
				reply = reply.replace(shutdownMarker, "").trim();
			}
			const shutdownNote = session.shutdownRequested
				? `\n\n(@${session.name} requests shutdown — approve with send_message {name: "${session.name}", shutdown: true}, or send follow-up work to keep it going)`
				: "";
			pi.sendMessage(
				{
					customType: TEAMMATE_MESSAGE_TYPE,
					content: `Message from ${session.kind === "teammate" ? "teammate" : "background agent"} @${session.name}:\n\n${reply}${shutdownNote}`,
					display: true,
					details: {
						name: session.name,
						agentType: session.agentType,
						description: session.description,
						color: session.color,
						toolCount: outcome.toolCount,
						tokens: outcome.usage.input + outcome.usage.output,
						durationMs,
						failed,
						requestsShutdown: session.shutdownRequested,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		};
	}

	// Smart join (after pi-subagents): background reports landing close
	// together deliver as one batch — each report stays its own rendered
	// message, but only the last triggers a model turn, so N completions cost
	// one wake-up instead of N. A report flushes immediately when no other
	// background agent is still working; otherwise it waits up to
	// REPORT_JOIN_DEBOUNCE_MS for siblings (bounded by REPORT_JOIN_MAX_MS).
	const reportBuffer: Array<{ content: string; details: ResultMessageDetails }> = [];
	let reportFlushTimer: ReturnType<typeof setTimeout> | undefined;
	let reportFlushDeadline = 0;

	function flushBackgroundReports(): void {
		if (reportFlushTimer) clearTimeout(reportFlushTimer);
		reportFlushTimer = undefined;
		const batch = reportBuffer.splice(0);
		batch.forEach((report, i) => {
			pi.sendMessage(
				{ customType: RESULT_MESSAGE_TYPE, content: report.content, display: true, details: report.details },
				{ triggerTurn: i === batch.length - 1, deliverAs: "followUp" },
			);
		});
	}

	function queueBackgroundReport(content: string, details: ResultMessageDetails): void {
		reportBuffer.push({ content, details });
		const othersWorking = [...sessions.values()].some(
			(s) => s.kind === "background" && (s.state === "working" || s.state === "needs-input"),
		);
		if (!othersWorking) {
			flushBackgroundReports();
			return;
		}
		const now = Date.now();
		if (reportBuffer.length === 1) reportFlushDeadline = now + REPORT_JOIN_MAX_MS;
		if (reportFlushTimer) clearTimeout(reportFlushTimer);
		reportFlushTimer = setTimeout(flushBackgroundReports, Math.min(REPORT_JOIN_DEBOUNCE_MS, Math.max(0, reportFlushDeadline - now)));
		reportFlushTimer.unref?.();
	}

	/** Deliver a background session's initial task report. */
	function makeBackgroundReportDeliver(session: AgentSession): (outcome: RunOutcome, durationMs: number) => void {
		return (outcome, durationMs) => {
			const failed = Boolean(outcome.error && !outcome.finalText);
			const headline = `Background agent '${session.description}' (${session.agentType})`;
			const body = failed
				? `${headline} FAILED: ${outcome.error}`
				: `${headline} completed after ${outcome.toolCount} tool use${outcome.toolCount === 1 ? "" : "s"}:\n\n${outcome.finalText || "(no output)"}\n\n(It stays available for ~5 minutes — send follow-ups with send_message {name: "${session.name}"}.)`;
			queueBackgroundReport(body, {
				agentType: session.agentType,
				description: session.description,
				color: session.color,
				toolCount: outcome.toolCount,
				tokens: outcome.usage.input + outcome.usage.output,
				durationMs,
				ok: !failed,
				cancelled: false,
				sessionFile: session.sessionFile,
			});
		};
	}

	/** Run one conversational turn for a roster session, then drain its queue. */
	function runSessionTurn(
		session: AgentSession,
		message: string,
		ctx: ExtensionContext,
		deliver: (outcome: RunOutcome, durationMs: number) => void,
	): void {
		session.state = "working";
		session.pendingUi = undefined;
		session.currentTool = undefined;
		if (session.reaper) {
			clearTimeout(session.reaper);
			session.reaper = undefined;
		}
		updateWidget(ctx);
		const turnStartedAt = Date.now();
		void session.child.prompt(message).then((outcome) => {
			if (session.shutdown || !sessions.has(session.name)) {
				sessions.delete(session.name);
				updateWidget(ctx);
				return;
			}
			const failed = Boolean(outcome.error && !outcome.finalText);
			session.lastReply = outcome.finalText.trim() || undefined;
			session.currentTool = undefined;
			session.state = failed ? "failed" : session.kind === "teammate" ? "idle" : "done";
			deliver(outcome, Date.now() - turnStartedAt);
			const next = session.queue.shift();
			if (next !== undefined && session.child.alive) {
				runSessionTurn(session, next, ctx, makeReplyDeliver(session));
			} else {
				armReaper(session, ctx);
			}
			updateWidget(ctx);
		});
	}

	/** Answer a pending ask_user question with free text (from send_message). */
	function answerUiWithText(session: AgentSession, text: string, ctx: ExtensionContext): void {
		const req = session.pendingUi;
		if (!req) return;
		session.pendingUi = undefined;
		session.state = "working";
		if (req.method === "confirm") {
			session.child.respondUi(req.id, { confirmed: /^(y|yes|ok|sure|approve|confirm|true)/i.test(text.trim()) });
		} else {
			session.child.respondUi(req.id, { value: text });
		}
		updateWidget(ctx);
	}

	function spawnBackgroundSession(
		agent: AgentType,
		typeName: string,
		description: string,
		prompt: string,
		model: string | undefined,
		ctx: ExtensionContext,
	): AgentSession {
		const name = uniqueSessionName(description);
		const dir = makeSessionDir(SESSIONS_DIR, typeName);
		const promptPath = path.join(dir, "system-prompt.md");
		fs.writeFileSync(promptPath, assembleSystemPrompt(agent, cwd, model), { mode: 0o600 });
		const session = createSession({
			kind: "background",
			name,
			agent,
			typeName,
			description,
			model,
			sessionFile: path.join(dir, "session.jsonl"),
			promptPath,
			ctx,
		});
		runSessionTurn(session, prompt, ctx, makeBackgroundReportDeliver(session));
		return session;
	}

	const tool: ToolDefinition<never, AgentDetails> = {
		name: "agent",
		label: "Agent",
		description: `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types and the tools they have access to:
${typeList}

When to use the Agent tool:
- When you are instructed to execute custom slash commands, use the Agent tool with the slash command invocation as the entire prompt
- When searching for a keyword or file and you are not confident you will find the right match in the first few tries

When NOT to use the Agent tool:
- If you want to read a specific file path, use the read tool instead, to find the match more quickly
- If you are searching for a specific term or definition within a known location, search directly instead
- Other tasks that are not related to the agent descriptions above

Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
3. Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
4. The agent's outputs should generally be trusted
5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
6. The agent cannot launch further agents.
7. run_in_background: true makes the tool return immediately; the agent's report arrives as a message when it completes. Use for long tasks you don't need to block on. The agent keeps its context and stays alive for a few minutes after finishing, so you can send follow-ups with the send_message tool (the launch result tells you its @name).
8. Providing name spawns a persistent TEAMMATE instead of a one-shot subagent: it keeps its conversation context, replies arrive as @name messages, and you can send follow-ups with the send_message tool. Use when work is iterative or long-lived. The roster is flat — teammates cannot spawn anything.
9. pane: true (with name) puts the teammate in a tmux split pane as a fully interactive pi session the user can see and chat with directly. Use when the user asks for a visible pane or wants to supervise.
10. Agents may ask the user a question via their ask_user tool when blocked on a decision; the question is surfaced to the user directly (widget + alt+a manager) and the agent waits for the answer. You do not need to do anything when that happens.`,
		parameters: parameters as never,
		executionMode: "parallel",

		renderCall(args, theme, context) {
			// Once execution starts, the partial/final result row (renderResult)
			// owns the display; an empty container avoids a duplicate header.
			if (context.executionStarted) return new Container();
			const a = args as AgentParams;
			const typeName = a.subagent_type || "general-purpose";
			const descLabel = a.description ? ` ${theme.fg("dim", `(${a.description})`)}` : "";
			return new TruncatedText(`${theme.fg("toolTitle", theme.bold("agent"))} ${typeName}${descLabel}`, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const d = result.details as AgentDetails | undefined;
			const typeName = d?.agentType ?? "agent";
			const desc = d?.description;
			const suffix = statsSuffix(theme, d?.toolCount ?? 0, d?.tokens ?? 0);
			const c = new Container();

			const running = options.isPartial || d?.status === "running";
			if (running) {
				const glyph = theme.fg("accent", spinnerFrame(clockSpinner()));
				c.addChild(new TruncatedText(agentHeader(theme, glyph, typeName, d?.color, desc, `${suffix}${contextBadge(theme, d?.contextPercent)}`), 0, 0));
				if (options.expanded && d?.recentTools?.length) {
					for (const toolLine of d.recentTools) {
						c.addChild(new TruncatedText(theme.fg("dim", `   ${toolLine}`), 0, 0));
					}
				}
				c.addChild(new TruncatedText(theme.fg("dim", `⎿  ${d?.currentTool ?? "Initializing…"}`), 0, 0));
				return c;
			}

			if (d?.status === "launched") {
				const glyph = theme.fg("accent", "●");
				const note = d.pane
					? `⎿  teammate in tmux pane ${d.pane} — report arrives when it writes one`
					: d.teammateName
						? `⎿  teammate @${d.teammateName} — replies arrive as messages; follow up with send_message (alt+a manages)`
						: "⎿  running in background — report arrives when complete (alt+a manages)";
				c.addChild(new TruncatedText(agentHeader(theme, glyph, typeName, d.color, desc, suffix), 0, 0));
				c.addChild(new TruncatedText(theme.fg("dim", note), 0, 0));
				return c;
			}

			const failed = context.isError || (d?.exitCode !== undefined && d.exitCode !== 0);
			const glyph = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
			c.addChild(new TruncatedText(agentHeader(theme, glyph, typeName, d?.color, desc, suffix), 0, 0));

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (failed && text.trim()) {
				// Errors must be visible without expanding.
				for (const line of text.trim().split("\n").slice(0, 3)) {
					c.addChild(new TruncatedText(theme.fg("error", `   ${line}`), 0, 0));
				}
			} else if (options.expanded && text.trim()) {
				const lines = text.slice(0, 2000).split("\n").filter((l) => l.trim()).slice(0, 5);
				for (const line of lines) {
					c.addChild(new TruncatedText(theme.fg("dim", `   ${line.trim()}`), 0, 0));
				}
			}
			if (d?.sessionFile && (failed || options.expanded)) {
				c.addChild(sessionLink(theme, d.sessionFile));
			}
			return c;
		},

		async execute(_id, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as AgentParams;
			const typeName = params.subagent_type || "general-purpose";
			// Fresh discovery per call: lookup and error message share one map.
			const available = discoverAgentTypes(cwd);
			const agent = available.get(typeName);
			if (!agent) {
				throw new Error(`Unknown subagent_type '${typeName}'. Available: ${[...available.keys()].join(", ")}`);
			}

			const model = params.model || agent.model;
			const wantsPane = params.pane === true || params.teammate === true;

			// In-process teammate (Claude's primary teammate form): a named,
			// persistent, conversational agent whose RPC child stays alive
			// between turns; replies relay back as @name messages.
			if (params.name && !wantsPane) {
				const name = sanitizeTeammateName(params.name);
				if (sessions.has(name)) {
					throw new Error(`An agent named '@${name}' already exists. Use the send_message tool to talk to it, or pick a different name.`);
				}
				const mateDir = makeSessionDir(TEAMMATES_DIR, name);
				const promptPath = path.join(mateDir, "system-prompt.md");
				fs.writeFileSync(promptPath, `${assembleSystemPrompt(agent, cwd, model)}\n\n${buildInProcessBlock(name)}`, { mode: 0o600 });

				const session = createSession({
					kind: "teammate",
					name,
					agent,
					typeName,
					description: params.description,
					model,
					sessionFile: path.join(mateDir, "session.jsonl"),
					promptPath,
					ctx,
				});
				runSessionTurn(session, params.prompt, ctx, makeReplyDeliver(session));

				return {
					content: [{ type: "text", text: `Teammate '@${name}' (${typeName}) spawned in-process. Its replies will arrive as messages from @${name}; use the send_message tool for follow-ups. Continue with other work — do not wait or poll.` }],
					details: {
						status: "launched",
						agentType: typeName,
						description: params.description,
						model,
						color: agent.color,
						toolCount: 0,
						tokens: 0,
						teammateName: name,
					},
				};
			}

			// Pane teammate: interactive pi in a tmux split pane. Keeps pi's full
			// system prompt (skills, project context) and appends teammate framing;
			// the task is the initial prompt. Reports back via a watched file.
			if (wantsPane) {
				if (!insideTmux()) {
					throw new Error("Teammate mode requires pi to be running inside tmux. Run a normal or background subagent instead (omit teammate).");
				}
				const name = (params.name || `${typeName}-${++teammateCounter}`).replace(/[^\w.-]/g, "-").slice(0, 32);
				const mateDir = path.join(TEAMMATES_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
				fs.mkdirSync(mateDir, { recursive: true });
				const reportPath = path.join(mateDir, "report.md");
				const matePromptPath = path.join(mateDir, "teammate-prompt.md");
				const mateTaskPath = path.join(mateDir, "task.md");
				fs.writeFileSync(matePromptPath, buildTeammatePrompt(name, agent, reportPath), { mode: 0o600 });
				fs.writeFileSync(mateTaskPath, params.prompt, { mode: 0o600 });

				const command = [
					"pi",
					"--append-system-prompt",
					shellQuote(matePromptPath),
					...(model ? ["--model", shellQuote(model)] : []),
					shellQuote(`@${mateTaskPath}`),
				].join(" ");
				const target = tmuxTarget();
				const split = tmuxRun([
					"split-window", "-d", "-h", "-P", "-F", "#{pane_id}",
					"-e", `${CHILD_ENV}=1`,
					"-c", cwd,
					...(target ? ["-t", target] : []),
					command,
				]);
				if (!split.ok) {
					throw new Error(`Failed to spawn teammate pane: ${split.err || "tmux split-window failed"}`);
				}
				const paneId = split.out;
				tmuxRun(["select-pane", "-t", paneId, "-T", name]);

				const startedAt = Date.now();
				const mate: Teammate = {
					name,
					agentType: typeName,
					description: params.description,
					color: agent.color,
					paneId,
					startedAt,
					reportPath,
					reportDelivered: false,
					stopWatching: () => {},
				};
				mate.stopWatching = watchReport(reportPath, (text) => {
					mate.reportDelivered = true;
					pi.sendMessage(
						{
							customType: RESULT_MESSAGE_TYPE,
							content: `Teammate '${name}' (${typeName}) report:\n\n${text.trim()}`,
							display: true,
							details: {
								agentType: typeName,
								description: `${name}: ${params.description}`,
								color: agent.color,
								toolCount: 0,
								tokens: 0,
								durationMs: Date.now() - startedAt,
								ok: true,
								cancelled: false,
							},
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				});
				teammates.set(paneId, mate);

				return {
					content: [{ type: "text", text: `Teammate '${name}' (${typeName}) spawned in tmux pane ${paneId}. The user can chat with it directly; its report will be delivered as a message when it finishes. Continue with other work — do not wait or poll.` }],
					details: {
						status: "launched",
						agentType: typeName,
						description: params.description,
						model,
						color: agent.color,
						toolCount: 0,
						tokens: 0,
						pane: paneId,
					},
				};
			}

			// Background mode: return immediately, track in the roster, deliver
			// the report as a session message on completion. Only meaningful when
			// the session outlives the tool call (interactive/RPC), so headless
			// print mode falls through to the synchronous path.
			if (params.run_in_background === true && ctx.hasUI) {
				const session = spawnBackgroundSession(agent, typeName, params.description, params.prompt, model, ctx);
				return {
					content: [{ type: "text", text: `Background agent '${session.name}' launched (${typeName}). Its report will be delivered as a message when it completes; while it is alive you can send follow-ups with send_message {name: "${session.name}"}. Continue with other work — do not wait or poll.` }],
					details: {
						status: "launched",
						agentType: typeName,
						description: params.description,
						model,
						color: agent.color,
						toolCount: 0,
						tokens: 0,
						sessionFile: session.sessionFile,
					},
				};
			}

			// Synchronous subagent: one prompt run, then the child is discarded.
			// It still joins the roster while running so the user can watch it,
			// answer its ask_user questions, or kill it from the alt+a manager.
			const dir = makeSessionDir(SESSIONS_DIR, typeName);
			const promptPath = path.join(dir, "system-prompt.md");
			fs.writeFileSync(promptPath, assembleSystemPrompt(agent, cwd, model), { mode: 0o600 });
			const sessionFile = path.join(dir, "session.jsonl");

			const emit = (progress: ChildProgress) => {
				onUpdate?.({
					content: [{ type: "text", text: `${typeName}: ${params.description} — ${progress.currentTool ?? "Initializing…"}` }],
					details: {
						status: "running",
						agentType: typeName,
						description: params.description,
						model,
						color: agent.color,
						currentTool: progress.currentTool,
						recentTools: progress.recentTools,
						toolCount: progress.toolCount,
						tokens: progress.tokens,
						contextPercent: progress.contextPercent,
					},
				});
			};

			const session = createSession({
				kind: "sync",
				name: uniqueSessionName(params.description),
				agent,
				typeName,
				description: params.description,
				model,
				sessionFile,
				promptPath,
				ctx,
				onProgress: emit,
			});
			emit({ recentTools: [], toolCount: 0, tokens: 0 });

			const onAbort = () => session.child.kill("Aborted by caller.");
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const outcome = await session.child.prompt(params.prompt);
				if (outcome.error && !outcome.finalText) {
					// Throwing is the only way to mark the result as an error:
					// pi's loop overrides any isError field returned here.
					throw new Error(`${outcome.error}\n(child session: ${shortenPath(sessionFile)})`);
				}
				return {
					content: [{ type: "text", text: outcome.finalText || "(subagent returned no output)" }],
					details: {
						status: "done",
						agentType: typeName,
						description: params.description,
						model,
						color: agent.color,
						toolCount: outcome.toolCount,
						tokens: outcome.usage.input + outcome.usage.output,
						turns: outcome.turns,
						exitCode: 0,
						sessionFile,
					},
				};
			} finally {
				signal?.removeEventListener("abort", onAbort);
				sessions.delete(session.name);
				session.child.kill();
				updateWidget(ctx);
			}
		},
	};

	pi.registerTool(tool as never);

	const sendMessageParameters = {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "The agent's name (with or without the @): a teammate, or a live background agent",
			},
			message: {
				type: "string",
				description: "The message to deliver. It continues the agent's persistent conversation; the reply arrives as an @name message. If the agent has a pending ask_user question, the message answers that question instead.",
			},
			shutdown: {
				type: "boolean",
				description: "Set to true to shut the agent down instead of messaging it.",
			},
		},
		required: ["name"],
		additionalProperties: false,
	};

	const sendMessageTool: ToolDefinition<never, { name: string; queued?: boolean }> = {
		name: "send_message",
		label: "SendMessage",
		description: `Send a follow-up message to a running agent — a teammate (spawned via the agent tool's name parameter) or a live background agent — or shut one down.

- In-process teammates and background agents: the message continues their persistent conversation; the reply arrives as a message from @name. If the agent is mid-turn, the message is queued. If the agent is blocked on an ask_user question, the message answers that question and the turn resumes.
- Pane teammates: the message is typed into their tmux pane.
- shutdown: true ends the agent instead of messaging it. Use it to approve a teammate's shutdown request; sending follow-up work instead implicitly declines the request.`,
		parameters: sendMessageParameters as never,
		executionMode: "parallel",

		renderCall(args, theme) {
			const a = args as { name?: string; message?: string; shutdown?: boolean };
			const name = sanitizeTeammateName(a.name ?? "?");
			const session = sessions.get(name);
			const label = typeLabel(theme, `@${name}`, session?.color);
			if (a.shutdown === true) return new TruncatedText(`${theme.fg("toolTitle", theme.bold("send_message"))} ${label} ${theme.fg("warning", "shutdown")}`, 0, 0);
			const preview = (a.message ?? "").replace(/\s+/g, " ").trim();
			return new TruncatedText(`${theme.fg("toolTitle", theme.bold("send_message"))} ${label} ${theme.fg("dim", preview)}`, 0, 0);
		},

		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { name: string; message?: string; shutdown?: boolean };
			const name = sanitizeTeammateName(params.name);

			const session = sessions.get(name);
			if (session && session.kind === "sync") {
				// A synchronous subagent's result goes to its pending tool call;
				// the only meaningful interaction is answering its question.
				if (session.pendingUi && params.message?.trim()) {
					answerUiWithText(session, params.message, ctx);
					return { content: [{ type: "text", text: `Answer delivered to '${name}', which resumes its task. Its result arrives through the original agent tool call.` }], details: { name } };
				}
				throw new Error(`'${name}' is a synchronous subagent still working on its original tool call; it cannot be messaged${params.shutdown ? " or shut down here — abort the tool call instead" : ""}.`);
			}
			if (session) {
				if (params.shutdown === true) {
					destroySession(session, ctx);
					return { content: [{ type: "text", text: `'@${name}' shut down.` }], details: { name } };
				}
				if (!params.message?.trim()) throw new Error("message is required unless shutdown is true.");
				session.shutdownRequested = false; // follow-up work implicitly declines a pending request
				if (session.pendingUi) {
					answerUiWithText(session, params.message, ctx);
					return { content: [{ type: "text", text: `'@${name}' had a pending question; your message was delivered as the answer and its turn resumes. Its reply will arrive as a message.` }], details: { name } };
				}
				if (session.state === "working") {
					session.queue.push(params.message);
					updateWidget(ctx);
					return { content: [{ type: "text", text: `'@${name}' is mid-turn; message queued (position ${session.queue.length}). Its reply will arrive as a message.` }], details: { name, queued: true } };
				}
				if (!session.child.alive) {
					throw new Error(`'@${name}' has exited and can no longer be messaged.`);
				}
				runSessionTurn(session, params.message, ctx, makeReplyDeliver(session));
				return { content: [{ type: "text", text: `Message delivered to '@${name}'. Its reply will arrive as a message — continue with other work.` }], details: { name } };
			}

			const paneMate = [...teammates.values()].find((m) => m.name === name);
			if (paneMate) {
				if (params.shutdown === true) {
					paneMate.stopWatching();
					tmuxRun(["kill-pane", "-t", paneMate.paneId]);
					teammates.delete(paneMate.paneId);
					return { content: [{ type: "text", text: `Pane teammate '${name}' (${paneMate.paneId}) killed.` }], details: { name } };
				}
				if (!params.message?.trim()) throw new Error("message is required unless shutdown is true.");
				const typed = tmuxRun(["send-keys", "-t", paneMate.paneId, "-l", "--", params.message]);
				if (!typed.ok) throw new Error(`Failed to type into pane ${paneMate.paneId}: ${typed.err}`);
				tmuxRun(["send-keys", "-t", paneMate.paneId, "Enter"]);
				return { content: [{ type: "text", text: `Message typed into '${name}' (tmux pane ${paneMate.paneId}). Check the pane or wait for its report.` }], details: { name } };
			}

			const known = [...sessions.values()].filter((s) => s.kind !== "sync").map((s) => `@${s.name}`).concat([...teammates.values()].map((m) => m.name));
			throw new Error(`No agent named '@${name}'.${known.length ? ` Known agents: ${known.join(", ")}` : " No message-able agents are running."}`);
		},
	};
	pi.registerTool(sendMessageTool as never);

	// ─── Workflows: deterministic multi-agent orchestration scripts ───

	const WORKFLOW_RESULT_TYPE = "claude-subagent-workflow-result";
	const WORKFLOWS_DIR = path.join(os.homedir(), ".claude-subagent", "workflows");
	const WORKFLOW_AGENT_CAP = 50;

	interface WorkflowJournalEntry {
		key: string;
		value: unknown;
	}

	interface WorkflowRun {
		id: string;
		name: string;
		scriptPath: string;
		journalPath: string;
		state: "running" | "done" | "failed";
		phase?: string;
		agentsSpawned: number;
		cacheHits: number;
		tokens: number;
		/** Hard token ceiling for this run; agent() throws once exceeded. */
		budgetTotal?: number;
		startedAt: number;
		endedAt?: number;
		deadline: number;
		logs: string[];
		error?: string;
		/** Completed agent() results, persisted for resume. */
		journal: WorkflowJournalEntry[];
		/** Journal from the run being resumed; entries are consumed by key. */
		replay?: { entries: WorkflowJournalEntry[]; used: boolean[] };
	}

	/** Stable key for one agent() call: same prompt+opts → same key. */
	function workflowCallKey(prompt: string, opts: unknown): string {
		const s = JSON.stringify([prompt, opts ?? null]);
		let h = 5381;
		for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
		return h.toString(16);
	}

	/** Minimal JSON Schema check: type, required, properties, items. */
	function schemaErrors(value: unknown, schema: Record<string, unknown> | undefined, at = "$"): string[] {
		if (!schema) return [];
		const errs: string[] = [];
		const t = schema.type as string | undefined;
		const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
		if (t && t !== actual && !(t === "integer" && actual === "number" && Number.isInteger(value))) {
			return [`${at}: expected ${t}, got ${actual}`];
		}
		if (actual === "object") {
			const obj = value as Record<string, unknown>;
			for (const k of (schema.required as string[] | undefined) ?? []) {
				if (!(k in obj)) errs.push(`${at}: missing required key '${k}'`);
			}
			const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
			if (props) {
				for (const [k, sub] of Object.entries(props)) {
					if (k in obj) errs.push(...schemaErrors(obj[k], sub, `${at}.${k}`));
				}
			}
		} else if (actual === "array" && schema.items) {
			(value as unknown[]).forEach((item, i) =>
				errs.push(...schemaErrors(item, schema.items as Record<string, unknown>, `${at}[${i}]`)),
			);
		}
		return errs;
	}

	const workflowRuns = new Map<string, WorkflowRun>();
	let nextWorkflowId = 1;

	function updateWorkflowStatus(ctx: ExtensionContext): void {
		const active = [...workflowRuns.values()].filter((r) => r.state === "running");
		ctx.ui.setStatus(
			"workflows",
			active.length ? active.map((r) => `wf ${r.name}${r.phase ? ` · ${r.phase}` : ""}`).join(" | ") : undefined,
		);
	}

	function workflowLog(run: WorkflowRun, ctx: ExtensionContext, message: string): void {
		run.logs.push(`[${formatDuration(Date.now() - run.startedAt)}] ${message}`);
		if (run.logs.length > 200) run.logs.splice(0, run.logs.length - 200);
		updateWorkflowStatus(ctx);
	}

	/** Extract a JSON value from model text (tolerates fences and prose). */
	function extractJson(text: string): unknown {
		const cleaned = text.replace(/```(?:json)?/g, "").trim();
		try {
			return JSON.parse(cleaned);
		} catch {}
		const start = cleaned.search(/[[{]/);
		if (start === -1) throw new Error("no JSON found");
		const open = cleaned[start];
		const close = open === "{" ? "}" : "]";
		const end = cleaned.lastIndexOf(close);
		if (end <= start) throw new Error("no JSON found");
		return JSON.parse(cleaned.slice(start, end + 1));
	}

	/** Run one workflow agent to completion; returns final text, validated JSON (schema), or null. */
	async function runWorkflowAgent(
		run: WorkflowRun,
		ctx: ExtensionContext,
		acquire: () => Promise<() => void>,
		prompt: string,
		opts: { label?: string; agentType?: string; model?: string; schema?: Record<string, unknown>; phase?: string } = {},
	): Promise<unknown> {
		const key = workflowCallKey(prompt, {
			agentType: opts.agentType,
			model: opts.model,
			schema: opts.schema,
		});
		const recordAndReturn = (value: unknown) => {
			if (value !== null) {
				run.journal.push({ key, value });
				try {
					fs.writeFileSync(run.journalPath, JSON.stringify(run.journal));
				} catch {}
			}
			return value;
		};

		// Resume: an unconsumed journal entry with the same key replays instantly.
		if (run.replay) {
			const i = run.replay.entries.findIndex((e, idx) => !run.replay!.used[idx] && e.key === key);
			if (i !== -1) {
				run.replay.used[i] = true;
				run.cacheHits++;
				workflowLog(run, ctx, `agent ${opts.label ?? "agent"} ← cached (resume)`);
				return recordAndReturn(run.replay.entries[i].value);
			}
		}

		if (run.agentsSpawned >= WORKFLOW_AGENT_CAP) throw new Error(`workflow agent cap (${WORKFLOW_AGENT_CAP}) reached`);
		if (Date.now() > run.deadline) throw new Error("workflow timed out");
		if (run.budgetTotal && run.tokens >= run.budgetTotal) {
			throw new Error(`token budget exhausted (${run.tokens} >= ${run.budgetTotal})`);
		}
		run.agentsSpawned++;
		const release = await acquire();
		try {
			const available = discoverAgentTypes(cwd);
			const typeName = opts.agentType ?? "general-purpose";
			const agentType = available.get(typeName);
			if (!agentType) throw new Error(`unknown agentType '${typeName}'`);
			const label = opts.label ?? `agent-${run.agentsSpawned}`;
			const model = opts.model ?? agentType.model;
			let fullPrompt = prompt;
			if (opts.schema) {
				fullPrompt += `\n\nWhen the task is complete, call the structured_output tool exactly once, with its "result" argument set to a single JSON value matching this JSON Schema:\n${JSON.stringify(opts.schema)}\nDo not produce the result as plain text.`;
			} else {
				fullPrompt += `\n\nYour final message is consumed by an orchestration script, not a human — return the requested data directly.`;
			}

			const name = uniqueSessionName(`${run.id}-${label}`);
			const dir = makeSessionDir(SESSIONS_DIR, typeName);
			const promptPath = path.join(dir, "system-prompt.md");
			fs.writeFileSync(promptPath, assembleSystemPrompt(agentType, cwd, model), { mode: 0o600 });
			const session = createSession({
				kind: "background",
				name,
				agent: agentType,
				typeName,
				description: `${run.name}: ${label}`,
				model,
				sessionFile: path.join(dir, "session.jsonl"),
				promptPath,
				ctx,
				structuredOutput: Boolean(opts.schema),
			});
			workflowLog(run, ctx, `agent ${label} started`);

			const settle = (outcome: RunOutcome) => {
				run.tokens += outcome.usage.input + outcome.usage.output;
				const failed = Boolean(outcome.error && !outcome.finalText && outcome.structuredOutput === undefined);
				session.lastReply = outcome.finalText.trim() || (outcome.structuredOutput !== undefined ? JSON.stringify(outcome.structuredOutput, null, 2) : undefined);
				session.state = failed ? "failed" : "done";
				armReaper(session, ctx);
				updateWidget(ctx);
			};

			let outcome = await session.child.prompt(fullPrompt);
			settle(outcome);
			if (outcome.error && !outcome.finalText && outcome.structuredOutput === undefined) {
				workflowLog(run, ctx, `agent ${label} FAILED: ${outcome.error}`);
				return null;
			}
			if (!opts.schema) {
				workflowLog(run, ctx, `agent ${label} done`);
				return recordAndReturn(outcome.finalText.trim());
			}

			// Schema mode: prefer the structured_output tool call; fall back to
			// parsing the reply text; up to two repair round-trips on failure.
			for (let attempt = 0; ; attempt++) {
				let problem: string;
				try {
					const value = outcome.structuredOutput !== undefined ? outcome.structuredOutput : extractJson(outcome.finalText);
					const errs = schemaErrors(value, opts.schema);
					if (!errs.length) {
						workflowLog(run, ctx, `agent ${label} done (structured${outcome.structuredOutput !== undefined ? "" : ", from text"})`);
						return recordAndReturn(value);
					}
					problem = errs.slice(0, 5).join("; ");
				} catch (err) {
					problem = outcome.structuredOutput === undefined ? `no structured_output call and reply text is not JSON (${String(err)})` : String(err);
				}
				if (attempt >= 2 || !session.child.alive) {
					workflowLog(run, ctx, `agent ${label} failed schema validation: ${problem}`);
					return null;
				}
				workflowLog(run, ctx, `agent ${label} schema retry: ${problem}`);
				session.state = "working";
				updateWidget(ctx);
				outcome = await session.child.prompt(
					`Your result was not valid: ${problem}. Call the structured_output tool again with a corrected "result" that matches the schema exactly.`,
				);
				settle(outcome);
				if (outcome.error && !outcome.finalText && outcome.structuredOutput === undefined) return null;
			}
		} finally {
			release();
		}
	}

	async function executeWorkflow(
		run: WorkflowRun,
		script: string,
		args: unknown,
		maxConcurrency: number,
		ctx: ExtensionContext,
	): Promise<unknown> {
		// Simple semaphore — local model servers can't take a big fan-out.
		let inFlight = 0;
		const waiters: Array<() => void> = [];
		const acquire = (): Promise<() => void> => {
			const release = () => {
				inFlight--;
				waiters.shift()?.();
			};
			if (inFlight < maxConcurrency) {
				inFlight++;
				return Promise.resolve(release);
			}
			return new Promise((resolve) => {
				waiters.push(() => {
					inFlight++;
					resolve(release);
				});
			});
		};

		const sandbox = {
			args,
			agent: (prompt: string, opts?: Record<string, unknown>) => runWorkflowAgent(run, ctx, acquire, prompt, opts as never),
			parallel: (thunks: Array<() => Promise<unknown>>) =>
				Promise.all(thunks.map((t) => Promise.resolve().then(t).catch((err) => {
					workflowLog(run, ctx, `parallel task error: ${String(err)}`);
					return null;
				}))),
			pipeline: (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>) =>
				Promise.all(
					items.map(async (item, index) => {
						let current: unknown = item;
						for (const stage of stages) {
							try {
								current = await stage(current, item, index);
							} catch (err) {
								workflowLog(run, ctx, `pipeline item ${index} error: ${String(err)}`);
								return null;
							}
						}
						return current;
					}),
				),
			phase: (title: string) => {
				run.phase = title;
				workflowLog(run, ctx, `── phase: ${title}`);
			},
			log: (message: string) => workflowLog(run, ctx, String(message)),
			budget: {
				total: run.budgetTotal ?? null,
				spent: () => run.tokens,
				remaining: () => (run.budgetTotal ? Math.max(0, run.budgetTotal - run.tokens) : Infinity),
			},
			console: { log: (...parts: unknown[]) => workflowLog(run, ctx, parts.map(String).join(" ")) },
		};

		const body = script.replace(/^\s*export\s+/gm, "");
		const context = vm.createContext(sandbox);
		const wrapped = new vm.Script(`(async () => {\n${body}\n})()`, { filename: run.scriptPath });
		const timeLeft = () => Math.max(1000, run.deadline - Date.now());
		return await Promise.race([
			wrapped.runInContext(context) as Promise<unknown>,
			new Promise((_, reject) => setTimeout(() => reject(new Error("workflow timed out")), timeLeft()).unref?.()),
		]);
	}

	const workflowTool: ToolDefinition<never, unknown> = {
		name: "workflow",
		label: "Workflow",
		description: `Execute a JavaScript orchestration script that coordinates multiple subagents deterministically. Runs in the background — returns immediately with a run ID; the script's return value is delivered as a message when it completes. Use /workflows to watch progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent checks before committing), or for scale one context can't hold. Use it when the user asks for orchestration or the task is genuinely that scale; for a single lookup or one subtask, use the agent tool instead. The right move is often hybrid: scout inline first to discover the work-list, then pipeline over it.

The script body runs in an async context (top-level await and return work). Available globals:
- agent(prompt, opts?): Promise<string|object|null> — spawn a subagent and await its final reply. opts: {label, agentType, model, schema, phase}. With schema (a JSON Schema object), the subagent is forced to call a structured_output tool and agent() returns the validated value (with repair retries); returns null on agent failure or unrepairable output — filter with .filter(Boolean).
- pipeline(items, ...stages): run each item through stages independently, NO barrier between stages — item A can be in stage 3 while item B is still in stage 1. THIS IS THE DEFAULT for multi-stage work. Stages receive (prev, originalItem, index). A stage that throws drops that item to null.
- parallel(thunks): run tasks concurrently. This is a BARRIER: it awaits all thunks. A barrier is correct ONLY when the next step needs cross-item context from ALL results (dedup across the full set, early-exit on zero count). "I need to flatten/filter first" is not a reason — do it inside a pipeline stage.
- phase(title), log(message): progress reporting (visible in /workflows).
- args: the value passed as the tool's args parameter.
- budget: {total, spent(), remaining()} — token ceiling from the token_budget parameter; agent() throws once exceeded. Guard loops: while (budget.total && budget.remaining() > 20000) {...}

Concurrency is capped (default 3 — local model servers are small); excess agent() calls queue. Lifetime cap of ${WORKFLOW_AGENT_CAP} agents per run. Prefer a few well-prompted agents over a large fan-out, and scale to what the user asked for: "find any bugs" → a few finders with a single verify pass; "thoroughly audit" → bigger pool plus adversarial verification.

Quality patterns: adversarial verify (N skeptics per finding, each prompted to REFUTE; majority kills it); diverse-lens verify (each verifier gets a different lens — correctness, security, repro); judge panel (N independent attempts, judges score, synthesize from the winner); loop-until-dry (keep spawning finders until 2 consecutive rounds find nothing new — dedup against everything SEEN, not just confirmed); completeness critic (final agent asks "what's missing?"). If the script bounds coverage (top-N, sampling), log() what was dropped.

The canonical multi-stage shape — each dimension verifies as soon as its review completes, no waiting:
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: "review:" + d.key, schema: FINDINGS}),
    review => parallel(review.findings.map(f => () =>
      agent("Adversarially verify, default to refuted if uncertain: " + f.title, {schema: VERDICT})
        .then(v => ({...f, verdict: v}))))
  )
  return results.flat().filter(Boolean).filter(f => f.verdict && f.verdict.isReal)

Resume: pass resume_from_run_id with a prior run ID — agent() calls whose prompt+opts are unchanged return their recorded results instantly; only new or edited calls run live. Avoid timestamps/randomness in prompts or cache hits become misses.`,
		parameters: {
			type: "object",
			properties: {
				script: {
					type: "string",
					description: "The workflow script (JavaScript, async context). May start with `export const meta = {name, description}`.",
				},
				args: { description: "Optional value exposed to the script as the global `args`." },
				max_concurrency: {
					type: "number",
					description: "Max agents running at once (default 3, max 6).",
				},
				timeout_minutes: {
					type: "number",
					description: "Abort the run after this many minutes (default 30, max 120).",
				},
				token_budget: {
					type: "number",
					description: "Optional hard token ceiling for the run; agent() throws once spent. Exposed to the script as budget.",
				},
				resume_from_run_id: {
					type: "string",
					description: "Run ID of a prior workflow to resume: unchanged agent() calls replay their recorded results instantly.",
				},
			},
			required: ["script"],
			additionalProperties: false,
		} as never,
		executionMode: "parallel",

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as unknown as {
				script: string;
				args?: unknown;
				max_concurrency?: number;
				timeout_minutes?: number;
				token_budget?: number;
				resume_from_run_id?: string;
			};
			const id = `wf_${nextWorkflowId++}`;
			const name = /name:\s*["']([\w-]+)["']/.exec(params.script)?.[1] ?? id;
			fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
			const scriptPath = path.join(WORKFLOWS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.mjs`);
			fs.writeFileSync(scriptPath, params.script);
			const timeoutMs = Math.min(Math.max(params.timeout_minutes ?? 30, 1), 120) * 60_000;

			let replay: WorkflowRun["replay"];
			let resumeNote = "";
			if (params.resume_from_run_id) {
				const prior = workflowRuns.get(params.resume_from_run_id);
				let entries = prior?.journal;
				if (!entries?.length && prior?.journalPath) {
					try {
						entries = JSON.parse(fs.readFileSync(prior.journalPath, "utf-8")) as WorkflowJournalEntry[];
					} catch {}
				}
				if (entries?.length) {
					replay = { entries, used: entries.map(() => false) };
					resumeNote = ` Resuming from ${params.resume_from_run_id}: ${entries.length} recorded agent results will replay where calls are unchanged.`;
				} else {
					resumeNote = ` (resume_from_run_id ${params.resume_from_run_id} has no journal — running fresh.)`;
				}
			}

			const run: WorkflowRun = {
				id,
				name,
				scriptPath,
				journalPath: `${scriptPath}.journal.json`,
				state: "running",
				agentsSpawned: 0,
				cacheHits: 0,
				tokens: 0,
				budgetTotal: params.token_budget,
				startedAt: Date.now(),
				deadline: Date.now() + timeoutMs,
				logs: [],
				journal: [],
				replay,
			};
			workflowRuns.set(id, run);
			updateWorkflowStatus(ctx);
			const concurrency = Math.min(Math.max(params.max_concurrency ?? 3, 1), 6);

			void executeWorkflow(run, params.script, params.args, concurrency, ctx)
				.then((result) => {
					run.state = "done";
					run.endedAt = Date.now();
					const rendered = typeof result === "string" ? result : JSON.stringify(result, null, 2);
					const clipped = (rendered ?? "(no return value)").slice(0, 8000);
					const cacheNote = run.cacheHits ? ` (+${run.cacheHits} replayed from ${params.resume_from_run_id})` : "";
					pi.sendMessage(
						{
							customType: WORKFLOW_RESULT_TYPE,
							content: `Workflow ${run.name} (${id}) completed in ${formatDuration(run.endedAt - run.startedAt)} — ${run.agentsSpawned} agents${cacheNote}, ${formatTokens(run.tokens)} tokens. Resume with resume_from_run_id "${id}" to rerun with edits.\n\nReturn value:\n${clipped}`,
							display: true,
							details: { id, name: run.name, ok: true, scriptPath },
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				})
				.catch((err) => {
					run.state = "failed";
					run.endedAt = Date.now();
					run.error = String(err);
					pi.sendMessage(
						{
							customType: WORKFLOW_RESULT_TYPE,
							content: `Workflow ${run.name} (${id}) FAILED after ${formatDuration(run.endedAt - run.startedAt)}: ${run.error}\n\nRecent log:\n${run.logs.slice(-10).join("\n")}`,
							display: true,
							details: { id, name: run.name, ok: false, scriptPath },
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				})
				.finally(() => updateWorkflowStatus(ctx));

			return {
				content: [
					{
						type: "text",
						text: `Workflow ${run.name} started with run ID ${id} (script saved to ${scriptPath}).${resumeNote} It runs in the background — the return value will arrive as a message when it completes. Continue with other work or end your turn; use /workflows to watch progress.`,
					},
				],
				details: { id, name: run.name, scriptPath },
			};
		},
	};
	pi.registerTool(workflowTool as never);

	pi.registerCommand("workflows", {
		description: "Show workflow runs and their progress",
		handler: async (_args, ctx) => {
			if (workflowRuns.size === 0) {
				ctx.ui.notify("No workflow runs in this session.", "info");
				return;
			}
			const sections = [...workflowRuns.values()].map((r) => {
				const dur = formatDuration((r.endedAt ?? Date.now()) - r.startedAt);
				const head = `## ${r.name} (${r.id}) — ${r.state}${r.phase ? ` · ${r.phase}` : ""} · ${r.agentsSpawned} agents · ${dur}`;
				const err = r.error ? `\n**Error:** ${r.error}` : "";
				return `${head}${err}\n\n${r.logs.slice(-30).map((l) => `- ${l}`).join("\n") || "(no log yet)"}`;
			});
			await showMarkdownPager(ctx, "Workflow runs", `# Workflow runs\n\n${sections.join("\n\n")}`);
		},
	});

	/** Open a child session transcript in a tmux split, or tell the user how. */
	function openSessionPane(ui: ExtensionContext["ui"], sessionFile: string): void {
		if (!fs.existsSync(sessionFile)) {
			ui.notify("No transcript yet — the child hasn't produced a message", "warning");
			return;
		}
		if (insideTmux()) {
			const target = tmuxTarget();
			const split = tmuxRun([
				"split-window", "-h", "-P", "-F", "#{pane_id}",
				"-e", `${CHILD_ENV}=1`,
				...(target ? ["-t", target] : []),
				`pi --session ${shellQuote(sessionFile)}`,
			]);
			if (split.ok) {
				ui.notify(`Opened session in pane ${split.out}`, "info");
				return;
			}
		}
		ui.notify(`View with: pi --session ${shortenPath(sessionFile)}`, "info");
	}

	/** Interactively answer a session's pending ask_user question. */
	async function answerPendingUi(session: AgentSession, ctx: ExtensionContext): Promise<void> {
		const req = session.pendingUi;
		if (!req) {
			ctx.ui.notify("The question was already answered", "info");
			return;
		}
		let payload: UiResponsePayload | undefined;
		if (req.method === "select" && req.options?.length) {
			const choice = await ctx.ui.select(`${sessionLabel(session)}: ${req.title}`, req.options);
			if (choice === undefined) return;
			payload = { value: choice };
		} else if (req.method === "confirm") {
			payload = { confirmed: await ctx.ui.confirm(sessionLabel(session), req.message ?? req.title) };
		} else {
			const answer = await ctx.ui.input(`${sessionLabel(session)}: ${req.title}`, "answer for the subagent");
			if (answer === undefined || !answer.trim()) return;
			payload = { value: answer };
		}
		if (session.pendingUi?.id !== req.id) return; // answered meanwhile (e.g. via send_message)
		session.pendingUi = undefined;
		session.state = "working";
		session.child.respondUi(req.id, payload);
		updateWidget(ctx);
	}

	/** Render a child session transcript as readable text (skips thinking blocks). */
	function formatTranscript(sessionFile: string): string | undefined {
		let raw: string;
		try {
			raw = fs.readFileSync(sessionFile, "utf-8");
		} catch {
			return undefined;
		}
		const out: string[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let entry: { type?: string; message?: { role?: string; toolName?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || !entry.message) continue;
			const m = entry.message;
			if (m.role === "user") {
				out.push("## user", extractText(m.content).trim() || "(empty)", "");
			} else if (m.role === "assistant") {
				const parts: string[] = [];
				if (Array.isArray(m.content)) {
					for (const b of m.content as Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>) {
						if (b.type === "text" && b.text?.trim()) parts.push(b.text.trim());
						else if (b.type === "toolCall") parts.push(`[tool: ${b.name ?? "?"} ${JSON.stringify(b.arguments ?? {}).slice(0, 120)}]`);
					}
				}
				out.push("## assistant", parts.join("\n") || "(thinking only)", "");
			} else if (m.role === "toolResult") {
				const text = extractText(m.content).trim();
				const lines = text.split("\n");
				const shown = lines.slice(0, 10).join("\n");
				out.push(`## result: ${m.toolName ?? "tool"}`, shown + (lines.length > 10 ? `\n… (${lines.length - 10} more lines)` : ""), "");
			}
		}
		return out.length ? out.join("\n") : undefined;
	}

	/** Scrollable rendered-markdown pager overlay (↑/↓, pgup/pgdn, g/G, esc). */
	async function showMarkdownPager(ctx: ExtensionContext, title: string, markdown: string): Promise<void> {
		await ctx.ui.custom<void>(
			(tui, _thm, _keybindings, done) => {
				const md = new Markdown(markdown, 1, 0, getMarkdownTheme());
				let offset = 0;
				let view = 20;
				const pad = (line: string, width: number) => {
					const t = truncateToWidth(line, width);
					return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
				};
				return {
					render(width: number): string[] {
						const thm = ctx.ui.theme;
						const body = md.render(width);
						view = Math.max(6, Math.floor((tui.terminal.rows || 30) * 0.8) - 5);
						offset = Math.max(0, Math.min(offset, body.length - view));
						const slice = body.slice(offset, offset + view).map((l) => pad(l, width));
						const head = thm.fg("accent", pad(` ${title}`, width));
						const above =
							offset > 0
								? thm.fg("muted", pad(`─── ↑ ${offset} more ───`, width))
								: thm.fg("muted", "─".repeat(width));
						const rest = body.length - offset - view;
						const below =
							rest > 0
								? thm.fg("muted", pad(`─── ↓ ${rest} more ───`, width))
								: thm.fg("muted", "─".repeat(width));
						const hint = thm.fg("muted", pad(" ↑/↓ scroll · pgup/pgdn · g/G top/bottom · esc close", width));
						return [head, above, ...slice, below, hint];
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || data === "q") {
							done(undefined);
							return;
						}
						if (matchesKey(data, "up")) offset -= 1;
						else if (matchesKey(data, "down")) offset += 1;
						else if (matchesKey(data, "pageUp")) offset -= view;
						else if (matchesKey(data, "pageDown")) offset += view;
						else if (matchesKey(data, "home") || data === "g") offset = 0;
						else if (matchesKey(data, "end") || data === "G") offset = Number.MAX_SAFE_INTEGER;
						offset = Math.max(0, offset);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "85%", maxHeight: "85%" } },
		);
	}

	/**
	 * Live transcript viewer — a rendered-markdown overlay that follows the
	 * child's conversation as it grows (re-reads the session file once a
	 * second while open). Scrolling up pauses the follow; f/G/end resume it.
	 * `x x` stops the agent without leaving the viewer. No tmux needed.
	 */
	async function viewTranscript(session: AgentSession, ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom<void>(
			(tui, _thm, _keybindings, done) => {
				let text = formatTranscript(session.sessionFile) ?? "*(no messages yet)*";
				let md = new Markdown(text, 1, 0, getMarkdownTheme());
				let offset = 0;
				let view = 20;
				let follow = true;
				let confirmStop = false;
				const refresh = setInterval(() => {
					const next = formatTranscript(session.sessionFile) ?? "*(no messages yet)*";
					if (next !== text) {
						text = next;
						md = new Markdown(text, 1, 0, getMarkdownTheme());
						tui.requestRender();
					} else if (session.state === "working" || session.state === "needs-input") {
						tui.requestRender(); // keep the header spinner/stats fresh
					}
				}, TRANSCRIPT_REFRESH_MS);
				refresh.unref?.();
				const close = () => {
					clearInterval(refresh);
					done(undefined);
				};
				const pad = (line: string, width: number) => {
					const t = truncateToWidth(line, width);
					return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
				};
				const stopAgent = () => {
					const live = session.state === "working" || session.state === "needs-input" || (session.kind !== "sync" && session.child.alive);
					if (!live) {
						ctx.ui.notify("Agent already finished", "info");
						return;
					}
					if (session.kind === "sync") {
						// The pending agent tool call owns cleanup; killing the
						// child settles it with an abort error.
						session.child.kill("Aborted by the user via the transcript viewer.");
					} else {
						destroySession(session, ctx);
					}
				};
				return {
					render(width: number): string[] {
						const thm = ctx.ui.theme;
						const body = md.render(width);
						view = Math.max(6, Math.floor((tui.terminal.rows || 30) * 0.8) - 5);
						const bottom = Math.max(0, body.length - view);
						if (follow) offset = bottom;
						offset = Math.max(0, Math.min(offset, bottom));
						const slice = body.slice(offset, offset + view).map((l) => pad(l, width));
						const running = session.state === "working" || session.state === "needs-input";
						const glyph = running ? spinnerFrame(clockSpinner()) : session.state === "failed" ? "✗" : "●";
						const stats = ` · ${session.child.toolCount} tool use${session.child.toolCount === 1 ? "" : "s"} · ${formatTokens(session.child.tokens)} tokens · ${formatDuration(Date.now() - session.startedAt)}`;
						const followNote = follow ? "" : " · paused";
						const head = thm.fg("accent", pad(` ${glyph} ${sessionLabel(session)} — ${session.state}${stats}${followNote}`, width));
						const above =
							offset > 0
								? thm.fg("muted", pad(`─── ↑ ${offset} more ───`, width))
								: thm.fg("muted", "─".repeat(width));
						const rest = body.length - offset - view;
						const below =
							rest > 0
								? thm.fg("muted", pad(`─── ↓ ${rest} more ───`, width))
								: thm.fg("muted", "─".repeat(width));
						const hint = confirmStop
							? thm.fg("warning", pad(" press x again to stop the agent — any other key cancels", width))
							: thm.fg("muted", pad(" ↑/↓ scroll (pauses follow) · f/G follow · x stop agent · esc close", width));
						return [head, above, ...slice, below, hint];
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || data === "q") {
							close();
							return;
						}
						if (data === "x") {
							if (confirmStop) {
								confirmStop = false;
								stopAgent();
							} else {
								confirmStop = true;
							}
							tui.requestRender();
							return;
						}
						confirmStop = false;
						if (matchesKey(data, "up")) {
							follow = false;
							offset -= 1;
						} else if (matchesKey(data, "down")) offset += 1;
						else if (matchesKey(data, "pageUp")) {
							follow = false;
							offset -= view;
						} else if (matchesKey(data, "pageDown")) offset += view;
						else if (matchesKey(data, "home") || data === "g") {
							follow = false;
							offset = 0;
						} else if (matchesKey(data, "end") || data === "G" || data === "f") follow = true;
						offset = Math.max(0, offset);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "85%", maxHeight: "85%" } },
		);
	}

	/** Show a session's recent activity and last reply without attaching. */
	async function peekSession(session: AgentSession, ctx: ExtensionContext): Promise<void> {
		const lines = [
			`# ${sessionLabel(session)} — ${session.agentType}${session.model ? ` (${session.model})` : ""}`,
			`task: ${session.description}`,
			`state: ${session.state}${session.pendingUi ? ` — ${session.pendingUi.title}` : ""}`,
			`running: ${formatDuration(Date.now() - session.startedAt)} · ${session.child.toolCount} tool use${session.child.toolCount === 1 ? "" : "s"} · ${formatTokens(session.child.tokens)} tokens`,
			`session: ${shortenPath(session.sessionFile)}`,
			"",
			"## Recent tools",
			...(session.child.recentTools.length ? session.child.recentTools.map((t) => `- ${t}`) : ["(none yet)"]),
			"",
			"## Last reply",
			session.lastReply ?? "(no reply yet)",
		];
		await showMarkdownPager(ctx, `Peek: ${sessionLabel(session)}`, lines.join("\n"));
	}

	/** Dispatch a user-initiated background agent (from /dispatch or the manager). */
	async function dispatchAgent(ctx: ExtensionContext, promptArg?: string): Promise<void> {
		const ui = ctx.ui;
		const available = discoverAgentTypes(cwd);
		let prompt = (promptArg ?? "").trim();
		let typeName: string | undefined;
		// Agent-view-style first-word match: "/dispatch Explore where is auth handled"
		if (prompt) {
			const firstWord = prompt.split(/\s+/, 1)[0]!;
			if (available.has(firstWord)) {
				const rest = prompt.slice(firstWord.length).trim();
				if (rest) {
					typeName = firstWord;
					prompt = rest;
				}
			}
		}
		if (!prompt) {
			const typed = await ui.input("Dispatch background agent", "describe the task");
			if (!typed?.trim()) return;
			prompt = typed.trim();
		}
		if (!typeName) {
			const names = [...available.keys()].sort((a, b) => (a === "general-purpose" ? -1 : b === "general-purpose" ? 1 : a.localeCompare(b)));
			typeName = await ui.select("Agent type", names);
			if (!typeName) return;
		}
		const agent = available.get(typeName);
		if (!agent) return;
		const description = prompt.split(/\s+/).slice(0, 6).join(" ").slice(0, 48);
		const session = spawnBackgroundSession(agent, typeName, description, prompt, agent.model, ctx);
		ui.notify(`Dispatched '${session.name}' (${typeName}) — its report will arrive as a message`, "info");
	}

	async function openAgentManager(ctx: ExtensionContext, killAllDirectly = false): Promise<void> {
		const ui = ctx.ui;
		pruneDeadTeammates();
		const roster = sortedSessions();
		const paneMates = [...teammates.values()];

		interface Entry {
			label: string;
			actions: Array<{ label: string; run: () => void | Promise<void> }>;
			kill: () => void;
		}
		const entries: Entry[] = [
			...roster.map((session): Entry => {
				const kill = () => {
					if (session.kind === "sync") {
						// The pending agent tool call owns cleanup; killing the
						// child settles it with an abort error.
						session.child.kill("Aborted by the user via the agent manager.");
					} else {
						destroySession(session, ctx);
					}
				};
				const stateText = session.state === "needs-input" ? `needs input: ${session.pendingUi?.title ?? "question"}` : session.state;
				return {
					label: `${sessionLabel(session)} (${session.description}) · ${stateText} · ${formatDuration(Date.now() - session.startedAt)}`,
					kill,
					actions: [
						...(session.pendingUi ? [{ label: "Answer question", run: () => answerPendingUi(session, ctx) }] : []),
						...(session.shutdownRequested ? [{ label: "Approve shutdown", run: kill }] : []),
						{ label: "Peek", run: () => peekSession(session, ctx) },
						...(session.kind !== "sync"
							? [
									{
										label: "Send message",
										run: async () => {
											const message = await ui.input(`Message ${sessionLabel(session)}`, "type a message for the agent");
											if (!message?.trim()) return;
											session.shutdownRequested = false;
											if (session.pendingUi) {
												answerUiWithText(session, message, ctx);
												ui.notify(`Answered ${sessionLabel(session)}'s question`, "info");
											} else if (session.state === "working") {
												session.queue.push(message);
												ui.notify(`Queued for ${sessionLabel(session)}`, "info");
											} else if (session.child.alive) {
												runSessionTurn(session, message, ctx, makeReplyDeliver(session));
												ui.notify(`Sent to ${sessionLabel(session)} — reply arrives as a message`, "info");
											} else {
												ui.notify(`${sessionLabel(session)} has exited`, "warning");
											}
											updateWidget(ctx);
										},
									},
									{
										label: "Rename",
										run: async () => {
											const v = await ui.input(`Rename ${sessionLabel(session)}`, session.description);
											if (v?.trim()) {
												session.description = v.trim();
												updateWidget(ctx);
											}
										},
									},
								]
							: []),
						{ label: "Watch transcript (live)", run: () => viewTranscript(session, ctx) },
						...(insideTmux() ? [{ label: "Open transcript in tmux pane", run: () => openSessionPane(ui, session.sessionFile) }] : []),
						{ label: session.kind === "sync" ? "Kill" : "Shut down", run: kill },
					],
				};
			}),
			...paneMates.map((mate): Entry => {
				const kill = () => {
					mate.stopWatching();
					tmuxRun(["kill-pane", "-t", mate.paneId]);
					teammates.delete(mate.paneId);
				};
				return {
					label: `pane ${mate.paneId}: ${mate.name} (${mate.description}) · ${formatDuration(Date.now() - mate.startedAt)}${mate.reportDelivered ? " · reported" : ""}`,
					kill,
					actions: [
						{
							label: "Focus pane",
							run: () => {
								const focus = tmuxRun(["select-pane", "-t", mate.paneId]);
								if (!focus.ok) ui.notify(`Pane ${mate.paneId} not focusable: ${focus.err}`, "warning");
							},
						},
						{
							label: "Send message",
							run: async () => {
								const message = await ui.input(`Message ${mate.name} (pane ${mate.paneId})`, "typed into the pane");
								if (!message?.trim()) return;
								tmuxRun(["send-keys", "-t", mate.paneId, "-l", "--", message]);
								tmuxRun(["send-keys", "-t", mate.paneId, "Enter"]);
								ui.notify(`Typed into pane ${mate.paneId}`, "info");
							},
						},
						{ label: "Kill pane", run: kill },
					],
				};
			}),
		];

		const killEverything = () => {
			for (const entry of entries) entry.kill();
			ui.notify(`Killed ${entries.length} agent${entries.length === 1 ? "" : "s"}`, "warning");
		};
		if (killAllDirectly) {
			if (entries.length === 0) ui.notify("No agents running", "info");
			else killEverything();
			return;
		}

		const dispatch = "Dispatch new agent…";
		const killAll = "Kill all";
		const close = "Close";
		const labels = entries.map((entry) => entry.label);
		const menu = entries.length > 0 ? [dispatch, ...labels, killAll, close] : [dispatch, close];
		const choice = await ui.select(`Agents (${entries.length})`, menu);
		if (!choice || choice === close) return;
		if (choice === dispatch) {
			await dispatchAgent(ctx);
			return;
		}
		if (choice === killAll) {
			killEverything();
			return;
		}
		const entry = entries[labels.indexOf(choice)];
		if (!entry) return;
		const actionLabels = entry.actions.map((a) => a.label);
		const action = await ui.select(entry.label, [...actionLabels, "Back"]);
		if (!action || action === "Back") return;
		const picked = entry.actions.find((a) => a.label === action);
		if (picked) {
			await picked.run();
			if (action === "Kill" || action === "Kill pane" || action === "Shut down" || action === "Approve shutdown") {
				ui.notify(`Done: ${action} — ${entry.label}`, "warning");
			}
		}
	}

	pi.registerCommand("agents", {
		description: "Manage running agents: answer questions, peek, message, dispatch, kill",
		async handler(args, ctx) {
			const trimmed = args.trim().toLowerCase();
			await openAgentManager(ctx, trimmed === "kill all" || trimmed === "killall");
		},
	});

	pi.registerCommand("dispatch", {
		description: "Dispatch a background agent: /dispatch [agent-type] <task>",
		async handler(args, ctx) {
			await dispatchAgent(ctx, args);
		},
	});

	pi.registerShortcut("alt+a", {
		description: "Open the agent manager",
		handler: (ctx) => openAgentManager(ctx),
	});

	interface ResultMessageDetails {
		agentType: string;
		description: string;
		color?: string;
		toolCount: number;
		tokens: number;
		durationMs: number;
		ok: boolean;
		cancelled: boolean;
		sessionFile?: string;
	}

	pi.registerMessageRenderer<ResultMessageDetails>(RESULT_MESSAGE_TYPE, (message, options, theme) => {
		const d = message.details;
		if (!d) return undefined; // fall back to default custom-message rendering
		const text = typeof message.content === "string" ? message.content : extractText(message.content);
		const glyph = d.cancelled ? theme.fg("warning", "■") : d.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const suffix = `${statsSuffix(theme, d.toolCount, d.tokens)}${theme.fg("dim", ` · ${formatDuration(d.durationMs)} · background`)}`;
		const c = new Container();
		c.addChild(new TruncatedText(agentHeader(theme, glyph, d.agentType, d.color, d.description, suffix), 0, 0));
		// Body: skip the headline paragraph (everything before the first blank
		// line) — the header row above already carries that information.
		const paragraphBreak = text.indexOf("\n\n");
		const body = (paragraphBreak === -1 ? (d.ok ? "" : text) : text.slice(paragraphBreak + 2)).trim();
		if (body) {
			const lines = body.split("\n");
			const shown = options.expanded ? lines : lines.filter((l) => l.trim()).slice(0, 3);
			for (const line of shown) {
				c.addChild(new TruncatedText(`   ${d.ok || d.cancelled ? theme.fg("dim", line) : theme.fg("error", line)}`, 0, 0));
			}
			if (!options.expanded && lines.length > shown.length) {
				c.addChild(new TruncatedText(theme.fg("dim", `   … ${lines.length - shown.length} more lines (ctrl+o expands)`), 0, 0));
			}
		}
		if (d.sessionFile && (options.expanded || !d.ok)) {
			c.addChild(sessionLink(theme, d.sessionFile));
		}
		return c;
	});

	interface TeammateMessageDetails {
		name: string;
		agentType: string;
		description: string;
		color?: string;
		toolCount: number;
		tokens: number;
		durationMs: number;
		failed: boolean;
		requestsShutdown?: boolean;
	}

	pi.registerMessageRenderer<TeammateMessageDetails>(TEAMMATE_MESSAGE_TYPE, (message, options, theme) => {
		const d = message.details;
		if (!d) return undefined;
		const text = typeof message.content === "string" ? message.content : extractText(message.content);
		const glyph = d.failed ? theme.fg("error", "✗") : theme.fg("accent", "●");
		const shutdownBadge = d.requestsShutdown ? theme.fg("warning", " · requests shutdown") : "";
		const suffix = `${statsSuffix(theme, d.toolCount, d.tokens)}${theme.fg("dim", ` · ${formatDuration(d.durationMs)}`)}${shutdownBadge}`;
		const c = new Container();
		c.addChild(new TruncatedText(`${glyph} ${typeLabel(theme, `@${d.name}`, d.color)} ${theme.fg("dim", `(${d.agentType})`)}${suffix}`, 0, 0));
		const paragraphBreak = text.indexOf("\n\n");
		const body = (paragraphBreak === -1 ? text : text.slice(paragraphBreak + 2)).trim();
		if (body) {
			const lines = body.split("\n");
			const shown = options.expanded ? lines : lines.filter((l) => l.trim()).slice(0, 6);
			for (const line of shown) {
				c.addChild(new TruncatedText(`   ${d.failed ? theme.fg("error", line) : line}`, 0, 0));
			}
			if (!options.expanded && lines.length > shown.length) {
				c.addChild(new TruncatedText(theme.fg("dim", `   … ${lines.length - shown.length} more lines (ctrl+o expands)`), 0, 0));
			}
		}
		return c;
	});
}
