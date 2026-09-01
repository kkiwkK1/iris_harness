/**
 * Starting a card's scripts because a chat opened.
 *
 * What is tested here is the part with no user in front of it. The probe's
 * failures are seen by the person who pressed the button; these happen while
 * someone is reading a conversation, so "it stopped" and "it never started" look
 * identical from outside unless the code is careful about which it reports.
 *
 * @module iris-web/tests/card-scripts
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import type { ScriptContext, ScriptView } from '@iris/protocol'

import { startCardScripts, type CardScriptsEnv } from '../src/sandbox/card-scripts.ts'
import {
  describeRun,
  summariseRuns,
  type ScriptRunState,
} from '../src/sandbox/script-run-state.ts'

const CONTEXT = {
  chat: [],
  chatMetadata: {},
  name1: 'You',
  name2: 'Her',
  characters: [],
  extensionSettings: {},
  variables: {},
} as ScriptContext

/** A card with three scripts, the middle one disabled. */
function scripts(): ScriptView[] {
  return [
    { id: 'a', name: 'first', enabled: true, bytes: 10 },
    { id: 'b', name: 'skipped', enabled: false, bytes: 10 },
    { id: 'c', name: 'last', enabled: true, bytes: 10 },
  ] as ScriptView[]
}

/** A harness recording what the controller did, with every step overridable. */
function harness(overrides: Partial<CardScriptsEnv> = {}) {
  const started: string[] = []
  const attached: string[] = []
  const disposed: string[] = []
  const failures: ScriptRunState[] = []
  let latest: readonly ScriptRunState[] = []

  const env: CardScriptsEnv = {
    resolve: async () => ({ scripts: scripts(), documentGranted: false }),
    context: async () => CONTEXT,
    body: async (_character, scriptId) => ({ ok: true, content: `/* ${scriptId} */` }),
    bootstrap: async () => '(function(){})()',
    start: input => {
      // One frame for the card's whole set now, so the harness records the set.
      for (const script of input.scripts) started.push(script.id ?? '')
      return {
        // Models the DOM's own answer, so the controller's check is exercised
        // rather than skipped for want of the property.
        element: { id: 'card-frame', isConnected: false } as never,
        emit: () => undefined,
        dispose: () => disposed.push('card-frame'),
      }
    },
    attach: card => {
      const element = card.element as unknown as { id: string, isConnected: boolean }
      element.isConnected = true
      attached.push(element.id)
    },
    // Short enough to assert on, long enough that the ordinary path finishes
    // first. The production default is eight seconds.
    readyTimeoutMs: 20,
    onState: states => {
      latest = states
    },
    onFailure: state => failures.push(state),
    ...overrides,
  }

  return {
    env,
    started,
    attached,
    disposed,
    failures,
    states: () => latest,
  }
}

/** Let the controller's async setup run to completion. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

test('only enabled scripts start, in the order the card lists them', async () => {
  const bench = harness()
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(bench.started, ['a', 'c'], 'the disabled script must not run')
})

test('one script failing to load does not stop the next', async () => {
  /*
   * The isolation rule. A card whose first script has been deleted from disk
   * must still get its second one, because the alternative is that one stale
   * entry silently disables everything after it.
   */
  const bench = harness({
    body: async (_character, scriptId) =>
      scriptId === 'a'
        ? { ok: false, error: { code: 'not-found', message: 'no such script' } }
        : { ok: true, content: '/* ok */' },
  })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(bench.started, ['c'], 'the later script still ran')
  assert.equal(bench.failures[0]?.scriptId, 'a')
  assert.match(
    bench.failures[0]?.detail ?? '',
    /not-found: no such script/,
    "the host's own code and message, not a sentence invented here",
  )
})

test('a frame that cannot be created is reported against every script in it', async () => {
  /*
   * With one frame per card this is no longer one script's problem. It is
   * reported against each of them because each is a line the reader is looking
   * at, and a card showing three green scripts and one failure would be lying
   * about the three.
   */
  const bench = harness({
    start: () => {
      throw new Error('no iframe for you')
    },
  })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(bench.failures.map(state => state.scriptId), ['a', 'c'])
  assert.equal(bench.failures[0]?.phase, 'bootstrap-failed')
})

test('leaving the chat mid-setup starts nothing', async () => {
  /*
   * Opening a chat and leaving immediately is ordinary navigation, and the setup
   * is several awaits long. Without the disposal checks the user ends up with
   * frames belonging to a chat they are no longer in — running a card against a
   * conversation that is not on screen.
   */
  const bench = harness({
    resolve: async () => {
      await Promise.resolve()
      return { scripts: scripts(), documentGranted: false }
    },
  })
  const running = startCardScripts(bench.env, 'chat-1', 'card-1')
  running.dispose()
  await settle()

  assert.deepEqual(bench.started, [], 'nothing may start after the chat has gone')
})

test('disposing tears down every frame that did start', async () => {
  const bench = harness()
  const running = startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()
  running.dispose()
  running.dispose()

  assert.deepEqual(bench.disposed, ['card-frame'], 'one frame holds the card, so one teardown')
})

test('a card whose grants cannot be resolved reports against the card, not a script', async () => {
  // None of them got far enough to be the one at fault, and silence here would
  // be indistinguishable from a card that ships no scripts at all.
  const bench = harness({
    resolve: async () => {
      throw new Error('host unreachable')
    },
  })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.equal(bench.failures.length, 1)
  assert.equal(bench.failures[0]?.scriptId, '')
  assert.match(bench.failures[0]?.detail ?? '', /host unreachable/)
})

test('a missing context is reported rather than run against', async () => {
  // A card handed a context it did not get would read undefined members and fail
  // somewhere unrelated.
  const bench = harness({ context: async () => undefined })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(bench.started, [])
  assert.match(bench.failures[0]?.detail ?? '', /did not supply a context/)
})

test('grants are asked of the host, not handed in', async () => {
  /*
   * The shape of `resolve` is the assertion: it is a call taking the character
   * id, so a caller cannot satisfy it with a cached value read earlier under
   * that same id. Character ids are reused when a card is deleted, which is what
   * makes any such cache unsound — and this path has no user present to notice a
   * grant that belongs to a card that no longer exists.
   */
  const asked: string[] = []
  const bench = harness({
    resolve: async characterId => {
      asked.push(characterId)
      return { scripts: scripts(), documentGranted: true }
    },
  })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(asked, ['card-1'], 'resolved once, at run time, by id')
})

test('states are published for every script that got as far as being tried', async () => {
  const bench = harness()
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(
    bench.states().map(state => state.scriptId),
    ['a', 'c'],
  )
  assert.deepEqual(
    bench.states().map(state => state.phase),
    ['dispatched', 'dispatched'],
    'a frame that has not answered yet is dispatched, never running',
  )
})

test('every started frame is put into the document', async () => {
  /*
   * The failure this pins had no symptom at all. `runCard` builds an iframe and
   * stops; one that is never inserted never loads, so the bootstrap never parses,
   * the frame never says `ready`, and every script rests on `starting…` forever —
   * with no frame, no console error and no notice, because nothing failed. It
   * only looked like the orchestration had stalled.
   *
   * Attaching is part of the controller's contract for exactly that reason: a
   * caller cannot forget it, because there is no longer a caller who could.
   */
  const bench = harness()
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(bench.attached, ['card-frame'], 'a frame that started but was never attached is inert')
})

test('a frame that never reports ready stops being "starting" and says so', async () => {
  /*
   * The one silence with no innocent reading. Quiet *after* a body has run is
   * normal here — a card that registers listeners and returns is working — but
   * quiet before `ready` means the frame never started at all.
   *
   * `starting…` must not be a state something can rest in forever, which is the
   * rule that would have named the missing-attach bug in one run instead of six
   * rounds of elimination.
   */
  const bench = harness()
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()
  assert.deepEqual(bench.states().map(state => state.phase), ['dispatched', 'dispatched'])

  await new Promise(resolve => setTimeout(resolve, 40))

  assert.deepEqual(
    bench.states().map(state => state.phase),
    ['silent', 'silent'],
  )
  assert.match(bench.failures[0]?.detail ?? '', /never became ready/)
})

test('a frame that did report ready is never called silent', async () => {
  // Otherwise every working card would be reported as a failure eight seconds in.
  const bench = harness({
    start: input => {
      for (const script of input.scripts) input.onPhase(script.id, { phase: 'running' })
      return {
        element: { id: 'card-frame', isConnected: true } as never,
        emit: () => undefined,
        dispose: () => undefined,
      }
    },
  })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()
  await new Promise(resolve => setTimeout(resolve, 40))

  assert.deepEqual(bench.states().map(state => state.phase), ['running', 'running'])
  assert.deepEqual(bench.failures, [], 'a card that started and went quiet is working, not failing')
})

test('an attach that does nothing is caught, not trusted', async () => {
  /*
   * The contract can require an `attach`; it cannot require that the one supplied
   * works. A no-op satisfies the compiler and reproduces the original silent
   * failure exactly, so the controller asks the DOM whether the frame really
   * arrived instead of believing the call it just made.
   */
  const bench = harness({ attach: () => undefined })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(
    bench.failures.map(state => state.scriptId),
    ['a', 'c'],
  )
  assert.match(bench.failures[0]?.detail ?? '', /never put into the document/)
})

test('a blocked script is named in the summary, not averaged into "starting"', async () => {
  /*
   * The ruling this enforces: sibling success must not paper over a hang. With a
   * card's scripts in one frame the neighbours of a stuck script are visibly
   * fine, so a heading that folded a wait into "still starting" would report a
   * healthy card while one of its scripts was stopped indefinitely.
   */
  const { summariseRuns } = await import('../src/sandbox/script-run-state.ts')

  const summary = summariseRuns([
    { scriptId: 'a', name: 'provider', phase: 'ran' },
    { scriptId: 'b', name: 'consumer', phase: 'waiting', waitingFor: 'Mvu' },
  ])

  assert.match(summary, /waiting for Mvu/)
  assert.doesNotMatch(summary, /still starting/)
})

test('a long wait says how long, and is never abandoned', async () => {
  /*
   * This replaces a test that asserted a *timeout*. There is no timeout any
   * more, and removing it was the fix: upstream's `waitGlobalInitialized` has no
   * deadline at all — it resolves when the event fires and otherwise waits. The
   * five seconds this frame used to enforce came from `async-wait-until`'s
   * default, which upstream applies to the Mvu `stat_data` poll *after* the
   * global is present, not to the wait for it.
   *
   * Mis-siting it turned a patient wait into a race that a cold fetch loses:
   * every chat is a fresh opaque origin, so a card's bundle is never cached,
   * while upstream's same-origin frames see a warm one. So the wait is patient
   * again, and the panel says how long it has been waiting rather than giving up
   * on the card's behalf.
   */
  const { describeRun, isSettled, summariseRuns } = await import(
    '../src/sandbox/script-run-state.ts'
  )

  const fresh = { scriptId: 'b', name: 'consumer', phase: 'waiting' as const, waitingFor: 'Mvu' }
  const slow = { ...fresh, waitingMs: 5_000 }

  assert.equal(describeRun(fresh), 'waiting for Mvu')
  assert.equal(describeRun(slow), 'still waiting for Mvu (5s)')
  assert.equal(isSettled('waiting'), false, 'a wait is not an ending')
  assert.match(
    summariseRuns([{ scriptId: 'a', name: 'provider', phase: 'ran' }, slow]),
    /waiting for Mvu/,
  )
})

test('a card with nothing to run starts no frame and reports nothing', async () => {
  /*
   * The empty case. A card whose scripts are all switched off must not get a
   * frame — an empty one would report a readiness that means nothing — and must
   * not produce a failure either, because nothing failed.
   *
   * Tested because "no scripts" is the input least likely to be tried: it looks
   * like nothing happens, which is exactly when a wrong answer goes unnoticed.
   */
  const bench = harness({ resolve: async () => ({ scripts: [], documentGranted: false }) })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.deepEqual(bench.started, [])
  assert.deepEqual(bench.attached, [])
  assert.deepEqual(bench.failures, [], 'a card with no scripts has not failed')
})

test('a failure that is really a gap in Iris does not read as a broken card', async () => {
  /*
   * `waitGlobalInitialized is not defined` cost a full verification round
   * reading as a card bug. It was not: it was a member upstream gives every card
   * and this sandbox did not.
   *
   * That is the expensive half of a bad diagnostic — not that it is unclear, but
   * that it **arrives with a suspect already attached**, so nobody checks the
   * innocent party. The names Iris knows it should provide are already written
   * down, so a ReferenceError naming one of them can be attributed correctly.
   */
  const { describeRun } = await import('../src/sandbox/script-run-state.ts')

  const ours = describeRun({
    scriptId: 'a',
    name: 'x',
    phase: 'threw',
    detail: 'ReferenceError: waitGlobalInitialized is not defined',
  })
  assert.match(ours, /gap here, not in the card/)

  const library = describeRun({
    scriptId: 'a',
    name: 'x',
    phase: 'threw',
    detail: 'ReferenceError: toastr is not defined',
  })
  assert.match(library, /a library upstream seeds from its own page/)

  // A name that is genuinely the card's own stays the card's own: over-claiming
  // would move the suspect to the other innocent party.
  const theirs = describeRun({
    scriptId: 'a',
    name: 'x',
    phase: 'threw',
    detail: 'ReferenceError: myOwnTypo is not defined',
  })
  assert.equal(theirs, 'failed: ReferenceError: myOwnTypo is not defined')

  // And an ordinary throw is left exactly as the card wrote it.
  const plain = describeRun({ scriptId: 'a', name: 'x', phase: 'threw', detail: 'boom' })
  assert.equal(plain, 'failed: boom')
})

test('a refusal says which of the two it is, instead of asserting policy', async () => {
  /*
   * "the sandbox does not allow it" asserted a *policy*, and most refusals here
   * are not one. A scope the pushed snapshot cannot carry is a gap; a member the
   * sandbox deliberately withholds is a decision. Reporting both as prohibition
   * puts the suspect on a decision nobody made, so the gap never gets filed.
   *
   * The distinction already existed in the hint `UnsupportedApiError` carries.
   * The panel was discarding it and inventing a reason in its place.
   */
  const { describeRun } = await import('../src/sandbox/script-run-state.ts')

  const gap = describeRun({
    scriptId: 'a',
    name: 'x',
    phase: 'refused',
    member: "getVariables({type:'chat'})",
    detail:
      "Iris sandbox: getVariables({type:'chat'}) is not available to card scripts." +
      ' The frame snapshot carries the message scope only.',
  })
  assert.match(gap, /The frame snapshot carries the message scope only\./)
  assert.doesNotMatch(gap, /does not allow/, 'a gap must not be reported as a prohibition')

  // A refusal that offered no explanation says only what it knows.
  const bare = describeRun({ scriptId: 'a', name: 'x', phase: 'refused', member: 'document.cookie' })
  assert.equal(bare, 'refused document.cookie')
})

test('a report that belongs to the frame rather than a script still arrives', async () => {
  /*
   * A regression cohabitation introduced, and the worst-shaped kind: it removed
   * reports without removing anything visible.
   *
   * The frame speaks for itself as well as for its scripts — the
   * missing-libraries banner, a bootstrap failure before any token exists, a
   * global it could not define. None of those carries a script id, and the
   * attribution guard dropped them along with genuinely misattributed outcomes.
   * The banner that warned about `YAML` and `$` three runs before any card
   * reached them simply stopped arriving.
   */
  const bench = harness({
    start: input => {
      // No script id: this is the frame talking about itself.
      input.onPhase(undefined, {
        phase: 'bootstrap-failed',
        detail: 'libraries a card may expect are not present in this frame: showdown',
      })
      return {
        element: { id: 'card-frame', isConnected: true } as never,
        emit: () => undefined,
        dispose: () => undefined,
      }
    },
  })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.match(bench.failures.map(f => f.detail ?? '').join(' '), /showdown/)
})

test('an outcome naming a script this card does not have is still dropped', async () => {
  // The other half of the distinction. Attributing a stray outcome to a
  // neighbour would read as a working script failing, which is worse than
  // losing it — so "names nobody" and "names a stranger" are handled apart.
  const bench = harness({
    start: input => {
      input.onPhase('a-script-from-another-card', { phase: 'threw', detail: 'not ours' })
      return {
        element: { id: 'card-frame', isConnected: true } as never,
        emit: () => undefined,
        dispose: () => undefined,
      }
    },
  })
  startCardScripts(bench.env, 'chat-1', 'card-1')
  await settle()

  assert.equal(bench.failures.length, 0)
})

test('a module that arrives after the deadline is described as late, not as loaded', () => {
  /*
   * Both halves of this matter and they pull against each other.
   *
   * Left as `failed`, the panel mourns a card that works — a real provider was
   * declared dead at fifteen seconds, then arrived, published, and woke all
   * three of its consumers while the row still said failed.
   *
   * Repainted to a plain `loaded`, the fifteen seconds of dead air before the
   * card started vanish from the record, and that delay is the actual remaining
   * defect. So the row says both: it worked, and it was late.
   */
  const late = describeRun({
    scriptId: 's1',
    name: 'MVU',
    phase: 'ran',
    lateMs: 17_400,
  })

  assert.ok(late.includes('loaded'))
  assert.ok(late.includes('17s'), 'the duration is the evidence that the fetch is slow')
  assert.ok(late.includes('reported as failed'), 'the withdrawn verdict is stated, not hidden')

  const onTime = describeRun({ scriptId: 's1', name: 'MVU', phase: 'ran' })
  assert.equal(onTime, 'loaded', 'an ordinary load gains no ceremony')
})

test('a late arrival stops the card being counted as failed', () => {
  // The summary is what a reader checks first; leaving it at "1 of 4 failed"
  // would keep the headline wrong after the row beneath it was corrected.
  const states: ScriptRunState[] = [
    { scriptId: 'a', name: 'provider', phase: 'ran', lateMs: 17_000 },
    { scriptId: 'b', name: 'one', phase: 'ran' },
    { scriptId: 'c', name: 'two', phase: 'ran' },
  ]
  const summary = summariseRuns(states)

  assert.ok(!summary.includes('failed'), `still reporting a failure: ${summary}`)
  assert.ok(summary.includes('3 of 3'))
})

