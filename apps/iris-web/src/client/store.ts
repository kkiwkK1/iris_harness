/**
 * The browser's copy of what the host knows.
 *
 * One rule shapes this file: **the host authors chat state, and this store only
 * ever holds a projection of it.** So `stream.end` replaces the view wholesale
 * instead of being reconciled into it, and optimistic state lives in one
 * narrow, clearly-named place (`stream`) that is thrown away the moment the
 * settled view arrives. The protocol asks for exactly this, and the reason is
 * that a delta can be missed — a reconnect, a second page on the same chat —
 * while a settled view cannot be wrong.
 *
 * @module iris-web/client/store
 */

import type { ReportGrade } from '../app/blocked-line.ts'
import { createStore, type StoreApi } from 'zustand/vanilla'

import type {
  BackupPreview,
  BackupSummary,
  CharacterSummary,
  ChatSearchHit,
  ChatSummary,
  ChatView,
  ConnectionProfile,
  DebugReport,
  GenerationSettings,
  IrisClient,
  IrisEvent,
  PersonaView,
  PresetManagerView,
  PresetSummary,
  RegexScriptView,
  RpcResponse,
  ScriptContext,
  ScriptView,
  WorldbookEntry,
  WorldbookSettingsView,
} from '@iris/protocol'

import { asRpcError, describeError, isHostError } from './errors.ts'
import { isShellAction, wireMethodFor } from '../sandbox/card-api.ts'
import { draftThroughComposer, sendThroughComposer } from '../app/composer-bus.ts'
import { loadAutoOpenChat } from '../theme/theme.ts'
import { consentState, type ConsentState } from '../sandbox/consent.ts'
import type { ScriptRunState } from '../sandbox/script-run-state.ts'
import { markSaved, openWiEditor, updateWiEntry, type WiEditorState } from '../app/worldbook-editor.ts'
// Read at call time, not subscribed: the store is not a React component, and a
// notice is worded when it is raised, in the language in force at that moment.
import { getLanguage } from '../app/i18n/language.ts'
import { translate } from '../app/i18n/strings.ts'

/** A prompt breakdown, or why there is not one. */
export type ItemizationResult =
  | { ok: true, itemization: import('@iris/protocol').PromptItemization }
  | { ok: false, error: import('@iris/protocol').RpcError }

/** A script body, or why there is not one. */
export type ScriptBodyResult =
  | { ok: true, content: string }
  | { ok: false, error: import('@iris/protocol').RpcError }

/** Text arriving for a turn that has not settled yet. */
export interface StreamBuffer {
  turn: number
  text: string
  reasoning: string
  /**
   * Identity the host gave the row this text belongs to.
   *
   * Absent only when deltas arrived without their opening frame — a reconnect
   * mid-generation — where the settled view fetched by the reopen already
   * carries the row, and its own key is used instead.
   */
  key?: string
  /**
   * The text the buffer opened with: a continue paints its deltas over the
   * reading it writes on from, and without the seed the row would collapse to
   * the new words alone while streaming.
   */
  seed?: string
  /**
   * Who the arriving text is for. Absent means the character's reply; `'user'`
   * is an impersonation, so the streaming row reads as the user's from its
   * first delta instead of flipping roles when it settles.
   */
  role?: 'user'
  /** The speaker to show for that role. */
  name?: string
}

/** The host's standing offer to clean one chat, as it raised it. */
export interface CleanupOffer {
  chatId: string
  /** Lines in the chat file, which is what upstream gates on. */
  lines: number
  /** The range a sweep would cover, inclusive, in message indices. */
  from: number
  to: number
  /** How many layers inside that range still hold something to remove. */
  layers: number
}

/**
 * What a reader can answer.
 *
 * Three values, and **no fourth for a dismissal**: dismissing sends nothing at
 * all. Upstream folds `CANCELLED` into `NEGATIVE`, which is the bug this
 * deliberately does not reproduce.
 */
export type CleanupAnswer = 'clean' | 'never' | 'backup-and-clean'

/** A transient message shown to the reader. */
export interface Notice {
  kind: 'error' | 'info'
  text: string
  /** Bumped per notice, so a repeat of the same text still re-announces. */
  seq: number
  /** When it was raised, so the log can date it. Epoch milliseconds. */
  at: number
  /**
   * How many identical notices, inside the dedup window, this entry stands
   * for. Absent for a notice that stands for itself.
   */
  count?: number
  /**
   * Which channel raised it, when the channel matters to how the notice is
   * read. Transport notices are the session's one self-healing species: the
   * event socket failing during a host restart is expected, and the log marks
   * them resolved when the connection returns.
   */
  source?: 'transport'
  /** A transport error the connection has since recovered from. */
  resolved?: boolean
}

/**
 * How long an identical notice merges into the one before it.
 *
 * The case that set the window: a host restart drops the event socket, and the
 * client's reconnect schedule fires "the Iris event socket failed" every few
 * seconds — four identical rows in half a minute is noise shaped like a
 * finding. Ten seconds is longer than any backoff step the client schedules,
 * so one outage reads as one entry that counts its recurrences, while the same
 * sentence arriving ten minutes apart is the two events it genuinely is.
 */
export const NOTICE_DEDUP_WINDOW_MS = 10_000

/**
 * The identity a repeat has to match for the log's dedup.
 *
 * Exact text, **except for the parts of a failure that are per-run noise**. A
 * card's scripts evaluate from a fresh blob URL on every run, and the frame's
 * uncaught-error reports quote that URL with its stack position — so the same
 * bug in the same card arrived as a *different* sentence each time, exact-text
 * dedup collapsed nothing, and one recurring fault filled the panel with rows
 * that differed only by a UUID. Stripped: `blob:` references, their embedded
 * positions included. Kept: everything else, byte for byte — two failures that
 * say anything differently about the cause are still two events.
 * @param text - the notice's verbatim text.
 * @returns the text with volatile addresses blanked.
 */
export function noticeRecurrenceKey(text: string): string {
  return text.replace(/blob:\S+/g, 'blob')
}

/**
 * Whether a notice about to be raised merges into the log's last entry.
 *
 * Pure so the window's edges can be asserted without a clock: a merge needs
 * the same kind, channel, and a gap **inside** the window, and a sentence
 * whose only differences are per-run addresses (see `noticeRecurrenceKey`).
 * @param last - the log's newest entry, if any.
 * @param kind - the incoming notice's kind.
 * @param text - the incoming notice's text.
 * @param source - the incoming notice's channel, if it names one.
 * @param now - the incoming notice's arrival time.
 * @returns true when the incoming notice is a recurrence of `last`.
 */
export function repeatsLatestNotice(
  last: Notice | undefined,
  kind: Notice['kind'],
  text: string,
  source: Notice['source'],
  now: number,
): boolean {
  return (
    last !== undefined
    && last.kind === kind
    && last.source === source
    && now - last.at < NOTICE_DEDUP_WINDOW_MS
    && noticeRecurrenceKey(last.text) === noticeRecurrenceKey(text)
  )
}

/**
 * How many notices the log keeps.
 *
 * Bounded because it is a diagnostic and not a journal: fifty is more than a
 * session's worth of real events and small enough that the panel stays
 * readable. Older ones fall off the front, and the panel says so — a list that
 * quietly forgets is a list someone will read as complete.
 */
export const NOTICE_LOG_LIMIT = 50

/** Everything the interface renders from. */
/**
 * One line the panel keeps about a card, and the run it came from.
 *
 * The generation is what stops three runs' worth of findings from reading as
 * one present-tense list.
 */
export interface CardReport {
  text: string
  generation: number
  /**
   * Which channel it came from, shown **beside** the text rather than in it.
   *
   * Two sites used to write `interface: ${message}` and `overlay: ${detail}`
   * into the sentence. That is the shape the host's pushed reports were just
   * corrected for — it produced `variables: variables: trimmed …` there — and
   * it is wrong for the same reason in both places: a channel concatenated into
   * a message cannot be styled, cannot be filtered, and duplicates itself the
   * moment anything else adds a prefix too.
   *
   * The pulled host view already had the right shape and is what this copies: a
   * separate element (`.iris-reports__area`) next to the message.
   *
   * **Not required**, unlike the host's `kind`. Most reports here are a frame's
   * own whole sentence with no channel to name, and inventing one for them
   * would be a label with nothing behind it.
   */
  channel?: string
  /**
   * How it should be read, when the reporter said.
   *
   * **Absent means neutral**, not failure. The first version defaulted to
   * failure and the panel painted every entry red, because most of this list is
   * not failures at all — what a frame paid for its libraries, a card's own
   * `toastr.info`, the overlay's visibility summary. A caller with nothing to
   * say about severity says nothing.
   */
  grade?: ReportGrade
  /** Which script it was about, so a corrected verdict can be found again. */
  scriptId?: string
  /**
   * Set when later evidence refuted this report.
   *
   * Marked rather than deleted. The frame really did say it, and the fact that
   * a module took long enough to be declared dead is worth keeping even once it
   * arrives — but left unmarked it makes the panel mourn a card that works.
   */
  withdrawn?: boolean
}

/** What a caller can say about a report besides its text. */
export interface CardReportOptions {
  /** Which script it was about, so a corrected verdict can be found again. */
  scriptId?: string
  /** How it should be read. Absent means neutral. */
  grade?: ReportGrade
  /** Which channel raised it, shown as a label beside the text. */
  channel?: string
}

export interface IrisState {
  connected: boolean
  chats: ChatSummary[]
  characters: CharacterSummary[]
  /** The open conversation, or undefined on the empty surface. */
  chatId: string | undefined
  view: ChatView | undefined
  /** Present exactly while the open chat is generating. */
  stream: StreamBuffer | undefined
  /** Sampling in force for the open chat, or the global defaults. */
  settings: GenerationSettings | undefined
  /**
   * The worldbook panel's data, as last fetched.
   *
   * `undefined` until `loadWorldbooks` runs — which the panel reads as "not
   * loaded yet" and shows as such, because "no books exist" and "nobody asked"
   * are opposite answers that an empty list renders identically.
   */
  worldbooks: { names: string[], globalSelect: string[], settings: WorldbookSettingsView } | undefined
  /**
   * The open chat character's world book binding, as last fetched.
   *
   * `primary` is the card's own `extensions.world` — displayed, not editable
   * here, because it lives on the card file. `additional` is the host-stored
   * list the panel edits. `characterId` names whose binding this is, so a chat
   * switch can tell "stale" from "unbound" instead of rendering the previous
   * character's books onto the new one.
   */
  charBooks: { characterId: string, primary: string | null, additional: string[] } | undefined
  /**
   * The entry editor's local draft for the one book it has open, or undefined
   * when none is open.
   *
   * **The one client-authored slice beside the notices.** Everything else here
   * projects the host; this holds work the reader has typed and the host has
   * not been given. It lives in the store rather than in the panel's state so
   * a drawer can close, a chat can switch, and the draft — with its
   * unsaved-changes warning — is still there when the reader comes back.
   * `baseline` inside it is the host's last answer, which is what makes the
   * dirty comparison a fact rather than a flag.
   */
  wiEditor: WiEditorState | undefined
  /**
   * The persona panel's data, as last fetched.
   *
   * `undefined` until `loadPersonas` runs — the same "not loaded" vs "none
   * exist" split the worldbook panel draws, because a host with no persona
   * store refuses the group outright and an empty list must not be the answer
   * that renders instead of the refusal.
   */
  personas: { personas: PersonaView[], activeId?: string } | undefined
  notice: Notice | undefined
  /**
   * Every notice raised this session, newest last.
   *
   * **The notice bar is not a record.** It shows one at a time and clears
   * itself after 3.2 seconds (8 for an error), which is correct for
   * interrupting someone and useless for anyone who was not looking — and that
   * includes anyone verifying from outside the browser. Two acceptance rounds
   * were spent on notices that had certainly fired and had already gone: the
   * evidence existed for three seconds and nothing kept it.
   *
   * So the transient channel keeps its behaviour and gains a durable shadow.
   * This is the same argument the card report list was built on, applied to the
   * one channel that still had no memory.
   */
  noticeLog: readonly Notice[]
  /**
   * How many notices fell off the front of the log.
   *
   * Counted rather than inferred from the length, because the two differ by one
   * at exactly the moment the panel starts talking about it: at
   * `length === LIMIT` **nothing has been dropped yet** — the next push is what
   * drops the first. A panel that says "older ones have been dropped" while the
   * log is merely full states something false, and it is the kind of false that
   * makes a reader distrust the rest of the instrument.
   */
  noticesDropped: number
  /** True during the first load, so the shell can hold its layout still. */
  booting: boolean
  /**
   * Which transport the page is actually running on, and where its data comes
   * from.
   *
   * In the store because the interface has to be able to say it. A page that
   * cannot report whether its data is real is a page whose observers will
   * eventually check two true things and conclude a false one — which is exactly
   * what happened before this field existed.
   */
  transport: 'rpc' | 'fake'
  dataOrigin: string

  /**
   * Card scripts of the open chat's character.
   *
   * Held against the character rather than the chat, because that is what the
   * grant is stored against — two chats with the same card share one decision,
   * and showing it per chat would imply otherwise.
   */
  scripts: ScriptView[]
  /** Which character `scripts` describes, so a stale list is never shown. */
  scriptsFor: string | undefined
  /** Whether that character's scripts may touch the real page. */
  documentGranted: boolean
  /**
   * Whether the user has answered the run-scripts question for this card.
   *
   * Three states, and the absent one is not a decline — see `sandbox/consent.ts`
   * for why that distinction is the feature rather than a nicety.
   */
  scriptsAllowed: ConsentState
  /**
   * Frame-level reports for this card, kept until the card changes.
   *
   * The notice bar cannot hold these. It is one slot that clears itself after
   * eight seconds, so a burst of startup reports overwrites itself and the
   * survivor is gone before anyone looks — which is how a verification round
   * concluded the warnings were never emitted when in fact they had all arrived
   * and been destroyed by the channel carrying them.
   *
   * Deduplicated and durable: a diagnostic that cannot be read when someone
   * finally looks is a diagnostic that does not exist.
   */
  cardReports: CardReport[]
  /**
   * The host's own diagnostics, as last fetched.
   *
   * Separate from `cardReports` and deliberately so: those come from a card's
   * frame and are about a card, and **this list has to be readable in a chat
   * with no scripts at all.** The host trims variables, materialises books and
   * evaluates templates whether or not any card is running, and until now the
   * buffer holding those records had no exit to the screen — `debug.reports`
   * existed and nothing in this app called it.
   *
   * `undefined` until asked for, which the view shows as "not fetched" rather
   * than as "nothing happened". The two look identical in an empty array and
   * they are opposite answers.
   */
  hostReports: DebugReport[] | undefined
  /** How many records the host dropped before the oldest one held. */
  hostReportsDropped: number
  /** Every kind the host's buffer holds, for the filter to offer. */
  hostReportKinds: readonly string[]
  /** True while a fetch is out, so the view can say so rather than look empty. */
  hostReportsLoading: boolean
  /**
   * The host's standing offer to clean this chat, when it has made one.
   *
   * **Held rather than gated on the open chat**, and that is a race rather than
   * a preference: the host raises the offer while a chat is being opened, and
   * `chatId` here is set by the `chat.open` reply. Dropping an offer that
   * arrived a beat early would lose it until the next open — a silent outcome
   * the protocol permits and the reader would experience as "the dialog never
   * appeared". So it is kept with its own `chatId` and the dialog renders only
   * when the two agree.
   */
  cleanupOffer: CleanupOffer | undefined
  /**
   * Chats whose cleaning offer has been **answered** this session.
   *
   * A shell-side guard, and it is what closes a real defect: pressing "do not
   * remind me again" wrote `ignore_cleanup` on the host and the dialog stayed
   * on screen. The answer had landed — the clear runs before the call — and
   * then a second `cleanup.offer` for the same chat put it straight back.
   *
   * The user answered. A second offer for that chat in the same session is not
   * a new question, and a dialog that returns after an answer is
   * indistinguishable from an answer that failed.
   *
   * **A dismissal is deliberately not recorded here.** Esc means "ask again",
   * so a later offer for that chat must still be able to appear — the whole
   * divergence from upstream rests on deferral staying possible.
   */
  cleanupAnswered: readonly string[]
  /**
   * Which run the panel is currently showing.
   *
   * Reports outlive the run that produced them on purpose — a diagnostic nobody
   * can read when they finally look is a diagnostic that does not exist — but
   * durability without a generation made the panel unreadable in a different
   * way: relics of three different runs hung side by side, all of them phrased
   * in the present tense, and telling them apart meant remembering what had
   * been tried when. One reading showed "the provider import timed out" beside
   * an error that could only have come from a run where that same import
   * *succeeded*.
   *
   * Clearing on card change was not enough, because re-running the same card is
   * the common case during verification.
   */
  cardRunGeneration: number
  /**
   * The open card run: its identity **and the chat it belongs to**.
   *
   * `runId` is `${chatId}:${generation}` — readable so a host report can name
   * which open an injection came from, and **opaque on the wire**: the host
   * stores it and never parses it. The generation alone was not enough because
   * it is not unique across chats.
   *
   * **The chat is carried here rather than read from state when needed**, and
   * that is a measured fix rather than tidiness. `endCardRun` used to read
   * `get().chatId`, but it runs from a React cleanup — which fires *after* the
   * store's `chatId` has already become the new chat. So half the `runEnded`
   * calls named the wrong conversation:
   *
   * ```
   * { chatId: '爱衣-…',  runId: '不要被神隐挑战-…:19' }   ← wrong chat
   * { chatId: '爱衣-…',  runId: '爱衣-…:20' }            ← right, by luck
   * ```
   *
   * The host looks a run up by chat and id together, so a mismatched pair
   * cleared nothing and the previous run's injections stayed live — measured on
   * 8787: exactly six, which is exactly what one V1.5.4 run injects.
   *
   * One field rather than two, because the pair must never drift: a run's chat
   * is fixed when the run begins and reading either half from anywhere else is
   * the bug this shape prevents.
   *
   * `undefined` between runs.
   */
  cardRun: { runId: string, chatId: string } | undefined
  /** What each of this card's scripts is doing, once they start on their own. */
  runStates: ScriptRunState[]

  /** Saved connection profiles, and which one was last activated. */
  connections: ConnectionProfile[]
  activeConnectionId: string | undefined

  /**
   * The profile's preset library, once fetched.
   *
   * **Undefined is a real answer**, not "not yet": a host with no preset
   * library (the seeded page, a composition that mounts no store) refuses
   * `preset.list`, and the panel that asked renders nothing rather than an
   * empty list that reads as "no presets". Loaded by the panel, not by boot —
   * a seeded page must not raise an error notice for a feature it never had.
   */
  presets: PresetSummary[] | undefined
  /** The active preset's library name, when it is one from the library. */
  activePreset: string | undefined
  /**
   * Preset names the configured SillyTavern install offers, from the last
   * `preset.list`. Undefined when no install is configured at all, which the
   * panel reads as "the import row does not exist".
   */
  presetInstall: string[] | undefined
  /** The prompt manager's state: the active preset and its ordered prompts. */
  presetManager: PresetManagerView | undefined

  /**
   * The profile's global regex scripts, once fetched, in run order.
   *
   * Same meaning of `undefined` as `presets`: a host with no global regex store
   * refuses `regex.list`, and the panel that asked renders nothing rather than
   * an empty list that reads as "no scripts yet". Loaded by the panel, not by
   * boot — a seeded page must not raise an error notice for a feature it never
   * had.
   */
  regexScripts: RegexScriptView[] | undefined

  /**
   * The profile's conversation snapshots, once fetched, newest first.
   *
   * Same meaning of `undefined` as `presets` and `regexScripts`: a host that
   * keeps no snapshot store refuses `backup.list`, and the panel that asked
   * renders nothing rather than an empty list that reads as "nothing has ever
   * needed a snapshot". Loaded by the panel, not by boot.
   */
  backups: BackupSummary[] | undefined
}

/** What the interface calls. Every one of these is a host round trip. */
export interface IrisActions {
  boot(): Promise<void>
  openChat(chatId: string): Promise<void>
  closeChat(): void
  createChat(characterId: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  renameChat(chatId: string, title: string): Promise<void>
  /**
   * Search the profile's conversations by a fragment of floor text.
   *
   * **Resolves `undefined` on failure instead of raising a notice.** A search
   * box fires on a debounce, so a host without the method would turn every
   * keystroke into a global error banner; the caller shows the unfiltered list
   * and the reason stays in the console where it belongs.
   */
  searchChats(query: string): Promise<ChatSearchHit[] | undefined>
  send(text: string): Promise<void>
  regenerate(): Promise<void>
  /** Write on from the newest reply; the result rejoins that floor. */
  continueReply(): Promise<void>
  /** Have the model write the user's next line instead of a reply. */
  impersonate(): Promise<void>
  abort(): Promise<void>
  swipe(turn: number, index: number): Promise<void>
  editMessage(id: number, text: string): Promise<void>
  deleteMessage(id: number): Promise<void>
  importCard(filename: string, base64: string): Promise<void>
  /**
   * Copy SillyTavern chat files into this profile under one character.
   *
   * Per-file outcomes: the sidebar list is refreshed when any file lands, and
   * every refused file raises a notice carrying the host's named reason.
   */
  importChats(characterId: string, files: readonly { filename: string, base64: string }[]): Promise<void>
  /** Download one conversation as SillyTavern JSONL, named after its id. */
  exportChat(chatId: string): Promise<void>
  deleteCharacter(characterId: string): Promise<void>
  /** Copy a character under a fresh id; its chats are not copied. */
  duplicateCharacter(characterId: string): Promise<void>
  /** Change a character's display name on its card. The id does not move. */
  renameCharacter(characterId: string, name: string): Promise<void>
  /** Replace a character's whole tag list on its card. */
  setCharacterTags(characterId: string, tags: readonly string[]): Promise<void>
  /** Star or unstar a character — profile-level, never written into the card. */
  favoriteCharacter(characterId: string, favorite: boolean): Promise<void>
  /** Download a character card as PNG or JSON, the export the host names. */
  exportCharacter(characterId: string, format: 'png' | 'json'): Promise<void>
  patchSettings(patch: Record<string, unknown>): Promise<void>
  loadScripts(characterId: string): Promise<void>
  setScriptEnabled(scriptId: string, enabled: boolean): Promise<void>
  /**
   * Record the user's answer to the run-scripts question.
   *
   * A decline is stored, never cleared: clearing it would read back as "never
   * asked" and put the question again on the next chat they open, which is how a
   * permission prompt becomes something people dismiss without reading.
   */
  answerScriptsAllowed(allowed: boolean): Promise<void>
  /** Record a frame-level report for this card, once. */
  beginCardRun(): void
  /**
   * Tell the host the open card run is over, so its injections go.
   *
   * Idempotent by clearing the id first: the frame's teardown and `pagehide`
   * can both reach this, and the host reports how many injections it cleared —
   * a second call would report a second sweep of nothing.
   */
  endCardRun(): Promise<void>
  /**
   * Add or re-date one durable report.
   *
   * **An options bag, and it earned it.** This was positional
   * (`text, scriptId?, grade?`) on the argument that an object would rewrite
   * seven call sites to serve one. A fourth optional — the channel — is where
   * that stops holding: `addCardReport(detail, undefined, undefined, 'overlay')`
   * is a line whose meaning is carried entirely by the position of two
   * `undefined`s.
   */
  addCardReport(text: string, options?: CardReportOptions): void
  /**
   * Fetch the host's diagnostics.
   *
   * On demand rather than on a timer. A debug read that polls is a debug read
   * that costs something while nobody is looking at it, and the charter is
   * explicit that this is a debug page and not an observability platform. The
   * one thing that cannot wait to be asked for — an irreversible deletion —
   * arrives as a pushed event instead.
   */
  loadHostReports(): Promise<void>
  /**
   * Answer the host's cleaning offer.
   *
   * @param answer - what the reader chose. There is no value for "dismissed":
   *   see `dismissCleanupOffer`.
   */
  answerCleanup(answer: CleanupAnswer): Promise<void>
  /**
   * Put the offer away **without answering it**.
   *
   * A deliberate divergence from upstream, and the reason is that upstream's
   * behaviour here is a bug we are not reproducing: its dialog treats
   * `CANCELLED` and `NEGATIVE` as one branch (`legacy_chat.ts:27-33`), so one
   * press of Esc writes `ignore_cleanup` permanently — the user believes they
   * deferred and the extension believes they declined forever.
   *
   * Iris sends **nothing**, which the protocol already defines as a complete
   * outcome: nothing is cleaned, nothing is recorded, and the offer comes back
   * next time. Recorded in `notes/apps/iris-web/DEVIATIONS.md`.
   */
  dismissCleanupOffer(): void
  withdrawReportsFor(scriptId: string): void
  /** Replace what the running scripts are reported to be doing. */
  setRunStates(states: readonly ScriptRunState[]): void
  /**
   * The card's scripts and grants, straight from the host.
   *
   * Separate from `loadScripts` and deliberately uncached: that one fills the
   * panel and returns early when it already holds the character, which is right
   * for a panel and wrong for starting code. Character ids are reused when a card
   * is deleted, so a cached answer can belong to a card that no longer exists —
   * and the auto-run path has nobody watching to notice.
   */
  resolveScripts(characterId: string): Promise<{ scripts: ScriptView[], documentGranted: boolean }>
  /**
   * Fetch the worldbook panel's data: book names, the global selection, and the
   * effective world-info settings.
   *
   * On demand rather than at boot — the drawer is where this is read, and a
   * reader who never opens it should not pay for three round trips. `undefined`
   * until the first fetch, which the panel shows as "not loaded".
   */
  loadWorldbooks(): Promise<void>
  /** Choose the books injected into every chat, and hold the answer. */
  setGlobalSelect(names: readonly string[]): Promise<void>
  /** Patch the world-info scan settings, and hold the effective result. */
  patchWorldbookSettings(patch: Partial<WorldbookSettingsView>): Promise<void>
  /**
   * Fetch the open chat character's world book binding, and hold it.
   *
   * A no-op that clears the held answer when no chat is open: a binding belongs
   * to a character, and the panel must not show one without its owner.
   */
  loadCharBooks(): Promise<void>
  /**
   * Replace the open chat character's additional books, and hold the answer.
   *
   * The whole list, in order — the host's write is whole-list, and an empty
   * list unbinds all. A no-op when no chat is open.
   */
  setCharBooks(names: readonly string[]): Promise<void>
  /** Fetch the backup panel's data: every snapshot the profile holds. */
  loadBackups(): Promise<void>
  /**
   * Read the head of one snapshot for the confirm dialog.
   *
   * **Resolves `undefined` on failure instead of raising through the guard**,
   * like `searchChats`: the panel needs the value in place, and the host's
   * named reason is raised as its own notice here.
   */
  previewBackup(backupId: string): Promise<BackupPreview | undefined>
  /**
   * Write a snapshot back over its conversation.
   *
   * The typed confirmation crosses to the host, which enforces it — the panel's
   * disabled button is courtesy, the contract is the gate. The list is
   * re-fetched afterwards, and a chat that is open re-opens so the page shows
   * the conversation that came back.
   */
  restoreBackup(backupId: string, confirm: string): Promise<void>
  /** Remove one snapshot; the live conversation is never touched. */
  deleteBackup(backupId: string): Promise<void>
  /**
   * Fetch one book's entries into the entry editor's local draft.
   *
   * Replaces whatever draft was open, after the panel has checked for unsaved
   * work — the check is the caller's, because "you have unsaved changes" is a
   * question about intent, and only the reader can answer it.
   */
  openWiEditor(book: string): Promise<void>
  /** Put the entry editor away. Any unsaved work goes with it. */
  closeWiEditor(): void
  /** Edit one entry's draft. Local until `saveWiEditor` sends the whole book. */
  patchWiEntry(uid: number, patch: Partial<WorldbookEntry>): void
  /** Throw away unsaved work; the editor stays open on the host's last answer. */
  discardWiEdits(): void
  /**
   * Save the whole book with one `worldbook.replace`.
   *
   * Whole-book because that is the only write the host offers, and upstream's
   * semantics besides: the drafts arrive in the order to keep, and anything
   * absent would be deleted. Dirty is then reset from the host's answer.
   */
  saveWiEditor(): Promise<void>
  /**
   * Download the book exactly as it sits on disk, before edits are saved.
   *
   * The pre-write snapshot, with the one destination available to a browser:
   * the reader's downloads folder. The host owns no worldbook backup RPC, so
   * this is the honest nearest thing, and it reads the raw saved shape via
   * `worldbook.load` — the shape a restore would have to put back.
   */
  exportWiBackup(): Promise<void>
  /** Fetch the persona panel's data: the personas and which one is active. */
  loadPersonas(): Promise<void>
  /**
   * Create or edit one persona, and optionally activate it in the same call.
   * The answer (the list after the change) is held, not the argument — the
   * host may have merged or rejected fields the form did not know about.
   */
  savePersona(input: {
    id?: string
    name: string
    description?: string
    position?: PersonaView['position']
    depth?: number
    role?: 'system' | 'user' | 'assistant'
    active?: boolean
  }): Promise<void>
  /** Remove a persona; the held answer reflects the cleared activation if it was active. */
  deletePersona(id: string): Promise<void>
  /** Fetch a card's remote dependency through the host, which owns the allowlist. */
  fetchScriptDependency(url: string): Promise<string>
  setDocumentGrant(granted: boolean): Promise<void>
  /**
   * The host's snapshot for one chat, or undefined when the host will not give
   * one.
   *
   * Returned rather than stored: it is a per-run payload for a frame, not shell
   * state, and keeping it in the store would mean holding a whole conversation's
   * worth of card-visible data long after the run that needed it.
   */
  scriptContext(chatId: string, characterId: string): Promise<ScriptContext | undefined>
  /**
   * Persist one card's extension settings partition, as a frame reported it.
   *
   * The frame posts its whole partition on every proxied write and on
   * `SillyTavern.saveSettings[Debounced]`; this is where that report lands.
   * The host keeps one partition per card, so a key a card writes — the
   * install-detection shape `extensionSettings.someKey = …` included — reads
   * back the same way it does upstream, rather than evaporating with the
   * snapshot.
   */
  saveCardExtensionSettings(settings: Record<string, unknown>): Promise<void>
  /**
   * One script's body, or undefined when the host will not give one.
   *
   * Returned rather than stored for the same reason as the context, and more
   * so: a body can be megabytes of webpack output, and the shell has no use for
   * it once the frame has it.
   */
  scriptBody(characterId: string, scriptId: string): Promise<ScriptBodyResult>
  /**
   * How a request assembles: a record of one already sent, or a preview of the
   * next.
   *
   * Returned rather than stored, like the other two per-request payloads. A
   * breakdown is a few dozen rows about one moment; keeping it in shell state
   * would mean holding a stale answer that looks current.
   */
  itemize(turn?: number): Promise<ItemizationResult>
  /**
   * Run a slash command a card invoked.
   *
   * The string is passed through untouched. Splitting it needs upstream's escape
   * rule, which lives host-side; a second copy in the browser would agree in
   * every test and disagree the first time a user types a `|`.
   */
  runSlash(command: string): Promise<string>
  /**
   * Perform one card action.
   *
   * The allowlist is checked here, on the trusted side. The frame shapes its
   * facade from the same list, but that is convenience — a card reaching the
   * shell with a name that is not on it is refused regardless of what the frame
   * thought it was offering.
   */
  runCardAction(method: string, params: unknown): Promise<unknown>
  loadConnections(): Promise<void>
  activateConnection(id: string): Promise<void>
  saveConnection(patch: {
    id?: string
    label?: string
    provider: string
    model: string
    preset?: string
    sampling?: Record<string, unknown>
    baseURL?: string
    /**
     * Write-only, exactly as the protocol says: absent keeps the stored key,
     * empty string clears it, non-empty replaces it. The store never sees the
     * key again after this call.
     */
    apiKey?: string
    apiKeyHeader?: string
  }): Promise<void>
  deleteConnection(id: string): Promise<void>
  /**
   * Ask the host to probe an endpoint and fetch its model list.
   *
   * The verdict — a failed probe included — comes back as the response: the
   * method answers "no, and here is why" rather than throwing for it, so the
   * form renders a result instead of catching one. Only a refusal *before*
   * any probe (a fake client, a malformed ask) rejects, and the panel shows
   * that as its own sentence.
   */
  testConnection(params: {
    profileId?: string
    baseURL?: string
    apiKey?: string
    apiKeyHeader?: string
    preset?: string
  }): Promise<RpcResponse<'connection.test'>>
  /**
   * Fetch the preset library, the active name and the prompt manager's state.
   *
   * Deliberately not `guard`-wrapped: the one expected failure is a host with
   * no library, and a notice would make every seeded dev page announce a
   * missing feature as if it were broken. The panel reads the refusal from
   * `presets === undefined` and renders nothing.
   */
  loadPresets(): Promise<void>
  /** Make a library preset the active one and apply what it carries. */
  selectPreset(name: string): Promise<void>
  /** Fetch the prompt manager's state for whatever preset is active. */
  viewManager(): Promise<void>
  /** Toggle one prompt of the active ordering, where the host allows it. */
  setPromptEnabled(id: string, enabled: boolean): Promise<void>
  /** Move one prompt within the active ordering. */
  movePrompt(id: string, index: number): Promise<void>
  /** Remove one non-system prompt from the active preset. */
  removePrompt(id: string): Promise<void>
  /** Persist the active state as a named library preset (upsert). */
  savePreset(name: string): Promise<void>
  /** Delete a preset from the library. */
  deletePreset(name: string): Promise<void>
  /**
   * Copy presets from the configured SillyTavern install, read-only.
   *
   * Returns what happened rather than only raising a notice, because an import
   * of twelve names with two skipped owes the reader which two and why.
   */
  importPresets(names?: readonly string[]): Promise<{
    imported: readonly string[]
    skipped: readonly { name: string, reason: string }[]
  }>
  /**
   * Import hand-carried preset files — the file-picker half of upstream's
   * import button.
   *
   * Per-file outcomes rather than a batch abort, the `importChats` rule: one
   * bad file must not veto the folder. Refusals come back as the host's named
   * reasons (not prose) so the wording stays on the side that knows the
   * language, alongside which files landed and whether one replaced a preset
   * of the same name.
   */
  importPresetFiles(files: readonly { filename: string, base64: string }[]): Promise<{
    imported: readonly { name: string, overwritten: boolean, sensitive: readonly string[] }[]
    refused: readonly { name: string, reason: 'invalid-json' | 'not-a-preset' | 'unusable-name' }[]
  }>
  /**
   * Download one preset's file body — what an export is.
   *
   * Host-side read, browser-side save: the file never lands anywhere but the
   * reader's own downloads folder.
   */
  exportPreset(name: string): Promise<void>
  /**
   * Fetch the profile's global regex scripts.
   *
   * Deliberately not `guard`-wrapped, same as `loadPresets`: the one expected
   * failure is a host with no global regex store, and the panel reads that from
   * `regexScripts === undefined` and renders nothing.
   */
  loadRegex(): Promise<void>
  /**
   * Replace the whole global list with what the panel computed.
   *
   * One whole-list primitive — the host has no per-row verbs — so a toggle, a
   * delete, a reorder and an import are all this, over the rows
   * `regexScripts` last showed.
   */
  setRegexScripts(scripts: readonly RegexScriptView[]): Promise<void>
  notify(kind: Notice['kind'], text: string): void
  /** A failure of the event channel itself — resolvable, unlike a host refusal. */
  notifyTransportError(text: string): void
  dismissNotice(): void
}

/** The store the whole interface reads. */
export type IrisStore = StoreApi<IrisState & IrisActions>

/**
 * Build the store and wire it to a client.
 *
 * @param client - the transport, real or fake. The interface never sees which.
 * @returns the store and a disposer that drops the event subscription. The
 * disposer matters because the store is created inside a Cordis plugin, and a
 * plugin that leaves a listener behind is precisely the failure Iris exists to
 * avoid.
 */
export function createIrisStore(
  client: IrisClient,
  /**
   * Which transport this store is fed by, and where its data comes from.
   *
   * Required, with no default. A default here would be a hidden decision, and the
   * failure it hides is worse than the one the disclosure was built to prevent: a
   * caller that forgot the argument would get a page announcing "seeded data"
   * while talking to a real host, or the reverse. Either way the reader is told a
   * confident falsehood about the one thing they cannot otherwise check, and the
   * blame lands on the disclosure rather than on the missing argument.
   */
  source: { transport: 'rpc' | 'fake', origin: string },
): { store: IrisStore, dispose: () => void } {
  let noticeSeq = 0

  const store: IrisStore = createStore<IrisState & IrisActions>((set, get) => {
    /**
     * The state patch that raises one notice.
     *
     * **One constructor, because there were three.** `notify` was not the only
     * place a notice was built — the guard's catch and the card-import path each
     * assembled their own — so a durable log added to `notify` alone would have
     * been silently incomplete for exactly the errors most worth keeping. A
     * patch rather than a setter so a caller that is also writing other fields
     * (the import writes `characters` too) can spread it into one `set`.
     *
     * **Deduplicated within a short window, and only there.** The log used to
     * keep every arrival, on the argument that the same sentence arriving twice
     * is two events and that something recurred is usually the finding. Real
     * traffic corrected the half of that which hurts: the reconnect schedule
     * fires the *same* sentence every few seconds during a host restart, and
     * four identical rows is not a finding, it is one outage counting itself.
     * So an identical neighbour inside the window becomes a count on one entry
     * — the recurrence is still on the record, as `×N` — while the same
     * sentence after the window is the separate event it is. "Identical" is
     * `repeatsLatestNotice`'s call, and per-run addresses (`blob:` URLs and
     * their stack positions) do not make a sentence new.
     * @param kind - how loud it is.
     * @param text - what it says.
     * @param source - the channel, when it changes how the notice reads.
     * @returns the fields to set.
     */
    const raise = (kind: Notice['kind'], text: string, source?: Notice['source']): {
      notice: Notice
      noticeLog: readonly Notice[]
      noticesDropped: number
    } => {
      noticeSeq += 1
      const now = Date.now()
      const log = get().noticeLog
      const last = log[log.length - 1]
      if (last !== undefined && repeatsLatestNotice(last, kind, text, source, now)) {
        // A fresh occurrence is a live problem again, so a resolved mark from
        // the merged entry does not ride along (the key is dropped, not set).
        // The row speaks the **newest** occurrence's words: `at` already moves
        // to now, and a sentence that still quotes this run's addresses is the
        // evidence this entry stands for.
        const { resolved: _closed, ...carried } = last
        void _closed
        const merged: Notice = {
          ...carried,
          text,
          seq: noticeSeq,
          at: now,
          count: (last.count ?? 1) + 1,
        }
        return {
          notice: merged,
          noticeLog: [...log.slice(0, -1), merged],
          noticesDropped: get().noticesDropped,
        }
      }
      const notice: Notice = source === undefined
        ? { kind, text, seq: noticeSeq, at: now }
        : { kind, text, seq: noticeSeq, at: now, source }
      const kept = [...log, notice]
      return {
        notice,
        noticeLog: kept.slice(-NOTICE_LOG_LIMIT),
        noticesDropped: get().noticesDropped + Math.max(0, kept.length - NOTICE_LOG_LIMIT),
      }
    }

    /**
     * Run a host call, turning a refusal into a notice rather than a crash.
     *
     * The sentence above describes one of the two things this catches. The other
     * is a bug in the guarded callback itself, which arrives as a plain `Error`,
     * gets relabelled `internal` — a code the host also uses — and then reads to
     * the user as the host having answered. Same notice, opposite origin, and
     * the reader is sent to the wrong side.
     *
     * The distinction is available right here and was being discarded, so it is
     * kept: a fault of ours says it is ours.
     *
     * Generic since the preset import: a caller that needs to know what the
     * call produced (which names imported, which were skipped and why) reads
     * the answer here instead of re-asking, and `undefined` is its "it never
     * happened" — distinct from an answer that says something.
     */
    const guard = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await work()
      } catch (error: unknown) {
        set(raise('error', isHostError(error)
          ? describeError(error, getLanguage())
          : translate(getLanguage(), 'irisOwnFault', { detail: describeError(error, getLanguage()) })))
        return undefined
      }
    }

    return {
      connected: client.connected,
      chats: [],
      characters: [],
      chatId: undefined,
      view: undefined,
      stream: undefined,
      settings: undefined,
      worldbooks: undefined,
      charBooks: undefined,
      wiEditor: undefined,
      personas: undefined,
      notice: undefined,
      noticeLog: [],
      noticesDropped: 0,
      booting: true,
      transport: source.transport,
      dataOrigin: source.origin,
      scripts: [],
      scriptsFor: undefined,
      scriptsAllowed: 'unknown',
      cardReports: [],
      /*
       * Host reports are **not** reset beside the card ones below. Those belong
       * to a card's run and go stale the moment the chat changes; these belong
       * to the host, which trims and materialises regardless of which
       * conversation is open — clearing them on a chat switch would delete the
       * only record of a deletion.
       */
      hostReports: undefined,
      hostReportsDropped: 0,
      hostReportKinds: [],
      hostReportsLoading: false,
      cleanupOffer: undefined,
      cleanupAnswered: [],
      cardRunGeneration: 0,
      cardRun: undefined,
      runStates: [],
      documentGranted: false,
      connections: [],
      activeConnectionId: undefined,
      presets: undefined,
      activePreset: undefined,
      presetInstall: undefined,
      presetManager: undefined,
      regexScripts: undefined,
      backups: undefined,

      async boot(): Promise<void> {
        await guard(async () => {
          const [chats, characters, settings] = await Promise.all([
            client.call('chat.list', {}),
            client.call('character.list', {}),
            client.call('settings.get', {}),
          ])
          set({
            chats: chats.chats,
            characters: characters.characters,
            settings: settings.settings,
            connected: client.connected,
          })
          // Open the most recent conversation rather than an empty surface. This
          // is a reading app: the reader almost always wants to continue. A
          // reader who said otherwise gets the empty surface they asked for —
          // the choice lives on the device (per-device prefs, never the host).
          const first = chats.chats[0]
          if (first !== undefined && loadAutoOpenChat()) await get().openChat(first.chatId)
        })
        set({ booting: false })
      },

      async openChat(chatId: string): Promise<void> {
        // Clear the previous chat's stream buffer before awaiting: leaving it in
        // place would paint one chat's in-flight text under another's title.
        set({ chatId, view: undefined, stream: undefined })
        await guard(async () => {
          const [opened, settings] = await Promise.all([
            client.call('chat.open', { chatId }),
            client.call('settings.get', { chatId }),
          ])
          // A second open may have started while this one was in flight.
          if (get().chatId !== chatId) return
          set({ view: opened.view, settings: settings.settings })
        })
      },

      closeChat(): void {
        set({ chatId: undefined, view: undefined, stream: undefined })
      },

      async createChat(characterId: string): Promise<void> {
        await guard(async () => {
          const { view } = await client.call('chat.create', { characterId })
          set({ chatId: view.chatId, view, stream: undefined })
        })
      },

      async deleteChat(chatId: string): Promise<void> {
        await guard(async () => {
          await client.call('chat.delete', { chatId })
          if (get().chatId !== chatId) return
          const next = get().chats.find(row => row.chatId !== chatId)
          if (next === undefined) get().closeChat()
          else await get().openChat(next.chatId)
        })
      },

      async renameChat(chatId: string, title: string): Promise<void> {
        await guard(async () => {
          const { chats } = await client.call('chat.rename', { chatId, title })
          set({ chats })
          const view = get().view
          if (view !== undefined && view.chatId === chatId) set({ view: { ...view, title } })
        })
      },

      async searchChats(query: string): Promise<ChatSearchHit[] | undefined> {
        try {
          const { hits } = await client.call('chat.search', { query })
          return hits
        } catch (error: unknown) {
          console.warn('chat.search failed; showing the unfiltered list', error)
          return undefined
        }
      },

      async send(text: string): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          await client.call('chat.send', { chatId, text })
        })
      },

      async regenerate(): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          await client.call('chat.regenerate', { chatId })
        })
      },

      async continueReply(): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          await client.call('chat.send', { chatId, kind: 'continue' })
        })
      },

      async impersonate(): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          await client.call('chat.send', { chatId, kind: 'impersonate' })
        })
      },

      async abort(): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          await client.call('chat.abort', { chatId })
        })
      },

      async swipe(turn: number, index: number): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          const { view } = await client.call('chat.swipe', { chatId, turn, index })
          if (get().chatId === chatId) set({ view })
        })
      },

      async editMessage(id: number, text: string): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          const { view } = await client.call('chat.editMessage', { chatId, id, text })
          if (get().chatId === chatId) set({ view })
        })
      },

      async deleteMessage(id: number): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          const { view } = await client.call('chat.deleteMessage', { chatId, id })
          if (get().chatId === chatId) set({ view })
        })
      },

      async importCard(filename: string, base64: string): Promise<void> {
        await guard(async () => {
          const { character } = await client.call('character.import', { filename, content: base64 })
          const { characters } = await client.call('character.list', {})
          set({ characters, ...raise('info', `Imported ${character.name}.`) })
        })
      },

      /**
       * Copy SillyTavern chat files into this profile, under one character.
       *
       * **Per-file outcomes, not a batch abort.** A folder of ten chats where
       * two are not chat files must import the eight and say which two did not —
       * failing the whole folder on the first bad file would let one stray
       * download veto the user's whole history. The host refuses a file whole
       * (nothing half-imported), so each file has exactly two outcomes.
       *
       * The failure sentence keeps the **host's own detail** rather than the
       * generic invalid-request copy: the reason a file was refused names the
       * field it was missing, and that detail is the information.
       * @param characterId - the character every file belongs to.
       * @param files - name and base64 payload, as the file picker read them.
       */
      async importChats(
        characterId: string,
        files: readonly { filename: string, base64: string }[],
      ): Promise<void> {
        let imported = 0
        const failures: string[] = []
        for (const file of files) {
          try {
            await client.call('chat.import', {
              filename: file.filename,
              content: file.base64,
              characterId,
            })
            imported += 1
          } catch (error: unknown) {
            failures.push(asRpcError(error, getLanguage()).message)
          }
        }
        if (imported > 0) {
          // The host also pushes `chats.updated`; this read is the action's own
          // answer, so the list is current even without an event socket.
          const { chats } = await client.call('chat.list', {})
          set({ chats })
          get().notify('info', translate(
            getLanguage(),
            imported === 1 ? 'chatsImportedOne' : 'chatsImported',
            { n: imported },
          ))
        }
        for (const failure of failures) get().notify('error', failure)
      },

      /**
       * Download one conversation as SillyTavern JSONL.
       *
       * Host-side read, browser-side save — the `exportPreset` shape, so the
       * file never lands anywhere but the reader's own downloads folder.
       * @param chatId - the conversation to take out.
       */
      async exportChat(chatId: string): Promise<void> {
        await guard(async () => {
          const { filename, content } = await client.call('chat.export', { chatId })
          const url = URL.createObjectURL(new Blob([content], { type: 'application/jsonl' }))
          const link = document.createElement('a')
          link.href = url
          link.download = filename
          link.click()
          URL.revokeObjectURL(url)
          get().notify('info', translate(getLanguage(), 'chatExported', { name: filename }))
        })
      },

      async deleteCharacter(characterId: string): Promise<void> {
        await guard(async () => {
          await client.call('character.delete', { characterId })
          const { characters } = await client.call('character.list', {})
          /*
           * Drop the cached script list if it belonged to the card just deleted.
           *
           * Deletion is the one moment a character *id* can change owner — but it
           * is not the only moment a permission loses its subject. The panel
           * moving to a different card does the same thing and does it dozens of
           * times a day; the probe's network grant had exactly that bug. The rule
           * is about the subject, not about deletion: re-anchor a permission
           * whenever what it was granted to stops being what is in front of you.
           *
           * The host
           * mints ids with `uniqueId(toId(name), existing)` against the cards that
           * currently exist, so deleting "Aria" frees `aria` and the next card of
           * that name is handed the same id. `loadScripts` returns early when
           * `scriptsFor` already matches — so without this, opening the *new*
           * Aria would skip the round trip and show the old one's scripts and,
           * worse, its `documentGranted`.
           *
           * That would also defeat the host's own fix: it now forgets a deleted
           * card's grant, and this cache would answer `true` without ever asking.
           * Two green halves that leak when composed — the host is right and stays
           * right, because the question never reaches it.
           *
           * The two fields go for different reasons, and the difference is the
           * rule worth carrying: **content rebinds by name, permissions never.**
           * `scripts` is content — the new card has its own, so this is ordinary
           * cache invalidation, and the chats deliberately survive for the same
           * reason (reimporting a card to carry on playing is what a user means
           * to do). `documentGranted` is a permission, and the user granted it to
           * a card that no longer exists. Any per-character state added here has
           * to answer which of the two it is before it is cached.
           */
          const stale = get().scriptsFor === characterId
          set({
            characters,
            ...(stale
              ? {
                  scripts: [],
                  scriptsFor: undefined,
                  documentGranted: false,
                  // `unasked`, not `declined`. Inheriting a decline is the worst
                  // of the three: the new card is never offered its scripts and
                  // nothing reports why.
                  scriptsAllowed: 'unknown' as ConsentState,
                  runStates: [],
                  cardReports: [],
                }
              : {}),
          })
        })
      },

      /**
       * Copy a character under a fresh id.
       *
       * The host does the copying and names the copy; the list re-read is this
       * action's own answer, so the new row is there even without an event
       * socket. The copy opens nothing and copies no chats — it is a card in a
       * library, not a conversation.
       * @param characterId - the character to copy.
       */
      async duplicateCharacter(characterId: string): Promise<void> {
        await guard(async () => {
          const { character } = await client.call('character.duplicate', { characterId })
          const { characters } = await client.call('character.list', {})
          set({ characters, ...raise('info', translate(getLanguage(), 'characterDuplicated', { name: character.name })) })
        })
      },

      /**
       * Change a character's display name.
       *
       * The name goes onto the card; the id stays, and with it every binding,
       * chat and star keyed by it — which is exactly why the list is re-read
       * here: the row's name changed without its identity moving.
       * @param characterId - the character to rename.
       * @param name - the new name, verbatim.
       */
      async renameCharacter(characterId: string, name: string): Promise<void> {
        await guard(async () => {
          await client.call('character.rename', { characterId, name })
          const { characters } = await client.call('character.list', {})
          set({ characters, ...raise('info', translate(getLanguage(), 'characterRenamed', { name })) })
        })
      },

      /**
       * Replace a character's whole tag list.
       *
       * One call, not add/remove/edit calls: the editor edits the list, and the
       * card is too small a document for the traffic of a tag at a time.
       * @param characterId - the character to edit.
       * @param tags - the complete new list, in order.
       */
      async setCharacterTags(characterId: string, tags: readonly string[]): Promise<void> {
        await guard(async () => {
          await client.call('character.setTags', { characterId, tags: [...tags] })
          const { characters } = await client.call('character.list', {})
          set({ characters })
        })
      },

      /**
       * Star or unstar a character.
       *
       * Optimistic locally, then confirmed from the host's own echo: the star
       * is one boolean on one row, and a round trip before the pixel moves is
       * latency a list this size can feel. A host without the store refuses —
       * and the refusal rolls the row back, because a lit star over an error
       * notice is the one answer this control must never give.
       * @param characterId - the character to change.
       * @param favorite - the star's new state.
       */
      async favoriteCharacter(characterId: string, favorite: boolean): Promise<void> {
        const before = get().characters
        set(state => ({
          characters: state.characters.map(character =>
            character.characterId === characterId ? { ...character, favorite } : character),
        }))
        const done = await guard(async () => {
          const answer = await client.call('character.favorite', { characterId, favorite })
          if (answer.favorite !== favorite) {
            const { characters } = await client.call('character.list', {})
            set({ characters })
          }
          return answer
        })
        // `guard` swallows the refusal and answers undefined; the pixel goes
        // back to where it was, and the notice says why.
        if (done === undefined) set({ characters: before })
      },

      /**
       * Download a character card as a file another front-end can read.
       *
       * The bytes cross as base64 because that is how `character.import` takes
       * them; a PNG is binary, so they are decoded back before the blob is
       * offered to the browser. Host-side read, browser-side save — the
       * `exportChat` shape.
       * @param characterId - the character to take out.
       * @param format - the file shape to export as.
       */
      async exportCharacter(characterId: string, format: 'png' | 'json'): Promise<void> {
        await guard(async () => {
          const { filename, content } = await client.call('character.export', { characterId, format })
          const type = format === 'png' ? 'image/png' : 'application/json'
          const bytes = Uint8Array.from(atob(content), ch => ch.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type }))
          const link = document.createElement('a')
          link.href = url
          link.download = filename
          link.click()
          URL.revokeObjectURL(url)
          get().notify('info', translate(getLanguage(), 'characterExported', { name: filename }))
        })
      },

      async patchSettings(patch: Record<string, unknown>): Promise<void> {
        const chatId = get().chatId
        await guard(async () => {
          // Scoped to the open chat when there is one: a reader adjusting
          // temperature mid-scene means "for this scene", not "for everything".
          const { settings } = await client.call('settings.set', {
            ...(chatId === undefined ? {} : { chatId }),
            settings: patch,
          })
          set({ settings })
        })
      },

      async loadWorldbooks(): Promise<void> {
        await guard(async () => {
          const [names, selection, settings] = await Promise.all([
            client.call('worldbook.names', {}),
            client.call('worldbook.globalSelect', {}),
            client.call('worldbook.settings', {}),
          ])
          set({ worldbooks: { names: names.names, globalSelect: selection.names, settings: settings.settings } })
        })
      },

      async setGlobalSelect(names: readonly string[]): Promise<void> {
        await guard(async () => {
          const answer = await client.call('worldbook.setGlobalSelect', { names: [...names] })
          // Held from the answer, not from the argument: the host skips a name
          // with no file behind it, so the selection as stored can differ from
          // the selection as asked.
          set(state => ({
            worldbooks: state.worldbooks === undefined
              ? undefined
              : { ...state.worldbooks, globalSelect: answer.names },
          }))
        })
      },

      async patchWorldbookSettings(patch: Partial<WorldbookSettingsView>): Promise<void> {
        await guard(async () => {
          const answer = await client.call('worldbook.setSettings', patch)
          set(state => ({
            worldbooks: state.worldbooks === undefined
              ? undefined
              : { ...state.worldbooks, settings: answer.settings },
          }))
        })
      },

      async loadCharBooks(): Promise<void> {
        const characterId = get().view?.characterId
        if (characterId === undefined) {
          // No open chat, no owner for a binding — clearing beats showing the
          // previous character's books beside a different conversation.
          set({ charBooks: undefined })
          return
        }
        await guard(async () => {
          const answer = await client.call('worldbook.charNames', { characterId })
          // The chat can switch while the call is in flight; an answer for the
          // character that is no longer open is dropped, not shown.
          if (get().view?.characterId !== characterId) return
          set({ charBooks: { characterId, primary: answer.primary, additional: answer.additional } })
        })
      },

      async setCharBooks(names: readonly string[]): Promise<void> {
        const characterId = get().view?.characterId
        if (characterId === undefined) return
        await guard(async () => {
          const answer = await client.call('worldbook.setCharBooks', { characterId, names: [...names] })
          // Held from the answer: the host collapses duplicates and answers the
          // binding as stored, which can differ from the list as asked.
          if (get().view?.characterId !== characterId) return
          set({ charBooks: { characterId, primary: answer.primary, additional: answer.additional } })
        })
      },

      async loadBackups(): Promise<void> {
        await guard(async () => {
          const { backups } = await client.call('backup.list', {})
          set({ backups })
        })
      },

      async previewBackup(backupId: string): Promise<BackupPreview | undefined> {
        try {
          const { preview } = await client.call('backup.preview', { backupId })
          return preview
        } catch (error: unknown) {
          get().notify('error', translate(
            getLanguage(),
            'backupFailed',
            { detail: asRpcError(error, getLanguage()).message },
          ))
          return undefined
        }
      },

      async restoreBackup(backupId: string, confirm: string): Promise<void> {
        await guard(async () => {
          const answer = await client.call('backup.restore', { backupId, confirm })
          // Held from the answer, not assumed: the chat the host restored is
          // the fact, and its list may have moved as well.
          const { chats } = await client.call('chat.list', {})
          set({ chats, ...raise('info', translate(
            getLanguage(),
            answer.previous === undefined ? 'backupRestoredClean' : 'backupRestored',
            { title: answer.chat.title },
          )) })
          if (get().chatId === answer.chat.chatId) await get().openChat(answer.chat.chatId)
          await get().loadBackups()
        })
      },

      async deleteBackup(backupId: string): Promise<void> {
        await guard(async () => {
          await client.call('backup.delete', { backupId })
          set(raise('info', translate(getLanguage(), 'backupDeleted')))
          await get().loadBackups()
        })
      },

      async openWiEditor(book: string): Promise<void> {
        // Replaced before the fetch: whatever the previous book's drafts held,
        // this book's editor must not open showing them. The panel's
        // unsaved-changes check runs *before* calling this, so a guarded
        // switch never reaches here with work still on the table.
        set({ wiEditor: undefined })
        await guard(async () => {
          const answer = await client.call('worldbook.get', { name: book })
          set({ wiEditor: openWiEditor(book, answer.entries) })
        })
      },

      closeWiEditor(): void {
        set({ wiEditor: undefined })
      },

      patchWiEntry(uid: number, patch: Partial<WorldbookEntry>): void {
        const state = get().wiEditor
        if (state === undefined) return
        set({ wiEditor: updateWiEntry(state, uid, patch) })
      },

      discardWiEdits(): void {
        const state = get().wiEditor
        if (state === undefined) return
        // Back to the baseline, not to a closed editor: "throw these changes
        // away" means keep looking at the book, at what the host last said.
        set({ wiEditor: { ...state, drafts: JSON.parse(JSON.stringify(state.baseline)) as WorldbookEntry[] } })
      },

      async saveWiEditor(): Promise<void> {
        const state = get().wiEditor
        if (state === undefined) return
        await guard(async () => {
          // Whole-book, in the drafts' order — which is how display order is
          // chosen, the same way upstream's writer assigns `displayIndex` from
          // array position. The send is the drafts verbatim: they were built
          // from the wire shape and are the wire shape.
          const answer = await client.call('worldbook.replace', {
            name: state.book,
            entries: JSON.parse(JSON.stringify(state.drafts)) as WorldbookEntry[],
          })
          // Reset dirty from the host's answer, not from the drafts.
          set(prev => ({
            wiEditor: prev.wiEditor === undefined ? undefined : markSaved(prev.wiEditor, answer.entries),
          }))
          get().notify('info', translate(getLanguage(), 'wiSaved', { name: state.book }))
        })
      },

      async exportWiBackup(): Promise<void> {
        const state = get().wiEditor
        if (state === undefined) return
        await guard(async () => {
          // The raw saved shape, not the card-facing one: this file is what a
          // restore would put back, so it is the shape a restore would read.
          // (The profile's `backups/` directory is not reachable from here —
          // the host owns no worldbook backup RPC yet — so the pre-write
          // snapshot lands in the reader's downloads folder instead, recorded
          // as a debt in notes/apps/iris-web/DEVIATIONS.md.)
          const { book } = await client.call('worldbook.load', { name: state.book })
          if (book === null || book === undefined) throw new Error(`world book "${state.book}" could not be read`)
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const url = URL.createObjectURL(new Blob([JSON.stringify(book, null, 2)], { type: 'application/json' }))
          const link = document.createElement('a')
          link.href = url
          link.download = `${state.book}.${stamp}.json`
          link.click()
          URL.revokeObjectURL(url)
          get().notify('info', translate(getLanguage(), 'wiBackupExported', { name: state.book }))
        })
      },

      async loadPersonas(): Promise<void> {
        await guard(async () => {
          const answer = await client.call('persona.list', {})
          set({ personas: { personas: answer.personas, ...(answer.activeId === undefined ? {} : { activeId: answer.activeId }) } })
        })
      },

      async savePersona(input: {
        id?: string
        name: string
        description?: string
        position?: PersonaView['position']
        depth?: number
        role?: 'system' | 'user' | 'assistant'
        active?: boolean
      }): Promise<void> {
        await guard(async () => {
          const answer = await client.call('persona.set', input)
          set({ personas: { personas: answer.personas, ...(answer.activeId === undefined ? {} : { activeId: answer.activeId }) } })
        })
      },

      async deletePersona(id: string): Promise<void> {
        await guard(async () => {
          const answer = await client.call('persona.delete', { id })
          set({ personas: { personas: answer.personas, ...(answer.activeId === undefined ? {} : { activeId: answer.activeId }) } })
        })
      },

      async loadScripts(characterId: string): Promise<void> {
        if (get().scriptsFor === characterId) return
        // Cleared first: the previous card's scripts must not sit under the new
        // card's name for the length of a round trip, because the one thing this
        // panel exists to answer is "what does THIS card run".
        set({
          scripts: [],
          scriptsFor: characterId,
          documentGranted: false,
          // `unknown` until the host answers. `unasked` here would put the
          // question during the round trip — including to a user whose answer is
          // already stored and about to arrive.
          scriptsAllowed: 'unknown',
          runStates: [],
          cardReports: [],
        })
        await guard(async () => {
          const listed = await client.call('script.list', { characterId })
          if (get().scriptsFor !== characterId) return
          set({
            scripts: listed.scripts,
            documentGranted: listed.documentGranted,
            // Read through `consentState`, never `?? false`: the field is absent
            // when nobody has been asked, and folding that into a decline means
            // the question is never put and scripts never start, silently.
            scriptsAllowed: consentState(listed),
          })
        })
      },

      async answerScriptsAllowed(allowed: boolean): Promise<void> {
        const characterId = get().scriptsFor
        if (characterId === undefined) return
        await guard(async () => {
          const { scriptsAllowed } = await client.call('script.setScriptsAllowed', {
            characterId,
            allowed,
          })
          // Guarded on the card still being the one in front of the user: the
          // answer belongs to the card it was given about, and an await is long
          // enough to change cards.
          if (get().scriptsFor === characterId) {
            set({ scriptsAllowed: scriptsAllowed ? 'allowed' : 'declined' })
          }
        })
      },

      beginCardRun(): void {
        // Monotonic rather than reset per card: two runs must never share a
        // number, and a card's reports are cleared on switch anyway. A counter
        // that restarted could make a stale entry look current again.
        const generation = get().cardRunGeneration + 1
        const chatId = get().chatId
        /*
         * The id is minted **here**, at the one point that already means "a new
         * run starts now" — the same call the report generation hangs off. A
         * second place deciding when a run begins is a second answer to which
         * run an injection belongs to.
         */
        set({
          cardRunGeneration: generation,
          cardRun: chatId === undefined
            ? undefined
            : { runId: `${chatId}:${String(generation)}`, chatId },
        })
      },

      async endCardRun(): Promise<void> {
        const run = get().cardRun
        /*
         * **The run's own chat, not the open one.** This runs from a React
         * cleanup, which fires after `chatId` has already become the *next*
         * chat — so reading it here named the wrong conversation on every
         * switch, the host matched nothing, and the injections it was asked to
         * clear stayed live. Measured on 8787 before this line changed.
         *
         * Cleared first, so a second call cannot send a second `runEnded` for
         * the same run. The teardown path and `pagehide` can both fire — a tab
         * closing during a chat switch — and the host counts what it cleared,
         * so a duplicate would report a second sweep of nothing.
         */
        set({ cardRun: undefined })
        if (run === undefined) return
        const { runId, chatId } = run
        /*
         * Not wrapped in `guard`: this runs during teardown, and a notice about
         * a run that has already ended would arrive over whatever the reader is
         * looking at next. A failure here leaves the host's injections in place
         * and it reports them itself — the orphan path, which is the case the
         * host keeps rather than guesses about.
         */
        try {
          await client.call('script.runEnded', { chatId, runId })
        } catch {
          // Reported by the host as an orphan run rather than here as a notice.
        }
      },

      async answerCleanup(answer: CleanupAnswer): Promise<void> {
        const offer = get().cleanupOffer
        if (offer === undefined) return
        /*
         * Cleared before the call, not after. The reader has answered; leaving
         * the dialog up while the host works invites a second press, and a
         * second `clean` on a chat whose sweep is already running is a request
         * nobody can mean.
         */
        /*
         * Cleared before the call, and the chat is recorded as answered in the
         * same breath. Leaving the dialog up while the host works invites a
         * second press, and a second `clean` on a chat whose sweep is already
         * running is a request nobody can mean.
         */
        set({
          cleanupOffer: undefined,
          cleanupAnswered: [...get().cleanupAnswered, offer.chatId],
        })
        await guard(async () => {
          const result = await client.call('chat.answerCleanup', { chatId: offer.chatId, answer })
          if (answer === 'never') return
          /*
           * What actually happened, said in one notice.
           *
           * **The backup path is the part that has to be shown.** Upstream
           * toasts it (`runtime.cleanup.exportSucceeded`, `legacy_chat.ts:60-73`)
           * and the reason survives translation: a user who asked for a backup
           * before letting something be deleted needs to know where it went, and
           * an export that succeeded silently is indistinguishable from one that
           * was skipped.
           *
           * `cleaned` is reported even when it is zero, because zero is the
           * answer to a question the user just asked — "was there anything to
           * clean?" — and hiding it would leave them wondering whether the
           * button worked.
           */
          const swept = result.cleaned === 1
            ? translate(getLanguage(), 'cleanedOne')
            : translate(getLanguage(), 'cleanedMessages', { n: result.cleaned })
          get().notify(
            'info',
            result.backup === undefined
              ? swept
              : `${swept} — ${translate(getLanguage(), 'backedUpTo', { path: result.backup })}`,
          )
        })
      },

      dismissCleanupOffer(): void {
        // No call. Silence is the outcome — see the declaration for why this is
        // deliberately not `'never'`.
        set({ cleanupOffer: undefined })
      },

      async loadHostReports(): Promise<void> {
        set({ hostReportsLoading: true })
        try {
          /*
           * No `since`, so the whole held buffer comes back. Paging exists in
           * the contract (`since`/`limit`) and is deliberately not used here:
           * the buffer is bounded by the host, the page shows all of it, and a
           * cursor would be a second thing to be wrong about which records the
           * reader is looking at.
           *
           * **There is no `kinds` filter in the request** — the contract takes
           * `since` and `limit` only, and returns the kinds it holds. So the
           * filtering is the view's, over everything fetched.
           */
          const answer = await client.call('debug.reports', {})
          set({
            hostReports: answer.reports,
            hostReportsDropped: answer.dropped,
            hostReportKinds: answer.kinds,
          })
        } catch (error: unknown) {
          /*
           * Reported, not swallowed. A diagnostics view that fails silently is
           * worse than none: a reader takes an empty list for "the host had
           * nothing to say", which is the one reading that cannot be corrected
           * by looking harder.
           */
          get().notify(
            'error',
            translate(getLanguage(), 'reportsUnreadable', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          )
        } finally {
          set({ hostReportsLoading: false })
        }
      },

      addCardReport(text: string, options?: CardReportOptions): void {
        const { scriptId, grade, channel } = options ?? {}
        const generation = get().cardRunGeneration
        const seen = get().cardReports

        /*
         * One entry per fact, re-dated when the fact recurs.
         *
         * Two things had to be true at once. A card polling a missing slot must
         * not fill the panel with one fact — that is the notice bar again. But
         * the same fact arising in a *new* run is news: it means the thing was
         * not fixed, and suppressing it as a duplicate would leave the panel
         * showing it stamped with a run that has long since ended.
         *
         * So the text stays unique and its generation moves forward. Position
         * is deliberately not moved: a list that reorders itself while someone
         * is reading it is harder to follow than one that does not.
         */
        const at = seen.findIndex(report => report.text === text)
        if (at === -1) {
          set({
            cardReports: [...seen, {
              text,
              generation,
              ...(scriptId === undefined ? {} : { scriptId }),
              ...(grade === undefined ? {} : { grade }),
              ...(channel === undefined ? {} : { channel }),
            }],
          })
          return
        }
        if (seen[at]?.generation === generation) return
        const updated = [...seen]
        updated[at] = { text, generation, ...(scriptId === undefined ? {} : { scriptId }) }
        set({ cardReports: updated })
      },

      withdrawReportsFor(scriptId: string): void {
        /*
         * Called when a script that was reported failed turns out to have
         * succeeded — a module that finished after the frame's deadline had
         * already given up on it.
         *
         * Marked, not removed. Deleting would leave no trace that anything took
         * long enough to be declared dead, and that delay is the actual defect
         * even when it resolves. Leaving it unmarked is the other error: three
         * consumers ran happily while the panel still said their provider had
         * failed.
         */
        const seen = get().cardReports
        if (!seen.some(report => report.scriptId === scriptId && report.withdrawn !== true)) return
        set({
          cardReports: seen.map(report =>
            report.scriptId === scriptId ? { ...report, withdrawn: true } : report,
          ),
        })
      },

      setRunStates(states: readonly ScriptRunState[]): void {
        set({ runStates: [...states] })
      },

      async resolveScripts(
        characterId: string,
      ): Promise<{ scripts: ScriptView[], documentGranted: boolean }> {
        // Not wrapped in `guard`: the caller is about to decide whether to run
        // code, and a refusal turned into a notice would resolve as though the
        // host had answered.
        const listed = await client.call('script.list', { characterId })
        return { scripts: listed.scripts, documentGranted: listed.documentGranted }
      },

      async fetchScriptDependency(url: string): Promise<string> {
        // The allowlist is the host's; a page cannot police its own fetches. The
        // refusal names the host it declined rather than being softened here.
        const { content } = await client.call('script.fetch', { url })
        return content
      },

      async setScriptEnabled(scriptId: string, enabled: boolean): Promise<void> {
        const characterId = get().scriptsFor
        if (characterId === undefined) return
        await guard(async () => {
          const { scripts } = await client.call('script.setEnabled', { characterId, scriptId, enabled })
          if (get().scriptsFor === characterId) set({ scripts })
        })
      },

      async setDocumentGrant(granted: boolean): Promise<void> {
        const characterId = get().scriptsFor
        if (characterId === undefined) return
        await guard(async () => {
          const result = await client.call('script.setDocumentGrant', { characterId, granted })
          if (get().scriptsFor !== characterId) return
          set({ documentGranted: result.documentGranted })
          // Said plainly, because the policy is that a grant takes effect on the
          // next run and a user who expects it to apply now would draw the wrong
          // conclusion from a card that keeps failing.
          get().notify(
            'info',
            granted
              ? translate(getLanguage(), 'pageAccessGranted')
              : translate(getLanguage(), 'pageAccessRevoked'),
          )
        })
      },

      async scriptContext(chatId: string, characterId: string): Promise<ScriptContext | undefined> {
        try {
          const { context } = await client.call('script.context', { chatId, characterId })
          return context
        } catch {
          // Swallowed on purpose, and the only place in this store that does. A
          // refused context is an expected answer — the fake client refuses
          // rather than inventing one — and the caller decides what to do about
          // it, so raising a notice here would put a message in front of the user
          // about something the caller may be handling fine.
          return undefined
        }
      },

      async saveCardExtensionSettings(settings: Record<string, unknown>): Promise<void> {
        // The partition belongs to the card of the open chat. A report arriving
        // with no chat open has no owner to write under, so it is dropped the
        // way a frame event is dropped after disposal: late, not lost.
        const characterId = get().view?.characterId
        if (characterId === undefined) return
        // `guard`, not throw: the sender is a frame's fire-and-forget report
        // (and upstream's own save is an unawaited debounced call), so a
        // rejection would surface nowhere — a notice is the only channel that
        // can say the write did not stick.
        await guard(async () => {
          await client.call('script.setExtensionSettings', { characterId, settings })
        })
      },

      async scriptBody(characterId: string, scriptId: string): Promise<ScriptBodyResult> {
        try {
          const { content } = await client.call('script.body', { characterId, scriptId })
          return { ok: true, content }
        } catch (error: unknown) {
          // The reason travels. The first version returned a bare `undefined` and
          // its one caller printed a fixed sentence blaming the fake client —
          // which was then shown for a refusal from a real host, sending someone
          // to debug the transport they had already got working. An explanation
          // that does not depend on the failure is a guess with a confident
          // voice.
          return { ok: false, error: asRpcError(error) }
        }
      },

      async loadConnections(): Promise<void> {
        await guard(async () => {
          const listed = await client.call('connection.list', {})
          set({ connections: listed.profiles, activeConnectionId: listed.activeId })
        })
      },

      async activateConnection(id: string): Promise<void> {
        const chatId = get().chatId
        await guard(async () => {
          // Scoped like every other settings write: activating while a chat is
          // open means "for this scene". Otherwise the reader would change a
          // conversation's route by touching what looks like a global list.
          const result = await client.call('connection.activate', {
            id,
            ...(chatId === undefined ? {} : { chatId }),
          })
          set({ settings: result.settings, activeConnectionId: result.activeId })
        })
      },

      async saveConnection(patch): Promise<void> {
        await guard(async () => {
          const listed = await client.call('connection.save', patch)
          set({ connections: listed.profiles, activeConnectionId: listed.activeId })
        })
      },

      async testConnection(params): Promise<RpcResponse<'connection.test'>> {
        // The verdict passes through untouched. A refused probe is a response,
        // not a rejection — only a refusal before any probe lands here as a
        // throw, and the panel renders that as its own sentence.
        return client.call('connection.test', params)
      },

      async deleteConnection(id: string): Promise<void> {
        await guard(async () => {
          const listed = await client.call('connection.delete', { id })
          // `activeId` is taken from the response rather than kept: deleting the
          // active profile clears it host-side, and holding the old value would
          // leave the interface reporting a current connection nobody can open.
          set({ connections: listed.profiles, activeConnectionId: listed.activeId })
        })
      },

      async loadPresets(): Promise<void> {
        try {
          const listed = await client.call('preset.list', {})
          set({
            presets: listed.presets,
            activePreset: listed.active,
            presetInstall: listed.install,
          })
        } catch {
          // A host with no library, saying so. The panel reads this state as
          // "the feature does not exist here" rather than "no presets yet".
          set({ presets: undefined, activePreset: undefined, presetInstall: undefined })
        }
      },

      async selectPreset(name: string): Promise<void> {
        await guard(async () => {
          const answer = await client.call('preset.select', { name })
          set({
            presets: answer.presets,
            activePreset: answer.active,
            presetManager: answer.manager,
          })
          /*
           * A switch applies the preset's scalars (temperature, window, effort)
           * host-side, so the sampling sliders just went stale. Re-read what is
           * in force — for the open chat, or the global defaults when none is —
           * rather than letting the drawer disagree with the host it just told.
           */
          const chatId = get().chatId
          const refreshed = chatId === undefined
            ? await client.call('settings.get', {})
            : await client.call('settings.get', { chatId })
          set({ settings: refreshed.settings })
        })
      },

      async viewManager(): Promise<void> {
        await guard(async () => {
          const { manager } = await client.call('preset.view', {})
          set({ presetManager: manager })
        })
      },

      async setPromptEnabled(id: string, enabled: boolean): Promise<void> {
        await guard(async () => {
          const { manager } = await client.call('preset.setEnabled', { id, enabled })
          set({ presetManager: manager })
        })
      },

      async movePrompt(id: string, index: number): Promise<void> {
        await guard(async () => {
          const { manager } = await client.call('preset.move', { id, index })
          set({ presetManager: manager })
        })
      },

      async removePrompt(id: string): Promise<void> {
        await guard(async () => {
          const { manager } = await client.call('preset.removePrompt', { id })
          set({ presetManager: manager })
        })
      },

      async savePreset(name: string): Promise<void> {
        await guard(async () => {
          const answer = await client.call('preset.save', { name })
          set({ presets: answer.presets, activePreset: answer.active })
          get().notify('info', translate(getLanguage(), 'presetSaved', { name }))
        })
      },

      async deletePreset(name: string): Promise<void> {
        await guard(async () => {
          const answer = await client.call('preset.delete', { name })
          set({ presets: answer.presets, activePreset: answer.active })
          get().notify('info', translate(getLanguage(), 'presetDeleted', { name }))
        })
      },

      async importPresets(names?: readonly string[]): Promise<{
        imported: readonly string[]
        skipped: readonly { name: string, reason: string }[]
      }> {
        const answer = await guard(async () =>
          client.call('preset.import', { ...(names === undefined ? {} : { names: [...names] }) }))
        // Refused: the notice is already up; nothing imported and nothing to list.
        if (answer === undefined) return { imported: [], skipped: [] }
        set({ presets: answer.presets })
        const n = answer.imported.length
        if (n > 0) {
          get().notify('info', translate(getLanguage(), n === 1 ? 'presetImportedOne' : 'presetImported', { n }))
        }
        return { imported: answer.imported, skipped: answer.skipped }
      },

      async importPresetFiles(files: readonly { filename: string, base64: string }[]): Promise<{
        imported: readonly { name: string, overwritten: boolean, sensitive: readonly string[] }[]
        refused: readonly { name: string, reason: 'invalid-json' | 'not-a-preset' | 'unusable-name' }[]
      }> {
        const imported: { name: string, overwritten: boolean, sensitive: readonly string[] }[] = []
        const refused: { name: string, reason: 'invalid-json' | 'not-a-preset' | 'unusable-name' }[] = []
        for (const file of files) {
          const answer = await guard(async () =>
            client.call('preset.importFile', { filename: file.filename, content: file.base64 }))
          // Refused outright (the transport, or a host without a library): the
          // guard has already raised the notice; the file simply did not land.
          if (answer === undefined) continue
          if (answer.outcome.imported) {
            imported.push({
              name: answer.outcome.name,
              overwritten: answer.outcome.overwritten,
              sensitive: answer.outcome.sensitive,
            })
          } else {
            refused.push({ name: answer.outcome.name, reason: answer.outcome.reason })
          }
          // The response carries the library as of this file; the last one read
          // is the current one, so the list never trails the loop.
          set({ presets: answer.presets })
        }
        if (imported.length > 0) {
          get().notify('info', translate(
            getLanguage(),
            imported.length === 1 ? 'presetImportedOne' : 'presetImported',
            { n: imported.length },
          ))
        }
        return { imported, refused }
      },

      async exportPreset(name: string): Promise<void> {
        await guard(async () => {
          const { preset } = await client.call('preset.read', { name })
          /*
           * Saved the way the host stores it — four-space JSON — so a file that
           * goes out of an export can go straight back into an install without
           * showing up as a full-file diff there either.
           */
          const body = JSON.stringify(preset, null, 4)
          const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
          const link = document.createElement('a')
          link.href = url
          link.download = `${name}.json`
          link.click()
          URL.revokeObjectURL(url)
          get().notify('info', translate(getLanguage(), 'presetExported', { name }))
        })
      },

      async loadRegex(): Promise<void> {
        try {
          const { scripts } = await client.call('regex.list', {})
          set({ regexScripts: scripts })
        } catch {
          // A host with no global regex store, saying so — read the same way
          // `presets === undefined` is: the feature does not exist here.
          set({ regexScripts: undefined })
        }
      },

      async setRegexScripts(scripts: readonly RegexScriptView[]): Promise<void> {
        await guard(async () => {
          const answer = await client.call('regex.set', { scripts: [...scripts] })
          set({ regexScripts: answer.scripts })
        })
      },

      async runSlash(command: string): Promise<string> {
        const chatId = get().chatId
        if (chatId === undefined) throw new Error('no chat is open')
        // Deliberately not wrapped in `guard`: the caller is a card waiting on a
        // promise, and it needs the rejection. The failure still goes on the
        // record below, though — the rejection is kept, so "reported" and
        // "handed back" are two channels carrying one outcome, not a choice
        // between them.
        try {
          const { result } = await client.call('script.slash', { chatId, command })
          return result
        } catch (error: unknown) {
          set(raise('error', translate(getLanguage(), 'cardCallFailed', {
            method: 'triggerSlash',
            detail: describeError(error, getLanguage()),
          })))
          throw error
        }
      },

      async runCardAction(method: string, params: unknown): Promise<unknown> {
        const chatId = get().chatId
        if (chatId === undefined) throw new Error('no chat is open')

        /*
         * The shell's own actions, answered before the host lookup.
         *
         * A card writes `#send_textarea.value` and clicks `#send_but`; what has
         * to happen is that **Iris's composer** takes the text and submits it.
         * There is no host arm for "type this for the user", and giving these a
         * plausible wire method would route them to one that does not exist —
         * the failure would then arrive as the host refusing a method nobody
         * wrote, which is the misattribution this file already paid for once.
         *
         * Refused by throwing when nothing happened, because the caller is a
         * card and it has to be able to say so: `#send_but.click()` returns
         * void, so the rejection its wrapper reports is the only channel back.
         */
        if (isShellAction(method)) {
          const bag = typeof params === 'object' && params !== null
            ? (params as Record<string, unknown>)
            : {}
          const refused = method === 'composerDraft'
            ? draftThroughComposer(String(bag['text'] ?? ''))
            : sendThroughComposer()
          if (refused !== undefined) throw new Error(refused)
          return {}
        }

        const wire = wireMethodFor(method)
        if (wire === undefined) {
          // Named, so a card author reading their console learns which member was
          // refused rather than that "something" failed.
          /*
           * States the fact, not a motive.
           *
           * "Iris does not let card scripts call X" reads as a decision, and the
           * commonest reason a method is missing from this table is that nobody
           * has built it yet — `setVariables` sat outside it for exactly that
           * reason. Announcing a gap as a prohibition tells the reader the
           * question is settled, so nobody asks for it.
           */
          /*
           * Named as **this app's** refusal, because that is whose it is.
           *
           * It used to say only "is not one of the actions a card can ask Iris
           * for", and `writeButtons` wraps a rejection as "the host refused to
           * store the table" — so a refusal decided at this line was presented
           * to the reader as the host's answer to a request the host never
           * received. Two sessions checked the host's handler, its registration
           * and its contract across three commits before anyone checked this
           * list for a missing line, which is the cost of a report that names
           * the wrong layer. Same family as a report on the wrong channel: what
           * a reader acts on first is where it says the fault is.
           */
          throw new Error(
            `${method} was not forwarded: this app does not list it among the actions a card` +
              ' may ask for, so the host was never asked — either it is deliberately withheld' +
              ' or it has not been built; the list is CARD_METHODS',
          )
        }

        // Not wrapped in `guard`: a card is awaiting this, and resolving its
        // promise despite a refusal would read as the action having run. But a
        // rejection alone is not enough either — the measured card wraps its
        // TH calls in its own try/catch and logs to the console, so a failure
        // that only travels as a rejection never reaches the user. Reported
        // **and** rethrown: the notice puts the failure on the record, the
        // rethrow keeps the card's contract intact.
        const params_ = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
        /*
         * An injection carries the run it belongs to.
         *
         * Added here rather than in the frame: a card has no idea what a run is,
         * and a frame could not be trusted with the id anyway — it is what
         * decides whose injections the host will later delete. Only
         * `setExtensionPrompt` takes it, because it is the only call that leaves
         * something behind for a run to own.
         */
        const runId = get().cardRun?.runId
        const scoped = wire === 'script.setExtensionPrompt' && runId !== undefined
          ? { runId }
          : {}
        // The method is typed now; only the params still need the cast, because
        // their shape depends on which method this turned out to be.
        try {
          return await client.call(wire, { chatId, ...scoped, ...params_ } as never)
        } catch (error: unknown) {
          set(raise('error', translate(getLanguage(), 'cardCallFailed', {
            method,
            detail: describeError(error, getLanguage()),
          })))
          throw error
        }
      },

      async itemize(turn?: number): Promise<ItemizationResult> {
        const chatId = get().chatId
        if (chatId === undefined) {
          return { ok: false, error: { code: 'not-found', message: 'no chat is open' } }
        }
        try {
          const { itemization } = await client.call('prompt.itemize', {
            chatId,
            ...(turn === undefined ? {} : { turn }),
          })
          return { ok: true, itemization }
        } catch (error: unknown) {
          return { ok: false, error: asRpcError(error) }
        }
      },

      notify(kind: Notice['kind'], text: string): void {
        set(raise(kind, text))
      },

      /**
       * A transport failure — the event socket, not a host answer.
       *
       * Tagged at the source so the log can resolve these when the connection
       * returns: a socket that failed during a host restart is the session's
       * one self-healing error, and marking it recovered is the difference
       * between "something is wrong" and "something was wrong".
       */
      notifyTransportError(text: string): void {
        set(raise('error', text, 'transport'))
      },

      dismissNotice(): void {
        set({ notice: undefined })
      },
    }
  })

  const offEvents = client.subscribe(event => {
    applyEvent(store, event)
    // After the projection, not before: a tap that ran first would see the store
    // in its pre-event state, and a card asking what changed would be told the
    // old answer.
    for (const listener of [...(TAPS.get(store) ?? [])]) listener(event)
  })
  // The connection has its own channel because the host cannot report its own
  // silence. Inferring it from arriving frames means the banner only appears
  // once some unrelated traffic happens to show up.
  //
  // A return **closes** the outage's notices: every unresolved transport error
  // is marked resolved — dimmed in the log, still on the record — and one
  // reconnected line replaces the fear that the reader has to dispel
  // themselves. Raised only when an outage actually logged an error, so a
  // page that connected once and stayed connected never announces anything.
  let wasConnected = client.connected
  const offConnection = client.onConnectionChange(connected => {
    store.setState({ connected })
    if (connected && !wasConnected) {
      const log = store.getState().noticeLog
      const outage = log.some(notice => notice.source === 'transport' && !notice.resolved)
      if (outage) {
        store.setState({
          noticeLog: log.map(notice =>
            notice.source === 'transport' && !notice.resolved ? { ...notice, resolved: true } : notice),
        })
        store.getState().notify('info', translate(getLanguage(), 'reconnected'))
      }
    }
    wasConnected = connected
  })

  return {
    store,
    dispose: () => {
      offConnection()
      offEvents()
    },
  }
}

/**
 * Fold one pushed frame into the store.
 *
 * Kept out of the store closure so the streaming rules are legible in one
 * place, and so they can be tested without a client.
 * @param store - the store to update.
 * @param event - the frame.
 *
 * Narrowed on `event.type` directly rather than through the protocol's `isEvent`
 * helper. The union's own discriminant reads no worse, and it leaves this module
 * with no value imports from the protocol — which is what lets the streaming
 * state machine be tested under plain `node --test`, with no bundler.
 */
/**
 * Extra listeners on the host's event stream, per store.
 *
 * A `WeakMap` rather than a module-level set, for the same reason `actionsOf`
 * uses one: two stores exist during a hot reload, and a shared registry would
 * feed the new store's events to the old store's listeners.
 */
const TAPS = new WeakMap<IrisStore, Set<(event: IrisEvent) => void>>()

/**
 * Watch the host's events as they arrive, alongside the projection.
 *
 * For consumers that need the events themselves rather than the state they
 * produce — a running card script is the only one so far, because upstream
 * gives cards an event stream and no equivalent of the store.
 * @param store - the store whose stream to watch.
 * @param listener - called after each event has been applied.
 * @returns a function that stops the subscription.
 */
export function tapHostEvents(store: IrisStore, listener: (event: IrisEvent) => void): () => void {
  const existing = TAPS.get(store) ?? new Set<(event: IrisEvent) => void>()
  existing.add(listener)
  TAPS.set(store, existing)
  return () => {
    existing.delete(listener)
  }
}

/** One variant of the event union, selected by its tag. */
type EventOf<T extends IrisEvent['type']> = Extract<IrisEvent, { type: T }>

/**
 * Apply an event only when it belongs to the conversation on screen.
 *
 * Frames for chats this page is not looking at are dropped rather than
 * buffered: the settled view fetched on the next open is authoritative anyway,
 * so a buffer would only add a way to be stale.
 *
 * A wrapper rather than a line at the top of `applyEvent`, because **not every
 * event names a chat** and the version that assumed so stopped compiling the
 * day one did not (`report`, which is about the host). Written this way the
 * gate is visible per event, and an event without a `chatId` cannot be wrapped
 * in it — the type will not allow it.
 * @param apply - what to do when the event is for the open chat.
 * @returns the gated handler.
 */
function forOpenChat<E extends { chatId: string }>(
  apply: (event: E, store: IrisStore) => void,
): (event: E, store: IrisStore) => void {
  return (event, store) => {
    if (event.chatId !== store.getState().chatId) return
    apply(event, store)
  }
}

/**
 * What to do with each kind of event.
 *
 * **Keyed by every member of the union, so a new variant is a compile error.**
 * This was a chain of `if (event.type === …)` and the cost of that showed up
 * once: a `report` event was added to the protocol, the chain had no branch for
 * it, and nothing would have complained — it happened to break the build only
 * because the code *above* the chain read `event.chatId`, which that variant
 * does not have. An accident caught it. A map keyed on the union does not need
 * one: leaving a decision unmade does not type-check.
 */
const HANDLERS: { [T in IrisEvent['type']]: (event: EventOf<T>, store: IrisStore) => void } = {
  'chats.updated': (event, store) => {
    store.setState({ chats: event.chats })
  },

  /*
   * The host's one-time offer to clean a chat that has never been cleaned.
   *
   * **Not wrapped in `forOpenChat`,** and the reason is a race rather than a
   * preference: the host raises this while a chat is being opened, and the
   * store's `chatId` is set by the `chat.open` reply. Gating here would drop an
   * offer that arrived a beat early, which the protocol treats as a complete
   * outcome (nothing cleaned, nothing recorded, offer returns next time) and a
   * reader would experience as "the dialog never appeared". The offer carries
   * its own `chatId`, so the dialog can decide when the two agree.
   *
   * Held rather than acted on: this is the one event that asks a question. The
   * host does nothing after raising it — deliberately, because the sweep it
   * describes is much wider than the periodic window and upstream only performs
   * it after asking.
   */
  'cleanup.offer': (event, store) => {
    /*
     * Ignored for a chat already answered this session. The host raising it
     * again is not something the shell can prevent, and re-showing the dialog
     * after an answer reads as the answer having failed — measured on 8789,
     * where `ignore_cleanup` was written and the dialog stayed up.
     */
    if (store.getState().cleanupAnswered.includes(event.chatId)) return
    store.setState({
      cleanupOffer: {
        chatId: event.chatId,
        lines: event.lines,
        from: event.from,
        to: event.to,
        layers: event.layers,
      },
    })
  },

  /*
   * A pushed diagnostic, and the one event that is **not** about a chat.
   *
   * Pushed rather than polled because of what it is for: an irreversible
   * deletion. A report that has to be fetched to be seen is a report the user
   * reads after the data is gone, and "we trimmed it correctly" and "the user
   * knows we trimmed it" are two different claims.
   */
  report: (event, store) => {
    /*
     * **The host's message, verbatim.** This used to prefix `${kind}: ` and the
     * result on screen was `variables: variables: trimmed 21 floor(s)…`: a host
     * report already opens with its own channel, by the same rule this project
     * applies to every report ("the channel is the report's first sentence"), so
     * the shell prefixing it again says it twice.
     *
     * The pulled view does not have this problem and shows why: there the kind
     * is a separate element beside the message, not concatenated into it. If
     * this line ever needs to be filterable, that is the shape to copy — a
     * label, not a prefix.
     */
    const line = event.report.message
    /*
     * The **reporter's** grade, not this frame's. It used to hardcode `fault`
     * on the reasoning that only irreversible deletions are pushed — true
     * today and not a property of the channel, and a grade a reader can see
     * should come from the site that knows rather than from what the shell
     * assumes about which sites use the channel.
     */
    actionsOf(store).addCardReport(line, {
      ...(event.report.scriptId === undefined ? {} : { scriptId: event.report.scriptId }),
      grade: event.report.grade,
      // The host's own channel, as a label. The pulled view has shown it this
      // way all along; the pushed copy was concatenating it into the sentence.
      channel: event.report.kind,
    })
    /*
     * The notice bar as well: what makes this worth interrupting for is that
     * the data is already gone, which no amount of severity conveys. A note
     * about something unrecoverable still has to be seen while the user is
     * there to see it.
     */
    actionsOf(store).notify(event.report.grade === 'fault' ? 'error' : 'info', line)
  },

  'stream.start': forOpenChat((event, store) => {
    store.setState({
      stream: {
        turn: event.turn,
        text: event.seed ?? '',
        reasoning: '',
        key: event.key,
        ...event.role === undefined ? {} : { role: event.role },
        ...event.name === undefined ? {} : { name: event.name },
      },
    })
  }),

  'stream.text': forOpenChat((event, store) => {
    store.setState({ stream: appendDelta(store.getState().stream, event.turn, 'text', event.delta) })
  }),

  'stream.reasoning': forOpenChat((event, store) => {
    store.setState({
      stream: appendDelta(store.getState().stream, event.turn, 'reasoning', event.delta),
    })
  }),

  'stream.end': forOpenChat((event, store) => {
    // The whole reason the protocol sends a view here: drop the optimistic
    // buffer and take the host's truth in one step.
    store.setState({ view: event.view, stream: undefined })
  }),

  'stream.error': forOpenChat((event, store) => {
    store.setState({ stream: undefined })
    store.getState().notify('error', event.message)
  }),

  'chat.updated': forOpenChat((event, store) => {
    // Deliberately does NOT clear `stream`: an edit or a swipe landing while a
    // later turn generates must not blank the text arriving for it.
    store.setState({ view: event.view })
  }),
}

/**
 * Add a delta to the buffer for a turn.
 *
 * A delta for a turn whose opening frame was never seen — a reconnect
 * mid-generation — **starts** the buffer rather than being discarded.
 * @param current - the buffer as it stands.
 * @param turn - the turn the delta belongs to.
 * @param field - which half of the buffer it extends.
 * @param delta - the text.
 * @returns the new buffer.
 */
function appendDelta(
  current: StreamBuffer | undefined,
  turn: number,
  field: 'text' | 'reasoning',
  delta: string,
): StreamBuffer {
  const base: StreamBuffer = current !== undefined && current.turn === turn
    ? current
    : { turn, text: '', reasoning: '' }
  return field === 'text'
    ? { ...base, text: base.text + delta }
    : { ...base, reasoning: base.reasoning + delta }
}

export function applyEvent(store: IrisStore, event: IrisEvent): void {
  /*
   * The cast is the one thing this shape cannot express: TypeScript will not
   * correlate `HANDLERS[event.type]` with `event` even though the map's type
   * guarantees they match. It is confined to this line, and the guarantee that
   * matters — that every variant has a handler — is checked where the map is
   * declared.
   */
  const handle = HANDLERS[event.type] as (frame: IrisEvent, store: IrisStore) => void
  handle(event, store)
}

/** Stable action facades, one per store. */
const FACADES = new WeakMap<IrisStore, IrisActions>()

/**
 * The action set, with an identity that does not change.
 *
 * zustand's `getState()` returns a **new object after every write**, so anything
 * using it as a `useEffect` dependency re-fires on every store change — and an
 * effect that calls an action then becomes an infinite loop: action writes,
 * identity changes, effect re-runs, action writes.
 *
 * That loop wedged a browser renderer hard enough to survive a tab close. It had
 * been latent for days in `App`'s boot effect and never fired, purely because
 * `App` selects primitives that happen not to change; the panel that finally
 * triggered it selects an array whose identity changes on every load. "Safe
 * because of what the neighbouring selector returns" is not a property worth
 * relying on, so the fix is here rather than at the call sites.
 *
 * Actions are the function-valued members of the state and are never replaced,
 * so capturing them once is sound. Picked by type rather than listed, because a
 * hand-written list is a second place for the action set to be declared and
 * would drift the first time one is added.
 * @param store - the store to read.
 * @returns the same object on every call for a given store.
 */
export function actionsOf(store: IrisStore): IrisActions {
  const cached = FACADES.get(store)
  if (cached !== undefined) return cached
  const state = store.getState() as unknown as Record<string, unknown>
  const facade = Object.fromEntries(
    Object.entries(state).filter(([, value]) => typeof value === 'function'),
  ) as unknown as IrisActions
  FACADES.set(store, facade)
  return facade
}
