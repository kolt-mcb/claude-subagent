// The subagent transcript must render through pi's own message components, so
// a child conversation looks like the root one. This drives the real builder
// against real child session.jsonl files on disk.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extensionJs, suite } from "./harness.mjs";

const t = suite("transcript rendering");

// Re-export the module-scope helpers so they can be imported directly; they are
// internal to the extension otherwise.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-render-"));
const modPath = path.join(out, "index.mjs");
fs.writeFileSync(modPath, `${extensionJs()}\nexport { buildTranscriptComponents, transcriptLines };\n`);
// Resolve bare imports against the package's own node_modules.
fs.symlinkSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "node_modules"), path.join(out, "node_modules"));

const { buildTranscriptComponents, transcriptLines } = await import(modPath);

// pi calls initTheme() during interactive startup; the message components read
// the global theme, so a bare node process has to do it too.
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme(undefined, false);
const { visibleWidth } = await import("@earendil-works/pi-tui");

// A minimal TUI stand-in: ToolExecutionComponent only needs it for renderer
// plumbing, and nothing here drives a real terminal.
const tui = { terminal: { columns: 100, rows: 40 }, requestRender() {} };
const opts = { tui, cwd: process.cwd() };

const teammatesDir = path.join(os.homedir(), ".pi-subagents", "teammates");
const candidates = fs.existsSync(teammatesDir)
	? fs
			.readdirSync(teammatesDir)
			.map((d) => path.join(teammatesDir, d, "session.jsonl"))
			.filter((f) => fs.existsSync(f) && fs.statSync(f).size > 2000)
	: [];

t.check(candidates.length > 0, "found real child transcripts to render against", `${candidates.length} file(s)`);

let rendered = 0;
let sawTool = false;
let sawText = false;
for (const file of candidates.slice(0, 5)) {
	let components;
	let lines;
	try {
		components = buildTranscriptComponents(file, opts);
		lines = transcriptLines(file, 100, opts);
	} catch (err) {
		t.check(false, `renders ${path.basename(path.dirname(file))} without throwing`, String(err));
		continue;
	}
	t.check(components.length > 0, `${path.basename(path.dirname(file))}: produced components`, `${components.length} components, ${lines.length} lines`);
	if (lines.length) rendered++;
	// Every line must be a string; a component returning junk would corrupt the pane.
	const bad = lines.filter((l) => typeof l !== "string");
	t.check(bad.length === 0, `${path.basename(path.dirname(file))}: all rendered lines are strings`);
	// No line may exceed the requested width. Measure with pi's own width
	// function: naive ANSI stripping miscounts OSC-8 hyperlinks and wide chars.
	const overlong = lines.filter((l) => visibleWidth(String(l)) > 100);
	t.check(overlong.length === 0, `${path.basename(path.dirname(file))}: no line overflows the width`, overlong.length ? `${overlong.length} overlong` : "");
	const flat = lines.join("\n");
	if (/read|bash|tool/i.test(flat)) sawTool = true;
	if (flat.trim().length > 50) sawText = true;
}

t.check(rendered > 0, "at least one transcript rendered to visible lines");
t.check(sawText, "rendered output carries conversation text");
t.check(sawTool, "rendered output includes tool activity");

// A file that does not exist must degrade to empty, not throw.
t.check(buildTranscriptComponents(path.join(out, "nope.jsonl"), opts).length === 0, "missing transcript yields no components");
t.check(transcriptLines(path.join(out, "nope.jsonl"), 80, opts).length === 0, "missing transcript yields no lines");

t.done();
process.exit(process.exitCode ?? 0);
