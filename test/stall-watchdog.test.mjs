// Drives the real RpcChild against a stub `pi` that emits a few events and
// then goes silent — the @perf-analyzer shape from session 019fa9a4, where a
// child did 29 tool calls, hung, and was steered three more times. Each steer
// re-armed the run timeout, so the run never settled and its work was lost.
// The stall watchdog must settle it regardless of how often it is poked.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { evalSlice, suite } from "./harness.mjs";

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "claude-subagent-stub-"));
fs.writeFileSync(
	path.join(bin, "pi"),
	`#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (JSON.parse(line).type === "prompt") {
      emit({ type: "tool_execution_start", toolName: "read", args: { path: "/a.c" } });
      emit({ type: "tool_execution_start", toolName: "read", args: { path: "/b.c" } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial findings before going quiet" }], usage: { input: 100, output: 50 } } });
      // ...and never emits agent_end. Steers are swallowed, like a wedged child.
    }
  }
});
setInterval(() => {}, 1 << 30);
`,
	{ mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;

// Production constants scaled down, keeping the poll interval a fraction of
// the stall window so the "stalled but not yet reaped" state is reachable.
const { RpcChild } = evalSlice({
	from: "const CHILD_ENV",
	to: "export default function claudeSubagent",
	expose: ["RpcChild"],
	context: { spawn, fs, os, path, vm, setTimeout, setInterval, clearTimeout, clearInterval, process, Buffer },
	transform: (body) =>
		body
			.replace(/const CHILD_STALL_MS = [^;]+;/, "const CHILD_STALL_MS = 800;")
			.replace(/const CHILD_STALL_POLL_MS = [^;]+;/, "const CHILD_STALL_POLL_MS = 1500;"),
});

const t = suite("stall watchdog");

const child = new RpcChild([], process.cwd(), 10 * 60 * 1000, { onProgress: () => {} });
const started = Date.now();
const run = child.prompt("audit these files");

let attempts = 0;
let accepted = 0;
const poller = setInterval(() => {
	attempts++;
	if (child.steer("Status check - what have you found so far?")) accepted++;
}, 300);

const outcome = await Promise.race([run, new Promise((r) => setTimeout(() => r({ __timeout: true }), 15000))]);
clearInterval(poller);

t.check(!outcome.__timeout, "run settles despite continuous steering", `settled in ${Date.now() - started}ms after ${attempts} steer attempts`);
if (!outcome.__timeout) {
	t.check(Boolean(outcome.stalled), "outcome is marked stalled", outcome.stalled ?? "(not set)");
	t.check(outcome.finalText.includes("partial findings"), "partial output is preserved rather than discarded");
	t.check(outcome.toolCount === 2, "work done before the hang is still counted", `toolCount=${outcome.toolCount}`);
	t.check(/2 tool uses/.test(outcome.stalled ?? ""), "stall note reports how far it got");
	t.check(accepted < attempts, "steer() refuses once the child has gone quiet", `${accepted}/${attempts} accepted`);
	t.check(child.alive === false, "wedged child is killed rather than left as a zombie");
}

t.done();
process.exit(process.exitCode ?? 0);
