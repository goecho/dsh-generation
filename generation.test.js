import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CREATOR_PRESET,
  FORK_TOOL,
  RUN_TOOL,
  WORKER_BASE_PRESETS,
  apply,
  createForkTool,
  createRunTool,
  createUserMessage,
  hideGenerationToolsIfWorker,
  isPresetId,
  renderPresetYml,
  summarizeWorkerSession,
  waitUntilIdle,
} from './generation.js'

function message(role, text) {
  return { role, content: [{ type: 'text', text }] }
}

function harness({
  compositionById = { cordis: 'name: \'@deepseek-ai/dsh-tool-cordis\'', standard: 'name: \'@deepseek-ai/dsh-tool-fs\'' },
  composedPreset = 'cordis',
  cwd = '/workspace',
  origin,
  copyImpl,
  createImpl,
} = {}) {
  const copied = []
  const restricted = []
  const mounted = []
  const created = []
  const disposed = []
  const followups = []
  const cancelled = []
  let tools = {}
  const listeners = new Map()
  const sections = []

  const session = {
    id: 'meta-session',
    header: { cwd, origin, delegationDepth: 0 },
    events: [],
    deriveMessages: () => [],
  }

  const agent = {
    session,
    ctx: {
      tools: {
        restrict(filter) {
          restricted.push(filter)
        },
      },
    },
    followup(msg) { followups.push(msg) },
    cancel(cause) { cancelled.push(cause) },
    whenIdle: async () => {},
  }

  const ctx = {
    agentPresets: {
      composedPreset() { return composedPreset },
      async read(id) {
        if (!Object.hasOwn(compositionById, id)) throw new Error(`unknown preset ${id}`)
        return compositionById[id]
      },
      async copy(from, id, name) {
        if (copyImpl) return copyImpl(from, id, name)
        copied.push({ from, id, name })
      },
      async resolve(id) {
        return { id, path: join(this._dir, id, 'agent.cordis.yml') }
      },
      async mount(agentCtx, id) {
        mounted.push({ id })
      },
      _dir: '',
    },
    agents: {
      async create(options) {
        if (createImpl) return createImpl(options, { created, disposed, followups, cancelled })
        created.push(options)
        await options.setup?.({ tools: { restrict(filter) { restricted.push(filter) } } })
        const workerSession = {
          id: options.sessionId,
          header: options.meta,
          events: [],
          deriveMessages: () => [message('assistant', 'done')],
        }
        const worker = {
          session: workerSession,
          ctx: { tools: { restrict(filter) { restricted.push(filter) } } },
          followup(msg) { followups.push(msg) },
          cancel(cause) { cancelled.push(cause) },
          whenIdle: async () => {},
        }
        return {
          agent: worker,
          async dispose() { disposed.push(workerSession.id) },
        }
      },
    },
    tools: {
      register(definition) { tools[definition.name] = definition },
      get(name) { return tools[name] },
    },
    systemPrompt: {
      section(section) { sections.push(section) },
    },
    on(event, callback, options) { listeners.set(event, { callback, options }) },
  }

  return {
    ctx,
    agent,
    copied,
    restricted,
    mounted,
    created,
    disposed,
    followups,
    cancelled,
    listeners,
    sections,
  }
}

test('preset ids match the roster containment pattern', () => {
  assert.equal(isPresetId('standard'), true)
  assert.equal(isPresetId('gen-1'), true)
  assert.equal(isPresetId('Cordis'), false)
  assert.equal(isPresetId('../etc'), false)
  assert.equal(isPresetId(''), false)
})

test('preset.yml dump is YAML-safe for quotes and newlines', () => {
  const yaml = renderPresetYml({
    name: 'gen-1',
    description: 'say "hello"\nnext line',
  })
  assert.equal(yaml, 'name: "gen-1"\ndescription: "say \\"hello\\"\\nnext line"\n')
})

test('summarizeWorkerSession keeps tool order and last assistant text', () => {
  const session = {
    events: [
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'tool/call', data: { name: 'fs_read' } },
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
    deriveMessages: () => [
      message('user', 'do the thing'),
      message('assistant', 'first'),
      message('assistant', 'final answer'),
    ],
  }
  assert.deepEqual(summarizeWorkerSession(session), {
    toolsUsed: ['bash', 'fs_read'],
    lastAssistantText: 'final answer',
    lastTurnEnd: 'completed',
  })
})

test('summarizeWorkerSession truncates a long last assistant message', () => {
  const session = {
    events: [],
    deriveMessages: () => [message('assistant', 'x'.repeat(5000))],
  }
  const summary = summarizeWorkerSession(session, { maxAssistantChars: 8 })
  assert.equal(summary.lastAssistantText, 'xxxxxxxx…')
})

test('createUserMessage is a frozen user-role inbox value', () => {
  const msg = createUserMessage('run tests')
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'user')
  assert.equal(msg.content[0].text, 'run tests')
  assert.equal(Object.isFrozen(msg), true)
  assert.equal(Object.isFrozen(msg.content), true)
  assert.throws(() => { msg.role = 'assistant' })
})

test('waitUntilIdle cancels the worker when the parent signal aborts', async () => {
  const cancelled = []
  let resolveIdle
  const idle = new Promise((resolve) => { resolveIdle = resolve })
  const agent = {
    cancel(cause) {
      cancelled.push(cause)
      resolveIdle()
    },
    whenIdle: async () => idle,
  }
  const controller = new AbortController()
  const waiting = waitUntilIdle(agent, controller.signal)
  controller.abort()
  assert.equal(await waiting, 'cancelled')
  assert.deepEqual(cancelled, [{ kind: 'parent' }])
})

test('mutations require approval while downstream veto is preserved', async () => {
  const bench = harness()
  apply(bench.ctx)
  const preTool = bench.listeners.get('tools/pre-execute')
  assert.deepEqual(preTool.options, { prepend: true })

  const denied = { kind: 'deny', reason: 'policy veto' }
  assert.equal(
    await preTool.callback({ name: FORK_TOOL, arguments: {} }, async () => denied),
    denied,
  )
  assert.deepEqual(
    await preTool.callback({ name: 'bash', arguments: {} }, async () => ({ kind: 'allow' })),
    { kind: 'allow' },
  )
  assert.deepEqual(
    await preTool.callback({ name: RUN_TOOL, arguments: {} }, async () => ({ kind: 'allow' })),
    {
      kind: 'ask',
      reason: 'Start a new working agent on a forked preset and run a task to idle.',
    },
  )
})

test('hides tools from shipped working presets and subagents', () => {
  const restricted = []
  const agent = {
    session: { header: { origin: 'subagent' } },
    ctx: { tools: { restrict(filter) { restricted.push(filter) } } },
  }
  hideGenerationToolsIfWorker({}, agent)
  assert.deepEqual(restricted, [{ deny: [FORK_TOOL, RUN_TOOL] }])

  restricted.length = 0
  const standard = {
    session: { header: {} },
    ctx: { tools: { restrict(filter) { restricted.push(filter) } } },
  }
  hideGenerationToolsIfWorker({
    agentPresets: { composedPreset: () => 'standard' },
  }, standard)
  assert.deepEqual(restricted, [{ deny: [FORK_TOOL, RUN_TOOL] }])
  assert.ok(WORKER_BASE_PRESETS.includes('minimal'))

  restricted.length = 0
  const creator = {
    session: { header: {} },
    ctx: { tools: { restrict(filter) { restricted.push(filter) } } },
  }
  hideGenerationToolsIfWorker({
    agentPresets: { composedPreset: () => CREATOR_PRESET },
  }, creator)
  assert.deepEqual(restricted, [])
})

test('generation_fork copies then writes purpose into preset.yml', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-generation-'))
  const dir = join(root, 'gen-1')
  await mkdir(dir)
  await writeFile(join(dir, 'agent.cordis.yml'), '[]\n')

  try {
    const bench = harness()
    bench.ctx.agentPresets._dir = root
    bench.ctx.agentPresets.resolve = async (id) => ({ id, path: join(root, id, 'agent.cordis.yml') })
    const tool = createForkTool(bench.ctx)
    const result = await tool.execute(
      { from: 'standard', id: 'gen-1', purpose: 'try a thinner toolset' },
      { agent: bench.agent, signal: new AbortController().signal },
    )
    assert.equal(result.ok, true)
    assert.equal(result.path, dir)
    assert.deepEqual(bench.copied, [{ from: 'standard', id: 'gen-1', name: 'gen-1' }])
    const yaml = await readFile(join(dir, 'preset.yml'), 'utf8')
    assert.equal(yaml, 'name: "gen-1"\ndescription: "try a thinner toolset"\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generation_fork refuses a bad id and a subagent caller', async () => {
  const bench = harness()
  const tool = createForkTool(bench.ctx)
  const badId = await tool.execute(
    { from: 'standard', id: 'Nope', purpose: 'x' },
    { agent: bench.agent, signal: new AbortController().signal },
  )
  assert.equal(badId.ok, false)
  assert.match(badId.error, /must match/)

  const sub = harness({ origin: 'subagent' })
  const refused = await createForkTool(sub.ctx).execute(
    { from: 'standard', id: 'gen-1', purpose: 'x' },
    { agent: sub.agent, signal: new AbortController().signal },
  )
  assert.equal(refused.ok, false)
  assert.match(refused.error, /cannot run on a subagent/)
})

test('generation_fork refuses overwrite reported by copy', async () => {
  const bench = harness({
    copyImpl: async () => {
      throw new Error('agent-presets: preset "gen-1" already exists — a copy never overwrites')
    },
  })
  const result = await createForkTool(bench.ctx).execute(
    { from: 'standard', id: 'gen-1', purpose: 'again' },
    { agent: bench.agent, signal: new AbortController().signal },
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /already exists/)
})

test('generation_run refuses cordis and creator-capable copies', async () => {
  const bench = harness()
  const tool = createRunTool(bench.ctx)
  const exec = { agent: bench.agent, signal: new AbortController().signal }

  const cordis = await tool.execute({ preset: 'cordis', task: 'hello' }, exec)
  assert.equal(cordis.ok, false)
  assert.match(cordis.error, /Creator mode/)

  const creatorCopy = await tool.execute({ preset: 'my-creator', task: 'hello' }, exec)
  assert.equal(creatorCopy.ok, false)
  // unknown preset read fails before the creator-plugin check
  assert.match(creatorCopy.error, /unknown preset/)

  const withCreator = harness({
    compositionById: {
      cordis: 'dsh-tool-cordis',
      'almost-worker': 'name: @deepseek-ai/dsh-tool-cordis',
    },
  })
  const refused = await createRunTool(withCreator.ctx).execute(
    { preset: 'almost-worker', task: 'hello' },
    { agent: withCreator.agent, signal: new AbortController().signal },
  )
  assert.equal(refused.ok, false)
  assert.match(refused.error, /still includes dsh-tool-cordis/)
})

test('generation_run mounts, follows up, summarizes, and disposes', async () => {
  const bench = harness({
    compositionById: {
      cordis: 'dsh-tool-cordis',
      'gen-1': 'name: @deepseek-ai/dsh-tool-fs',
    },
  })
  const result = await createRunTool(bench.ctx).execute(
    { preset: 'gen-1', task: 'list the files' },
    { agent: bench.agent, signal: new AbortController().signal },
  )
  assert.equal(result.ok, true)
  assert.equal(result.presetId, 'gen-1')
  assert.equal(result.lastAssistantText, 'done')
  assert.equal(result.stopReason, 'idle')
  assert.equal(bench.created.length, 1)
  assert.equal(bench.created[0].meta.origin, 'subagent')
  assert.equal(bench.created[0].meta.parentSession, 'meta-session')
  assert.equal(bench.created[0].meta.cwd, '/workspace')
  assert.equal(bench.created[0].meta.agentPreset, 'gen-1')
  assert.deepEqual(bench.mounted, [{ id: 'gen-1' }])
  assert.equal(bench.followups[0].content[0].text, 'list the files')
  assert.equal(bench.disposed.length, 1)
  assert.ok(bench.restricted.some(filter => filter.deny.includes(FORK_TOOL)))
})

test('generation_run is refused on a standard session', async () => {
  const bench = harness({
    composedPreset: 'standard',
    compositionById: { standard: 'name: @deepseek-ai/dsh-tool-fs' },
  })
  const result = await createRunTool(bench.ctx).execute(
    { preset: 'gen-1', task: 'hello' },
    { agent: bench.agent, signal: new AbortController().signal },
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /Creator mode/)
})

test('apply registers both tools and a prompt section', () => {
  const registered = []
  const sections = []
  const listeners = new Map()
  const ctx = {
    agentPresets: { composedPreset: () => 'cordis' },
    agents: {},
    tools: {
      register(definition) { registered.push(definition.name) },
      get(name) { return registered.includes(name) ? { name } : undefined },
    },
    systemPrompt: { section(section) { sections.push(section) } },
    on(event, callback, options) { listeners.set(event, { callback, options }) },
  }
  apply(ctx)
  assert.deepEqual(registered, [FORK_TOOL, RUN_TOOL])
  assert.equal(sections[0].name, 'dsh-generation')
  assert.match(sections[0].text({ agent: { ctx: {} } }), /make, not a compiler/)
  assert.ok(listeners.has('tools/pre-execute'))
  assert.ok(listeners.has('agent/created'))
})
