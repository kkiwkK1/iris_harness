/**
 * What the user has decided about a card's scripts.
 *
 * Kept apart from the card, because the two answer different questions. The
 * card's own `enabled` is a fact about the card and travels with it through
 * export and re-import; the user's switch is a decision about this
 * installation. Storing only the combination would let a re-import quietly
 * revive a script the user had turned off — the card would win an argument it
 * should not be in.
 *
 * The document grant lives here too, for the same reason and one more: a grant
 * is the user's, and nothing a card can write may create, request, or survive
 * the revocation of one. See `SANDBOX.md`.
 *
 * @module @iris/app-service/scripts
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ScriptView } from '@iris/protocol'
import { extractScripts, type CardScript } from '@iris/script'

/** Per-character policy, keyed by character id. */
interface PolicyFile {
  characters: Record<string, {
    /** Script ids the user switched off, or back on against the card's wishes. */
    enabled?: Record<string, boolean>
    /** Whether this card may reach the real page document. */
    documentGranted?: boolean
  }>
}

/** Reads and persists the user's decisions about card scripts. */
export class ScriptPolicyStore {
  readonly #path: string
  #file: PolicyFile = { characters: {} }
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   */
  constructor(path: string) {
    this.#path = path
  }

  /** Load on first use; a missing file is an empty policy, not an error. */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && 'characters' in parsed) {
        const characters = (parsed as PolicyFile).characters
        if (typeof characters === 'object' && characters !== null) this.#file = { characters }
      }
    } catch {
      // Unreadable or absent. An unreadable policy file must not stop the app
      // from opening — but note that the safe direction here is the DEFAULT, and
      // the default is deny, so a corrupt file loses grants rather than
      // inventing them.
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(this.#file, undefined, 2)}\n`, 'utf8')
  }

  /**
   * Whether a card may reach the real page document.
   * @param characterId - the card.
   * @returns the grant, defaulting to denied.
   */
  async documentGranted(characterId: string): Promise<boolean> {
    await this.#load()
    return this.#file.characters[characterId]?.documentGranted === true
  }

  /**
   * Grant or revoke the real document for one card.
   * @param characterId - the card.
   * @param granted - the new state.
   * @returns the state as stored.
   */
  async setDocumentGrant(characterId: string, granted: boolean): Promise<boolean> {
    await this.#load()
    const record = this.#file.characters[characterId] ?? {}
    if (granted) record.documentGranted = true
    // Deleted rather than written as `false`: absent and denied must be the same
    // state, or a revoked grant reads differently from one never given and the
    // two eventually get treated differently by something downstream.
    else delete record.documentGranted
    this.#file.characters[characterId] = record
    await this.#save()
    return granted
  }

  /**
   * Override one script's on/off.
   * @param characterId - the card.
   * @param scriptId - the script.
   * @param enabled - the user's choice.
   */
  async setEnabled(characterId: string, scriptId: string, enabled: boolean): Promise<void> {
    await this.#load()
    const record = this.#file.characters[characterId] ?? {}
    record.enabled = { ...record.enabled, [scriptId]: enabled }
    this.#file.characters[characterId] = record
    await this.#save()
  }

  /**
   * Project a card's scripts for a list view.
   * @param characterId - the card.
   * @param card - the decoded card.
   * @returns one row per script the card carries, disabled ones included.
   */
  async view(characterId: string, card: unknown): Promise<ScriptView[]> {
    await this.#load()
    const overrides = this.#file.characters[characterId]?.enabled ?? {}
    return extractScripts(card).scripts.map(script => this.#row(script, overrides))
  }

  /**
   * The scripts that should actually run, after both switches.
   * @param characterId - the card.
   * @param card - the decoded card.
   * @returns the scripts to hand a runner, in card order.
   */
  async runnable(characterId: string, card: unknown): Promise<CardScript[]> {
    await this.#load()
    const overrides = this.#file.characters[characterId]?.enabled ?? {}
    return extractScripts(card).scripts.filter(script => overrides[script.id] ?? script.enabled)
  }

  /** One row, with both switches reported separately. */
  #row(script: CardScript, overrides: Record<string, boolean>): ScriptView {
    return {
      id: script.id,
      name: script.name,
      ...script.info === undefined || script.info === '' ? {} : { info: script.info },
      enabledByCard: script.enabled,
      // The user's choice wins when they have made one. Absent means the card
      // decides, which is what makes a fresh import behave as its author meant.
      enabled: overrides[script.id] ?? script.enabled,
      bytes: script.content.length,
    }
  }
}
