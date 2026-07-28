// isStatusPing decides which follow-ups get rate limited while an agent is
// working. The corpus below is every send_message sent in session 019fa9a4:
// the content-free ones are what turned a still-reading agent into one that
// invented 21 findings. Real redirections must always get through.
import { evalSlice, suite } from "./harness.mjs";

const { isStatusPing } = evalSlice({
	from: "const STATUS_PING_COOLDOWN_MS",
	to: "function uniqueSessionName",
	expose: ["isStatusPing"],
});

const t = suite("status-ping classification");

const PINGS = [
	"Status check - what have you found so far? Summarize your findings.",
	"Please return with your FINAL summary of all findings now. Be concise but comprehensive.",
	"Please return with your FINAL summary of all findings now. Be concise but comprehensive. Include any test results.",
	"Report summary now - what bugs did you find? Be brief.",
	"Report summary now - architecture issues found? Be brief.",
	"Report summary now - correctness bugs found? Include test results. Be brief.",
	"How are things going? Any findings yet? Can you share preliminary results?",
	"Any findings yet? Preliminary results?",
	"What test results have you got? Any findings?",
	"Results? What assembly did you find?",
	"Benchmark results? Timing data?",
	"What are your test results? Did any edge cases fail? Just need the summary.",
];

const INSTRUCTIONS = [
	"Skip codegen.c and focus only on the lexer's keyword table.",
	"Also check /home/grunt/bootstrap/nucleus/compiler/parse.c for the same pattern.",
	"Stop reading and run `bash test.sh` instead, then tell me the exit code.",
	"The register allocator invalidation you flagged is wrong - reg_commit() does run on call boundaries. Recheck.",
	"Add a section on the ND_FR and ND_MATCH nodes that codegen never emits.",
	"Ignore the benchmarks directory entirely.",
	"Use snprintf instead of memcpy in your suggested fix.",
];

const missed = PINGS.filter((p) => !isStatusPing(p));
t.check(missed.length === 0, `all ${PINGS.length} content-free pings from session 019fa9a4 are recognised`, missed.join(" | "));

const blocked = INSTRUCTIONS.filter((p) => isStatusPing(p));
t.check(blocked.length === 0, `none of the ${INSTRUCTIONS.length} real redirections are rate limited`, blocked.join(" | "));

t.done();
