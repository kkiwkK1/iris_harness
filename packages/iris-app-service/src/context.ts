/**
 * The host half of the `parent.*` bridge.
 *
 * A card script reaches for SillyTavern's own globals. Measured over the 19
 * cards in the local corpus, the 15 `parent.SillyTavern` sites touch **19 of
 * the 145 fields** `getContext()` exposes — so this assembles those, and not a
 * transcription of upstream's interface. The width of a compatibility surface
 * should be decided by what the ecosystem reaches for, not by what the
 * documentation lists.
 *
 * What lives here is only the part the host can answer. Rendering
 * (`addOneMessage`, `printMessages`) has no meaning in a process with no DOM,
 * and the event bus is presented in the frame; both belong to the browser
 * stream. See `SANDBOX.md` for the split.
 *
 * @module @iris/app-service/context
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { CharacterSummary, ScriptContext } from '@iris/protocol'
import { extractScripts } from '@iris/script'

import type { ScopeBackend } from '@iris/variables'

import type { ChatEntry } from './entry.ts'
import { invalid } from './errors.ts'

// The wire type is used directly rather than mirrored. A parallel shape would
// need a translation table between them, and a translation table is a second
// place for the two halves to drift apart — which is exactly how `MessageView.key`
// came to mean two different things.
export type { ScriptContext } from '@iris/protocol'

/**
 * Whether a value can survive the chat file and the event log.
 *
 * Both are lossless-JSON only, and a frame can hand back anything. Catching it
 * here names the offending path; letting it through fails later inside an
 * append, where the message is about serialization and not about the card.
 * @param value - the candidate.
 * @param path - where it sits, for the message.
 * @throws {AppError} `invalid-request` at the first value that cannot be stored.
 */
export function assertStorable(value: unknown, path = 'value'): void {
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number': {
      if (!Number.isFinite(value)) throw invalid(`${path} is ${String(value)}, which cannot be stored`)
      return
    }
    case 'object': {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => { assertStorable(entry, `${path}[${String(index)}]`) })
        return
      }
      const prototype = Object.getPrototypeOf(value) as unknown
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalid(`${path} is a ${value.constructor?.name ?? 'class'} instance, which cannot be stored`)
      }
      for (const [key, nested] of Object.entries(value)) assertStorable(nested, `${path}.${key}`)
      return
    }
    default:
      throw invalid(`${path} is a ${typeof value}, which cannot be stored`)
  }
}

/**
 * Assemble what a card's script may read about its chat.
 * @param entry - the open conversation.
 * @param extras - the card's settings partition and the visible library.
 * @returns a detached snapshot.
 */
export function buildCardContext(
  entry: ChatEntry,
  extras: {
    extensionSettings: Record<string, unknown>
    characters: CharacterSummary[]
    /** Reports a growth alarm; see {@link variableLayersOf}. */
    onReport?: (message: string) => void
  },
): ScriptContext {
  const meta = entry.meta
  return {
    // `toFile`, not `exportMessages`: only the former attaches
    // `chat[i].variables[swipe_id]`, which is where a status-bar card reads its
    // MVU state. The bare projection loses it with no error to trace.
    chat: entry.toFile().messages,
    // Structured-cloned rather than handed over: the frame gets a copy it may
    // scribble on, and the host keeps the version it will actually store.
    chatMetadata: structuredClone(entry.header.chat_metadata),
    name1: entry.header.user_name,
    name2: entry.header.character_name,
    ...meta.characterId === undefined ? {} : { characterId: meta.characterId },
    chatId: entry.chatId,
    characters: extras.characters,
    extensionSettings: extras.extensionSettings,
    // The newest turn's message-scope table, which is where MVU keeps its tree.
    variables: entry.currentVariables() ?? {},
    variableLayers: variableLayersOf(entry, extras.onReport),
  }
}

/**
 * Write a card's `chatMetadata` changes back.
 *
 * Replaces wholesale rather than merging, because that is what upstream's
 * object semantics give a card: it mutates the object it was handed and calls
 * save, and a key it deleted is meant to be gone.
 * @param entry - the open conversation.
 * @param next - the metadata as the card left it.
 * @throws {AppError} `invalid-request` when it cannot be stored losslessly.
 */
export function commitChatMetadata(entry: ChatEntry, next: Record<string, unknown>): void {
  assertStorable(next, 'chatMetadata')
  entry.header.chat_metadata = next
}

/** What one card has stored under `extension_settings`. */
type Partitions = Record<string, Record<string, unknown>>

/**
 * `extension_settings`, partitioned per card.
 *
 * Upstream's is one global object every extension shares. Iris keeps a
 * partition per character, because the sandbox's whole model is that a grant is
 * given to *a card* — and a shared settings bag is a channel that ignores which
 * card is asking.
 */
/**
 * Where the global variable scope sits among the per-card partitions.
 *
 * A leading dot, because `isSafeId` refuses ids that begin with one — so this
 * key cannot collide with a character however a card is named.
 */
const GLOBAL_SECTION = '.variables'

export class ExtensionSettingsStore {
  readonly #path: string
  #partitions: Partitions = {}
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   */
  constructor(path: string) {
    this.#path = path
  }

  /** Load on first use; a missing file is an empty store, not an error. */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        this.#partitions = parsed as Partitions
      }
    } catch {
      // Absent or unreadable. An empty partition is the safe reading: a card
      // finds its settings missing and re-initializes them, which is a state it
      // already has to handle on first run.
    }
  }

  /**
   * The installation-wide variable scope, at upstream's own path.
   *
   * Upstream keeps this at `extension_settings.variables.global` in
   * `settings.json`, so the value lives at the isomorphic path here rather than
   * in a file of its own: `.variables` → `global`.
   *
   * **The leading dot is load-bearing.** This file's other top-level keys are
   * character ids, and `isSafeId` rejects any id beginning with a dot — so
   * `.variables` is a key no character can ever occupy. The alternative, a bare
   * `variables` key, collides the day someone names a card "variables", and that
   * collision would silently merge one card's settings with the global scope.
   * @returns the global tree, empty when nothing has been stored.
   */
  async globalVariables(): Promise<Record<string, unknown>> {
    await this.#load()
    const section = this.#partitions[GLOBAL_SECTION]
    const global = (section as { global?: unknown } | undefined)?.global
    return typeof global === 'object' && global !== null && !Array.isArray(global)
      ? structuredClone(global) as Record<string, unknown>
      : {}
  }

  /**
   * Replace the installation-wide variable scope.
   * @param variables - the whole tree.
   * @throws {AppError} `invalid-request` when it cannot be stored losslessly.
   */
  async setGlobalVariables(variables: Record<string, unknown>): Promise<void> {
    assertStorable(variables, 'global variables')
    await this.#load()
    this.#partitions[GLOBAL_SECTION] = { global: variables }
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(this.#partitions, null, 2)}
`, 'utf8')
  }

  /**
   * One card's settings.
   * @param characterId - whose partition.
   * @returns a detached copy; writes go through {@link set}.
   */
  async get(characterId: string): Promise<Record<string, unknown>> {
    await this.#load()
    return structuredClone(this.#partitions[characterId] ?? {})
  }

  /**
   * Replace one card's settings.
   * @param characterId - whose partition.
   * @param settings - the partition as the card left it.
   * @throws {AppError} `invalid-request` when it cannot be stored losslessly.
   */
  async set(characterId: string, settings: Record<string, unknown>): Promise<void> {
    assertStorable(settings, 'extensionSettings')
    await this.#load()
    this.#partitions[characterId] = settings
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(this.#partitions, null, 2)}\n`, 'utf8')
  }

  /**
   * Drop a card's partition, when its character is deleted.
   * @param characterId - whose partition.
   */
  async forget(characterId: string): Promise<void> {
    await this.#load()
    if (this.#partitions[characterId] === undefined) return
    delete this.#partitions[characterId]
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(this.#partitions, null, 2)}\n`, 'utf8')
  }
}

/**
 * The four layers a script frame's `getAllVariables` merges.
 *
 * Order and membership are upstream's, from `_getAllVariables` in
 * `JS-Slash-Runner/src/function/variables.ts`: `global → character → script →
 * chat` for a script frame, with floor tables folded in only for a message
 * frame. Each layer is sent as itself; the merge belongs to the façade, because
 * a merged tree cannot be taken apart again and a card asking for one scope
 * needs that scope alone.
 *
 * Two places where our layer is not upstream's, both worth knowing before
 * trusting a value read here:
 *
 * - **`global` is in-memory.** Upstream persists it in
 *   `extension_settings.variables.global`; this host's backend does not persist
 *   at all, so it is empty on every start. A card storing an installation-wide
 *   preference will not find it next time.
 * - **`character` is the card's shipped value, read-only.** Upstream's character
 *   scope is a live store that its deep watcher writes back into the card file
 *   — the same mechanism `script-variables.ts` documents refusing for the script
 *   scope. Reading gives the same answer until something writes; nothing here
 *   writes.
 * @param entry - the conversation the frame belongs to.
 * @returns each layer, unmerged.
 */
export const CHAT_LAYER_ALARM_BYTES = 2_621_440

export function variableLayersOf(
  entry: ChatEntry,
  onReport?: (message: string) => void,
): ScriptContext['variableLayers'] {
  const read = (option: Parameters<ChatEntry['variables']['getVariables']>[0]): Record<string, unknown> => {
    try {
      return entry.variables.getVariables(option)
    } catch {
      // A scope with no backend on this host. Empty rather than absent: the
      // façade merges these positionally and a missing layer would shift the
      // order it assigns in.
      return {}
    }
  }

  // Keyed by the ids the **card declares**, which is exactly the set of frames
  // that can exist: a frame runs one of the card's scripts, so its own id is
  // always in here. A partition left over from a script the card no longer
  // declares is not carried, because nothing can ask for it — and carrying it
  // would put a removed script's state back in front of a running one.
  const script: Record<string, Record<string, unknown>> = {}
  for (const declared of entry.card === undefined ? [] : extractScripts(entry.card).scripts) {
    script[declared.id] = read({ type: 'script', script_id: declared.id })
  }

  const chat = read({ type: 'chat' })

  // A growth alarm, not a limit. Nothing is refused and nothing is truncated:
  // this layer is pushed whole because upstream's frame reads it whole, and a
  // host that silently sent less would be answering a card's question wrongly.
  //
  // It exists because the ruling that made this path safe assumed all four
  // layers were small and bounded, and measurement found one that is neither:
  // `chat_metadata.variables` reaches 1.25 MiB in the corpus, larger than every
  // "latest floor" table in every chat combined. MVU's
  // `兼容性.更新到聊天变量` switch writes its whole tree here as well, so it
  // grows with the game rather than with the conversation — bounded by nothing.
  //
  // Today that is affordable. The point of the line is that when it stops being
  // affordable, the log already says so and nobody has to re-derive this.
  const chatBytes = Buffer.byteLength(JSON.stringify(chat), 'utf8')
  if (chatBytes > CHAT_LAYER_ALARM_BYTES) {
    onReport?.(
      `the chat variable layer is ${String(chatBytes)} bytes, past the ${String(CHAT_LAYER_ALARM_BYTES)} byte`
      + ' growth line (twice the largest measured in the corpus). This is a growth alarm, not a limit —'
      + ' nothing was withheld. It is pushed whole on every script frame, and it grows with play.',
    )
  }

  return {
    global: read({ type: 'global' }),
    character: entry.initialVariables,
    script,
    chat,
  }
}

/**
 * A variable backend over the persisted global scope.
 *
 * `ScopeBackend` is synchronous and the store is not, so the tree is held here
 * and the write is scheduled — the same shape `ScriptVariableStore` uses, and for
 * the same reason. It has to be **seeded before the first read**, because a
 * synchronous read cannot wait for a file: {@link openGlobalScope} does that and
 * is what a caller should use.
 *
 * Upstream's global scope is installation-wide by definition, which is why this
 * is shared across cards rather than partitioned like the settings beside it. The
 * two live in one file with different sharing rules, and the section key keeps
 * them from being confused for one another.
 * @param store - the settings store holding the scope.
 * @param seeded - the tree as loaded, for the synchronous first read.
 * @param onError - reports a write that failed; writes are not awaited.
 * @returns the backend.
 */
export function globalScopeBackend(
  store: ExtensionSettingsStore,
  seeded: Record<string, unknown>,
  onError: (error: Error) => void = () => {},
): ScopeBackend {
  let held = seeded
  let queue: Promise<void> = Promise.resolve()
  return {
    read: () => held,
    write: (_option, next) => {
      held = next
      queue = queue
        .then(async () => { await store.setGlobalVariables(next) })
        .catch((error: unknown) => { onError(error instanceof Error ? error : new Error(String(error))) })
    },
  }
}

/**
 * Load the global scope and hand back a backend over it.
 * @param store - the settings store.
 * @param onError - reports a write that failed.
 * @returns a backend whose first read already has the stored tree.
 */
export async function openGlobalScope(
  store: ExtensionSettingsStore,
  onError?: (error: Error) => void,
): Promise<ScopeBackend> {
  return globalScopeBackend(store, await store.globalVariables(), onError)
}
