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
 * the revocation of one. See `docs/SANDBOX.md`.
 *
 * The line to hold is: **when the thing a permission was granted to is no longer
 * the thing in front of you, re-anchor the permission.** *Content re-binds by
 * name; a permission does not.*
 *
 * Stated about the **subject**, not about deletion, because deletion is only one
 * of its instances. On the host, deleting a card is the moment a character id
 * changes owner — but in the browser the panel's current card changes dozens of
 * times a day with nothing deleted, and a permission held in panel state loses
 * its subject just as completely. Both are the same requirement.
 *
 * On this side, ids are minted from the card's name against the cards that exist
 * (`library.ts`), so deleting "Aria" frees `Aria` — the minting keeps the name's
 * case (`toId('Aria')` is `Aria`, not `aria`) — and the next card imported under
 * that name takes it. For **content** that is correct and deliberate —
 * SillyTavern stores chats under `chats/<character name>/` for exactly this
 * reason, and re-importing a card to carry on playing is a normal thing to do,
 * so the old conversations reattaching is the behaviour a user wants. `forget`
 * therefore does not touch chats.
 *
 * For a **permission** it is not correct at any strength. The user granted it to
 * a card that no longer exists; a different card inheriting it is a grant nobody
 * gave. So the policy is dropped on delete, and any future per-character store
 * has to answer which of the two it is before it is written.
 *
 * @module @iris/app-service/scripts
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { RegexScriptView, ScopedRegexView, ScriptView } from '@iris/protocol'
import { effectiveButtons, type ScriptButton } from './script-buttons.ts'
import { extractScripts, type CardScript } from '@iris/script'
import type { ScopedRegexPolicy } from './regex.ts'

/** Per-character policy, keyed by character id. */
interface PolicyFile {
  characters: Record<string, {
    /** Script ids the user switched off, or back on against the card's wishes. */
    enabled?: Record<string, boolean>
    /** Whether this card may reach the real page document. */
    documentGranted?: boolean
    /**
     * Whether the card's own regex tier may run — upstream's
     * `character_allowed_regex` membership.
     *
     * **Absent means allowed**, the third convention in this one record and the
     * only one whose default is permissive. It is not upstream's default, and
     * the reasoning is `notes/packages/iris-app-service/DEVIATIONS.md` §30: a
     * regex rule rewrites text and cannot execute, this host already ran the
     * tier unconditionally, and 15 of the 19 local cards carry one — 11 of
     * those 15 use it to strip raw `<UpdateVariable>` blocks out of the
     * reader's page, and all 15 carry at least one live display-only rule.
     * Nothing asks, so absent and "allowed" genuinely are one state here;
     * **a later round that adds the question has to add the third state
     * first**, as `scriptsAllowed` above has.
     */
    regexAllowed?: boolean
    /**
     * The user's own switches over the card's regex rules, by the rule's `id`.
     *
     * The same two-switch shape as `enabled` above, and stored here rather than
     * written back into the card — which is what upstream does
     * (`writeExtensionField`, `engine.js:148`). See §31 of the same ledger.
     */
    regexEnabled?: Record<string, boolean>
    /**
     * Whether this card's scripts may run at all.
     *
     * **Three states, and absent is not `false` here.** `undefined` means the
     * user has never been asked, which is what makes the shell ask once; `false`
     * means they were asked and said no, which must never re-open the question.
     * That is the opposite convention from `documentGranted` in this same
     * record, where absent and denied are deliberately the same state — there,
     * a revoked grant must be indistinguishable from one never given; here, the
     * difference between the two IS the feature. Writing `false` as an absence
     * would re-ask a user who already declined, on every chat they open.
     */
    scriptsAllowed?: boolean
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
   * Drop a card's policy, when its character is deleted.
   *
   * Load-bearing rather than tidy. Ids are derived from the card's name —
   * `library.ts` mints `uniqueId(toId(name), …)` against the cards **present** —
   * so deleting "Aria" frees the id `Aria` (`toId` keeps the case), and the next
   * card imported under that name takes it. A policy left behind is therefore not
   * orphaned, it is inherited, and one of the things it carries is
   * `documentGranted`: a grant the user gave to one card would silently apply to
   * a different one.
   * @param characterId - the card being deleted.
   */
  async forget(characterId: string): Promise<void> {
    await this.#load()
    if (this.#file.characters[characterId] === undefined) return
    delete this.#file.characters[characterId]
    await this.#save()
  }

  /**
   * Whether this card's scripts may run, and whether the user has said.
   *
   * Returns the third state rather than collapsing it: `undefined` is
   * "not asked yet", and the shell needs it to know to ask. See the field's own
   * note for why this differs from `documentGranted`.
   * @param characterId - the card.
   * @returns the answer, or `undefined` when the user has not been asked.
   */
  async scriptsAllowed(characterId: string): Promise<boolean | undefined> {
    await this.#load()
    return this.#file.characters[characterId]?.scriptsAllowed
  }

  /**
   * Record the user's answer to the run-scripts question.
   * @param characterId - the card.
   * @param allowed - what the user chose.
   * @returns the answer as stored.
   */
  async setScriptsAllowed(characterId: string, allowed: boolean): Promise<boolean> {
    await this.#load()
    const record = this.#file.characters[characterId] ?? {}
    // Written both ways, `false` included — unlike `documentGranted`, which
    // deletes on revoke. A `false` that vanished would be read back as "never
    // asked" and the user would be asked again every time they opened the chat.
    record.scriptsAllowed = allowed
    this.#file.characters[characterId] = record
    await this.#save()
    return allowed
  }

  /**
   * The user's decisions about one card's own regex tier.
   *
   * Always answerable, because both halves have a default that is a real
   * answer: the tier is allowed until the user says otherwise, and a rule with
   * no switch is at whatever the card said.
   * @param characterId - the card.
   * @returns the policy the regex composer should run under.
   */
  async scopedRegex(characterId: string): Promise<ScopedRegexPolicy> {
    await this.#load()
    const record = this.#file.characters[characterId]
    return {
      // `!== false`, not `=== true`: absent is allowed here. See the field.
      allowed: record?.regexAllowed !== false,
      enabled: record?.regexEnabled ?? {},
    }
  }

  /**
   * Allow or refuse one card's own regex tier.
   * @param characterId - the card.
   * @param allowed - the user's choice.
   * @returns the choice as stored.
   */
  async setScopedRegexAllowed(characterId: string, allowed: boolean): Promise<boolean> {
    await this.#load()
    const record = this.#file.characters[characterId] ?? {}
    // `false` is written and `true` deletes, because absent already means
    // allowed: a stored `true` would be a second spelling of the default, and
    // two spellings of one state is how a reader eventually treats them
    // differently. The opposite of `scriptsAllowed`, deliberately — there the
    // difference between absent and `false` is the feature.
    if (allowed) delete record.regexAllowed
    else record.regexAllowed = false
    this.#file.characters[characterId] = record
    await this.#save()
    return allowed
  }

  /**
   * Override one of a card's regex rules, against the card's own `disabled`.
   * @param characterId - the card.
   * @param scriptId - the rule's id, as the card stores it.
   * @param enabled - the user's choice.
   */
  async setScopedRegexEnabled(characterId: string, scriptId: string, enabled: boolean): Promise<void> {
    await this.#load()
    const record = this.#file.characters[characterId] ?? {}
    record.regexEnabled = { ...record.regexEnabled, [scriptId]: enabled }
    this.#file.characters[characterId] = record
    await this.#save()
  }

  /**
   * Project a card's own regex tier for a list view.
   *
   * Reads the card rather than a store: this tier lives in the card, and the
   * only thing here is the user's opinion of it. The rules come back **verbatim**
   * — unknown keys included — because a scoped rule is exportable and the export
   * has to be the file an install would accept.
   * @param characterId - the card.
   * @param card - the decoded card.
   * @returns one row per rule the card carries, and whether the tier may run.
   */
  async scopedRegexView(
    characterId: string,
    card: unknown,
  ): Promise<{ scripts: ScopedRegexView[], allowed: boolean }> {
    const policy = await this.scopedRegex(characterId)
    return { scripts: scopedRegexRows(card, policy.enabled), allowed: policy.allowed }
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
   * @param buttonOverrides - button tables scripts rewrote at runtime, by script
   *   id. Absent means every script shows what its card declares.
   *
   *   Passed in rather than read here because this store owns the user's
   *   decisions and the button store owns the scripts' — but **both read paths
   *   must merge the same way**. The panel's bar and the card-facing snapshot
   *   are two views of one fact, and a bar built from the declaration alone
   *   would keep showing buttons a script had already replaced, with the card
   *   and the UI disagreeing and neither of them wrong on its own terms.
   * @returns one row per script the card carries, disabled ones included.
   */
  async view(
    characterId: string,
    card: unknown,
    buttonOverrides: Record<string, ScriptButton[]> = {},
  ): Promise<ScriptView[]> {
    await this.#load()
    const overrides = this.#file.characters[characterId]?.enabled ?? {}
    return extractScripts(card).scripts.map(script => this.#row(script, overrides, buttonOverrides))
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
  #row(
    script: CardScript,
    overrides: Record<string, boolean>,
    buttonOverrides: Record<string, ScriptButton[]> = {},
  ): ScriptView {
    const buttons = effectiveButtons(script.buttons, buttonOverrides[script.id])
    return {
      id: script.id,
      name: script.name,
      // Stated on the row rather than left to the reader. Every row this class
      // produces came out of a card, and it stayed unsaid while that was the
      // only possibility — which is exactly how the character page came to
      // print a fixed 「卡内嵌」 under scripts from anywhere.
      source: 'card',
      ...script.info === undefined || script.info === '' ? {} : { info: script.info },
      enabledByCard: script.enabled,
      // The user's choice wins when they have made one. Absent means the card
      // decides, which is what makes a fresh import behave as its author meant.
      enabled: overrides[script.id] ?? script.enabled,
      // `Buffer.byteLength`, not `.length`. A JS string's length is UTF-16 code
      // units, so a Chinese script body reports about a third of its real size —
      // and this number is about to be shown to a user being asked whether to
      // run that code. Measured over the corpus's 47 scripts: 1.13x in total,
      // 2.07x on the worst single script.
      // Declaration ⊕ runtime override, the same merge the snapshot does. One
      // fact, two views: see `view`'s parameter for why they cannot diverge.
      ...buttons === undefined ? {} : { buttons },
      ...script.buttonsEnabled === undefined ? {} : { buttonsEnabled: script.buttonsEnabled },
      bytes: Buffer.byteLength(script.content, 'utf8'),
    }
  }
}

/**
 * Project one card's own regex tier, with the user's switches folded in.
 *
 * A free function rather than a method because it reads the *card* and a record
 * of decisions, and nothing else — the store passes its own record in. The rules
 * come back **verbatim**: a scoped rule is exportable, and a projection that
 * kept only the fields this shell renders would write a lossy export file.
 * @param card - the decoded card.
 * @param enabled - the user's switches, by the rule's `id`.
 * @returns one row per rule the card carries, in the card's own order.
 */
export function scopedRegexRows(
  card: unknown,
  enabled: Readonly<Record<string, boolean>>,
): ScopedRegexView[] {
  const scoped = scopedRegexOf(card)
  return scoped.map(script => {
    const byCard = script.disabled !== true
    const id = script.id
    return {
      script,
      enabledByCard: byCard,
      // A rule with no `id` cannot be addressed by a switch, so it reports the
      // card's word — the same rule `scriptsOf` applies when it runs them.
      // Upstream assigns ids lazily, so a card really can arrive without one;
      // all 173 rules in the local corpus carry one, but that is the corpus's
      // fact and not the format's.
      enabled: typeof id === 'string' ? enabled[id] ?? byCard : byCard,
    }
  })
}

/**
 * A card's `extensions.regex_scripts`, if it has one that is a list.
 * @param card - the decoded card, or anything at all.
 * @returns the rules, empty when the card carries none.
 */
function scopedRegexOf(card: unknown): RegexScriptView[] {
  if (typeof card !== 'object' || card === null) return []
  const data = (card as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return []
  const extensions = (data as { extensions?: unknown }).extensions
  if (typeof extensions !== 'object' || extensions === null) return []
  const scoped = (extensions as { regex_scripts?: unknown }).regex_scripts
  // Filtered, not trusted: `findRegex` and `replaceString` are what the engine
  // reads on every run, and a row missing either is one upstream's own importer
  // would have refused. Rows are dropped rather than repaired, because a
  // repaired rule is a rule the card's author did not write.
  return Array.isArray(scoped)
    ? scoped.filter((row): row is RegexScriptView =>
      typeof row === 'object' && row !== null && !Array.isArray(row)
      && typeof (row as RegexScriptView).findRegex === 'string'
      && typeof (row as RegexScriptView).replaceString === 'string')
    : []
}
