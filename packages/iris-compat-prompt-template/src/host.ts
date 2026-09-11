/**
 * The host side: spawn a child, push one batch, collect what comes back.
 *
 * One child per batch, killed when the batch ends. Measured, that costs about
 * 70 ms of fixed overhead — 42 ms to fork and reach ready, 24 ms to build the
 * realm, 4–16 ms to push a 3.12 MiB snapshot — and buys the absence of every
 * cross-batch state question: nothing to pollute, no respawn policy to get
 * wrong, no cache to invalidate.
 *
 * Two upstream behaviours are given up by that, both measured to have zero sites
 * in the corpus and both recorded in `notes/packages/iris-compat-prompt-template/DEVIATIONS.md`: `define()` no longer
 * persists across generations, and EJS's template cache is gone (upstream's own
 * cache is off in the user's live settings).
 *
 * @module @iris/compat-prompt-template/host
 */

import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BatchOutcome, ChildMessage, EvalBatch, ItemResult, Op } from './types.ts'

const require = createRequire(import.meta.url)

/**
 * Where the child's entry lives.
 *
 * `fileURLToPath`, not `.pathname`: this repository's own path contains
 * non-ASCII characters, which a URL percent-encodes — the same trap
 * `architecture.test.ts` documents.
 */
const CHILD_ENTRY = fileURLToPath(new URL('./child-entry.ts', import.meta.url))

/**
 * Directories the child may read.
 *
 * Node permits reading the entry point implicitly, but not its imports, so the
 * package's own sources and the two runtime dependencies need naming.
 *
 * **Two paths per dependency, not one.** `require.resolve` returns pnpm's store
 * realpath, but module resolution reads `<package>/node_modules/lodash/package.json`
 * — the symlink — on the way there, and the permission model checks the path it
 * actually touches. Listing only the realpath denies the resolution before it
 * ever gets to the target, which presents as a child that dies before saying
 * `ready`: no error, no results, just a batch where every item reports that
 * nothing came back. Hence the package root, which covers `src/` and the symlink
 * farm, plus the store realpaths, which are what the symlinks point at.
 *
 * The grant stays narrow despite that: the package root's `node_modules` is a
 * directory of symlinks, and following one lands on a realpath that is only
 * readable if it is listed here. So the child can read this package, `ejs`, and
 * `lodash`, and nothing else in the store.
 * @returns absolute directory paths.
 */
function readableDirectories(): string[] {
  return [
    // The package root: `src/` and the symlinks under `node_modules/`.
    dirname(dirname(CHILD_ENTRY)),
    dirname(require.resolve('ejs/package.json')),
    dirname(require.resolve('lodash/package.json')),
  ]
}

/**
 * The child's heap ceiling, in MiB.
 *
 * Measured 2026-09-11 rather than chosen. The heaviest batch this install can
 * produce — the 708,022-character variable blob of the largest chat, all 1,478
 * world-info entries in the snapshot (6.79 MiB), and all 203 templated entries
 * as items — peaked at **46.3 MiB** of `heapUsed` (22.4 MiB of old space) in a
 * process running nothing else, over two rounds that agreed to 0.2 MiB. Twice
 * that is 93; the floor of 128 wins, and is kept as a floor so the flag can
 * never end up tighter than a small Node process needs to start at all.
 *
 * The same batch runs end to end through a real forked child under this ceiling
 * in 257–276 ms, against the 2000 ms deadline — so the ceiling is not a bound
 * anything real is near.
 *
 * What it buys is the failure mode: without it a template that appends to a
 * string in a loop grows the child until the machine swaps, and the 2 s deadline
 * only fires after the damage. With it the child dies of `ERR_OUT_OF_MEMORY`,
 * the host sees an exit without `done`, and every unreached item falls back to
 * its original text — which is the same outcome as a timeout and already tested.
 */
export const CHILD_MAX_OLD_SPACE_MB = 128

/**
 * The largest template text one item may carry, in characters.
 *
 * Measured over the user's install on 2026-09-11: the largest single field
 * carrying a template tag is 19,399 characters (`命定之诗与黄昏之歌v3.0.4`,
 * entry «双子星的咏叹调-本体»), the heaviest book's templated entries come to
 * 356,328 characters in total, and every templated field in the whole 19-card
 * corpus comes to 560,233. One item here is an *assembled message*, so the
 * number to clear is the sum, not the single field: 1 MiB is 1.87× everything
 * the corpus has, and about 260k tokens of prompt — past any context window a
 * real generation could be using.
 *
 * Refused by name rather than left to the deadline: a 50 MiB template compiles
 * for seconds and then dies by `SIGKILL`, which reaches the caller as "timed
 * out" and tells nobody which item was the problem.
 */
export const MAX_TEMPLATE_CHARS = 1_048_576

/**
 * How the child is locked down.
 *
 * `--permission` denies filesystem writes, `child_process`, `worker`, addons and
 * wasi. It does **not** deny the network: Node 24 has no `--allow-net`, and
 * `process.permission.has('net')` returning false is the absence of a scope
 * rather than a refusal. The network is closed inside the child instead, by the
 * `vm` context refusing dynamic import — see `child.ts`.
 *
 * `--max-old-space-size` is the third limit and the only one that is a
 * resource rather than a capability: see {@link CHILD_MAX_OLD_SPACE_MB}.
 * @returns the exec arguments for the fork.
 */
export function childExecArgv(): string[] {
  return [
    `--max-old-space-size=${String(CHILD_MAX_OLD_SPACE_MB)}`,
    '--permission',
    ...readableDirectories().map(dir => `--allow-fs-read=${dir}/*`),
  ]
}

/** Tuning that is the host's business, not part of the protocol. */
export interface EvaluatorOptions {
  /**
   * Wall clock for a whole batch.
   *
   * Enforced here rather than in the child: `vm`'s own `timeout` bounds only
   * synchronous execution, and the corpus awaits — 63 sites, all of them
   * `await getwi` — so an async template walks straight past it.
   */
  deadlineMs?: number
}

/** The default budget: about 28× the measured cost of 200 templates. */
export const DEFAULT_DEADLINE_MS = 2000

/**
 * How many children this host will have alive at once.
 *
 * One. A batch is a fork plus a 3.12 MiB snapshot plus a heap ceiling, and
 * nothing about this work is latency-critical enough to pay that N times over —
 * a second concurrent generation waits for the first, which costs it the
 * measured ~70 ms of fixed overhead plus however long the first batch runs, and
 * bounds the evaluator's whole footprint at one child rather than at however
 * many chats the user happens to have generating.
 */
export const CHILD_CONCURRENCY_LIMIT = 1

/** The tail of the queue. A batch waits on it and then becomes it. */
let queue: Promise<unknown> = Promise.resolve()

/** How many batches are inside the child-owning section, and the most ever. */
const concurrency = { inFlight: 0, peak: 0 }

/**
 * The evaluator's concurrency watermark.
 *
 * Exported so the queue is provable rather than believed: a test that fires two
 * batches at once and reads `peak` back sees `1` with the queue in place and `2`
 * without it. Counting entries to the child-owning section rather than live
 * child processes is deliberate — the `exit` event lands after `evaluateBatch`
 * has already resolved, so a live-child count would read 2 even when the queue
 * is doing its job.
 * @returns how many batches are running now, and the most that ever ran at once.
 */
export function childConcurrency(): { inFlight: number, peak: number } {
  return { ...concurrency }
}

/**
 * Evaluate one batch.
 *
 * Never throws for a template's sake. A template that fails, a child that dies,
 * and a batch that overruns all come back as failed items, because upstream
 * leaves the original text in place and lets the generation continue — a card
 * with one broken entry is still a usable card.
 *
 * Batches are serialised — see {@link CHILD_CONCURRENCY_LIMIT}. The deadline
 * starts when this batch reaches the child, not when it was queued, so a batch
 * that waited is not punished for waiting.
 * @param batch - items and the snapshot they read.
 * @param options - host-side tuning.
 * @returns every item's result, every write, and whether the deadline was hit.
 */
export async function evaluateBatch(
  batch: Omit<EvalBatch, 'v' | 'deadlineMs'> & { deadlineMs?: number },
  options: EvaluatorOptions = {},
): Promise<BatchOutcome> {
  const run = queue.then(() => runInChild(batch, options), () => runInChild(batch, options))
  // The queue must survive a batch that rejected, or one unexpected throw would
  // wedge every later generation behind it.
  queue = run.then(() => undefined, () => undefined)
  return await run
}

/**
 * One batch, with a child to itself.
 * @param batch - items and the snapshot they read.
 * @param options - host-side tuning.
 * @returns the outcome.
 */
async function runInChild(
  batch: Omit<EvalBatch, 'v' | 'deadlineMs'> & { deadlineMs?: number },
  options: EvaluatorOptions,
): Promise<BatchOutcome> {
  concurrency.inFlight += 1
  concurrency.peak = Math.max(concurrency.peak, concurrency.inFlight)
  try {
    return await forkAndRun(batch, options)
  } finally {
    concurrency.inFlight -= 1
  }
}

/**
 * Fork, push, collect.
 * @param batch - items and the snapshot they read.
 * @param options - host-side tuning.
 * @returns the outcome.
 */
async function forkAndRun(
  batch: Omit<EvalBatch, 'v' | 'deadlineMs'> & { deadlineMs?: number },
  options: EvaluatorOptions,
): Promise<BatchOutcome> {
  const deadlineMs = batch.deadlineMs ?? options.deadlineMs ?? DEFAULT_DEADLINE_MS

  // Oversized items are refused here and never reach the child, so the cap is a
  // named error on one item rather than a `SIGKILL` that reads as a timeout for
  // the whole batch.
  const oversize = new Map<string, ItemResult>()
  const sendable = batch.items.filter((item) => {
    if (item.text.length <= MAX_TEMPLATE_CHARS) return true
    oversize.set(item.id, {
      ok: false,
      error: `template text is ${String(item.text.length)} characters, over the `
        + `${String(MAX_TEMPLATE_CHARS)} character limit for one item`,
    })
    return false
  })

  const received = new Map<string, ItemResult>(oversize)
  const ops: Op[] = []
  let timedOut = false
  let fatal: string | undefined

  // A batch with nothing left to send forks nothing. The same reasoning as
  // `promptHasTemplate` one layer up: the fork is the cost of the feature, and
  // paying it to be told there is no work is the one case worth short-circuiting.
  if (sendable.length === 0) {
    return {
      results: batch.items.map(item => ({
        id: item.id,
        result: received.get(item.id) ?? unreached(item.id, { timedOut, deadlineMs, fatal }),
      })),
      ops,
      timedOut,
    }
  }

  const request: EvalBatch = { v: 1, deadlineMs, items: sendable, snapshot: batch.snapshot }

  const child = fork(CHILD_ENTRY, [], {
    // Nothing of the host's environment crosses. Measured: 85 variables become
    // 11, and the 11 are what Windows injects into any process — no API keys.
    // It does still carry the OS user name, which is worth knowing rather than
    // calling this "empty".
    env: {},
    execArgv: childExecArgv(),
    // Structured clone rather than JSON: the snapshot is megabytes and gets
    // pushed whole.
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      resolve()
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill(child)
      finish()
    }, deadlineMs)

    const onMessage = (message: ChildMessage): void => {
      switch (message.kind) {
        case 'ready':
          child.send(request)
          return
        case 'item':
          received.set(message.id, message.result)
          ops.push(...message.ops)
          return
        case 'done':
          finish()
          return
        case 'fatal':
          fatal = message.error
          finish()
      }
    }

    const onExit = (): void => {
      // The child died without saying `done`: whatever arrived still counts.
      finish()
    }

    child.on('message', onMessage)
    child.on('exit', onExit)
  })

  kill(child)

  return {
    results: batch.items.map(item => ({
      id: item.id,
      result: received.get(item.id) ?? unreached(item.id, { timedOut, deadlineMs, fatal }),
    })),
    ops,
    timedOut,
  }
}

/**
 * What an item that never came back reports.
 *
 * A failure rather than a gap, so a caller that falls back to the original text
 * on failure needs no special case for a timeout.
 * @param id - the item.
 * @param context - why it did not arrive.
 * @returns its result.
 */
function unreached(
  id: string,
  context: { timedOut: boolean, deadlineMs: number, fatal: string | undefined },
): ItemResult {
  if (context.timedOut) return { ok: false, error: `evaluation timed out after ${context.deadlineMs}ms` }
  if (context.fatal !== undefined) return { ok: false, error: `evaluator failed: ${context.fatal}` }
  return { ok: false, error: `evaluator produced no result for ${id}` }
}

/**
 * End the child.
 *
 * `SIGKILL` because the point of the deadline is a template that will not stop,
 * and a template that will not stop will not honour a request to.
 * @param child - the process.
 */
function kill(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}
