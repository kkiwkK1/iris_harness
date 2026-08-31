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
 * @module @iris/compat-prompt-template/child
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

import { buildEnvironment, createState } from './environment.ts'
import type { BatchState } from './environment.ts'
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
 * lodash's source, to be evaluated **inside** each context.
 *
 * In-context rather than passed across, so that objects the template makes and
 * objects lodash makes share a realm. Measured at 24 ms per context. Passing the
 * host realm's lodash in also works — all eighteen cross-realm probes pass,
 * because lodash avoids `instanceof` — but same-realm removes the question
 * instead of answering it once.
 */
const lodashSource = readFileSync(require.resolve('lodash'), 'utf8')

/** A compiled template, ready to run in a context. */
type CompiledTemplate = (
  this: unknown,
  locals: unknown,
  escapeFn: (markup: string) => string,
  include: (originalPath: string) => { filename: string, template: string },
  rethrowFn: typeof rethrow,
) => Promise<string>

/**
 * Make the realm templates run in.
 *
 * `vm.createContext({})` starts from a bare global: no `process`, no `require`,
 * no `fetch`. Only lodash is added, because only lodash is reached for.
 * @returns a fresh context.
 */
export function createRealm(): vm.Context {
  const context = vm.createContext({})
  vm.runInContext(lodashSource, context, { filename: 'lodash.js' })
  return context
}

/**
 * Compile one template and run it in the context.
 *
 * The compile happens in this realm and the instantiation in the context: EJS's
 * `client: true` output is a self-contained function source, which is what makes
 * moving it across the boundary possible.
 * @param context - the realm to run in.
 * @param text - the template.
 * @param origin - upstream's `filename`; names the frame in an error.
 * @param locals - the environment, passed as both `this` and `locals`.
 * @returns the rendered text.
 */
export async function evaluate(
  context: vm.Context,
  text: string,
  origin: string,
  locals: Record<string, unknown>,
): Promise<string> {
  // Upstream's short-circuit. Text with no delimiter is never compiled, so a
  // card's prose cannot be a syntax error.
  if (!hasTemplate(text)) return text

  const compiled = ejs.compile(text, { ...UPSTREAM_COMPILE_OPTIONS, filename: origin })
  const source = applySourcePatches(String(compiled))
  const instantiated = vm.runInContext(`(${source})`, context, { filename: origin }) as CompiledTemplate

  return await instantiated.call(locals, locals, identityEscape, stubInclude, rethrow)
}

/**
 * What a failed item reports.
 *
 * The message is upstream's, which means EJS's suggestion to go and run
 * EJS-Lint is removed: it points a card author at a tool that is no part of
 * Iris, and upstream comments it out for the same reason.
 * @param error - whatever the template or the compiler threw.
 * @returns a failed result.
 */
function describeFailure(error: unknown): ItemResult {
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
  const state: BatchState = createState(batch.snapshot)
  const context = createRealm()

  for (const item of batch.items) {
    // A cheap check between items. It cannot interrupt a runaway loop inside
    // one item — `vm`'s own `timeout` only bounds synchronous code, and the
    // corpus awaits — so the host's kill is the enforcement, not this.
    if (Date.now() >= deadline) return

    const { result, ops } = await runItem(batch, item, state, context)
    send({ v: 1, kind: 'item', id: item.id, result, ops })
  }
}

/**
 * Evaluate one item.
 * @param batch - the request it belongs to.
 * @param item - the item.
 * @param state - variable state shared across the batch.
 * @param context - the realm.
 * @returns its result and the writes it performed.
 */
async function runItem(
  batch: EvalBatch,
  item: EvalItem,
  state: BatchState,
  context: vm.Context,
): Promise<{ result: ItemResult, ops: Op[] }> {
  const environment = buildEnvironment({
    snapshot: batch.snapshot,
    locals: item.locals,
    // `getwi` fetches another entry and evaluates it in the same realm and the
    // same variable state. Upstream has no recursion guard and neither does
    // this: a cycle overflows the stack, which lands in the catch below as a
    // failed item rather than a lost batch.
    evaluateNested: (text, origin, locals) => evaluate(context, text, origin, locals),
  }, state)

  try {
    const text = await evaluate(context, item.text, item.origin, environment.locals)
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
