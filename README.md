# dsh-generation

English | [中文](README.zh.md)

A DeepSeek Harness plugin that **forks agent presets and runs a task on the next generation**.

It is **make, not a compiler**. Creator mode is already the compiler: it can inspect the runtime, edit files, and author presets. This plugin only records a lineage — copy a known-good preset, let the meta agent edit that copy with ordinary `fs` / `bash`, then start a **new** working session on it.

## Install

```sh
dsh plugin --profile web add github:goecho/dsh-generation#fb2f69d
```

Then **restart** `dsh --profile web` so the host profile reloads. Pin that commit, or a later SHA from the [commit history](https://github.com/goecho/dsh-generation/commits/main), after you have read the source. The package is plain JavaScript, so git installs do not need a `prepare` build allowlist.

Then open a **Creator mode** (`cordis`) session — or a copy of that preset whose composition still has a plugin row `name: '@deepseek-ai/dsh-tool-cordis'`.

`dsh plugin add` installs into the **host** profile, so the two tools are registered globally. This plugin then hides them from every non-Creator session (including user copies of `standard` / `minimal` / `code`) and from every agent with `origin: subagent`, including the workers `generation_run` starts. Execute still refuses a non-Creator caller.

This repository already has the `dsh-plugin`, `dsh`, and `deepseek-harness` GitHub topics.

## Why

DeepSeek Harness splits composition into a Host plane (sandbox, model route, persistence) and an Agent plane (tools, persona, prompt). A session’s preset is locked once a turn has run, so you cannot hot-swap the working agent’s toolset without stranding logged tool calls.

The useful bootstrap is the same as a C compiler: **each generation is a new binary**. Stage N writes files for stage N+1; you do not patch the process that is currently compiling.

## What it is not

- Not a replacement for Creator mode (`cordis` preset) or `cordis_define` / `cordis_run`
- Not a way to recompose the current session, or to give an in-process subagent a different preset
- Not a YAML/JS generator, scorer, or auto-promoter of the default creator
- Not a Host-plane kernel: it does not add services, session event types, or sandbox backends
- It does **not** depend on `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm`. Tools are registered as raw definitions so a second copy of those packages cannot split the host’s module identity.

## Design

Four rules:

1. **The kernel stays assembly.** No new Host services, no new `SessionEvent` types, no unlocking `agent-preset-locked`.
2. **A generation is a new process of composition.** `generation_run` uses `agents.create` + `agentPresets.mount(id)`, never `recompose` on the meta session and never `composeFrom` (in-process children inherit the parent preset).
3. **This plugin is make.** It does not write `agent.cordis.yml`. Editing uses tools the creator preset already has.
4. **A human is stage3.** `fork` and `run` go through `tools/pre-execute` `ask`. Nothing is promoted to the default creator automatically. Lineage is the meta session log (`tool/call` / `tool/result`), not a second database.

```
meta session  (cordis + this plugin)
  → generation_fork     copy a preset to a new id
  → fs / bash           edit the copy (not this plugin)
  → generation_run      new agent, mount that id, run the task, dispose
  → summary             back into the meta log
  → fork again or stop
```

Working generations should fork from `standard`, `minimal`, or `code`.

## Tools

| Tool | Does | Does not |
| --- | --- | --- |
| `generation_fork` | `agentPresets.copy(from, id)`; writes `purpose` into the new `preset.yml` description; returns id and directory | Accept composition YAML (authoring stays copy-only); overwrite an existing id |
| `generation_run` | After approval, create an agent, `mount` the preset, `followup(task)`, wait until idle, cancel, or a 15-minute timeout, return `sessionId`, `stopReason`, tool names used, last assistant text, then `dispose` | Run Creator mode as the worker; inherit the meta toolset; leave a half-created agent on failure |

### `generation_fork`

| Argument | Required | Meaning |
| --- | --- | --- |
| `from` | yes | Preset id to copy. Prefer `standard`, `minimal`, or `code`. |
| `id` | yes | New preset id (`/^[a-z0-9][a-z0-9-]*$/`). Must not already exist. |
| `purpose` | yes | One sentence written into the new `preset.yml` description. |

Returns `{ ok, id, from, purpose, path, compositionPath }` where `path` is the preset directory.

### `generation_run`

| Argument | Required | Meaning |
| --- | --- | --- |
| `preset` | yes | Preset id to mount on the new working session. Must not be `cordis`. |
| `task` | yes | Self-contained follow-up for the worker. It does not see meta history. |

Refuses a worker whose composition still has a plugin row `name: '@deepseek-ai/dsh-tool-cordis'`. Inherits the meta session’s workspace `cwd`, records `origin: subagent` and `parentSession` so logs chain, and does not dump the full worker transcript into the meta context. If the worker never goes idle, it is cancelled after 15 minutes (`stopReason: "timeout"`). Domain failures keep `{ ok: false }` but render as `ERROR:` so the model notices.

Returns `{ ok, sessionId, presetId, stopReason, toolsUsed, lastAssistantText }`.

## Trust

Treat a Creator session that can fork and run generations as **shell access**. Mitigation in v1:

- Human approval on every fork and every run
- Worker preset cannot be `cordis`, and cannot still carry a `@deepseek-ai/dsh-tool-cordis` plugin row
- Edits belong under the new preset directory
- Model-written JavaScript is never auto-mounted via `cordis_run`

## Develop

```sh
npm test
```

There are no `@deepseek-ai/*` runtime dependencies. The tests mock `ctx.tools` / `ctx.agentPresets` / `ctx.agents`. GitHub Actions runs the same `npm test` on Node 22.

## License

[MIT](LICENSE)
