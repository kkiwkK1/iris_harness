/**
 * The character page's arithmetic and its one-line sentences.
 *
 * Split out of `CharacterPage.tsx` for one reason: the page is a `.tsx` module
 * and Node's type stripping does not transform JSX, so nothing in it can be
 * imported by a `node --test` file. Every derivation the page makes over what
 * the host sent — which conversations are this card's, how many of a book's
 * entries are switched on, what a script's two switches add up to — lives here
 * and is tested against the values a real card produces
 * (`character-facts.test.ts`); the page keeps the layout, and
 * `character-page.test.ts` reads its source for the guards.
 *
 * **The figures are counted here rather than sent.** `CardBookDigest` carries
 * entries and no totals precisely so that the number over a list and the list
 * cannot disagree — a host-computed `enabledCount` beside the rows it
 * summarises is a second derivation, and the pair going out of step is
 * invisible.
 *
 * @module iris-web/app/character-facts
 */

import type {
  CardBookDigest,
  ChatSummary,
  ScriptView,
  WorldbookEntryDigest,
} from '@iris/protocol'

import { translate, type StringKey } from './i18n/strings.ts'
import type { Language } from './i18n/strings.ts'

/** One book's three figures, as the row above its entries reports them. */
export interface BookFigures {
  /** Every entry the book holds, switched on or not. */
  entries: number
  /** How many are switched on (`disable: false` upstream). */
  enabled: number
  /** How many fire on every scan without matching anything. */
  constant: number
}

/**
 * Count one book's entries three ways.
 *
 * Measured over the 11 local cards that carry a book: 841 entries, of which 622
 * are enabled and 309 constant. So neither figure is a formality — a quarter of
 * a real library's entries are switched off, and a summary line that reported
 * only the total would describe a book a third larger than the one that plays.
 * @param book - the book as the host listed it.
 * @returns its total, its enabled count and its constant count.
 */
export function bookFigures(book: CardBookDigest): BookFigures {
  let enabled = 0
  let constant = 0
  for (const entry of book.entries) {
    if (entry.enabled) enabled += 1
    if (entry.constant) constant += 1
  }
  return { entries: book.entries.length, enabled, constant }
}

/**
 * One character's conversations, newest first.
 *
 * Matched on `characterId`, which is **optional** on a `ChatSummary`: a chat
 * with none is not this character's, so comparing against a defined id is
 * already the right filter and no `undefined === undefined` case can slip
 * through. Sorted here rather than trusted from the host — `chat.list` answers
 * newest-first today, and a page that reads "last active" off the first row must
 * not depend on that being true of every host and every later insertion.
 * @param chats - every conversation the store holds.
 * @param characterId - whose page is open.
 * @returns that character's conversations, most recently active first.
 */
export function chatsOf(
  chats: readonly ChatSummary[],
  characterId: string,
): readonly ChatSummary[] {
  return chats
    .filter(row => row.characterId === characterId)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * When this character was last active, or undefined when it never was.
 *
 * Taken as a maximum rather than from the first row, so it is right whatever
 * order the caller's list arrived in.
 * @param chats - one character's conversations.
 * @returns the newest `updatedAt`, or undefined for a card with no chats.
 */
export function latestActivity(chats: readonly ChatSummary[]): number | undefined {
  return chats.reduce<number | undefined>(
    (newest, row) => (newest === undefined || row.updatedAt > newest ? row.updatedAt : newest),
    undefined,
  )
}

/** Where one entry lands, by position, in the reader's language. */
const PLACES: Record<WorldbookEntryDigest['position'], StringKey> = {
  before_character_definition: 'facePlaceBeforeChar',
  after_character_definition: 'facePlaceAfterChar',
  before_example_messages: 'facePlaceBeforeExamples',
  after_example_messages: 'facePlaceAfterExamples',
  before_author_note: 'facePlaceBeforeNote',
  after_author_note: 'facePlaceAfterNote',
  at_depth: 'facePlaceAtDepth',
  outlet: 'facePlaceOutlet',
}

/**
 * Say where one entry is inserted.
 *
 * A table rather than eight `t()` calls in the page, because the position is
 * one of eight and a chain of ternaries over them reads as a decision when it
 * is a lookup. `at_depth` is the only one that takes a number, and it is the
 * only one whose `depth` the protocol carries — every other position holds the
 * field's default on disk, so a sentence naming a depth for it would report a
 * choice the author never made.
 *
 * Measured over the local corpus's 841 entries: 592 sit before the character
 * definition, 126 at a depth, 123 after the definition, and the remaining five
 * positions do not occur at all — so five of these eight sentences are carried
 * for correctness rather than for this library.
 * @param entry - the entry as the host listed it.
 * @param lang - the reader's language.
 * @returns the position, in words.
 */
export function describePlace(entry: WorldbookEntryDigest, lang: Language): string {
  if (entry.position === 'at_depth') {
    // The depth is absent exactly when the position is not `at_depth`, so this
    // branch is the one that can read it — and `0` is a real depth (the newest
    // floor), which is why the fallback is only for a host that sent neither.
    return translate(lang, 'facePlaceAtDepth', { depth: entry.depth ?? 0 })
  }
  return translate(lang, PLACES[entry.position])
}

/**
 * What fires one entry, when that needs saying at all.
 *
 * Three answers, and the interesting one is the third: **307 of the local
 * corpus's 841 entries carry no keys.** For a constant entry that is normal —
 * it fires without matching, and the row's own 常驻 marker has already said so,
 * which is why this returns nothing there rather than repeating it. For a
 * *selective* entry it means the entry can never fire, which is a fact about a
 * card that nothing else on the page would reveal.
 * @param entry - the entry as the host listed it.
 * @param lang - the reader's language.
 * @returns the sentence, or undefined when the constant marker covers it.
 */
export function describeTrigger(
  entry: WorldbookEntryDigest,
  lang: Language,
): string | undefined {
  if (entry.keys.length > 0) {
    // The reader's own list separator: a Chinese enumeration comma reads as a
    // list where a Latin comma reads as part of a key.
    return translate(lang, 'faceEntryKeys', {
      keys: entry.keys.join(lang === 'zh' ? '、' : ', '),
    })
  }
  return entry.constant ? undefined : translate(lang, 'faceEntryNoKeys')
}

/**
 * What a script's two switches add up to, said as the reason rather than the
 * result.
 *
 * Four states from two booleans, and all four are distinguishable on purpose:
 * "off" answers nothing a reader can act on, while "the author shipped it off"
 * and "you switched it off" call for opposite actions. `ScriptView` reports both
 * switches for exactly this reason.
 * @param script - the script as `script.list` reported it.
 * @param lang - the reader's language.
 * @returns the sentence for the script's state.
 */
/**
 * Where a script came from, in the reader's own words.
 *
 * **Read off the row, never assumed.** This page printed a fixed 「卡内嵌」 under
 * every script until the user's own library existed — correct while the card was
 * the only source, and a lie the moment it stopped being. The comment beside
 * that line said "there is no other tier behind it", which was true when it was
 * written and is the reason a wrong sentence survived: nothing rechecks a claim
 * that was accurate.
 *
 * The `default` arm covers `'card'` and anything a newer host adds. A source
 * this build has never heard of reading as "in the card" is the wrong direction
 * in principle — but the alternative is a blank where the reader expects a
 * word, and the type makes an unhandled case a compile error on the build that
 * adds one.
 * @param script - the row as `script.list` reported it.
 * @param lang - the reader's language.
 * @returns the sentence.
 */
export function describeScriptSource(script: ScriptView, lang: Language): string {
  switch (script.source) {
    case 'global': return translate(lang, 'faceScriptGlobal')
    case 'character': return translate(lang, 'faceScriptCharacter')
    default: return translate(lang, 'faceScriptInCard')
  }
}

export function describeScriptSwitch(script: ScriptView, lang: Language): string {
  if (script.enabled) {
    return script.enabledByCard
      ? translate(lang, 'faceScriptOn')
      : translate(lang, 'faceScriptOnByYou')
  }
  return script.enabledByCard
    ? translate(lang, 'faceScriptOffByYou')
    : translate(lang, 'faceScriptOffByCard')
}

/**
 * How many of a script's buttons its author left visible.
 *
 * Both numbers, always: **58 of the corpus's 89 buttons are `visible: false`**,
 * so "3 buttons" over a bar showing one is the ordinary case rather than the
 * odd one. Undefined for a script that declares no buttons — there is nothing
 * to say, and a "0 of 0" row is noise.
 * @param script - the script as `script.list` reported it.
 * @param lang - the reader's language.
 * @returns the sentence, or undefined when the script has no buttons.
 */
export function describeButtons(script: ScriptView, lang: Language): string | undefined {
  const buttons = script.buttons
  if (buttons === undefined || buttons.length === 0) return undefined
  const visible = buttons.filter(button => button.visible).length
  return translate(lang, 'faceScriptButtons', { n: buttons.length, visible })
}

/**
 * Why a book is on this card's list, when there is something to say.
 *
 * Silent for the ordinary case — the card's own book, in a file, under its own
 * name — because a row that annotates everything annotates nothing. The three
 * sentences it does produce are each a state a reader cannot make sense of
 * unaided: a book that exists only inside the card (a card nobody has opened on
 * this host), a name this host minted because the wanted one collided, and a
 * binding with no book behind it.
 * @param book - the book as the host listed it.
 * @param lang - the reader's language.
 * @returns the note, or undefined when the book needs none.
 */
export function describeBookOrigin(book: CardBookDigest, lang: Language): string | undefined {
  if (book.source === 'missing') return translate(lang, 'faceBookMissing')
  if (book.source === 'embedded') return translate(lang, 'faceBookEmbedded')
  if (book.materialised === true) return translate(lang, 'faceBookMinted')
  if (book.role === 'additional') return translate(lang, 'faceBookExtra')
  return undefined
}
