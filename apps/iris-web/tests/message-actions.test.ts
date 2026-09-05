/**
 * The `iris.message.actions` contract: registration, projection, callback,
 * disposal.
 *
 * These are the seam's rules, held against a real `SlotCore` with the shell's
 * own declarations — the same objects the browser runs — because the easy
 * things to get subtly wrong (cell identity, ordering, shadowing, what an
 * unmount removes) all live in the ledger's behavior, not in any component.
 *
 * @module iris-web/tests/message-actions
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import type { MessageView } from '@iris/protocol'

import { registerMessageAction, registeredActions } from '../src/slots/message-actions.ts'
import { createIrisSlots } from '../src/slots/slots.ts'

/** A floor view, with only the fields these tests vary. */
function floor(over: Partial<MessageView> & { id: number }): MessageView {
  return { role: 'assistant', text: 'hello', ...over } as MessageView
}

/** A descriptor with only the fields a test names. */
function action(over: Partial<Parameters<typeof registerMessageAction>[2]> & { id: string }) {
  return {
    label: over.id,
    run: () => undefined,
    ...over,
  }
}

/** Read a label the way the shell does: a thunk resolves at read time. */
function labelText(label: Parameters<typeof registerMessageAction>[2]['label']): string {
  return typeof label === 'function' ? label() : label
}

test('nothing registered renders nothing on the ledger', () => {
  /*
   * The zero-residue invariant starts at the data layer: an empty registry
   * projects an empty list, so the row's projection has nothing to grow a
   * button from. The browser-side half (no wrapper, no gap) follows from
   * this — there is nothing to render.
   */
  const { core } = createIrisSlots()
  assert.equal(registeredActions(core).length, 0)
  assert.equal(core.entries('iris.message.actions').length, 0)
})

test('register → one action, shown with its label; dispose → gone', () => {
  const { core } = createIrisSlots()
  const dispose = registerMessageAction(core, 'test', action({ id: 'a', label: 'Speak' }))

  assert.deepEqual(registeredActions(core).map(one => one.id), ['a'])
  // The disposer is the provider's whole unmount: the entry was the only
  // thing added, so removing it leaves nothing behind.
  dispose()
  assert.equal(registeredActions(core).length, 0)
  assert.equal(core.entries('iris.message.actions').length, 0)
})

test('labels can be thunks, resolved at read time', () => {
  const { core } = createIrisSlots()
  let word = 'first'
  registerMessageAction(core, 'test', action({ id: 'a', label: () => word }))

  assert.equal(labelText(registeredActions(core)[0]?.label ?? ''), 'first')
  word = 'second'
  // No re-registration: the same ledger entry reads differently after the
  // locale changes, which is what the thunk contract is for.
  assert.equal(labelText(registeredActions(core)[0]?.label ?? ''), 'second')
})

test('order sorts ascending; ties keep registration order', () => {
  const { core } = createIrisSlots()
  registerMessageAction(core, 'test', action({ id: 'late', order: 5 }))
  registerMessageAction(core, 'test', action({ id: 'early', order: 1 }))
  registerMessageAction(core, 'test', action({ id: 'default-a' }))
  registerMessageAction(core, 'test', action({ id: 'default-b' }))

  assert.deepEqual(
    registeredActions(core).map(one => one.id),
    ['default-a', 'default-b', 'early', 'late'],
  )
})

test('two registrations on one id throw — the cell is taken', () => {
  const { core } = createIrisSlots()
  registerMessageAction(core, 'one', action({ id: 'x' }))
  assert.throws(() => registerMessageAction(core, 'two', action({ id: 'x' })))
})

test('a re-register at a different priority shadows, lowest renders', () => {
  /*
   * The replacement story is the ledger's own: a provider may take over an
   * existing id by registering it at a different priority (useful the day a
   * provider wants to replace a default action rather than add one). The
   * projection shows winners only — and "lowest renders" is the ledger's rule
   * (ascending priority, default 0), so the taker registers *below* the base.
   */
  const { core } = createIrisSlots()
  registerMessageAction(core, 'base', action({ id: 'x', label: 'base' }))
  registerMessageAction(core, 'override', action({ id: 'x', label: 'override', priority: -1 }))

  const shown = registeredActions(core)
  assert.equal(shown.length, 1)
  assert.equal(labelText(shown[0]?.label ?? ''), 'override')
})

test('the callback reaches the handler with the floor, the streaming flag and the notice channel', () => {
  const { core } = createIrisSlots()
  const seen: { id: number, streaming: boolean, notified: string[] } = {
    id: -1, streaming: true, notified: [],
  }
  registerMessageAction(core, 'test', action({
    id: 'a',
    run: context => {
      seen.id = context.message.id
      seen.streaming = context.streaming
      context.notify('done')
    },
  }))
  const [descriptor] = registeredActions(core)
  assert.ok(descriptor !== undefined)

  const notices: string[] = []
  descriptor.run({
    message: floor({ id: 7 }),
    streaming: false,
    notify: text => notices.push(text),
  })

  assert.equal(seen.id, 7)
  assert.equal(seen.streaming, false)
  assert.deepEqual(notices, ['done'])
})

test('the ledger entry renders the standard inline button and wires onClick to the handler', () => {
  /*
   * Invoked as a plain function against a fake owner — no renderer, no DOM:
   * `createElement` answers an element object, which is the whole surface the
   * inline projection has. The folded projection (what the row ships) reads
   * the descriptor instead; this holds the inline face to the same contract.
   */
  const { core } = createIrisSlots()
  const notices: string[] = []
  let runs = 0
  registerMessageAction(core, 'test', action({
    id: 'a',
    label: 'Speak',
    title: 'say a thing',
    run: context => {
      runs += 1
      context.notify('heard')
    },
  }))

  const entry = core.entries('iris.message.actions')[0]
  assert.ok(entry !== undefined)
  // React.createElement's answer, typed as what it is: an element whose props
  // the assertions below read.
  const element = (entry.component as (props: object) => React.ReactElement)({
    message: floor({ id: 3 }),
    streaming: false,
    notify: (text: string) => notices.push(text),
  })

  assert.equal(element.type, 'button')
  assert.equal(element.props.className, 'iris-act')
  assert.equal(element.props.title, 'say a thing')
  assert.equal(element.props.children, 'Speak')
  element.props.onClick()
  assert.equal(runs, 1)
  assert.deepEqual(notices, ['heard'])
})
