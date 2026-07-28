// index.ts is a single-file pi extension with no build step, so the tests
// transpile it on demand and pull the units under test out of the emitted JS.
// Nothing here imports the extension normally — activating it would need a
// live pi host.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let cached;

/** Transpile index.ts once per run and return the emitted JavaScript. */
export function extensionJs() {
	if (cached) return cached;
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "claude-subagent-test-"));
	const tsc = path.join(ROOT, "node_modules/.bin/tsc");
	const res = spawnSync(
		tsc,
		["--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", out, path.join(ROOT, "index.ts")],
		{ encoding: "utf-8" },
	);
	const emitted = path.join(out, "index.js");
	if (!fs.existsSync(emitted)) throw new Error(`tsc emitted nothing:\n${res.stdout}${res.stderr}`);
	cached = fs.readFileSync(emitted, "utf-8");
	return cached;
}

/**
 * Evaluate a slice of the extension in a fresh context and return the named
 * bindings. `from`/`to` are source substrings marking the slice boundaries.
 */
export function evalSlice({ from, to, expose, context = {}, transform }) {
	const js = extensionJs();
	const start = js.indexOf(from);
	if (start === -1) throw new Error(`slice start not found: ${from}`);
	const end = to ? js.indexOf(to, start) : js.length;
	if (end === -1) throw new Error(`slice end not found: ${to}`);
	let body = js.slice(start, end);
	if (transform) body = transform(body);
	const ctx = { console, ...context };
	vm.createContext(ctx);
	vm.runInContext(`${body}\n;${expose.map((n) => `this.${n} = ${n};`).join("")}`, ctx);
	return ctx;
}

/** Minimal assertion collector — one line per check, non-zero exit on failure. */
export function suite(title) {
	const failures = [];
	console.log(`\n${title}`);
	return {
		check(ok, label, detail = "") {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
			if (!ok) failures.push(label);
		},
		done() {
			if (failures.length) {
				console.log(`  ${failures.length} check(s) failed`);
				process.exitCode = 1;
			}
			return failures.length;
		},
	};
}
