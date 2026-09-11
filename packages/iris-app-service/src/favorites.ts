/**
 * The characters a profile has starred.
 *
 * **Profile-level, and deliberately not the card's `fav` field.** Upstream
 * stamps `fav` into the card file itself (`data.extensions.fav`), so a star
 * travels with the card to everyone it is shared with, and `unsetPrivateFields`
 * exists precisely to strip it again on the way out. Iris's standing rule is
 * that runtime state does not go into shared card files — the same rule that
 * keeps materialised book names, button tables and chat pointers out of them —
 * so a star lives beside the profile, keyed by character id. A card exported
 * out of Iris carries no trace of the stars it earned here, and needs no
 * `unsetPrivateFields` of its own making.
 *
 * Its own file rather than a section of `settings.json`, for the same owner
 * separation the connections and personas chose: settings are what a chat is
 * using now; this is what this profile's reader liked.
 *
 * @module @iris/app-service/favorites
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { atomicWriteFile, readJsonStore } from './atomic.ts'

/**
 * The star list, in the order it was starred.
 *
 * Order is kept because it costs nothing and a list that remembers is free to
 * be sorted by it later; membership is the only thing the store itself answers.
 */
export class FavoriteStore {
  readonly #path: string
  readonly #onProblem: ((message: string) => void) | undefined
  #ids: string[] = []
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   * @param onProblem - told when the file was there and could not be parsed;
   *   see {@link readJsonStore}. Absent means silence.
   */
  constructor(path: string, onProblem?: (message: string) => void) {
    this.#path = path
    this.#onProblem = onProblem
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    // Absent stays "nothing is starred", which is the state every profile
    // starts in and a valid state to stay in. A file that is *there* and will
    // not parse is set aside first, so the `#save` below writes a new file
    // rather than over the list it could not read.
    const parsed = await readJsonStore(this.#path, this.#onProblem)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && Array.isArray((parsed as { favorites?: unknown }).favorites)) {
      this.#ids = ((parsed as { favorites: unknown }).favorites as unknown[])
        .filter((id): id is string => typeof id === 'string')
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await atomicWriteFile(this.#path, `${JSON.stringify({ favorites: this.#ids }, null, 2)}\n`)
  }

  /**
   * Every starred id.
   * @returns the ids, in the order they were starred.
   */
  async list(): Promise<string[]> {
    await this.#load()
    return [...this.#ids]
  }

  /**
   * Whether one character is starred.
   * @param characterId - the character asked about.
   */
  async has(characterId: string): Promise<boolean> {
    await this.#load()
    return this.#ids.includes(characterId)
  }

  /**
   * Star or unstar one character.
   *
   * Idempotent by construction: starring a starred character rewrites nothing.
   * @param characterId - the character to change.
   * @param favorite - the star's new state.
   * @returns the list after the change.
   */
  async set(characterId: string, favorite: boolean): Promise<string[]> {
    await this.#load()
    const at = this.#ids.indexOf(characterId)
    if (favorite === (at >= 0)) return [...this.#ids]
    if (favorite) this.#ids.push(characterId)
    else this.#ids.splice(at, 1)
    await this.#save()
    return [...this.#ids]
  }

  /**
   * Drop one character's star.
   *
   * The `character.delete` counterpart: ids are minted against the cards that
   * exist, so a deleted card's id is handed to the next card of that name, and
   * a star left behind would light up for a stranger.
   * @param characterId - whose star went with the card.
   */
  async forget(characterId: string): Promise<void> {
    await this.#load()
    const at = this.#ids.indexOf(characterId)
    if (at < 0) return
    this.#ids.splice(at, 1)
    await this.#save()
  }
}
