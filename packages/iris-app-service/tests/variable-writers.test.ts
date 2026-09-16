import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { SystemPluginDefinition, VariableWriteKind, VariableWriteView, VariableWriter } from '@iris/plugin-api'
import { StCompatBridge } from '@iris/compat-st-extension'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { MVU_CAPABILITY, TAVERN_HELPER_CAPABILITY } from '../src/plugins/capabilities.ts'
import { createMvuVariableWriter, type MvuCapability } from '../src/plugins/mvu.ts'
import { createTavernHelperCapability } from '../src/plugins/tavern-helper.ts'
import { IrisAppService, type Handlers, WRITER_TIMEOUT_MS } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { SystemPluginRuntime } from '../src/system-plugins.ts'

/*
 * The variable-writer registry: third writers through the activation scope,
 * the host's own two writers (ST-compat bridge floors, MVU), settlement order,
 * per-writer failure and budget, and the one place each behaviour is decided.
 *
 * The fixture deliberately mirrors `variable-arbitration.test.ts`'s shape —
 * custom builtin activations that only `provide` capabilities — because that
 * is exactly the composition the registry must serve: a host-registered MVU
 * writer has to work against a plugin definition the host did not write.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '', first_mes: 'Hello.',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
  },
})

/** What the third writer does when its `propose` is called this turn. */
type ThirdBehavior =
  | { kind: 'propose' }
  | { kind: 'gate' }
  | { kind: 'throw', message: string }
  | { kind: 'hang' }

interface ThirdControl {
  behavior: ThirdBehavior
  /** Resolved with the view each propose saw, one entry per call. */
  seen: VariableWriteView[]
  /** The gate a `gate` propose waits on; the test swaps it in and resolves it. */
  gate: Promise<void> | undefined
  release: (() => void) | undefined
  /**
   * Resolved the moment a `gate` propose is **inside** its await.
   *
   * The barrier the disable test waits on, instead of a wall clock.
   * `setTimeout(5)` assumed the settlement had reached the writer within 5 ms;
   * under parallel load it sometimes had not, the disable then raced a propose
   * that had not started, and whether the writer was "frozen into the turn" —
   * the thing the test is about — was decided by scheduler luck. This promise is
   * resolved by the code under observation, so the test cannot get ahead of it.
   * A plain promise and not a function: a caller that could resolve it would be
   * resolving its own barrier, which is how the first draft of this seam
   * silently tested nothing.
   */
  entered: Promise<void>
  /** How many `gate` proposes are parked in their await right now. */
  inPropose: number
}

function thirdControl(behavior: ThirdBehavior): ThirdControl {
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const control = { behavior, seen: [], gate: undefined, release: undefined, inPropose: 0, entered } as ThirdControl
  // The propose calls this; the test only awaits `control.entered`.
  ;(control as ThirdControl & { signalEntered: () => void }).signalEntered = enter
  return control
}

/** The third writer's proposal: its patch folded into the baseline's `stat_data`. */
function withThirdValue(view: VariableWriteView, patch: Record<string, unknown>): VariableWriteView['baseline'] {
  const statData = view.baseline['stat_data']
  return {
    ...view.baseline,
    stat_data: { ...(typeof statData === 'object' && statData !== null ? statData as Record<string, unknown> : {}), ...patch },
  }
}

interface Counts { st: number, mvu: number }

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  plugins: SystemPluginRuntime
  counts: Counts
  reports: string[]
  third: ThirdControl
  /**
   * A mutable slot run synchronously inside the `stream.end` (or
   * `stream.error`) broadcast.
   *
   * The settlement's terminal event fires **before** it releases the plugin
   * leases, so this is the one observation point where "the disable has not
   * completed yet" is deterministic rather than a race with the settle tail.
   * `settle()` resolves on that broadcast, and by the time the caller resumes
   * the lease may already have been released and the disable resolved — which
   * is exactly the flake the mid-propose test used to have. A holder object
   * rather than a settable property, so assigning it does not clash with the
   * destructured `fixture` return.
   */
  endHook: { run: (() => void) | undefined }
  settle(): Promise<void>
}

interface FixtureOptions {
  third?: ThirdControl
  /** The patch the third writer spreads into the baseline's `stat_data`. */
  thirdValue?: Record<string, unknown>
  writerTimeoutMs?: number
  stFloor?: Record<string, unknown> | undefined
}

async function fixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-variable-writers-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const counts: Counts = { st: 0, mvu: 0 }
  const third = options.third ?? thirdControl({ kind: 'propose' })
  const thirdValue = options.thirdValue ?? {}
  const definitions: SystemPluginDefinition[] = [
    {
      id: 'tavern-helper', name: 'TH', description: '', version: '1', apiVersion: 1,
      activate: scope => scope.provide(TAVERN_HELPER_CAPABILITY, createTavernHelperCapability(scope.revision)),
    },
    {
      id: 'mvu', name: 'MVU', description: '', version: '1', apiVersion: 1,
      dependencies: ['tavern-helper'],
      activate(scope) {
        const capability: MvuCapability = {
          revision: scope.revision,
          initialState: () => ({ initialized_lorebooks: {}, stat_data: { shared: 0, mvuOnly: 0 } }),
          replay: (_texts, baseline) => baseline,
          update: (_text, baseline) => {
            counts.mvu += 1
            return {
              // The baseline's own stat_data with only `shared` moved, so the
              // fixture's deltas stay one key wide and the conflict arithmetic
              // below stays readable.
              data: { ...baseline, stat_data: { ...(baseline['stat_data'] as Record<string, unknown> ?? {}), shared: 2 } },
              reports: [`MVU: turn folded (${String(counts.mvu)})`],
            }
          },
        }
        return scope.provide(MVU_CAPABILITY, capability)
      },
    },
    {
      id: 'third-writer', name: 'Third', description: '', version: '1', apiVersion: 1,
      dependencies: ['mvu'],
      activate(scope) {
        const control = third
        return scope.variables.registerWriter({
          baselineFor: view => view.baseline,
          propose: view => {
            control.seen.push(view)
            const behavior = control.behavior
            if (behavior.kind === 'throw') throw new Error(behavior.message)
            if (behavior.kind === 'hang') return new Promise(() => {})
            if (behavior.kind === 'gate') {
              const gate = control.gate ?? Promise.resolve()
              // Signal entry **before** awaiting, and count the park: the test's
              // `await entered` therefore proves `inPropose === 1`, i.e. that
              // the disable really does land while a propose is in flight.
              control.inPropose += 1
              ;(control as ThirdControl & { signalEntered: () => void }).signalEntered()
              return gate.then(
                () => { control.inPropose -= 1; return { variables: withThirdValue(view, thirdValue) } },
                error => { control.inPropose -= 1; throw error },
              )
            }
            return { variables: withThirdValue(view, thirdValue) }
          },
        })
      },
    },
  ]
  const plugins = new SystemPluginRuntime({
    context: new Context(), file: join(dir, 'plugins.json'), definitions,
  })
  await plugins.initialize()
  // Not in the default-enabled set: the fixture enables it through the real
  // lifecycle, so the writer registration under test is the activation path's
  // own, never a hand call to the runtime.
  await plugins.enable('third-writer')
  t.after(async () => { await plugins.dispose() })

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(
    join(dir, 'chats'), library,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, plugins,
  )
  const bridge = new StCompatBridge()
  const reports: string[] = []
  let ends = 0
  let awaited = 0
  const endHook: { run: (() => void) | undefined } = { run: undefined }
  let handlers: Handlers
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = '<UpdateVariable>probe</UpdateVariable>'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  handlers = new IrisAppService({
    stream, library, chats, plugins,
    diagnostics: new DiagnosticBuffer(),
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'model' }),
    ...options.writerTimeoutMs === undefined ? {} : { variableWriterTimeoutMs: options.writerTimeoutMs },
    stCompat: {
      bridge, extensionId: () => 'prompt-template', revisionOf: () => 1,
      settingsFor: async () => ({}), persistSettings: async () => {},
      installFromDirectory: async () => { throw new Error('not under test') },
    },
    broadcast(event: IrisEvent) {
      if (event.type === 'stream.end' || event.type === 'stream.error') {
        if (event.type === 'stream.error') reports.push(JSON.stringify(event))
        // Read whatever the test parked here **before** anything downstream of
        // the terminal event runs: this handler is synchronous and the leases
        // are released in the settle `finally`, after this broadcast returns.
        endHook.run?.()
        ends += 1
        return
      }
      if (event.type !== 'st-compat.request') return
      if (event.kind === 'generate') {
        const payload = event.payload as { messages: Array<{ role: string, content: string }> }
        handlers['stCompat.submit']({
          token: event.token, kind: 'generate', pluginRevision: event.revision,
          result: { kind: 'generate', messages: payload.messages, chatVariables: {}, globalVariables: {} },
        })
        return
      }
      counts.st += 1
      const payload = event.payload as { turn: number, text: string }
      handlers['stCompat.submit']({
        token: event.token, kind: 'reply', pluginRevision: event.revision,
        result: {
          kind: 'reply', turn: payload.turn, mes: payload.text,
          chatVariables: {}, globalVariables: {},
          ...options.stFloor === undefined ? {} : { floorVariables: structuredClone(options.stFloor) },
        },
      })
    },
    onError: error => { reports.push(error.message) },
  }).handlers()
  await handlers['stCompat.plane.attach']({ extensionId: 'prompt-template', pluginRevision: 1 })
  return {
    handlers, chats, plugins, counts, reports, third, endHook,
    settle: async () => {
      awaited += 1
      while (ends < awaited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

async function oneTurn(f: Fixture, text = 'go'): Promise<{ variables: Record<string, unknown>, commits: number, reports: string[] }> {
  const created = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const entry = await f.chats.open(chatId)
  const before = entry.session.events.filter(event => event.type === 'iris/variables').length
  await f.handlers['chat.send']({ chatId, text })
  await f.settle()
  const after = entry.session.events.filter(event => event.type === 'iris/variables').length
  const variables = await f.handlers['script.getVariables']({ chatId, scope: 'message', messageId: 'latest' })
  const debug = await f.handlers['debug.reports']({})
  return {
    variables: variables.variables,
    commits: after - before,
    reports: debug.reports.map(report => report.message),
  }
}

// --- T1/T2: the third writer joins, after ST and MVU, by (depth, id) ---------

test('a third writer joins through the scope and lands after ST and MVU', async (t) => {
  const f = await fixture(t, {
    stFloor: { stat_data: { shared: 1 } },
    thirdValue: { shared: 3 },
  })
  const result = await oneTurn(f)
  assert.deepEqual(f.counts, { st: 1, mvu: 1 }, JSON.stringify({ result, errors: f.reports }))
  assert.equal(result.commits, 1)
  // Same key written by all three: the last participant wins, and the last
  // participant is the one whose plugin depends on the other writers' plugin.
  assert.equal((result.variables['stat_data'] as Record<string, unknown>)['shared'], 3)
  const conflicts = result.reports.filter(message => message.includes('message variable conflict'))
  assert.equal(conflicts.length, 2, `expected two conflicts, got ${JSON.stringify(result.reports)}`)
  assert.ok(conflicts[0]?.includes('mvu won'), conflicts.join('\n'))
  assert.ok(conflicts[1]?.includes('third-writer won'), conflicts.join('\n'))
})

test('settlement order is (dependency depth, id): prompt-template, mvu, third-writer', async (t) => {
  const f = await fixture(t, { thirdValue: {} })
  await oneTurn(f)
  // The full sequence, not a membership check: a comparator simplified to the
  // id alone sorts 'mvu' before 'prompt-template' alphabetically and reverses
  // a decade of upstream handler order — the exact silent regression this
  // assertion exists to redden.
  assert.deepEqual(
    f.plugins.orderedVariableWriters().map(entry => entry.pluginId),
    ['prompt-template', 'mvu', 'third-writer'],
  )
})

// --- T3: disabling a writer removes its proposals from the next settlement ---

test('disabling a writer leaves the next turn to the writers that remain', async (t) => {
  const f = await fixture(t, {
    stFloor: { stat_data: { shared: 1 } },
    thirdValue: { shared: 3 },
  })
  await oneTurn(f)
  await f.plugins.disable('third-writer')
  // Gone from the registry view, not merely muted.
  assert.equal(
    f.plugins.orderedVariableWriters().some(entry => entry.pluginId === 'third-writer'),
    false,
    'a disabled writer still appears in the settlement order',
  )
  const result = await oneTurn(f)
  assert.equal((result.variables['stat_data'] as Record<string, unknown>)['shared'], 2)
  assert.equal(result.variables['third'], undefined)
})

// --- T4: a disable that lands mid-propose waits behind the settlement lease --

test('a disable issued mid-propose does not tear the turn it lands in', async (t) => {
  const f = await fixture(t, {
    third: thirdControl({ kind: 'gate' }),
    thirdValue: { shared: 3 },
  })
  /*
   * The gate is set **before** the turn starts, so the writer's first propose
   * is the one that parks — there is no window where a propose could run
   * against the default resolved gate and make "the disable lands mid-propose"
   * untrue. Awaiting `entered()` then waits on a signal the code under
   * observation emits from inside that propose, not on a clock: the old
   * `setTimeout(5)` assumed settlement had reached the writer within 5 ms,
   * which under parallel load it sometimes had not.
   */
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.third.gate = gate
  const created = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await f.handlers['chat.send']({ chatId, text: 'go' })

  // Parked inside propose now: the writer's lease is held by the generation,
  // so the disable cannot complete — and must not — until settlement releases
  // it. The participant set was frozen at snapshot; this turn keeps the
  // proposal, and the next turn does not have the writer at all.
  await f.third.entered
  // The positive control: `entered()` resolving means the writer is *inside*
  // its propose right now, so the disable below lands on a parked propose and
  // not on a turn that has not reached it yet. A lying or wall-clock barrier
  // cannot say this — the count is incremented by the code under observation
  // immediately before its await.
  assert.equal(f.third.inPropose, 1, 'the barrier fired while no propose was parked, so the disable would race the turn')
  const disabling = f.plugins.disable('third-writer')
  /*
   * The mid-turn observation is taken **inside the `stream.end` broadcast**, not
   * after `settle()` resumes.
   *
   * `settle()` resolves when it sees that broadcast, but `#settle` keeps going
   * past it — `#announceChats`, the settle `finally`, the lease release — so by
   * the time the awaiting caller gets its turn the disable may already have
   * resolved. Asserting `disabled === false` out there was a race the scheduler
   * sometimes lost (the CI red this task is about). The `endHook` fires
   * synchronously from the broadcast handler, before the settle tail, where
   * "the disable has not completed yet" is true by construction: the writer's
   * lease is still held.
   */
  let disabledWhenEnded: boolean | undefined
  f.endHook.run = () => { disabledWhenEnded = disabled }
  let disabled = false
  void disabling.then(() => { disabled = true })
  release()
  await f.settle()

  const variables = await f.handlers['script.getVariables']({ chatId, scope: 'message', messageId: 'latest' })
  assert.equal((variables.variables['stat_data'] as Record<string, unknown>)['shared'], 3,
    'a writer frozen into the settlement lost its proposal to a mid-turn disable')
  assert.equal(disabledWhenEnded, false, 'the disable completed before the terminal event, while the writer still held its lease')
  await disabling
  assert.equal(disabled, true, 'the disable never completed after the settlement released the lease')

  const next = await oneTurn(f)
  assert.equal((next.variables['stat_data'] as Record<string, unknown>)['shared'], 2,
    'a disabled writer still wrote on the turn after its disable')
})

// --- T5: a throwing writer is a row note, not a broken reply -----------------

test('a writer that throws settles the reply and marks the row hook-failed', async (t) => {
  const f = await fixture(t, {
    third: thirdControl({ kind: 'throw', message: 'third writer exploded' }),
    stFloor: { stat_data: { shared: 1 } },
  })
  const result = await oneTurn(f)
  // The reply settled: one commit, ST and MVU both applied — and MVU, running
  // after ST, is the one whose shared value survives.
  assert.deepEqual(f.counts, { st: 1, mvu: 1 }, JSON.stringify({ result, errors: f.reports }))
  assert.equal(result.commits, 1)
  assert.equal((result.variables['stat_data'] as Record<string, unknown>)['shared'], 2)
  // The row carries the fault without stopping the plugin.
  const failure = f.plugins.failure('third-writer')
  assert.ok(failure !== undefined, 'the failed writer left no row note')
  assert.equal(failure?.state, 'hook-failed')
  assert.ok(failure?.reason.includes('third writer exploded'), failure?.reason ?? '')
  const row = f.plugins.snapshot().plugins.find(plugin => plugin.id === 'third-writer')
  assert.equal(row?.enabled, true, 'a hook failure disabled the plugin')
  assert.equal(row?.status, 'enabled', 'a hook failure errored the row')
})

// --- T6: the budget is enforced by the race, not by the signal alone ---------

test('a writer past its budget is cut off and the reply still settles', async (t) => {
  const f = await fixture(t, {
    third: thirdControl({ kind: 'hang' }),
    writerTimeoutMs: 20,
  })
  const result = await oneTurn(f)
  assert.deepEqual(f.counts, { st: 1, mvu: 1 })
  assert.equal(result.commits, 1, 'a hung writer took the reply down with it')
  const failure = f.plugins.failure('third-writer')
  assert.equal(failure?.state, 'hook-failed')
  assert.ok(failure?.reason.includes('budget'), failure?.reason ?? '')
})

test('the shipped writer budget is five seconds', () => {
  assert.equal(WRITER_TIMEOUT_MS, 5000)
})

// --- T7: hook-failed clears on the next successful proposal, and only that ---

test('a successful proposal clears the row note, and only a hook-failed one', async (t) => {
  const failing = await fixture(t, {
    third: thirdControl({ kind: 'throw', message: 'once' }),
    thirdValue: { third: 1 },
  })

  await oneTurn(failing)
  assert.equal(failing.plugins.failure('third-writer')?.state, 'hook-failed')
  // The throw was one turn's opinion; the writer proposing normally again
  // clears its own note.
  failing.third.behavior = { kind: 'propose' }
  const recovered = await oneTurn(failing)
  assert.equal(failing.plugins.failure('third-writer'), undefined)
  assert.equal((recovered.variables['stat_data'] as Record<string, unknown>)['third'], 1)

  // The guard: a settlement may clear its own hook note, never an install
  // verdict. Direct runtime calls, because a tampered row's writers never run.
  const tampered = await fixture(t, { thirdValue: {} })
  tampered.plugins.markFailure('mvu', { state: 'tampered', reason: 'planted' })
  tampered.plugins.clearHookFailure('mvu')
  assert.equal(tampered.plugins.failure('mvu')?.state, 'tampered', 'clearHookFailure washed an install verdict')
  tampered.plugins.clearHookFailure('nobody')
  assert.equal(tampered.plugins.failure('nobody'), undefined)
})

// --- T8: the MVU writer's own rules, on fake views ---------------------------

function fakeView(overrides: Partial<VariableWriteView> = {}): VariableWriteView {
  return {
    chatId: 'c', turn: 2, kind: 'send', reason: 'completed', text: 'reply',
    baseline: {},
    variablesAt: () => undefined,
    declared: { initialized_lorebooks: {}, stat_data: { declared: true } },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function fakeCapability(update?: MvuCapability['update']): MvuCapability {
  return {
    revision: 1,
    initialState: () => ({ initialized_lorebooks: {}, stat_data: {} }),
    replay: (_texts, baseline) => baseline,
    update: update ?? ((_text, baseline) => ({ data: baseline, reports: [] })),
  }
}

test('the MVU writer refuses impersonations and answers the other kinds', () => {
  const writer = createMvuVariableWriter(fakeCapability())
  assert.equal(writer.propose(fakeView({ kind: 'impersonate' })), undefined)
  for (const kind of ['send', 'regenerate', 'continue'] satisfies VariableWriteKind[]) {
    assert.ok(writer.propose(fakeView({ kind })) !== undefined, `${kind} produced no proposal`)
  }
})

test('the MVU writer walks back to the nearest MVU table and falls back to declarations', () => {
  const writer = createMvuVariableWriter(fakeCapability())
  const mvuTurn = { initialized_lorebooks: {}, stat_data: { count: 7 } }
  // 1 is a plain table another writer left; 0 is the state MVU inherits from.
  const view = fakeView({
    turn: 2,
    variablesAt: turn => turn === 1 ? { other: true } : turn === 0 ? mvuTurn : undefined,
    declared: { initialized_lorebooks: {}, stat_data: { declared: true } },
  })
  assert.deepEqual(writer.baselineFor(view), mvuTurn)
  // No stored table at all: the card's declarations are the floor.
  assert.deepEqual(writer.baselineFor(fakeView({ variablesAt: () => undefined })), view.declared)
})

test('the MVU writer returns its engine reports under the mvu kind', async () => {
  const writer = createMvuVariableWriter(fakeCapability((_text, baseline) => ({
    data: baseline,
    reports: ['MVU: a dropped command'],
  })))
  const proposal = await writer.propose(fakeView())
  assert.deepEqual(proposal?.reports, ['MVU: a dropped command'])
  assert.equal(proposal?.reportKind, 'mvu')
})

// --- T9: an aborted partial keeps MVU and keeps the bridge out ---------------

test('an aborted partial settles through MVU and never through the bridge', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-variable-writers-abort-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  let mvuCalls = 0
  const definitions: SystemPluginDefinition[] = [
    {
      id: 'tavern-helper', name: 'TH', description: '', version: '1', apiVersion: 1,
      activate: scope => scope.provide(TAVERN_HELPER_CAPABILITY, createTavernHelperCapability(scope.revision)),
    },
    {
      id: 'mvu', name: 'MVU', description: '', version: '1', apiVersion: 1,
      dependencies: ['tavern-helper'],
      activate(scope) {
        const capability: MvuCapability = {
          revision: scope.revision,
          initialState: () => ({ initialized_lorebooks: {}, stat_data: { mvuOnly: 0 } }),
          replay: (_texts, baseline) => baseline,
          update: (_text, baseline) => {
            mvuCalls += 1
            return { data: { ...baseline, stat_data: { mvuOnly: 9 } }, reports: [] }
          },
        }
        return scope.provide(MVU_CAPABILITY, capability)
      },
    },
  ]
  const plugins = new SystemPluginRuntime({ context: new Context(), file: join(dir, 'plugins.json'), definitions })
  await plugins.initialize()
  t.after(async () => { await plugins.dispose() })

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(
    join(dir, 'chats'), library,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, plugins,
  )
  const counts = { st: 0 }
  let ends = 0
  let handlers: Handlers
  const stalling: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '*She opens her mouth to' }
    await new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('the turn was aborted')) }, { once: true })
    })
  }
  handlers = new IrisAppService({
    stream: stalling, library, chats, plugins,
    diagnostics: new DiagnosticBuffer(),
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'model' }),
    stCompat: {
      bridge: new StCompatBridge(), extensionId: () => 'prompt-template', revisionOf: () => 1,
      settingsFor: async () => ({}), persistSettings: async () => {},
      installFromDirectory: async () => { throw new Error('not under test') },
    },
    broadcast(event: IrisEvent) {
      if (event.type === 'stream.end') { ends += 1; return }
      if (event.type !== 'st-compat.request') return
      if (event.kind === 'reply') {
        counts.st += 1
        handlers['stCompat.submit']({
          token: event.token, kind: 'reply', pluginRevision: event.revision,
          result: {
            kind: 'reply', turn: (event.payload as { turn: number }).turn, mes: 'rewritten',
            chatVariables: {}, globalVariables: {}, floorVariables: { stOnly: 1 },
          },
        })
      }
    },
    onError: () => {},
  }).handlers()
  await handlers['stCompat.plane.attach']({ extensionId: 'prompt-template', pluginRevision: 1 })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const ending = new Promise<void>(resolve => {
    const timer = setInterval(() => { if (ends > 0) { clearInterval(timer); resolve() } }, 1)
    t.after(() => { clearInterval(timer) })
  })
  await handlers['chat.send']({ chatId, text: 'go' })
  await new Promise(resolve => setTimeout(resolve, 20))
  await handlers['chat.abort']({ chatId })
  await ending

  // The partial was kept and settled, MVU wrote it, the bridge was never run.
  assert.equal(mvuCalls, 1, 'an aborted turn skipped the MVU writer')
  assert.equal(counts.st, 0, 'an aborted turn ran the reply bridge')
  const variables = await handlers['script.getVariables']({ chatId, scope: 'message', messageId: 'latest' })
  assert.equal((variables.variables['stat_data'] as Record<string, unknown>)['mvuOnly'], 9)
  assert.equal(variables.variables['stOnly'], undefined,
    'an aborted turn carried a bridge floor proposal')
})

// --- T10: no runtime at all keeps the always-on compatibility writer ---------

test('a service composed without a plugin runtime still writes MVU variables', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-variable-writers-legacy-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  let ends = 0
  let handlers: Handlers
  const stream: StreamFn = async function* (): AsyncIterable<StreamChunk> {
    const text = "<UpdateVariable>_.set('count', 5);</UpdateVariable>"
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  handlers = new IrisAppService({
    stream, library, chats,
    diagnostics: new DiagnosticBuffer(),
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    onError: () => {},
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  // The real COMPAT_MVU engine inherits from the nearest earlier MVU table, so
  // the fixture plants one on the greeting turn through the script face (the
  // same write `st-compat-floor-variables.test.ts` uses) — with no runtime
  // there is no capability to seed declarations from.
  await handlers['script.setVariables']({
    chatId, scope: 'message', messageId: 0, op: 'insertOrAssign', variables: { stat_data: { count: 0 } },
  })
  await handlers['chat.send']({ chatId, text: 'go' })
  while (ends < 1) await new Promise(resolve => setTimeout(resolve, 1))
  const variables = await handlers['script.getVariables']({ chatId, scope: 'message', messageId: 'latest' })
  assert.equal((variables.variables['stat_data'] as Record<string, unknown>)['count'], 5,
    'the compatibility MVU writer stopped writing without a runtime')
})

// --- T11: the settlement range names no plugin id ----------------------------

test('the settlement range carries no quoted plugin id', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const source = await readFile(
    fileURLToPath(new URL('../src/service.ts', import.meta.url)),
    'utf8',
  )
  // Anchored by symbol, never by line: a stale anchor that yields an empty
  // slice would agree with every reintroduced literal, so the slice carries a
  // floor too.
  const start = source.indexOf('const impersonating = request.kind')
  const end = source.indexOf('arbitrateMessageVariables(')
  assert.notEqual(start, -1, 'the settlement anchor moved')
  assert.notEqual(end, -1, 'the arbitration anchor moved')
  const slice = source.slice(start, end)
  assert.ok(slice.length > 2000, `the settlement slice collapsed to ${String(slice.length)} chars`)
  for (const id of ['mvu', 'prompt-template']) {
    assert.doesNotMatch(slice, new RegExp(`['"]${id}['"]`),
      `the settlement still names "${id}" — the registry is no longer the only proposal source`)
  }
  // The one whitelist entry, with its reason: Tavern Helper's lease pins the
  // macro expander for the whole generation and has no variable role at all.
  assert.match(slice, /['"]tavern-helper['"]/)
})
