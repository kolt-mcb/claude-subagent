// Regression for the crash in session 019fad: a workflow spawned five agents,
// another extension replaced the session mid-run, and the next progress event
// from a still-running child read ctx.hasUI on the captured (now stale) ctx.
// pi's runner throws from that getter, the read happened inside a stdout
// stream handler, and an uncaught exception there killed the whole process —
// taking all five agents with it.
import { evalSlice, extensionJs, suite } from "./harness.mjs";

const s = suite("stale ctx never reaches the widget layer");

const { ctxAlive, updateWidget, updatePreviewWidget } = evalSlice({
	from: "function ctxAlive",
	to: "const teammates =",
	expose: ["ctxAlive", "updateWidget", "updatePreviewWidget"],
});

/** What pi's ExtensionRunner does once the session behind a ctx is gone. */
const staleCtx = {
	get hasUI() {
		throw new Error("This extension ctx is stale after session replacement or reload.");
	},
	get ui() {
		throw new Error("This extension ctx is stale after session replacement or reload.");
	},
};
const headlessCtx = { hasUI: false, ui: {} };

s.check(ctxAlive(headlessCtx) === true, "a live ctx reads as alive");
s.check(ctxAlive(staleCtx) === false, "a stale ctx reads as dead instead of throwing");
s.check(
	ctxAlive({
		get hasUI() {
			throw "string thrown, not an Error";
		},
	}) === false,
	"a non-Error throw is caught too",
);

function doesNotThrow(fn) {
	try {
		fn();
		return true;
	} catch {
		return false;
	}
}

s.check(doesNotThrow(() => updateWidget(staleCtx)), "updateWidget survives a stale ctx");

// Prove the guard is load-bearing rather than incidentally unreachable: strip
// it back to the pre-fix `if (!ctx.hasUI) return;` and the same call throws.
const { updateWidget: unguarded } = evalSlice({
	from: "function ctxAlive",
	to: "const teammates =",
	expose: ["updateWidget"],
	transform: (body) => {
		const stripped = body.replace("!ctxAlive(ctx) || !ctx.hasUI", "!ctx.hasUI");
		if (stripped === body) throw new Error("guard not found in updateWidget — test is stale");
		return stripped;
	},
});
s.check(!doesNotThrow(() => unguarded(staleCtx)), "without the guard, the same call throws (the original crash)");
s.check(doesNotThrow(() => updatePreviewWidget(staleCtx, undefined)), "updatePreviewWidget survives a stale ctx");
s.check(doesNotThrow(() => updateWidget(headlessCtx)), "updateWidget still no-ops when headless");

// The guard above fixes the one call site we know about. The stream boundary
// is what keeps the next unguarded call site from being fatal rather than
// merely broken, so assert the handlers route through the catch.
const js = extensionJs();
const stdoutHandler = js.slice(js.indexOf("this.proc.stdout?.on"), js.indexOf("this.proc.stderr?.on"));
s.check(/safeProcessLine/.test(stdoutHandler), "stdout handler routes lines through safeProcessLine");
s.check(!/[^e]this\.processLine\(/.test(stdoutHandler), "stdout handler never calls processLine directly");

const closeHandler = js.slice(js.indexOf('this.proc.on("close"'), js.indexOf('this.proc.on("close"') + 300);
s.check(/safeProcessLine/.test(closeHandler), "close handler drains the tail through safeProcessLine");

s.done();
