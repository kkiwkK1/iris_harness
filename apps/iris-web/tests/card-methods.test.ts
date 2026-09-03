/**
 * Every wire call the frame makes must be an action a card may ask for.
 *
 * A card's write goes through two lists that nobody had to keep in step: the
 * frame calls `host.call('replaceScriptButtons', …)`, and the store looks that
 * name up in `CARD_METHODS` before forwarding it. When the second list is
 * missing an entry the first one uses, the write is refused — and the refusal
 * arrives at the reader as *the host's* answer, because `writeButtons` reports
 * the rejection's own text under "the host refused to store the table".
 *
 * That happened. `'script.replaceScriptButtons'` had been in the protocol from
 * the start and `CARD_METHODS` never named it, so every card-initiated button
 * write was refused by this app while reading as a host or protocol mismatch.
 * Two sides were checked for a version skew before either list was checked for
 * a missing line.
 *
 * The suite could not have caught it, and the reason is worth naming: the test
 * that exercises the writers asserts the frame **posted** a `call` message, and
 * posting is unconditional — `callAction` does not consult `CARD_METHODS`. The
 * gate is in `client/store.ts`, one process boundary away from every test that
 * drives the frame. So this file does not drive anything; it compares the two
 * lists directly, which is the only place they are comparable.
 *
 * @module iris-web/tests/card-methods
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isCardMethod, CARD_METHODS, SHELL_ACTIONS } from '../src/sandbox/card-api.ts'

/*
 * `fileURLToPath`, not `URL.pathname`: this repository lives under a path with
 * non-ASCII segments, and `pathname` hands them back percent-encoded. The
 * `readdirSync` then fails with ENOENT on a path that looks almost right, which
 * on a different machine would have been a passing test.
 */
const SANDBOX = fileURLToPath(new URL('../src/sandbox/', import.meta.url))

/**
 * Every action name the frame passes to a wire call, with where it came from.
 *
 * Read out of the source rather than out of a runtime, because a runtime only
 * reaches the calls a test happens to trigger — and the one that broke was
 * reachable solely from a card that supplies a script id, which no unit test
 * does. A regex over source is the weaker instrument and it is the one that
 * sees all of them.
 * @returns each call site, as `{ name, where }`.
 */
function wireCalls(): { name: string, where: string }[] {
  const found: { name: string, where: string }[] = []
  for (const file of readdirSync(SANDBOX)) {
    if (!file.endsWith('.ts')) continue
    const source = readFileSync(join(SANDBOX, file), 'utf8')
    const lines = source.split(/\r?\n/u)
    lines.forEach((line, at) => {
      // `callAction('x'` and `host.call('x'` — the two spellings the frame uses
      // to reach the shell. A third spelling would go unseen, which is why the
      // floor below is asserted against a count and not against this pattern.
      for (const match of line.matchAll(/(?:callAction|\.call)\('([A-Za-z]+)'/gu)) {
        const name = match[1]
        if (name !== undefined) found.push({ name, where: `${file}:${String(at + 1)}` })
      }
    })
  }
  return found
}

test('every action the frame calls is one a card may ask Iris for', () => {
  const calls = wireCalls()

  /*
   * The floor, because a pattern that matched nothing would make this test pass
   * loudest. It is a floor and not an equality so that adding a call site does
   * not fail here for the wrong reason — the assertion below is the one that
   * has to hold.
   */
  assert.ok(calls.length >= 15, `only ${String(calls.length)} wire calls were found in the frame`)

  const unroutable = calls.filter(call => !isCardMethod(call.name))
  assert.deepEqual(
    unroutable,
    [],
    'these are refused by client/store.ts, and the card is told the host refused',
  )
})

test('the guard fails on a name the table does not carry', () => {
  /*
   * The teeth, inline rather than by mutating the source: `isCardMethod` is the
   * predicate under test, so a name that is definitely absent proves the check
   * discriminates. Without this, a predicate that answered `true` for
   * everything would leave the test above green forever.
   */
  assert.equal(isCardMethod('somethingNobodyDeclared'), false)
  assert.equal(isCardMethod('replaceScriptButtons'), true, 'the entry this file was written for')
})

test('every routable action names a namespaced wire method', () => {
  // A wire method without its namespace would be rejected by the protocol at
  // run time, in the one place a card is waiting on the promise.
  for (const [name, wire] of Object.entries(CARD_METHODS)) {
    assert.match(wire, /^[a-z]+\.[A-Za-z]+$/u, `${name} maps to "${wire}"`)
  }
})

test('a shell action is callable but has no wire method, and the two lists stay apart', () => {
  /*
   * The split exists so that a table of wire methods contains only wire
   * methods. A shell action given a plausible-looking value — `composer.send`,
   * say — would route to a host arm that does not exist, and the failure would
   * arrive as the host refusing a method nobody wrote.
   */
  for (const name of SHELL_ACTIONS) {
    assert.equal(isCardMethod(name), true, `${name} must be callable`)
    assert.equal(
      Object.hasOwn(CARD_METHODS, name),
      false,
      `${name} is the shell's to answer, so it must not name a wire method`,
    )
  }
  assert.ok(SHELL_ACTIONS.length > 0, 'an empty list would make this test pass vacuously')
})
