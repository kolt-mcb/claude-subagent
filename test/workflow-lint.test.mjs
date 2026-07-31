// lintWorkflowScript must catch the failures that waste a whole run — a
// script that cannot compile, or one that references a name it never bound —
// without blocking the shapes the tool description actively recommends.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { evalSlice, suite } from "./harness.mjs";

const { lintWorkflowScript: lint } = evalSlice({
	from: "const WORKFLOW_SANDBOX_GLOBALS",
	to: "/** Stable key for one agent() call",
	expose: ["lintWorkflowScript"],
	context: { vm },
});

const t = suite("workflow script pre-flight lint");

const CANONICAL = `export const meta = { name: "review", description: "d" };
const FINDINGS = { type: "object" };
const VERDICT = { type: "object" };
const DIMENSIONS = [{ key: "bugs", prompt: "p" }];
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: "review:" + d.key, schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent("Verify: " + f.title, { schema: VERDICT }).then(v => ({ ...f, verdict: v }))))
);
return results.flat().filter(Boolean).filter(f => f.verdict && f.verdict.isReal);`;

const NESTED_TEMPLATES = `const rows = [{ id: "a", gb: 1, quality: 9 }];
const MAX_GB = 95;
log(\`\${rows.length} models fit within \${MAX_GB} GB\`);
const brief = \`Ranked:
\${rows.map((r, i) => \`\${i + 1}. \${r.id} | \${r.gb} GB | quality \${r.quality}/10 | notes: \${(r.notes || []).join(", ") || "none"}\`).join("\\n")}\`;
return await agent(brief, { schema: { type: "object" } });`;

const MULTI_DECLARATOR = `function key(b) { return b.file + ":" + b.line; }
const FINDERS = [{ prompt: "p1" }, { prompt: "p2" }];
const seen = new Set(), confirmed = [];
let dry = 0;
while (dry < 2) {
  const found = (await parallel(FINDERS.map(f => () => agent(f.prompt, { schema: { type: "object" } }))))
    .filter(Boolean).flatMap(r => r.bugs);
  const fresh = found.filter(b => !seen.has(key(b)));
  if (!fresh.length) { dry++; continue; }
  dry = 0;
  fresh.forEach(b => seen.add(key(b)));
  confirmed.push(...fresh);
}
return confirmed;`;

// The script from session 019fa9a4: six serial agents, then console.log(LANG)
// against a variable bound as REC. Every agent ran before it threw.
const SESSION_019FA9A4 = `export const meta = { name: "Codebase Review", description: "Comprehensive review" };
const LANG_SPEC = \`/spec.md\`;
const REC = await agent(\`Review the spec at \${LANG_SPEC}\`);
const LEX_REVIEW = await agent(\`Review the lexer\`);
const PARSE_REVIEW = await agent(\`Review the parser\`);
const CODEGEN_REVIEW = await agent(\`Review the codegen\`);
console.log("=== Language Design Analysis ===");
console.log(LANG);
console.log(LEX_REVIEW);`;

// Escapes inside a regex literal are not identifiers. An early version read
// the \s and \S in /\{[\s\S]*\}/ as undeclared names and blocked two real
// workflow runs.
const REGEX_LITERALS = `const reviews = await parallel([() => agent("go", { schema: { type: "object" } })]);
let parsed = {};
for (const review of reviews) {
  if (typeof review === "string") {
    const jsonStr = review.match(/\\{[\\s\\S]*\\}/);
    if (jsonStr) parsed = JSON.parse(jsonStr[0]);
  }
}
const slug = String(parsed.title || "").replace(/[^\\w-]+/g, "-").split(/\\s*,\\s*/);
const ratio = reviews.length / 2 / 1;
return { parsed, slug, ratio };`;

for (const [label, script] of [
	["canonical pipeline shape from the tool description", CANONICAL],
	["nested template literals with prose between interpolations", NESTED_TEMPLATES],
	["multi-declarator const and a helper function", MULTI_DECLARATOR],
	["regex literals with class escapes, plus division", REGEX_LITERALS],
]) {
	const r = lint(script, "/tmp/t.mjs");
	t.check(r.errors.length === 0, `does not block: ${label}`, r.errors.join(" ") || "clean");
}

const failing = lint(SESSION_019FA9A4, "/tmp/t.mjs");
t.check(failing.errors.some((e) => e.includes("LANG")), "catches the unbound LANG reference from session 019fa9a4");
t.check(failing.warnings.some((w) => w.includes("sequential")), "warns about serial await agent() with no pipeline/parallel");
t.check(failing.warnings.some((w) => w.includes("schema")), "warns that no agent() call passes a schema");
t.check(failing.warnings.some((w) => w.includes("return")), "warns that the script returns nothing");

// From the pirun3 verification run: the workflow reported "completed in 0s —
// 2 agents, 0 tokens" and returned {"specSummary":{},"bugSummary":{}}.
const UNAWAITED = `const summarizeSpec = agent("Summarize SPEC.md", { label: "spec" });
const summarizeBug = agent("Summarize BUG_ANALYSIS.md", { label: "bug" });
return { specSummary: summarizeSpec, bugSummary: summarizeBug };`;
const un = lint(UNAWAITED, "/tmp/t.mjs");
t.check(un.warnings.some((w) => w.includes("summarizeSpec") && w.includes("without await")), "warns when agent() results are returned unawaited");
t.check(un.errors.length === 0, "unawaited agent() is a warning, not a block");

const DEFERRED_AWAIT = `const p = agent("go", { schema: { type: "object" } });
log("launched");
const result = await p;
return result;`;
t.check(!lint(DEFERRED_AWAIT, "/tmp/t.mjs").warnings.some((w) => w.includes("without await")), "does not warn on a deliberate deferred await");
t.check(!lint(CANONICAL, "/tmp/t.mjs").warnings.some((w) => w.includes("without await")), "does not warn on thunks passed to parallel()");

t.check(lint("const x = (;", "/tmp/t.mjs").errors.some((e) => e.includes("compile")), "catches a syntax error before spawning anything");
t.check(
	lint(`const REC = await agent("go", { schema: {} }); log(RECC); return REC;`, "/tmp/t.mjs").errors.some((e) => e.includes("RECC")),
	"catches a typo'd reference",
);

// Regression corpus: every workflow script this install has ever run. Only
// genuinely broken ones may be blocked.
const dir = path.join(os.homedir(), ".pi-subagents", "workflows");
if (fs.existsSync(dir)) {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs"));
	// The sandbox globals a workflow script may reference without declaring
	// them. Anything else it uses bare is a genuine ReferenceError.
	const SANDBOX = new Set(["args", "agent", "parallel", "pipeline", "phase", "log", "budget", "console", "meta"]);
	const blocked = [];
	for (const f of files) {
		const src = fs.readFileSync(path.join(dir, f), "utf-8");
		const errs = lint(src, f).errors;
		if (errs.length) blocked.push({ f, src, errs });
	}
	// Re-derive each block independently of the linter: a compile error is
	// self-evident (the runner uses the same parse), and an unbound-identifier
	// error is genuine only if the name really is neither declared in the
	// source nor provided by the sandbox.
	const spurious = blocked.filter(({ src, errs }) => {
		if (errs.some((e) => e.includes("compile"))) return false;
		const named = /never declared: ([^.]+)\./.exec(errs.join(" "));
		if (!named) return true;
		return named[1].split(", ").some((name) => {
			if (SANDBOX.has(name)) return true;
			const declared = new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(src);
			return declared;
		});
	});
	t.check(
		spurious.length === 0,
		`no false positives across ${files.length} historical workflow scripts`,
		spurious.map((b) => b.f).join(", ") || `${blocked.length} blocked, each independently confirmed broken`,
	);
}

t.done();
