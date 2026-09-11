/**
 * The environment a template sees, built from a snapshot.
 *
 * Upstream exposes roughly ninety names, backed by the whole SillyTavern page:
 * `execute()` runs slash commands, `SillyTavern.getContext()` hands over the
 * application, `$` is jQuery bound to the real document. Measured across the
 * corpus, templates touch **six** of them. This module implements those six
 * faithfully and refuses the rest by name.
 *
 * Refusing by name rather than by omission is `docs/SANDBOX.md`'s rule: `undefined`
 * from a lookup is indistinguishable from "not found", so a card would take a
 * policy decision for a missing value and fail somewhere later with no trace of
 * why.
 *
 * **What this module does not do is hand any of it to a template.** It returns a
 * *description* — data, live reads, callables, guarded objects — and `child.ts`
 * builds the template's scope out of it inside the `vm` realm, so that every
 * function a template can see is a context trampoline and every object a
 * context object. A closure from this file reaching template code directly is
 * `escapeFn.constructor("return process")`, which is `realm.ts`'s whole subject.
 *
 * The state these closures read and write is itself made **inside** the realm —
 * {@link createState} builds it with the realm's `JSON.parse` and mutates it
 * with the realm's lodash — so `getvar` can keep returning a live reference the
 * way upstream does, instead of a copy that silently drops a template's
 * `getvar('stat_data').hp = 5`.
 *
 * @module @iris/compat-prompt-template/environment
 */

import type { GuardedSpec, Realm, RealmLodash } from './realm.ts'
import type { Json, Op, Scope, Snapshot, WorldInfoEntry } from './types.ts'

/**
 * Raised when a template reaches for part of upstream's environment that this
 * package does not implement.
 *
 * Names the member, because the card author's next question is always "which
 * one", and a card that fails this way is a measurement: it tells us which part
 * of the surface the corpus did not predict.
 *
 * It is thrown in **this** realm and reaches the template as a context `Error`
 * carrying the same `name` and `message` — see `realm.ts`. So a template can
 * read what it says and cannot use it as a bridge back here.
 */
export class UnsupportedTemplateApiError extends Error {
  override name = 'UnsupportedTemplateApiError'
  constructor(member: string, detail?: string) {
    super(`${member} is not available to Iris templates${detail ? `: ${detail}` : ''}`)
  }
}

/** Upstream accepts either an options object or a bare string shorthand. */
export type VarOptions = string | boolean | {
  scope?: Scope | 'cache'
  inscope?: Scope | 'cache'
  outscope?: Scope | 'cache'
  index?: number | string
  defaults?: unknown
  clone?: boolean
  noCache?: boolean
  merge?: boolean
  flags?: 'nx' | 'xx' | 'nxs' | 'xxs' | 'n'
  results?: 'old' | 'new' | 'fullcache'
  dryRun?: boolean
  withMsg?: unknown
}

/** Options this package understands. Anything else is refused rather than ignored. */
const KNOWN_OPTIONS = new Set([
  'scope', 'inscope', 'outscope', 'index', 'defaults', 'clone', 'noCache',
  'merge', 'flags', 'results', 'dryRun',
])

type Normalized = Exclude<VarOptions, string | boolean>

/**
 * Upstream's `optionsConverter`, restricted to the forms it actually produces.
 *
 * A bare string is either a `results` mode, a `flags` mode, or a scope that sets
 * all three of `scope`/`inscope`/`outscope` at once; a bare boolean is `dryRun`.
 * @param options - what the template passed.
 * @returns the option object upstream would have built.
 */
function normalizeOptions(options: VarOptions = {}): Normalized {
  if (typeof options === 'boolean') return { dryRun: options }
  if (typeof options === 'string') {
    switch (options) {
      case 'old': case 'new': case 'fullcache':
        return { results: options }
      case 'nx': case 'xx': case 'nxs': case 'xxs': case 'n':
        return { flags: options }
      case 'cache': case 'global': case 'local': case 'message': case 'initial':
        return { scope: options, inscope: options, outscope: options }
      default:
        throw new UnsupportedTemplateApiError(`variable option '${options}'`, 'not a scope, flag or result mode upstream defines')
    }
  }
  for (const key of Object.keys(options)) {
    if (KNOWN_OPTIONS.has(key)) continue
    throw new UnsupportedTemplateApiError(
      `variable option '${key}'`,
      key === 'withMsg'
        ? 'selecting another message needs the chat, which is not pushed to the evaluator'
        : 'unknown to this compatibility layer',
    )
  }
  return options
}

/**
 * Normalise an options argument so a scope can be layered onto it.
 *
 * The shorthands spread their caller's options and then force a scope, and the
 * caller may have passed upstream's bare-string form. Converting first keeps
 * `getMessageVar(k, 'old')` meaning what it means upstream.
 * @param options - whatever the template passed.
 * @returns the object form.
 */
function asObject(options: VarOptions): Normalized {
  return normalizeOptions(options)
}

/**
 * `_.get` with upstream's null-key behaviour.
 * @param lodash - the realm's lodash, so a miss builds nothing of this realm.
 * @param object - the store to read.
 * @param key - a lodash path, or null for the whole store.
 * @param defaults - what to return when the path is absent.
 * @returns the value at the path.
 */
function get(lodash: RealmLodash, object: object, key: string | number | null, defaults?: unknown): unknown {
  if (key == null) return object
  return lodash.get(object, key, defaults)
}

/**
 * One template scope, described rather than built.
 *
 * Split by how each member has to cross into the realm: data is re-created,
 * reads and calls become trampolines, guarded objects become context proxies.
 */
export interface EnvironmentMembers {
  /** Plain JSON the host pushed: the scalars and this item's own locals. */
  data: Record<string, Json>
  /** Members whose value is read from live batch state on every access. */
  reads: Record<string, () => unknown>
  /** Host callables the template invokes. */
  calls: Record<string, (...args: never[]) => unknown>
  /** Objects with a closed member list and a named refusal for everything else. */
  objects: Record<string, GuardedSpec>
}

/** A description of the template scope, plus the writes performed through it. */
export interface Environment {
  /** What `child.ts` builds the template's scope out of. */
  members: EnvironmentMembers
  /** Writes performed so far, in order. Read after each item. */
  ops: Op[]
}

/** How to build one. */
export interface EnvironmentOptions {
  snapshot: Snapshot
  /** The realm the state lives in and the template will run in. */
  realm: Pick<Realm, 'lodash'>
  /** Per-item additions — a world-info entry supplies its own `world_info`. */
  locals?: Record<string, Json> | undefined
  /**
   * Compiles and evaluates a nested template, for `getwi`.
   *
   * Injected rather than imported so this module stays free of the engine: the
   * recursion is `getwi`'s business, and where the compiler lives is `child.ts`'s.
   * The third argument is what the nested evaluation adds *on top of* the
   * calling item's scope; composing the two is the caller's job, because the
   * composition has to happen inside the realm.
   */
  evaluateNested: (text: string, origin: string, extra: Record<string, unknown>) => Promise<string>
}

/**
 * Build the environment for one item.
 *
 * Each item gets a fresh `ops` array and its own view, but they share the
 * mutable variable state so that a write in item 3 is visible to item 4 — which
 * is how upstream behaves, because upstream is writing to the live application.
 * @param options - the snapshot, the realm, per-item locals, and the nested evaluator.
 * @param state - variable state shared across the batch. Created by `createState`.
 * @returns the environment.
 */
export function buildEnvironment(options: EnvironmentOptions, state: BatchState): Environment {
  const { snapshot, realm, locals: itemLocals, evaluateNested } = options
  const lodash = realm.lodash
  const ops: Op[] = []

  const readScope = (scope: Scope | 'cache'): Record<string, unknown> =>
    scope === 'cache' ? state.cache : state.scopes[scope]

  const getvar = (key: string | null, rawOptions?: VarOptions): unknown => {
    const opts = normalizeOptions(rawOptions)
    const { index, defaults, clone } = opts
    const store = readScope(opts.scope ?? opts.inscope ?? 'cache')

    if (index != null) {
      // Upstream stores indexed values as JSON strings inside the variable. The
      // realm's `JSON.parse`, so the object handed back is the realm's.
      const raw = get(lodash, store, key, '{}')
      const data = state.parse(typeof raw === 'string' && raw ? raw : '{}') as object
      const idx = Number(index)
      return get(lodash, data, Number.isNaN(idx) ? index : idx, defaults)
    }
    const result = get(lodash, store, key, defaults)
    return clone ? lodash.cloneDeep(result) : result
  }

  const setvar = (key: string, value: unknown, rawOptions?: VarOptions): unknown => {
    const opts = normalizeOptions(rawOptions)
    const { index, flags, results, merge, dryRun } = opts
    if (index != null) {
      throw new UnsupportedTemplateApiError('setvar option \'index\'', 'indexed writes are not implemented')
    }
    if (dryRun) return undefined

    if (flags === 'nx' && lodash.has(state.cache, key)) return undefined
    if (flags === 'xx' && !lodash.has(state.cache, key)) return undefined
    if (flags === 'nxs' && getvar(key, rawOptions) !== undefined) return undefined
    if (flags === 'xxs' && getvar(key, rawOptions) === undefined) return undefined

    let oldValue: unknown
    let newValue = value
    if (results === 'old' || merge) oldValue = get(lodash, state.cache, key, undefined)

    if (merge) {
      if ((oldValue === undefined || lodash.isArray(oldValue)) && lodash.isArray(value)) {
        newValue = lodash.concat((oldValue ?? []) as unknown[], value)
      } else {
        newValue = lodash.mergeWith(
          lodash.cloneDeep(oldValue ?? state.empty()),
          value,
          (_dst: unknown, src: unknown) => (lodash.isArray(src) ? src : undefined),
        )
      }
    }

    // Upstream writes the cache first, then the backing scope. Both, always:
    // the cache is what the rest of the batch reads.
    if (newValue === undefined) lodash.unset(state.cache, key)
    else lodash.set(state.cache, key, newValue)

    // Upstream's default write scope is `message`, not the read default `cache`.
    const scope = (opts.scope ?? opts.outscope ?? 'message') as Scope | 'cache'
    if (scope === 'cache') {
      throw new UnsupportedTemplateApiError('setvar scope \'cache\'', 'upstream has no cache-only write')
    }
    if (scope === 'initial') {
      // Upstream does support this, writing its in-memory `STATE.initialVariables`,
      // which evaporates with the page. Iris has no such store: `initial` is a
      // projection of what the card file ships. So the write would either vanish
      // silently — misleading — or edit the card, which is a different and much
      // larger operation than the template asked for. Refused by name instead;
      // zero corpus sites, and `notes/packages/iris-compat-prompt-template/DEVIATIONS.md` records the divergence.
      throw new UnsupportedTemplateApiError(
        'setvar scope \'initial\'',
        'initial variables come from the card file and are not writable at runtime',
      )
    }
    if (newValue === undefined) lodash.unset(state.scopes[scope], key)
    else lodash.set(state.scopes[scope], key, newValue)

    ops.push(
      newValue === undefined
        ? { op: 'delvar', scope, key }
        : { op: 'setvar', scope, key, value: newValue as Json },
    )

    const bumped = Number(state.cache['_modify_id'])
    state.cache['_modify_id'] = Number.isFinite(bumped) ? bumped + 1 : 1

    if (results === 'old') return oldValue
    if (results === 'fullcache') return state.cache
    return newValue
  }

  /**
   * `getwi(world, entry)` — fetch another world-info entry and evaluate it.
   *
   * Upstream's overload: when the second argument is a plain object, the first
   * argument is the entry title and the book comes from the fallback chain.
   * The target may be a string, a RegExp or a uid; the corpus uses all but uid.
   */
  const getwi = async (
    worldOrEntry: string | RegExp | null,
    entryOrData: string | RegExp | number | Record<string, unknown> = {},
    data: Record<string, unknown> = {},
  ): Promise<string> => {
    let explicitBook: string | null
    let target: string | RegExp | number
    // The realm's `isPlainObject`, because the object under test was made by the
    // template: a host lodash compares against a host `Object.prototype` and
    // answers `false` for every one of them.
    if (lodash.isPlainObject(entryOrData)) {
      explicitBook = null
      target = worldOrEntry as string | RegExp
      data = entryOrData as Record<string, unknown>
    } else {
      explicitBook = (worldOrEntry as string | null) || null
      target = entryOrData as string | RegExp | number
    }

    const own = itemLocals?.['world_info'] as { world?: string } | undefined
    const book = resolveLorebook(explicitBook, own?.world, snapshot.lorebooks)
    const entry = findWorldInfoEntry(snapshot.worldInfo, book, target)
    if (!entry) return ''

    return await evaluateNested(
      entry.content,
      `worldinfo/${entry.world}/${entry.uid}-${entry.comment}`,
      { ...data, world_info: entry },
    )
  }

  /**
   * The two members of `SillyTavern` the corpus uses, and a wall behind them.
   *
   * `saveMetadata` records the write rather than performing it; the host applies
   * it, like every other write. The wall is described here and built as a
   * context `Proxy` by `realm.ts`, so a template that catches the refusal holds
   * an error of its own realm.
   */
  const sillyTavern: GuardedSpec = {
    reads: { chatMetadata: () => state.chatMetadata },
    calls: {
      saveMetadata: () => {
        ops.push({ op: 'saveMetadata', value: lodash.cloneDeep(state.chatMetadata) as Json })
      },
    },
    refuse: member => new UnsupportedTemplateApiError(
      `SillyTavern.${member}`,
      'only chatMetadata and saveMetadata are bridged',
    ),
  }

  /**
   * Upstream's per-scope shorthands.
   *
   * Found by the differential script, not by the original census: that counted
   * `getvar`/`setvar` and missed the alias family entirely, so the corpus's
   * `getMessageVar` (5 sites) and `setLocalVar` (1 site) read as zero and five
   * fields failed with a `ReferenceError` that would have rendered fine in the
   * operator's SillyTavern. Transcribed from `prepareContext`, where each is a
   * one-line partial application of the base function.
   */
  const scoped = {
    getLocalVar: (key: string | null, options: VarOptions = {}) => getvar(key, { ...asObject(options), scope: 'local' }),
    getGlobalVar: (key: string | null, options: VarOptions = {}) => getvar(key, { ...asObject(options), scope: 'global' }),
    getMessageVar: (key: string | null, options: VarOptions = {}) => getvar(key, { ...asObject(options), scope: 'message' }),
    setLocalVar: (key: string, value: unknown, options: VarOptions = {}) => setvar(key, value, { ...asObject(options), scope: 'local' }),
    setGlobalVar: (key: string, value: unknown, options: VarOptions = {}) => setvar(key, value, { ...asObject(options), scope: 'global' }),
    setMessageVar: (key: string, value: unknown, options: VarOptions = {}) => setvar(key, value, { ...asObject(options), scope: 'message' }),
  }

  const members: EnvironmentMembers = {
    data: { ...snapshot.scalars, ...itemLocals },
    reads: { variables: () => state.cache },
    calls: {
      getvar,
      getVariable: getvar,
      setvar,
      setVariable: setvar,
      ...scoped,
      getwi,
      getWorldInfo: getwi,
    } as EnvironmentMembers['calls'],
    objects: { SillyTavern: sillyTavern },
  }

  return { members, ops }
}

/**
 * Which book an unqualified `getwi` searches.
 *
 * Upstream's chain, from `getWorldInfoEntries`:
 *
 * ```js
 * const lore = name || characters[this_chid]?.data?.extensions?.world
 *   || power_user.persona_description_lorebook || chat_metadata[METADATA_KEY] || ''
 * ```
 *
 * The first link — the entry's own book — is reached through
 * `boundedReadWorldinfo`, which passes `worldinfoOrEntry || this.world_info?.world
 * || ''` as `name`. So an entry being evaluated in its own right searches its own
 * book; an entry whose text has already been folded into an assembled message has
 * no `world_info` and falls through to the card's bound book, which is where all
 * 58 of the corpus's literal targets live.
 * @param explicit - the book the caller named, if any.
 * @param entryWorld - `world_info.world`, when this evaluation has one.
 * @param lorebooks - the rest of the chain.
 * @returns the single book to search, or undefined when the chain runs out.
 */
export function resolveLorebook(
  explicit: string | null | undefined,
  entryWorld: string | undefined,
  lorebooks: Snapshot['lorebooks'],
): string | undefined {
  // Upstream's `||`, so an empty string falls through exactly as it does there.
  return explicit || entryWorld || lorebooks.character || lorebooks.persona || lorebooks.chat || undefined
}

/**
 * Find the entry `getwi` was asked for, within one book.
 *
 * **One book, never the union.** Upstream loads a single lorebook and scans it;
 * when the chain resolves to nothing it loads nothing and the lookup fails. An
 * implementation that searched every pushed entry would answer a `getwi` with a
 * same-titled entry from a book the card never referenced — the right shape of
 * answer, from the wrong place, with nothing raised anywhere.
 *
 * The predicate is upstream's, in one pass per entry:
 * `comment === title || uid === title || comment.match(title)`. The third is a
 * `String.prototype.match`, so a **string** target is also tried as a regular
 * expression — which means a title containing regex metacharacters can throw,
 * exactly as it does upstream, and surfaces as a failed item.
 * @param entries - every pushed entry, across all books.
 * @param book - the resolved book; undefined means the chain ran out.
 * @param target - a title, a regex over titles, or a uid.
 * @returns the first entry that matches, or undefined.
 */
export function findWorldInfoEntry(
  entries: WorldInfoEntry[],
  book: string | undefined,
  target: string | RegExp | number,
): WorldInfoEntry | undefined {
  if (book === undefined) return undefined
  return entries.find(entry => entry.world === book && matchesEntry(entry, target))
}

/**
 * Upstream's three-way match, evaluated per entry rather than in passes.
 *
 * There is no `target instanceof RegExp` shortcut here, and there used to be.
 * ``getwi(null, new RegExp(`^${charName}$`))`` — the corpus's one computed
 * target — builds its regex inside the **template's** realm, where `instanceof`
 * compares against this realm's `RegExp.prototype` and answers `false`. So the
 * branch never fired for the regexes that actually arrive, and the ones it did
 * fire for took `RegExp.test` where upstream takes `String.match`. Dropping it
 * leaves one predicate, upstream's, for every realm.
 * @param entry - the candidate.
 * @param target - what `getwi` was given.
 * @returns whether upstream would return this entry.
 */
function matchesEntry(entry: WorldInfoEntry, target: string | RegExp | number): boolean {
  if (entry.comment === String(target) || entry.uid === String(target)) return true
  // `String.match(number)` is null, which upstream notes and relies on.
  if (typeof target === 'number') return false
  return entry.comment.match(target) !== null
}

/** Variable state that lives for the whole batch, not one item. */
export interface BatchState {
  /** Upstream's merged view. What an unqualified `getvar` reads. */
  cache: Record<string, unknown>
  /** The four backing stores, which is what a scoped read or write touches. */
  scopes: Record<Scope, Record<string, unknown>>
  chatMetadata: Record<string, unknown>
  /** The realm's `JSON.parse`, for `getvar`'s indexed form. */
  parse: (text: string) => unknown
  /** A fresh object of the realm this state lives in. */
  empty: () => object
}

/**
 * Recreate upstream's variable cache, **inside the realm**.
 *
 * `Object.assign` in this order, then a deep clone — a **shallow** merge, so a
 * key present in two scopes is taken whole from the later one rather than merged
 * key-by-key. Transcribed from `precacheVariables`; the order is load-bearing
 * and is the reason the scopes are pushed unmerged.
 *
 * Every object here is built by the realm: `realm.adopt` re-parses the pushed
 * JSON with the context's own `JSON.parse`, the merge is the context's
 * `Object.assign`, and the clone is the context's lodash.
 *
 * **Once per batch is the whole cost of the realm rule.** Re-creating each value
 * as it crosses would have been the obvious reading, and it is both slower and
 * wrong: `getvar('stat_data')` hands upstream's template a live reference, so a
 * card writing `getvar('stat_data').hp = 5` writes the cache, and a per-call
 * copy would drop that silently. Building the state inside the realm instead
 * keeps the reference live and pays the conversion here.
 *
 * Measured 2026-09-11 on the corpus's heaviest chat — a 708,022-character
 * variable blob — over three rounds: **9.6, 10.9, 10.2 ms**, against the 9.7 and
 * 9.9 ms the host-realm `_.cloneDeep` it replaced cost on the same input. So the
 * realm re-creation is free to within the noise of the deep clone that was
 * already there, and is 0.5% of the 2000 ms batch deadline. The same install's
 * heaviest possible batch — that blob, all 1,478 world-info entries (6.79 MiB of
 * snapshot) and all 203 templated entries as items — runs end to end through a
 * real forked child in 257–276 ms.
 * @param snapshot - what the host pushed.
 * @param realm - where the state is to live.
 * @returns state for one batch.
 */
export function createState(snapshot: Snapshot, realm: Realm): BatchState {
  const scopes: Record<Scope, Record<string, unknown>> = {
    global: realm.adopt(snapshot.variables.global ?? {}) as Record<string, unknown>,
    initial: realm.adopt(snapshot.variables.initial ?? {}) as Record<string, unknown>,
    local: realm.adopt(snapshot.variables.local ?? {}) as Record<string, unknown>,
    message: realm.adopt(snapshot.variables.message ?? {}) as Record<string, unknown>,
  }
  const cache = realm.lodash.cloneDeep(realm.assign(
    scopes.global,
    scopes.initial,
    scopes.local,
    scopes.message,
    realm.adopt({ _trace_id: snapshot.traceId, _modify_id: 0 }),
  )) as Record<string, unknown>

  return {
    cache,
    scopes,
    chatMetadata: realm.adopt(snapshot.chatMetadata ?? {}) as Record<string, unknown>,
    parse: realm.parse,
    empty: realm.create,
  }
}
