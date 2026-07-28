// Run every *.test.mjs in this directory. No framework: each test file prints
// PASS/FAIL lines and exits non-zero on failure.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();

let failed = 0;
for (const f of files) {
	const res = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
	if (res.status !== 0) failed++;
}

console.log(`\n${files.length} suite(s), ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
