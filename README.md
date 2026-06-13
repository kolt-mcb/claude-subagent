# claude-subagent

A Claude Code–style **Agent (Task) tool** for [pi](https://pi.dev), the interactive CLI coding agent. It lets a pi session spawn purpose-built subagents — one-shot helpers, long-lived named teammates, and background workers — plus a deterministic multi-agent **workflow** runner.

The design deliberately mirrors Claude Code's subagent model rather than pi's built-in one:

- Subagents run with a **minimal, purpose-built system prompt** (base + agent definition + environment). They do **not** inherit the parent's system prompt, project context, skills, or conversation history.
- The task prompt is passed **verbatim** as the user message.
- Subagents **cannot nest** — children run with `--no-extensions`.
- The subagent's **final assistant text** is returned as the tool result.

## How it works

Children run as long-lived `pi --mode rpc` processes: JSONL commands on stdin, events on stdout. One `prompt()` is one run, but the process **survives between runs**, so background agents and teammates keep their context and accept follow-ups via `send_message` without resuming session files.

- **One-shot subagent** — the `agent` tool blocks and returns the child's report.
- **Background agent** (`run_in_background: true`) — returns immediately; the report is delivered back into the session as a message when the child finishes. Running agents render in a bottom widget; you can watch any agent's live transcript and read its context utilization.
- **Teammate** (`agent` with a `name`) — a persistent, named worker whose replies arrive as `@name` messages and that you steer over time with `send_message`.
- **Workflow** — a deterministic JavaScript orchestration script (`parallel`/`pipeline`/`agent`) for fan-out, verification, and synthesis across many agents.

### Steering a running agent

`send_message` to a busy agent **steers its current turn by default** — the message is injected mid-run (pi's `steer`) and the agent folds it in at its next step without losing context. Pass `interrupt: true` to instead **hard-stop** the turn (abort any running command) and run the message as a fresh prompt.

### Custom agent types

Built-in `general-purpose`, plus custom agents auto-discovered from Claude Code's own locations:

```
<cwd>/.claude/agents/*.md
~/.claude/agents/*.md
```

Each is a markdown file with frontmatter (`name`, `description`, `tools`, `model`, `color`) and a body that becomes the agent's system prompt.

## Install

This is a pi extension — a single `index.ts`. Point pi at it:

```bash
pi -e /path/to/claude-subagent/index.ts
```

or add it to your pi extension config (see `package.json`'s `pi.extensions`).

> **Note:** runtime dependencies are provided by your pi installation rather than pinned in `package.json`; install/run against a matching pi version.

## License

MIT — see [LICENSE](LICENSE).
