/**
 * The evaluator, as it runs inside the child process.
 *
 * This file is the untrusted side's neighbour, not the untrusted side itself.
 * Card template code never executes in this realm: it is compiled here — which
 * builds a function without running its body — and then instantiated and run
 * inside a `vm` context that has no `process`, no `require`, and no working
 * dynamic import.
 *
 * That last one is why the `vm` layer exists at all. Deleting globals is not
 * enough, because `import()` is syntax rather than a global and survives every
 * deletion: measured, `await import("node:net")` succeeds from inside a compiled
 * template in a child with `process` hard-removed and `--permission` on. A
 * context created without an `importModuleDynamically` callback refuses it by
 * design. Node's permission model does not gate the network — there is no
 * `--allow-net` in 24.x — so the context is the thing that closes that door, and
 * `--permission` plus an empty environment is what makes a context escape land
 * somewhere worth nothing.
 *
 * **A context with no host objects in it**, which this file used to claim and
 * did not deliver. Until 2026-09-11 the three arguments EJS's `client: true`
 * signature takes — `escapeFn`, `include`, `rethrow` — were passed straight in
 * as this realm's own functions, and so was every member of `locals`, so
 * `<%= escapeFn.constructor("return process")() %>` handed a template this
 * realm's `Function` and, through it, `process` and `globalThis.fetch`. The
 * claim is now true, and `realm.ts` is how: every callable crosses as a frozen
 * trampoline built inside the context, every value is re-created there through
 * the context's own `JSON.parse`, errors and promises included, and lodash is
 * evaluated in the context rather than handed across. This file's job is to
 * assemble the scope out of those pieces — {@link buildScope} — and to keep the
 * four arguments of the template signature bridged the same way.
 *
 * @module @iris/compat-prompt-template/child
 */

import { createRequire } from 'node:module'

import { buildEnvironment, createState } from './environment.ts'
import type { BatchState, Environment } from './environment.ts'
import { createRealm } from './realm.ts'
import type { Realm } from './realm.ts'
import type { ChildMessage, EvalBatch, EvalItem, ItemResult, Op } from './types.ts'
import {
  UPSTREAM_COMPILE_OPTIONS,
  applySourcePatches,
  hasTemplate,
  identityEscape,
  installNestedDelimiters,
  rethrow,
  stripLintHint,
  stubInclude,
} from './upstream.ts'

const require = createRequire(import.meta.url)

/** EJS, patched to upstream's dialect before anything compiles. */
const ejs = require('ejs') as {
  compile: (text: string, options: Record<string, unknown>) => unknown
}
installNestedDelimiters(ejs)

/**
 * A compiled template, ready to run in a context.
 *
 * Every parameter is typed `unknown` on purpose: each one is a context value by
 * the time it gets here, and naming a host type for it would be the mistake this
 * file is about.
 */
type CompiledTemplate = (
  this: unknown,
  locals: unknown,
  escapeFn: unknown,
  include: unknown,
  rethrowFn: unknown,
) => Promise<string>

export { createRealm } from './realm.ts'
export type { Realm } from './realm.ts'

/**
 * Compile one template and run it in the context.
 *
 * The compile happens in this realm and the instantiation in the context: EJS's
 * `client: true` output is a self-contained function source, which is what makes
 * moving it across the boundary possible.
 *
 * The three engine arguments are bridged, not passed. They are this file's own
 * functions and EJS hands all three to template code by name, so passing them
 * raw is `escapeFn.constructor("return process")` — the escape this package was
 * measured to have on 2026-09-11.
 * @param realm - the realm to run in.
 * @param text - the template.
 * @param origin - upstream's `filename`; names the frame in an error.
 * @param scope - the template's `locals`, already a context object.
 * @returns the rendered text.
 */
export async function evaluate(
  realm: Realm,
  text: string,
  origin: string,
  scope: object,
): Promise<string> {
  // Upstream's short-circuit. Text with no delimiter is never compiled, so a
  // card's prose cannot be a syntax error.
  if (!hasTemplate(text)) return text

  const compiled = ejs.compile(text, { ...UPSTREAM_COMPILE_OPTIONS, filename: origin })
  const source = applySourcePatches(String(compiled))
  const instantiated = realm.run(`(${source})`, origin) as CompiledTemplate

  return await instantiated.call(
    scope,
    scope,
    // Not `String(args[0])`: upstream's escape is the identity, so `<%= x %>`
    // with `x` undefined must hand `__append` an undefined it filters out, not
    // the six characters "undefined".
    realm.fn('escapeFn', (_self, args) => identityEscape(args[0] as string)),
    realm.fn('include', (_self, args) => stubInclude(args[0] as string)),
    realm.fn('rethrow', (_self, args) => (rethrow as (...a: never[]) => never)(...args as never[])),
  )
}

/**
 * Build the object a template's `with (locals)` resolves against.
 *
 * Every member crosses by the rule its kind needs: data is re-created inside the
 * context, a live read and a call become frozen context trampolines, and a
 * guarded object becomes a context `Proxy` whose refusal is a context `Error`.
 * Nothing here hands a template a function or an object of this realm, which is
 * the property `tests/realm.test.ts` prosecutes member by member.
 * @param realm - where the scope is built.
 * @param environment - the description `buildEnvironment` returned.
 * @returns the context object to pass as `locals`.
 */
export function buildScope(realm: Realm, environment: Environment): object {
  const { data, reads, calls, objects } = environment.members
  const scope = realm.create()
  for (const [key, value] of Object.entries(data)) realm.define(scope, key, realm.adopt(value))
  for (const [key, read] of Object.entries(reads)) realm.defineGetter(scope, key, read)
  for (const [key, call] of Object.entries(calls)) {
    realm.define(scope, key, realm.fn(key, (_self, args) => call(...args as never[])))
  }
  for (const [key, spec] of Object.entries(objects)) realm.define(scope, key, realm.guarded(key, spec))
  return scope
}

/**
 * What a failed item reports.
 *
 * The message is upstream's, which means EJS's suggestion to go and run
 * EJS-Lint is removed: it points a card author at a tool that is not part of
 * Iris, and upstream comments it out for the same reason.
 * @param error - whatever the template or the compiler threw.
 * @returns a failed result.
 */
function describeFailure(error: unknown): ItemResult {
  // `instanceof Error` is deliberately not the test: an error raised inside the
  // realm is an `Error` of *that* realm and would fail it. `String(error)` on
  // one still reads `ReferenceError: nope is not defined`, which is the class
  // name a card author needs.
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: stripLintHint(message) }
}

/**
 * Evaluate a whole batch, streaming one message per item.
 *
 * Items share `state`, so a write in one is visible to the next — upstream is
 * writing to the live application, and a batch that isolated its items would
 * quietly change what every multi-entry card computes.
 * @param batch - the request.
 * @param send - how to emit a message.
 */
export async function runBatch(batch: EvalBatch, send: (message: ChildMessage) => void): Promise<void> {
  const deadline = Date.now() + batch.deadlineMs
  const realm = createRealm()
  const state: BatchState = createState(batch.snapshot, realm)

  for (const item of batch.items) {
    // A cheap check between items. It cannot interrupt a runaway loop inside
    // one item — `vm`'s own `timeout` only bounds synchronous code, and the
    // corpus awaits — so the host's kill is the enforcement, not this.
    if (Date.now() >= deadline) return

    const { result, ops } = await runItem(batch, item, state, realm)
    send({ v: 1, kind: 'item', id: item.id, result, ops })
  }
}

/**
 * Evaluate one item.
 * @param batch - the request it belongs to.
 * @param item - the item.
 * @param state - variable state shared across the batch.
 * @param realm - the realm.
 * @returns its result and the writes it performed.
 */
async function runItem(
  batch: EvalBatch,
  item: EvalItem,
  state: BatchState,
  realm: Realm,
): Promise<{ result: ItemResult, ops: Op[] }> {
  // Declared before the environment because `getwi` closes over it and the
  // environment is what the scope is built from. A nested evaluation gets the
  // calling item's own scope with the entry's additions layered on, composed
  // inside the realm so the composition is a context object too.
  let scope: object
  const environment = buildEnvironment({
    snapshot: batch.snapshot,
    realm,
    locals: item.locals,
    // `getwi` fetches another entry and evaluates it in the same realm and the
    // same variable state. Upstream has no recursion guard and neither does
    // this: a cycle overflows the stack, which lands in the catch below as a
    // failed item rather than a lost batch.
    evaluateNested: (text, origin, extra) =>
      evaluate(realm, text, origin, realm.assign(scope, realm.adopt(extra))),
  }, state)
  scope = buildScope(realm, environment)

  try {
    const text = await evaluate(realm, item.text, item.origin, scope)
    return { result: { ok: true, text }, ops: environment.ops }
  } catch (error) {
    // The writes an item performed before throwing are kept. Upstream applies a
    // `setvar` the moment it runs, so a template that writes and then fails has
    // already written; discarding them here would be tidier and wrong.
    return { result: describeFailure(error), ops: environment.ops }
  }
}

/**
 * Wire the process up. Runs when this file is the child's entry point.
 *
 * Exported and called at import time rather than guarded by a main check: this
 * module is only ever loaded as a child entry, and a silent no-op when the IPC
 * channel is missing would present as a batch that never returns.
 */
export function main(): void {
  const send = (message: ChildMessage): void => {
    process.send?.(message)
  }

  if (typeof process.send !== 'function') {
    throw new Error('@iris/compat-prompt-template child was started without an IPC channel')
  }

  process.on('message', (message: unknown) => {
    const batch = message as EvalBatch
    if (batch?.v !== 1) {
      send({ v: 1, kind: 'fatal', error: `unsupported batch version ${String(batch?.v)}` })
      return
    }
    runBatch(batch, send).then(
      () => { send({ v: 1, kind: 'done' }) },
      (error: unknown) => {
        send({ v: 1, kind: 'fatal', error: error instanceof Error ? error.message : String(error) })
      },
    )
  })

  process.on('uncaughtException', (error: Error) => {
    send({ v: 1, kind: 'fatal', error: error.message })
  })

  send({ v: 1, kind: 'ready' })
}
