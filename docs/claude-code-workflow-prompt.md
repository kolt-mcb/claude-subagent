# Claude Code's Workflow tool prompt (as of Fable 5, June 2026)

Transcribed verbatim from the Workflow tool description in a live Claude Code session.

---

Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a `<task-notification>` arrives when the workflow completes. Use /workflows to watch live progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt.
- Ultracode is on for the session.
- The user directly asked for a workflow or multi-agent orchestration in their own words ("use a workflow", "fan out agents") — the ask must be in the user's words; a task that would merely benefit from a workflow does not count.
- A skill or slash command's instructions say to call Workflow.
- The user asked to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.

Common single-phase workflows you can chain across turns:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

For larger work, run several in sequence — read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

Every script must begin with `export const meta = {...}`:

    export const meta = {
      name: 'find-flaky-tests',
      description: 'Find flaky tests and propose fixes',   // one-line, shown in permission dialog
      phases: [                                            // one entry per phase() call
        { title: 'Scan', detail: 'grep test logs for retries' },
        { title: 'Fix', detail: 'one agent per flaky test' },
      ],
    }
    // script body starts here — use agent()/parallel()/pipeline()/phase()/log()

The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required: `name`, `description`. Optional: `whenToUse`, `phases`.

## Script body hooks

- `agent(prompt, opts?): Promise<any>` — spawn a subagent. Without schema, returns its final text as a string. With `schema` (a JSON Schema), the subagent is forced to call a StructuredOutput tool and agent() returns the validated object — no parsing needed. Returns null if the user skips the agent mid-run or the subagent dies on a terminal API error after retries (filter with .filter(Boolean)). opts: `label` (display), `phase` (explicit progress group — use inside pipeline()/parallel() stages to avoid races on the global phase() state), `model` (override; default to omitting — the agent inherits the main-loop model, which is almost always correct), `isolation: 'worktree'` (fresh git worktree — EXPENSIVE, use ONLY when agents mutate files in parallel; auto-removed if unchanged), `agentType` (custom subagent type from the same registry as the Agent tool; composes with schema).
- `pipeline(items, stage1, stage2, ...): Promise<any[]>` — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index). A stage that throws drops that item to `null` and skips its remaining stages.
- `parallel(thunks): Promise<any[]>` — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws resolves to `null` (the call never rejects) — `.filter(Boolean)` before using results. Use ONLY when you genuinely need all results together.
- `log(message)` — progress message shown to the user above the progress tree.
- `phase(title)` — start a new phase; subsequent agent() calls group under this title.
- `args` — the value passed as Workflow's `args` input, verbatim. Pass arrays/objects as actual JSON values, NOT JSON-encoded strings.
- `budget: {total, spent(), remaining()}` — the turn's token target from the user's "+500k"-style directive. Hard ceiling: once spent() reaches total, further agent() calls throw. Use for dynamic loops (`while (budget.total && budget.remaining() > 50_000)`) or static scaling (`const FLEET = budget.total ? Math.floor(budget.total/100_000) : 5`).
- `workflow(nameOrRef, args?)` — run another workflow inline as a sub-step (one level of nesting only). Shares the parent's concurrency cap, abort signal, and budget.

Subagents are told their final text IS the return value (not a human-facing message), so they return raw data.

Scripts are plain JavaScript, NOT TypeScript. The body runs in an async context — use await directly. Standard JS built-ins available — EXCEPT `Date.now()`/`Math.random()`/argless `new Date()`, which throw (they would break resume); pass timestamps in via args.

DEFAULT TO pipeline(). A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1: dedup/merge across the full result set, early-exit on zero count, or prompts referencing "the other findings". NOT justified by "I need to flatten/filter first" (do it inside a pipeline stage), "the stages are conceptually separate", or "it's cleaner". Smell test: `parallel → transform → parallel` where the transform has no cross-item dependency should be a pipeline.

Concurrent agent() calls are capped at min(16, cpu cores - 2) per workflow — excess calls queue. Lifetime cap 1000 agents. A single parallel()/pipeline() call accepts at most 4096 items.

## Canonical patterns (from the prompt, abridged)

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:

    const results = await pipeline(
      DIMENSIONS,
      d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),
      review => parallel(review.findings.map(f => () =>
        agent(`Adversarially verify: ${f.title}`, {label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA})
          .then(v => ({...f, verdict: v}))
      ))
    )
    const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)

Loop-until-count:

    const bugs = []
    while (bugs.length < 10) {
      const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
      bugs.push(...result.bugs)
      log(`${bugs.length}/10 found`)
    }

Composed exhaustive review (find → dedup vs seen → diverse-lens judge panel → loop-until-dry):

    const seen = new Set(), confirmed = []
    let dry = 0
    while (dry < 2) {
      const found = (await parallel(FINDERS.map(f => () =>
        agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
      const fresh = found.filter(b => !seen.has(key(b)))      // dedup vs ALL seen — plain code, not an agent
      if (!fresh.length) { dry++; continue }
      dry = 0; fresh.forEach(b => seen.add(key(b)))
      const judged = await parallel(fresh.map(b => () =>
        parallel(['correctness','security','repro'].map(lens => () =>
          agent(`Judge "${b.desc}" via the ${lens} lens — real?`, {phase: 'Verify', schema: VERDICT})))
          .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
      confirmed.push(...judged.filter(v => v.real).map(v => v.b))
    }
    // dedup vs `seen`, NOT `confirmed` — else judge-rejected findings reappear every round

## Quality patterns

- **Adversarial verify**: N independent skeptics per finding, each prompted to REFUTE; kill if majority refute.
- **Perspective-diverse verify**: give each verifier a distinct lens (correctness, security, perf, repro) instead of N identical refuters — diversity catches failure modes redundancy can't.
- **Judge panel**: N independent attempts from different angles, parallel judges score, synthesize from the winner grafting the best ideas from runners-up.
- **Loop-until-dry**: for unknown-size discovery, keep spawning finders until K consecutive rounds return nothing new.
- **Multi-modal sweep**: parallel agents each searching a different way (by-container, by-content, by-entity, by-time).
- **Completeness critic**: a final agent asking "what's missing — modality not run, claim unverified, source unread?" Its findings become the next round.
- **No silent caps**: if a workflow bounds coverage (top-N, sampling), log() what was dropped.

Scale to what the user asked for: "find any bugs" → a few finders, single-vote verify; "thoroughly audit" → larger pool, 3–5 vote adversarial pass, synthesis stage. These patterns aren't exhaustive — compose novel harnesses when the task calls for it.

## Resume

The tool result includes a runId. Relaunch with `{scriptPath, resumeFromRunId}` — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after runs live. Same script + same args → 100% cache hit. (This is why Date.now()/Math.random() are banned in scripts.)
