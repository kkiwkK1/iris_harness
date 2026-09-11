/**
 * The capability face extensions reach the host through.
 *
 * The ruling (`notes/EXTENSION-SYSTEM-RULING.md` §2) is that an extension can
 * touch exactly what the host **provides as a service** — storage namespaces,
 * event subscription, generation-pipeline hooks, settings contributions — and
 * that an inject outside that list is refused. Cordis has no literal
 * `ctx.provide`; a provided service is a named field on the context published
 * by a `Service` subclass, the pattern `IrisRpcHost` already uses. This module
 * publishes the two faces this host puts in the v1 surface:
 *
 * - {@link IrisStorageService} (`ctx.irisStorage`) — the storage namespace
 *   (ruling §2, first item). One directory per extension under the profile's
 *   `extensions/` root, contained and atomically written, because the ruling's
 *   forbidden list names raw filesystem paths and a second write path beside
 *   `host.lock` and this face closes both by construction: there is no path
 *   parameter anywhere on it, and every write goes through `atomicWriteFile`.
 * - {@link IrisGenerationService} (`ctx.irisGeneration`) — the generation
 *   pipeline hook (ruling §2, 「生成管线钩子是第一公民」). The one hook v1
 *   carries is the record hook: at the end of every real generation the host
 *   hands each registered sink the request as it went out, the provider's
 *   figures, and what failed, and the sink can do nothing that costs the
 *   generation — a throw is logged and the generation carries on, which is
 *   `cache-trace.ts`'s own rule promoted to contract.
 *
 * Deliberately **not** here yet, and named for the follow-up rather than
 * forgotten: the `claim`/manifest machinery of `docs/EXTENSIONS.md` §3.1 (the
 * `iris:` package.json node, id de-duplication, the boot log line), the
 * `events` face (§3.3) and the declarative `settings` face (§3.5). The PoC
 * needs storage and one hook; the rest of the contract is E-2's to land, and
 * the shapes here are meant to survive that landing.
 *
 * @module @iris/app-service/extensions
 */

import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { Context, Service } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { PromptDivergence } from '@iris/protocol'

import { atomicWriteFile } from './atomic.ts'
import { invalid } from './errors.ts'
import { isSafeId } from './paths.ts'

/**
 * One extension's storage namespace.
 *
 * A name is `/`-separated segments, each segment passing the same identifier
 * guard a chat filename passes, and the resolved path is checked to still be
 * inside the namespace — the belt-and-braces pair `fileFor` established, with
 * the same reasoning: one guard alone is one bug away from `../../`. Writes
 * are atomic and create their directory; a document absent reads as
 * `undefined`, not as an error, because a namespace an extension has never
 * written is its ordinary first state.
 */
export interface ExtensionStorage {
  /** Read one JSON document. Absent is `undefined`. */
  read(name: string): Promise<unknown | undefined>
  /** Replace one JSON document whole, atomically. */
  write(name: string, value: unknown): Promise<void>
  /** Delete one document. Absent is not an error. */
  remove(name: string): Promise<void>
  /** The document names directly inside `prefix`, or the namespace root. */
  list(prefix?: string): Promise<string[]>
}

/**
 * Resolve one namespace name to a path inside `root`, refusing escape.
 * @param root - the namespace's directory.
 * @param name - `/`-separated segments, each a safe id.
 * @returns the absolute path.
 * @throws {AppError} `invalid-request` when any segment would leave `root`.
 */
function resolveInside(root: string, name: string): string {
  // The empty name is the namespace root itself, not a failed segment.
  const segments = name === '' ? [] : name.split('/')
  for (const segment of segments) {
    if (!isSafeId(segment)) throw invalid(`"${name}" is not a valid storage name`)
  }
  const base = resolve(root)
  const path = resolve(base, ...segments)
  if (path !== base && !path.startsWith(base + sep)) {
    throw invalid(`"${name}" is not a valid storage name`)
  }
  return path
}

/**
 * The filesystem-backed namespace, and the only writer this face ships.
 *
 * Exported so a test can stand a namespace up over a temporary directory; the
 * service hands out namespaces built on this and nothing else.
 * @param root - the namespace's own directory. It need not exist.
 * @returns the namespace.
 */
export function localNamespace(root: string): ExtensionStorage {
  return {
    async read(name: string): Promise<unknown | undefined> {
      try {
        return JSON.parse(await readFile(resolveInside(root, name), 'utf8')) as unknown
      } catch (cause: unknown) {
        // Absent is the ordinary state; a document present but malformed is
        // the caller's to see, because silently reading a corrupt document as
        // "never written" is how a half-write becomes invisible.
        if ((cause as { code?: string }).code === 'ENOENT') return undefined
        throw cause
      }
    },

    async write(name: string, value: unknown): Promise<void> {
      const path = resolveInside(root, name)
      await mkdir(resolve(root, name.split('/').slice(0, -1).join('/')), { recursive: true })
      await atomicWriteFile(path, JSON.stringify(value))
    },

    async remove(name: string): Promise<void> {
      try {
        await unlink(resolveInside(root, name))
      } catch (cause: unknown) {
        if ((cause as { code?: string }).code !== 'ENOENT') throw cause
      }
    },

    async list(prefix?: string): Promise<string[]> {
      // An absent or empty prefix names the namespace root itself; a trailing
      // slash is the natural way to write "everything under this directory"
      // and is not a segment of its own.
      const trimmed = (prefix ?? '').replace(/\/+$/u, '')
      const dir = resolveInside(root, trimmed)
      const head = trimmed === '' ? '' : `${trimmed}/`
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (cause: unknown) {
        // No directory is the ordinary state of a namespace nothing was
        // written to yet, not a failure worth raising.
        if ((cause as { code?: string }).code === 'ENOENT') return []
        throw cause
      }
      return entries
        .filter(entry => entry.isFile())
        .map(entry => `${head}${entry.name}`)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    },
  }
}

/**
 * The storage capability, published as `ctx.irisStorage`.
 *
 * `namespace` takes the **extension's id**, not a path: the root is derived by
 * the host from `profilePaths().extensions`, so an extension can name its own
 * directory and nothing else, and two extensions cannot share one by accident.
 */
export class IrisStorageService extends Service {
  // TypeScript `private`, not `#name`: Cordis derives a per-context view of a
  // service with `Object.create` over this instance, and a true private field
  // is not reachable through that delegation (`IrisRpcHost` records the same).
  private readonly extensionsRoot: string

  /**
   * @param ctx - the context to publish on.
   * @param profileRoot - the profile's own directory (`profilePaths().root`).
   */
  constructor(ctx: Context, profileRoot: string) {
    super(ctx, 'irisStorage')
    this.extensionsRoot = join(profileRoot, 'extensions')
  }

  /**
   * The namespace one extension owns.
   * @param id - the extension's persistence id; the same identifier rules as
   *   any directory name on disk.
   * @returns the namespace, rooted at `<profile>/extensions/<id>/`.
   */
  namespace(id: string): ExtensionStorage {
    // The id becomes a directory segment, so it goes through the same guard a
    // chat id does — an unchecked `..` here would put one extension's writes
    // inside another's.
    if (!isSafeId(id)) throw invalid(`"${id}" is not a valid extension id`)
    return localNamespace(join(this.extensionsRoot, id))
  }
}

/**
 * The record hook's payload, signature version 1.
 *
 * Everything a request-side instrument needs and nothing it must re-derive:
 * the request exactly as the provider receives it — `layout` included, because
 * the byte-to-part map is built from the driver's own record, not by searching
 * the body — plus the provider's figures once it has said, and what surfaced
 * when the reply did not complete. Delivered **once per generation, from the
 * generation's own `finally`**: an aborted turn is a turn whose cost figure is
 * missing, and it is exactly the turn a reader is trying to place, so the hook
 * fires for failures too — `error` says which, and `usage` is simply absent.
 */
export interface GenerationRecord {
  /** The hook signature's version. A breaking change is a new hook, not this. */
  apiVersion: 1
  /** The request as the provider is about to receive it, layout included. */
  request: GenerateOptions
  /** The conversation, the kind, and the turn — `-1` when it is not a turn. */
  target: { chatId: string, kind: string, caller?: string, turn: number }
  /** When the request went out; Unix epoch milliseconds. */
  sentAt: number
  /** What the provider charged, once it has said. Absent when it never did. */
  usage?: { inputTokens?: number, cacheReadTokens?: number }
  /** What surfaced in the report panel, when the reply did not complete. */
  error?: string
}

/**
 * The port the host hands generation records through, and asks the stored
 * record's own comparison of.
 *
 * This is the service option's type (`AppServiceOptions.cacheTrace`): the
 * service does not know whether a store, an extension, or a test stands behind
 * it, only that records go in and comparisons come out.
 */
export interface CacheTraceSink {
  /** Receives every real generation's record, failures included. */
  record(payload: GenerationRecord): void | Promise<void>
  /** The stored record's own comparison, for the host's `prompt.divergence`. */
  divergence?(chatId: string, seq?: number): Promise<PromptDivergence | undefined>
}

/**
 * What one extension registers to receive {@link GenerationRecord}s.
 *
 * `divergence` is the read-back face: the host's `prompt.divergence` RPC
 * consults the first sink that declares it, because the reader of the record
 * should be the writer of it — the comparison is over the sink's own stored
 * bytes, and a host-side reader would make the on-disk format a second
 * contract nobody asked for. Optional, because a sink that only observes has
 * nothing to answer.
 */
export interface GenerationSink extends CacheTraceSink {
  /** The sink speaks the same signature version its payloads carry. */
  apiVersion: 1
}

/**
 * The generation pipeline hook, published as `ctx.irisGeneration`.
 *
 * A sink that records must never cost the generation it records: `record`
 * awaits each sink in turn inside its own guard, a throw is logged with the
 * sink's owner and dropped, and the generation carries on exactly as if the
 * sink were not installed. This is `cache-trace.ts`'s own rule — an instrument
 * that can break the thing it measures is not one — promoted from one store's
 * discipline to the hook contract's.
 */
export class IrisGenerationService extends Service {
  /** Registration order is the run order; `cordis.yml` order decides nothing. */
  // `private` rather than `#name`, for the per-context delegation above.
  private readonly sinks = new Map<string, GenerationSink>()

  constructor(ctx: Context) {
    super(ctx, 'irisGeneration')
  }

  /**
   * Register a sink. One sink per owner: a second registration replaces the
   * first, so a hot reload cannot leave two copies of one extension recording.
   * @param owner - the extension's id, for the log line when it misbehaves.
   * @param sink - the sink.
   * @returns a disposer, for `ctx.effect`.
   */
  registerSink(owner: string, sink: GenerationSink): () => void {
    if (sink.apiVersion !== 1) throw invalid(`extension "${owner}" speaks hook signature ${String(sink.apiVersion)}, and this host provides 1`)
    this.sinks.set(owner, sink)
    return () => {
      // Only the owner's own registration is removed: a disposer outliving its
      // replacement must not unregister the replacement with it.
      if (this.sinks.get(owner) === sink) this.sinks.delete(owner)
    }
  }

  /**
   * Hand one record to every sink, failure-isolated per sink.
   * @param payload - the generation's record.
   * @returns nothing; a sink's failure is logged, never raised.
   */
  async record(payload: GenerationRecord): Promise<void> {
    for (const [owner, sink] of this.sinks) {
      try {
        await sink.record(payload)
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `extensions: ${owner} generation.record failed (generation carried on): `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * Ask the first sink that answers comparisons for one.
   * @param chatId - the conversation.
   * @param seq - the newer of the pair, when stated.
   * @returns the comparison, or undefined when no sink answers or no pair exists.
   */
  async divergence(chatId: string, seq?: number): Promise<PromptDivergence | undefined> {
    for (const [owner, sink] of this.sinks) {
      if (sink.divergence === undefined) continue
      try {
        return await sink.divergence(chatId, seq)
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `extensions: ${owner} divergence failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return undefined
      }
    }
    return undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The storage capability this host provides (`./extensions.ts`). */
    irisStorage: IrisStorageService
    /** The generation hook this host provides (`./extensions.ts`). */
    irisGeneration: IrisGenerationService
  }
}
