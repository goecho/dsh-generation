import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Cordis plugin name used in lifecycle diagnostics. */
export const name = 'dsh-generation'

/**
 * Host-plane plugin: the two tools register globally, then this plugin hides
 * them from shipped working presets and from every `origin: subagent` agent
 * (including `generation_run` workers).
 */
export const inject = ['tools', 'agentPresets', 'agents', 'systemPrompt']

export const FORK_TOOL = 'generation_fork'
export const RUN_TOOL = 'generation_run'
export const METADATA_FILE = 'preset.yml'
export const CREATOR_PLUGIN = 'dsh-tool-cordis'
export const CREATOR_PRESET = 'cordis'
export const WORKER_BASE_PRESETS = Object.freeze(['standard', 'minimal', 'code'])
export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const MAX_PURPOSE = 500
const MAX_TASK = 100_000
const MAX_ASSISTANT_CHARS = 4_000
/** Cooperative deadline for `generation_run` if the worker never goes idle. */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000

const GENERATION_SECTION = [
  'You can fork a working-agent preset and run a task on the next generation.',
  'These tools are make, not a compiler: they never write agent.cordis.yml.',
  'generation_fork copies a known-good preset (usually standard, minimal, or code).',
  'Edit the copy with fs/bash. Then generation_run starts a NEW session on that id.',
  'Never recompose this session. Never run the cordis preset as a worker.',
  'Each fork and each run requires human approval. Lineage is this session\'s tool log.',
].join(' ')

const FORK_DESCRIPTION = [
  'Copy an existing agent preset to a new id (the only authoring write).',
  'Does not accept composition YAML and never overwrites an existing id.',
  'Writes `purpose` into the new preset.yml description, then returns the id and directory.',
  'Edit the copy afterwards with fs/bash; do not use this tool to patch the running session.',
].join(' ')

const RUN_DESCRIPTION = [
  'Create a NEW agent, mount the named preset, send `task` as a follow-up, wait until idle or cancel, then dispose.',
  'Inherits this session\'s workspace cwd and records origin=subagent plus parentSession.',
  'Refuses Creator mode (cordis) and any preset that still includes dsh-tool-cordis.',
  'Returns a summary only — not the worker transcript. Requires human approval.',
].join(' ')

/** Whether `id` is a legal preset directory name. */
export function isPresetId(id) {
  return typeof id === 'string' && PRESET_ID.test(id)
}

/** YAML document for a preset.yml that carries a display name and purpose. */
export function renderPresetYml({ name: displayName, description }) {
  const lines = []
  if (typeof displayName === 'string' && displayName.trim() !== '') {
    lines.push(`name: ${JSON.stringify(displayName)}`)
  }
  lines.push(`description: ${JSON.stringify(description)}`)
  return `${lines.join('\n')}\n`
}

/** Freeze a JSON-shaped tree before handing it to the agent inbox. */
export function freezeTree(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const child of value) freezeTree(child)
  } else {
    for (const child of Object.values(value)) freezeTree(child)
  }
  return Object.freeze(value)
}

/**
 * Build a follow-up user message without importing `@deepseek-ai/dsh-llm`
 * (a second copy of that package would split the host's module identity).
 */
export function createUserMessage(text) {
  return freezeTree({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(message) {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  return message.content
    .filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function turnEndKind(event) {
  const reason = event?.data?.reason
  if (typeof reason === 'string') return reason
  if (isRecord(reason) && typeof reason.kind === 'string') return reason.kind
  return undefined
}

/**
 * Compact a worker session into what the meta agent should see.
 * Walks the durable log for tool names / turn-end, and derived messages for
 * the last assistant text — never the full transcript.
 */
export function summarizeWorkerSession(session, { maxAssistantChars = MAX_ASSISTANT_CHARS } = {}) {
  const toolsUsed = []
  const seen = new Set()
  let lastTurnEnd = 'idle'
  for (const event of session?.events ?? []) {
    if (event?.type === 'tool/call' && typeof event.data?.name === 'string') {
      if (!seen.has(event.data.name)) {
        seen.add(event.data.name)
        toolsUsed.push(event.data.name)
      }
    }
    if (event?.type === 'turn/end') {
      lastTurnEnd = turnEndKind(event) ?? lastTurnEnd
    }
  }

  let lastAssistantText = ''
  const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue
    lastAssistantText = textOf(messages[index])
    break
  }
  if (lastAssistantText.length > maxAssistantChars) {
    lastAssistantText = `${lastAssistantText.slice(0, maxAssistantChars)}…`
  }

  return { toolsUsed, lastAssistantText, lastTurnEnd }
}

function failed(error) {
  return { ok: false, error }
}

function looksLikeCreatorComposition(composition) {
  return typeof composition === 'string' && composition.includes(CREATOR_PLUGIN)
}

/** Hide the two tools from one agent. Unknown/non-global names are ignored. */
export function denyGenerationTools(agent) {
  try {
    agent.ctx.tools.restrict({ deny: [FORK_TOOL, RUN_TOOL] })
  } catch {
    // Already hidden, registered in a preset layer, or restrict rejected the names.
  }
}

function composedPresetId(ctx, agent) {
  try {
    return ctx.agentPresets.composedPreset(agent.ctx)
  } catch {
    return undefined
  }
}

/**
 * Shipped working presets and every subagent must not see these tools.
 * Creator mode and copies of it keep them.
 */
export function hideGenerationToolsIfWorker(ctx, agent) {
  if (agent?.session?.header?.origin === 'subagent') {
    denyGenerationTools(agent)
    return
  }
  const presetId = composedPresetId(ctx, agent)
  if (WORKER_BASE_PRESETS.includes(presetId)) denyGenerationTools(agent)
}

function generationToolsVisible(ctx, agent) {
  if (agent === undefined) return false
  try {
    if (ctx.tools.get(FORK_TOOL, agent) !== undefined) return true
  } catch {
    // get() may require a scope key rather than the Agent object.
  }
  return composedPresetId(ctx, agent) === CREATOR_PRESET
}

async function metaAgentError(ctx, agent) {
  if (agent === undefined) {
    return 'generation tools must run on a live agent session'
  }
  if (agent.session?.header?.origin === 'subagent') {
    return 'generation tools cannot run on a subagent; use them from the Creator session'
  }
  const presetId = composedPresetId(ctx, agent)
  if (presetId === CREATOR_PRESET) return undefined
  if (presetId === undefined) {
    return 'generation tools need a mounted agent preset (Creator mode or a copy of it)'
  }
  let composition
  try {
    composition = await ctx.agentPresets.read(presetId)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (looksLikeCreatorComposition(composition)) return undefined
  return `generation tools are for Creator mode (cordis) or a copy of it; this session is on "${presetId}"`
}

async function workerPresetError(ctx, id) {
  if (id === CREATOR_PRESET) {
    return 'refusing to run Creator mode (cordis) as a worker'
  }
  let composition
  try {
    composition = await ctx.agentPresets.read(id)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (looksLikeCreatorComposition(composition)) {
    return `refusing to run a Creator-capable preset as a worker ("${id}" still includes ${CREATOR_PLUGIN})`
  }
  return undefined
}

function requireString(args, key, { max }) {
  if (!isRecord(args) || typeof args[key] !== 'string') return { error: `${key} must be a string` }
  const value = args[key].trim()
  if (value === '') return { error: `${key} must not be blank` }
  if (value.length > max) return { error: `${key} must be at most ${max} characters` }
  return { value }
}

function cancelWorker(agent) {
  try {
    agent.cancel({ kind: 'parent' })
  } catch {
    // Already idle or already cancelling.
  }
}

/**
 * Wait until the worker is idle, or until the parent signal / deadline fires.
 * Cancellation always goes through `agent.cancel({ kind: 'parent' })`.
 */
export async function waitUntilIdle(agent, signal, { timeoutMs } = {}) {
  const idle = agent.whenIdle()
  let timedOut = false
  let timer

  const onParentAbort = () => cancelWorker(agent)
  signal?.addEventListener('abort', onParentAbort, { once: true })
  if (signal?.aborted) cancelWorker(agent)
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      cancelWorker(agent)
    }, timeoutMs)
  }

  try {
    await idle
  } catch (error) {
    if (!(signal?.aborted || timedOut)) throw error
    try {
      await agent.whenIdle()
    } catch {
      // Driver may reject on cancel; quiescence is what we need.
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
  }

  if (signal?.aborted) return 'cancelled'
  if (timedOut) return 'timeout'
  return 'idle'
}

function stringifyResult(value) {
  return JSON.stringify(value, null, 2)
}

export function createForkTool(ctx) {
  return {
    name: FORK_TOOL,
    description: FORK_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Preset id to copy. Prefer standard, minimal, or code — not cordis.',
        },
        id: {
          type: 'string',
          description: 'New preset id. Must match /^[a-z0-9][a-z0-9-]*$/ and must not already exist.',
        },
        purpose: {
          type: 'string',
          description: 'One-sentence description written into the new preset.yml. What this generation is for.',
        },
      },
      required: ['from', 'id', 'purpose'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          id: { type: 'string' },
          from: { type: 'string' },
          purpose: { type: 'string' },
          path: { type: 'string' },
          compositionPath: { type: 'string' },
          warning: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: stringifyResult(value) }]
      },
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted()
      const blocked = await metaAgentError(ctx, exec?.agent)
      if (blocked !== undefined) return failed(blocked)

      const from = requireString(args, 'from', { max: 128 })
      if (from.error) return failed(from.error)
      const id = requireString(args, 'id', { max: 128 })
      if (id.error) return failed(id.error)
      if (!isPresetId(from.value)) return failed(`from must match ${String(PRESET_ID)}`)
      if (!isPresetId(id.value)) return failed(`id must match ${String(PRESET_ID)}`)
      const purpose = requireString(args, 'purpose', { max: MAX_PURPOSE })
      if (purpose.error) return failed(purpose.error)

      exec?.signal?.throwIfAborted()
      try {
        await ctx.agentPresets.copy(from.value, id.value, id.value)
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error))
      }

      exec?.signal?.throwIfAborted()
      let preset
      try {
        preset = await ctx.agentPresets.resolve(id.value)
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error))
      }

      const directory = dirname(preset.path)
      const result = {
        ok: true,
        id: id.value,
        from: from.value,
        purpose: purpose.value,
        path: directory,
        compositionPath: preset.path,
      }

      try {
        await writeFile(
          join(directory, METADATA_FILE),
          renderPresetYml({ name: id.value, description: purpose.value }),
          { encoding: 'utf8', mode: 0o600 },
        )
      } catch (error) {
        result.warning = `copied, but failed to write ${METADATA_FILE}: ${
          error instanceof Error ? error.message : String(error)
        }`
      }

      return result
    },
  }
}

export function createRunTool(ctx) {
  return {
    name: RUN_TOOL,
    description: RUN_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          description: 'Preset id to mount on the new working session. Must not be cordis.',
        },
        task: {
          type: 'string',
          description: 'User follow-up sent to the new agent. Keep it self-contained; the worker has no meta history.',
        },
      },
      required: ['preset', 'task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          sessionId: { type: 'string' },
          presetId: { type: 'string' },
          stopReason: { type: 'string' },
          toolsUsed: { type: 'array', items: { type: 'string' } },
          lastAssistantText: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: stringifyResult(value) }]
      },
    },
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted()
      const blocked = await metaAgentError(ctx, exec?.agent)
      if (blocked !== undefined) return failed(blocked)

      const preset = requireString(args, 'preset', { max: 128 })
      if (preset.error) return failed(preset.error)
      if (!isPresetId(preset.value)) return failed(`preset must match ${String(PRESET_ID)}`)
      const task = requireString(args, 'task', { max: MAX_TASK })
      if (task.error) return failed(task.error)

      const workerBlocked = await workerPresetError(ctx, preset.value)
      if (workerBlocked !== undefined) return failed(workerBlocked)

      const cwd = exec.agent.session.header.cwd
      if (typeof cwd !== 'string' || cwd === '') {
        return failed('meta session has no workspace cwd to inherit')
      }

      const parentDepth = exec.agent.session.header.delegationDepth
      const sessionId = randomUUID()
      const meta = {
        cwd,
        parentSession: exec.agent.session.id,
        origin: 'subagent',
        agentPreset: preset.value,
        delegationDepth: Number.isSafeInteger(parentDepth) ? parentDepth + 1 : 1,
      }

      exec?.signal?.throwIfAborted()
      let handle
      try {
        handle = await ctx.agents.create({
          sessionId,
          meta,
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, preset.value)
            denyGenerationTools({ ctx: agentCtx })
          },
        })
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error))
      }

      let stopReason = 'idle'
      let runError
      let summary = { toolsUsed: [], lastAssistantText: '', lastTurnEnd: 'idle' }
      try {
        exec?.signal?.throwIfAborted()
        handle.agent.followup(createUserMessage(task.value))
        stopReason = await waitUntilIdle(handle.agent, exec.signal, {
          timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
        })
        summary = summarizeWorkerSession(handle.agent.session)
      } catch (error) {
        if (exec?.signal?.aborted) {
          stopReason = 'cancelled'
          try {
            handle.agent.cancel({ kind: 'parent' })
          } catch {
            // ignore
          }
          try {
            await handle.agent.whenIdle()
          } catch {
            // ignore
          }
        } else {
          runError = error instanceof Error ? error.message : String(error)
        }
        summary = summarizeWorkerSession(handle.agent.session)
      } finally {
        try {
          await handle.dispose()
        } catch {
          // Teardown must not mask the summary we already have.
        }
      }

      if (runError !== undefined) {
        return {
          ok: false,
          error: runError,
          sessionId: handle.agent.session.id,
          presetId: preset.value,
          stopReason: summary.lastTurnEnd,
          toolsUsed: summary.toolsUsed,
          lastAssistantText: summary.lastAssistantText,
        }
      }

      return {
        ok: true,
        sessionId: handle.agent.session.id,
        presetId: preset.value,
        stopReason: stopReason === 'cancelled' || stopReason === 'timeout'
          ? stopReason
          : summary.lastTurnEnd,
        toolsUsed: summary.toolsUsed,
        lastAssistantText: summary.lastAssistantText,
      }
    },
  }
}

function isGenerationTool(name) {
  return name === FORK_TOOL || name === RUN_TOOL
}

export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    hideGenerationToolsIfWorker(ctx, agent)
  })

  ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !isGenerationTool(execution.name)) return decision
    const reason = execution.name === FORK_TOOL
      ? 'Copy an agent preset into a new locally authored directory.'
      : 'Start a new working agent on a forked preset and run a task to idle.'
    return { kind: 'ask', reason }
  }, { prepend: true })

  ctx.systemPrompt.section({
    name: 'dsh-generation',
    order: 180,
    text: (context) => (generationToolsVisible(ctx, context.agent) ? GENERATION_SECTION : ''),
  })

  ctx.tools.register(createForkTool(ctx))
  ctx.tools.register(createRunTool(ctx))
}
