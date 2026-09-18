/**
 * The sandbox-plugin tree: what it compiles, what it waits for, what it takes
 * away.
 *
 * Everything here is driven through the tree's injected seams — the compiler,
 * the clock, the two sinks — because the three things worth pinning cannot be
 * observed any other way:
 *
 * - **the bytes handed to the compiler**, which is the only honest form of the
 *   "the precheck and the mount share one wrapper" claim (§6.1). Calling the
 *   shared helper twice and comparing it with itself would pass whatever either
 *   real call site does.
 * - **the difference between failing and being slow**, which needs a clock a
 *   test can hold still.
 * - **the teardown checklist as a counted list**, because the way this goes
 *   wrong is that one of six items stops being done and nothing says so.
 *
 * @module iris-web/tests/plugin-tree
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  precheckSandboxPluginSyntax,
  SANDBOX_PLUGIN_FACADE_PARAM,
  SANDBOX_PLUGIN_LIMITS,
} from '@iris/protocol'

import {
  createSandboxPluginTree,
  SANDBOX_PLUGIN_TEARDOWN_ITEMS,
  type SandboxPluginOutcome,
  type SandboxPluginTreeEnv,
} from '../src/sandbox/plugin-tree.ts'

/** What one construction of the harness recorded. */
interface Bench {
  env: SandboxPluginTreeEnv
  /** Every `(param, body)` pair the tree handed a compiler. */
  compiled: { param: string, body: string }[]
  outcomes: SandboxPluginOutcome[]
  notes: string[]
  /** Style sheets inserted, as `pluginId:css`; and the ids cleared. */
  inserted: string[]
  stylesCleared: string[]
  panelsRemoved: string[]
  tracesCleared: string[]
  publishedStyles: string[]
  /** Move the fake clock and fire every deadline that has now expired. */
  advance: (ms: number) => void
}

/**
 * A tree with every seam recorded and a clock the test holds.
 * @param overrides - seams to replace.
 * @returns the bench.
 */
function bench(overrides: Partial<SandboxPluginTreeEnv> = {}): Bench {
  const compiled: { param: string, body: string }[] = []
  const outcomes: SandboxPluginOutcome[] = []
  const notes: string[] = []
  const inserted: string[] = []
  const stylesCleared: string[] = []
  const panelsRemoved: string[] = []
  const tracesCleared: string[] = []
  const publishedStyles: string[] = []
  let clock = 1_000
  const timers: { at: number, fire: () => void, cancelled: boolean }[] = []

  const env: SandboxPluginTreeEnv = {
    compile: (param, body) => {
      compiled.push({ param, body })
      // The real compiler, so a body that cannot be parsed fails here exactly as
      // it would in a frame — a stub that always returned a function would make
      // `mount-failed` on a syntax error untestable.
      return new Function(param, body)
    },
    styles: {
      insert: (pluginId, css) => {
        inserted.push(`${pluginId}:${css}`)
        return () => undefined
      },
      clear: pluginId => {
        stylesCleared.push(pluginId)
        return 0
      },
    },
    panel: {
      mount: () => () => undefined,
      remove: pluginId => panelsRemoved.push(pluginId),
      setVisible: () => undefined,
    },
    cardSurface: () => ({}),
    clearMemberTraces: pluginId => {
      tracesCleared.push(pluginId)
    },
    now: () => clock,
    after: (ms, fire) => {
      const timer = { at: clock + ms, fire, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    report: outcome => outcomes.push(outcome),
    publishStyle: (pluginId, css) => publishedStyles.push(`${pluginId}:${css}`),
    note: message => notes.push(message),
    ...overrides,
  }

  return {
    env,
    compiled,
    outcomes,
    notes,
    inserted,
    stylesCleared,
    panelsRemoved,
    tracesCleared,
    publishedStyles,
    advance: ms => {
      clock += ms
      for (const timer of [...timers]) {
        if (timer.cancelled || timer.at > clock) continue
        timer.cancelled = true
        timer.fire()
      }
    },
  }
}

/** Let the tree's promise chain drain. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

test('the mount compiles exactly what the host precheck compiles', async () => {
  /*
   * §6.1, and it is the **only** executor of that ruling.
   *
   * dsh paid for this one: a precheck with its own wrapper passes code the
   * mount's wrapper cannot parse, and the check then only makes people feel
   * safer. The two halves here are genuinely two — one reaches its compiler
   * through `precheckSandboxPluginSyntax`, the other through the tree's
   * injected `compile` — so this compares the bytes each side actually handed
   * over rather than two calls to one helper.
   */
  const source = 'return { apply() {} }'

  const host: { param: string, body: string }[] = []
  precheckSandboxPluginSyntax(source, (param, body) => {
    host.push({ param, body })
    return new Function(param, body)
  })

  const frame = bench()
  const tree = createSandboxPluginTree(frame.env)
  await tree.mount({ pluginId: 'p', version: 1, code: source })
  await settle()

  assert.equal(host.length, 1, 'the precheck must have compiled exactly once')
  assert.equal(frame.compiled.length, 1, 'the mount must have compiled exactly once')
  assert.equal(
    frame.compiled[0]?.param,
    host[0]?.param,
    'the facade parameter must be one name, not two spellings',
  )
  assert.equal(
    frame.compiled[0]?.body,
    host[0]?.body,
    'byte for byte: a precheck that compiles a different source checks nothing',
  )
  // Positive control, so the equality above cannot be satisfied by two empties.
  assert.equal(host[0]?.param, SANDBOX_PLUGIN_FACADE_PARAM)
  assert.match(host[0]?.body ?? '', /^"use strict";\n/u)
  assert.ok((host[0]?.body ?? '').includes(source))
})

test('a factory that throws is mount-failed, and the frame keeps going', async () => {
  const frame = bench()
  const tree = createSandboxPluginTree(frame.env)
  await tree.mount({ pluginId: 'p', version: 3, code: 'throw new Error("boom")' })
  await settle()

  assert.deepEqual(
    frame.outcomes.map(row => row.kind === 'failed' ? `${row.state}` : row.kind),
    ['mount-failed'],
  )
  const failed = frame.outcomes[0]
  assert.ok(failed?.kind === 'failed')
  assert.match(failed.detail, /boom/u)
  assert.equal(failed.version, 3, 'the version is carried, so a replace can be told from a first mount')
  assert.deepEqual(tree.mounted(), [], 'nothing that threw is on the tree')
})

test('an apply that throws is mount-failed, not mount-timeout', async () => {
  // The two are split because the fixes are different: one is wrong code, the
  // other is slow code. A single state would send every reader to the same place.
  const frame = bench()
  const tree = createSandboxPluginTree(frame.env)
  await tree.mount({
    pluginId: 'p',
    version: 1,
    code: 'return { apply() { throw new Error("in apply") } }',
  })
  await settle()

  const failed = frame.outcomes[0]
  assert.ok(failed?.kind === 'failed')
  assert.equal(failed.state, 'mount-failed')
  assert.match(failed.detail, /in apply/u)
})

test('an apply that never settles is mount-timeout at its deadline, and lands on the tree', async () => {
  const frame = bench()
  const tree = createSandboxPluginTree(frame.env)
  const running = tree.mount({
    pluginId: 'p',
    version: 1,
    code: 'return { apply() { return new Promise(() => {}) } }',
  })
  await settle()
  // The length, not the array: `deepEqual` against `[]` narrows the recorded
  // list to `never[]` for the rest of the function, which turns every reading
  // below it into a type error rather than an assertion.
  assert.equal(frame.outcomes.length, 0, 'nothing is decided before the deadline')

  frame.advance(SANDBOX_PLUGIN_LIMITS.applyMs)
  await running
  await settle()

  const failed = frame.outcomes[0]
  assert.ok(failed?.kind === 'failed')
  assert.equal(failed.state, 'mount-timeout')
  /*
   * **Still on the tree.** The promise cannot be cancelled, so the plugin is
   * running; taking its row away would leave whatever it has already put in the
   * document with nobody who can take it back.
   */
  assert.deepEqual(tree.mounted(), [{ pluginId: 'p', version: 1 }])
})

test('a rejection arriving after the deadline is caught and said, not left unhandled', async () => {
  /*
   * Copied from GENERATION-HOOKS §5.2 word for word, and it is not tidiness: an
   * abandoned promise rejecting is an `unhandledrejection` with no owner, which
   * surfaces as a frame-wide fault attributed to whatever ran last.
   */
  let reject: ((error: unknown) => void) | undefined
  const frame = bench({
    compile: () => () => ({
      apply: () =>
        new Promise((_resolve, no) => {
          reject = no
        }),
    }),
  })
  const tree = createSandboxPluginTree(frame.env)
  const running = tree.mount({ pluginId: 'p', version: 1, code: '' })
  await settle()
  frame.advance(SANDBOX_PLUGIN_LIMITS.applyMs)
  await running
  await settle()

  reject?.(new Error('late and angry'))
  await settle()

  assert.equal(frame.notes.length, 1, 'the late rejection is reported exactly once')
  assert.match(frame.notes[0] ?? '', /late and angry/u)
  assert.equal(
    frame.outcomes.filter(row => row.kind === 'failed').length,
    1,
    'and it does not become a second failure row for a plugin already written off',
  )
})

test('the teardown checklist compares six items, every one of them', async () => {
  /*
   * **The count is the assertion that matters**, and it is here because of a
   * shape this project has already shipped: a loop with a `continue` compared
   * four of twenty-six and stayed green. Naming the six and then asserting the
   * length is what makes "one of them quietly stopped running" a red test rather
   * than a silent leak.
   */
  const frame = bench()
  const tree = createSandboxPluginTree(frame.env)
  await tree.mount({
    pluginId: 'p',
    version: 1,
    code: 'return { apply() { iris.styles.insert("body{}") }, dispose() {} }',
  })
  await settle()

  const steps = await tree.unmount('p')
  await settle()

  assert.equal(steps.length, 6, 'the compared count, not merely "the ones I looked at"')
  assert.equal(
    steps.length,
    SANDBOX_PLUGIN_TEARDOWN_ITEMS.length,
    'the declared list and the run list must be the same length',
  )
  assert.deepEqual(
    steps.map(step => step.item),
    [...SANDBOX_PLUGIN_TEARDOWN_ITEMS],
    'in reverse of the order things were put there',
  )
  assert.ok(steps.every(step => step.ok), 'a clean plugin leaves a clean checklist')

  // And each item actually reached its sink, so the rows are not six labels.
  assert.deepEqual(frame.panelsRemoved, ['p'], 'item 2 removed the cell')
  assert.ok(frame.stylesCleared.includes('p'), "item 3 cleared this frame's sheets")
  assert.deepEqual(frame.tracesCleared, ['p'], 'item 5 swept the member surface')
  assert.deepEqual(tree.mounted(), [], 'item 6 took the row off the tree')
})

test('an item that fails records dispose-failed and the rest are still done', async () => {
  const frame = bench()
  const tree = createSandboxPluginTree(frame.env)
  await tree.mount({
    pluginId: 'p',
    version: 1,
    code: 'return { dispose() { throw new Error("will not let go") } }',
  })
  await settle()
  frame.outcomes.length = 0

  const steps = await tree.unmount('p')
  await settle()

  assert.equal(steps.length, 6, 'a failed item is a failed row, never a missing one')
  assert.equal(steps[0]?.ok, false)
  assert.match(steps[0]?.detail ?? '', /will not let go/u)
  assert.ok(steps.slice(1).every(step => step.ok), 'the other five still came away')
  const failure = frame.outcomes.find(row => row.kind === 'failed')
  assert.ok(failure?.kind === 'failed')
  assert.equal(failure.state, 'dispose-failed')
  assert.deepEqual(tree.mounted(), [], 'and the row is gone even so')
})

test('a batch mounts in id order and the styles it publishes follow it', async () => {
  // §9: lexicographic, recomputed, no counter and no plugin-chosen priority. The
  // order is visible in whose CSS wins a tie, so it is asserted through what the
  // sink saw rather than through an internal list.
  const frame = bench()
  const tree = createSandboxPluginTree(frame.env)
  const code = (mark: string): string => `return { apply() { iris.styles.insert("${mark}") } }`
  await tree.mountAll([
    { pluginId: '3-c', version: 1, code: code('c') },
    { pluginId: '1-a', version: 1, code: code('a') },
    { pluginId: '2-b', version: 1, code: code('b') },
  ])
  await settle()

  assert.deepEqual(frame.inserted, ['1-a:a', '2-b:b', '3-c:c'])
  assert.deepEqual(frame.publishedStyles, ['1-a:a', '2-b:b', '3-c:c'])
})

test('a plugin whose turn comes after the batch budget is named, not dropped', async () => {
  /*
   * "Later ones are not started" (§6.3) must not mean "later ones vanish": a
   * plugin that never got a turn and one that was never asked for are
   * indistinguishable afterwards without this row.
   */
  const frame = bench()
  /*
   * Each plugin spends **just under** its own 3 s, so none of them trips the
   * per-plugin budget and the only thing that can refuse one is the batch's own
   * ceiling. Four of them (4 × 2999 = 11996ms) put the fifth past the 10 s line;
   * the fourth starts at 8997ms, inside it, and must still run — a test whose
   * plugins each blew their own budget would go red for the wrong reason and
   * look like it had proved this.
   */
  const each = SANDBOX_PLUGIN_LIMITS.applyMs - 1
  const tree = createSandboxPluginTree({
    ...frame.env,
    compile: () => () => ({ apply: () => { frame.advance(each) } }),
  })
  await tree.mountAll(
    ['a', 'b', 'c', 'd', 'e'].map(pluginId => ({ pluginId, version: 1, code: '' })),
  )
  await settle()

  const rows = frame.outcomes.map(row => (row.kind === 'failed' ? `${row.pluginId}:${row.state}` : `${row.pluginId}:mounted`))
  assert.deepEqual(rows, ['a:mounted', 'b:mounted', 'c:mounted', 'd:mounted', 'e:mount-timeout'])
  const skipped = frame.outcomes.find(row => row.kind === 'failed')
  assert.ok(skipped?.kind === 'failed')
  assert.match(skipped.detail, /batch budget/u)
})

test('a replace tears the old version down before the new one is compiled', async () => {
  const frame = bench()
  const tree = createSandboxPluginTree(frame.env)
  await tree.mount({ pluginId: 'p', version: 1, code: 'return { apply() {} }' })
  await settle()
  frame.stylesCleared.length = 0
  frame.compiled.length = 0

  await tree.mount({ pluginId: 'p', version: 2, code: 'return { apply() {} }' })
  await settle()

  assert.ok(
    frame.stylesCleared.includes('p'),
    'the old version came away first, or the teardown would strip the new one',
  )
  assert.deepEqual(tree.mounted(), [{ pluginId: 'p', version: 2 }])
})

test('a synchronous apply that blows its budget is mount-timeout, not mounted', async () => {
  /*
   * Found by the PR-A acceptance run rather than by reasoning, which is why it
   * is worth a test of its own: a plugin that spun for six seconds and then
   * returned had already finished before any deadline could be armed, so the
   * tree filed a plugin that froze the frame for twice its budget as healthy.
   *
   * The deadline cannot fix that — a promise race does not preempt synchronous
   * code — so the only honest answer is to ask afterwards how long it took. The
   * clock is the fake one, so this is the decision under test and not a race.
   */
  const frame = bench()
  const spin = SANDBOX_PLUGIN_LIMITS.applyMs + 1_000
  const tree = createSandboxPluginTree({
    ...frame.env,
    compile: () => () => ({
      apply: () => {
        frame.advance(spin)
      },
    }),
  })
  await tree.mount({ pluginId: 'p', version: 1, code: '' })
  await settle()

  const outcome = frame.outcomes[0]
  assert.ok(outcome?.kind === 'failed')
  assert.equal(outcome.state, 'mount-timeout')
  assert.match(outcome.detail, new RegExp(`blocked the frame for ${String(spin)}ms`, 'u'))
  // Kept on the tree for the same reason the async timeout is: it is running,
  // and a row taken away leaves whatever it did with no owner.
  assert.deepEqual(tree.mounted(), [{ pluginId: 'p', version: 1 }])
})
