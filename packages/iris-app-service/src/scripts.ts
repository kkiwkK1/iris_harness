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

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { atomicWriteFile, readJsonStore } from './atomic.ts'
import type { RegexScriptView, ScopedRegexView, ScriptView } from '@iris/protocol'
import { effectiveButtons, type ScriptButton } from './script-buttons.ts'
import { extractScripts, type CardScript } from '@iris/script'
import { readPresetRegex, type PresetRegexPolicy, type ScopedRegexPolicy } from './regex.ts'

/**
 * The user's decisions, in two records: per character, and per preset **name**.
 *
 * One file, two subjects, because the file is "what the user has decided about
 * text and code that came with someone else's document" and a preset is one of
 * those documents. The alternative — a section of `settings.json` — is the one
 * this store's own docblock argues against: a settings reset must not be able
 * to hand anything a permission back.
 */
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
  /**
   * Per-**preset** policy, keyed by the preset's library name.
   *
   * Keyed by name because that is what upstream's own allow-list is keyed by —
   * `extension_settings.preset_allowed_regex[api]` is a list of preset names
   * (`extensions/regex/engine.js:126-128`) — and because a preset body has no
   * other identity here: the library addresses presets by name, a switch
   * records a name, and a re-import under the same name is the same preset as
   * far as every other surface is concerned.
   *
   * **Kept out of the preset file itself, deliberately.** Upstream's is in
   * `extension_settings` too, and the reasoning §31 makes about a card holds
   * with one extra edge for presets: a preset is passed around as a file far
   * more freely than a card, so a permission written into it would travel to
   * whoever received it next as a permission *they* had granted.
   */
  presets?: Record<string, {
    /**
     * Whether this preset's own regex tier may run.
     *
     * **Absent means refused**, the mirror image of `regexAllowed` twelve lines
     * up, and the same direction as upstream. The two defaults disagree because
     * their subjects do: a card's rules mostly hide the card's own bookkeeping
     * from its own reader, while the one preset measured here ships 40 rules of
     * which 18 are live and 6 rewrite the outgoing request — so a preset import
     * that silently acquired them would change what the model reads with no
     * moment at which anyone said yes (§53).
     */
    regexAllowed?: boolean
    /**
     * The user's own switches over this preset's regex rules, by the rule's `id`.
     *
     * The same shape and the same reasoning as the per-character
     * `regexEnabled`: the preset author's `disabled` travels with the file, the
     * user's switch is about this installation, and nothing here rewrites the
     * preset to record it.
     */
    regexEnabled?: Record<string, boolean>
  }>
}

/** Reads and persists the user's decisions about card scripts. */
export class ScriptPolicyStore {
  readonly #path: string
  readonly #onProblem: ((message: string) => void) | undefined
  #file: PolicyFile = { characters: {} }
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   * @param onProblem - told when the file was there and could not be parsed;
   *   see `atomic.ts`'s `readJsonStore`. Absent means silence.
   */
  constructor(path: string, onProblem?: (message: string) => void) {
    this.#path = path
    this.#onProblem = onProblem
  }

  /**
   * Load on first use; a missing file is an empty policy, not an error.
   *
   * An unreadable policy file must not stop the app from opening. The comment
   * that used to stand here said the fallback direction was safe because "the
   * default is deny" — **that is true of two of the three defaults and false of
   * the third.** `scriptsAllowed` answers `undefined` (ask the user) and
   * `presetRegex` answers `=== true` (deny), but {@link scopedRegex} answers
   * `!== false`: a card's own regex tier is *allowed* when nothing is recorded,
   * which is a deliberate ruling (commit a47b669 set the preset tier the other
   * way on purpose) and is not being changed here. What changes is that the
   * fallback is no longer invisible — the file is set aside under its own name
   * and the problem is reported, so a reader can tell "the user allowed this"
   * from "the file naming their refusals is gone".
   */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    const parsed = await readJsonStore(this.#path, this.#onProblem)
    if (typeof parsed === 'object' && parsed !== null) {
      const file = parsed as PolicyFile
      const characters = 'characters' in parsed && typeof file.characters === 'object' && file.characters !== null
        ? file.characters
        : {}
      // The preset record is read **beside** the character one rather than
      // instead of it: a file written before this record existed carries
      // `characters` alone, and a reader that required both would drop every
      // decision the user had already made. Same shape as the guard above,
      // and it has to stay separate for exactly that reason.
      const presets = typeof file.presets === 'object' && file.presets !== null
        ? file.presets
        : undefined
      this.#file = { characters, ...presets === undefined ? {} : { presets } }
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await atomicWriteFile(this.#path, `${JSON.stringify(this.#file, undefined, 2)}\n`)
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
   * The user's decisions about one preset's own regex tier.
   *
   * **Refused unless the user said otherwise** — `=== true`, the opposite
   * reading of {@link scopedRegex} one screen up, and upstream's own default
   * (`preset_allowed_regex[api]` starts empty and membership is added by hand).
   * The reasoning for the two defaults disagreeing is on the record they are
   * stored in, and in §53.
   * @param presetName - the preset's library name.
   * @returns the policy the regex composer should run that preset's tier under.
   */
  async presetRegex(presetName: string): Promise<PresetRegexPolicy> {
    await this.#load()
    const record = this.#file.presets?.[presetName]
    return {
      allowed: record?.regexAllowed === true,
      enabled: record?.regexEnabled ?? {},
    }
  }

  /**
   * Allow or refuse one preset's own regex tier.
   * @param presetName - the preset's library name.
   * @param allowed - the user's choice.
   * @returns the choice as stored.
   */
  async setPresetRegexAllowed(presetName: string, allowed: boolean): Promise<boolean> {
    await this.#load()
    const presets = this.#file.presets ?? {}
    const record = presets[presetName] ?? {}
    // `true` is written and `false` deletes — the mirror image of
    // `setScopedRegexAllowed`, and for the same reason read the other way
    // round: absent already means refused here, so a stored `false` would be a
    // second spelling of the default.
    if (allowed) record.regexAllowed = true
    else delete record.regexAllowed
    presets[presetName] = record
    this.#file.presets = presets
    await this.#save()
    return allowed
  }

  /**
   * Override one of a preset's regex rules, against the preset's own `disabled`.
   * @param presetName - the preset's library name.
   * @param scriptId - the rule's id, as the preset stores it.
   * @param enabled - the user's choice.
   */
  async setPresetRegexEnabled(presetName: string, scriptId: string, enabled: boolean): Promise<void> {
    await this.#load()
    const presets = this.#file.presets ?? {}
    const record = presets[presetName] ?? {}
    record.regexEnabled = { ...record.regexEnabled, [scriptId]: enabled }
    presets[presetName] = record
    this.#file.presets = presets
    await this.#save()
  }

  /**
   * Project one preset's own regex tier for a list view.
   *
   * Reads the preset body rather than a store, for `scopedRegexView`'s reason —
   * the tier lives in the file and only the opinion of it lives here — and
   * carries {@link malformed} because rows the engine cannot run are dropped
   * on both paths and a reader who sees 38 rules in a preset that has 40 is
   * owed the number.
   * @param presetName - the preset's library name.
   * @param body - the preset body.
   * @returns one row per runnable rule, whether the tier may run, and how many
   *   rows were refused.
   */
  async presetRegexView(
    presetName: string,
    body: unknown,
  ): Promise<{ scripts: ScopedRegexView[], allowed: boolean, malformed: number }> {
    const policy = await this.presetRegex(presetName)
    const read = readPresetRegex(body)
    return {
      scripts: regexRowsWithSwitches(read.scripts as readonly RegexScriptView[], policy.enabled),
      allowed: policy.allowed,
      malformed: read.malformed,
    }
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
  return regexRowsWithSwitches(scopedRegexOf(card), enabled)
}

/**
 * Pair each rule with the two switches over it.
 *
 * Shared by both gated tiers — a card's rules and a preset's — because the
 * pairing is the same fact in both: the file's author said `disabled`, the user
 * said this, and a reader needs to see which of the two is answering. Written
 * once so the panel's "M of N running" cannot mean one thing under a card and
 * another under a preset.
 * @param rules - the rules, in the file's own order.
 * @param enabled - the user's switches, by the rule's `id`.
 * @returns one row per rule.
 */
function regexRowsWithSwitches(
  rules: readonly RegexScriptView[],
  enabled: Readonly<Record<string, boolean>>,
): ScopedRegexView[] {
  return rules.map(script => {
    const byCard = script.disabled !== true
    const id = script.id
    return {
      script,
      enabledByCard: byCard,
      // A rule with no `id` cannot be addressed by a switch, so it reports the
      // file's own word — the same rule `scriptsOf` applies when it runs them.
      // Upstream assigns ids lazily, so a card really can arrive without one;
      // all 173 rules in the local card corpus carry one, and so do all 40 in
      // the measured preset, but that is the corpus's fact and not the
      // format's.
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
