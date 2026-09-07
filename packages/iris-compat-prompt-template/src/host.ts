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
 * How the child is locked down.
 *
 * `--permission` denies filesystem writes, `child_process`, `worker`, addons and
 * wasi. It does **not** deny the network: Node 24 has no `--allow-net`, and
 * `process.permission.has('net')` returning false is the absence of a scope
 * rather than a refusal. The network is closed inside the child instead, by the
 * `vm` context refusing dynamic import — see `child.ts`.
 * @returns the exec arguments for the fork.
 */
export function childExecArgv(): string[] {
  return ['--permission', ...readableDirectories().map(dir => `--allow-fs-read=${dir}/*`)]
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
 * Evaluate one batch.
 *
 * Never throws for a template's sake. A template that fails, a child that dies,
 * and a batch that overruns all come back as failed items, because upstream
 * leaves the original text in place and lets the generation continue — a card
 * with one broken entry is still a usable card.
 * @param batch - items and the snapshot they read.
 * @param options - host-side tuning.
 * @returns every item's result, every write, and whether the deadline was hit.
 */
export async function evaluateBatch(
  batch: Omit<EvalBatch, 'v' | 'deadlineMs'> & { deadlineMs?: number },
  options: EvaluatorOptions = {},
): Promise<BatchOutcome> {
  const deadlineMs = batch.deadlineMs ?? options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const request: EvalBatch = {
    v: 1,
    deadlineMs,
    items: batch.items,
    snapshot: batch.snapshot,
  }

  const received = new Map<string, ItemResult>()
  const ops: Op[] = []
  let timedOut = false
  let fatal: string | undefined

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
