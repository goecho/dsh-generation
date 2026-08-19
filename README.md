# dsh-generation

English | [中文](README.zh.md)

A DeepSeek Harness plugin that **forks agent presets and runs a task on the next generation**.

It is **make, not a compiler**. Creator mode is already the compiler: it can inspect the runtime, edit files, and author presets. This plugin only records a lineage — copy a known-good preset, let the meta agent edit that copy with ordinary `fs` / `bash`, then start a **new** working session on it.

## Why

DeepSeek Harness splits composition into a Host plane (sandbox, model route, persistence) and an Agent plane (tools, persona, prompt). A session’s preset is locked once a turn has run, so you cannot hot-swap the working agent’s toolset without stranding logged tool calls.

The useful bootstrap is the same as a C compiler: **each generation is a new binary**. Stage N writes files for stage N+1; you do not patch the process that is currently compiling.

## What it is not

- Not a replacement for Creator mode (`cordis` preset) or `cordis_define` / `cordis_run`
- Not a way to recompose the current session, or to give an in-process subagent a different preset
- Not a YAML/JS generator, scorer, or auto-promoter of the default creator
- Not a Host-plane kernel: it does not add services, session event types, or sandbox backends

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

Mount this plugin **only on Creator mode** (or a copy of it). Working generations fork from `standard`, `minimal`, or `code`, and must not include these tools.

## Tools

| Tool | Does | Does not |
| --- | --- | --- |
| `generation_fork` | `agentPresets.copy(from, id)`; writes `purpose` into the new `preset.yml` description; returns id and path | Accept composition YAML (authoring stays copy-only); overwrite an existing id |
| `generation_run` | After approval, create an agent, `mount` the preset, `followup(task)`, wait until idle or cancel, return `sessionId`, `stopReason`, tool names used, last assistant text, then `dispose` | Run Creator mode as the worker; inherit the meta toolset; leave a half-created agent on failure |

`generation_run` inherits the meta session’s workspace `cwd`, records `origin: subagent` and `parentSession` so logs chain, and does not dump the full worker transcript into the meta context.

## Trust

Treat a Creator session that can fork and run generations as **shell access**. Mitigation in v1:

- Human approval on every fork and every run
- Worker preset cannot be `cordis`
- Edits belong under the new preset directory
- Model-written JavaScript is never auto-mounted via `cordis_run`

## Status

Design is fixed; implementation is next. Install and tool schemas will land with the first package.

Intended install (not available yet):

```sh
dsh plugin --profile web add github:goecho/dsh-generation
```

Then use it from a Creator-mode session. Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic when publishing related repos.

## License

[MIT](LICENSE)