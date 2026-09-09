/**
 * Where the reader writes their part.
 *
 * **One card, one bar** (user, 2026-09-10, with a reference image: 「按照图片
 * 重新设计对话框并在配色上和本系统保持一致」). The writing surface and the
 * controls are one rounded sheet of raised paper: the draft at the top with all
 * the white space, and along the bottom edge a single row — 「+」 and the preset
 * on the left, the model with its effort, the capacity ring and the send disc on
 * the right. Nothing else is in the card. Everything the reader only *consults*
 * — the keyboard hint and what the conversation has cost — is a line of the
 * faintest type **under** it, outside the paper, which is the difference between
 * a control and a reading said in the layout rather than in a word.
 *
 * **The 「梅花」 decoration is still here and is now a watermark.** The branch
 * across the panel's top edge and the blossom sealed into the card's corner are
 * what canvas.json spends this screen's whole decorative budget on (装饰只在两处
 * … 这一屏唯一放开手的地方), so they stay — quieter, at half contrast and out of
 * the writing lane, because the reference's subject is the emptiness above the
 * bar and a mark that competes with it is a mark in the way. The one saturated
 * thing left is the send disc.
 *
 * The field grows with the draft up to a cap, because a reader writing three
 * paragraphs of scene should see them.
 *
 * **Every control in the bar states a fact and changes it.** That is the rule
 * the two capsules this bar replaces were built on and it is unchanged: a
 * control states what is in force, and pressing it answers the question that
 * fact raises. The preset names the preset and switches it; the model names the
 * model and its effort and changes them **for this conversation only**, which is
 * the scope the bar is already standing in — with a dot beside the name when
 * this conversation is not on its connection's model, because an override
 * nobody can see is one the reader will eventually be surprised by. The ring
 * draws how full the window is and opens the breakdown. 「+」 holds the two acts
 * that are not facts about the next request: the prompt itemization and the
 * slash commands.
 *
 * @module iris-web/app/Composer
 */

import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptDivergence, PromptItemization, ReasoningEffort } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import type { ResolvedButton } from './script-buttons.ts'
import { Slot } from '../slots/Slot.tsx'
import { PlumBlossom, PlumBranch } from './marks.tsx'
import { ScriptButtons } from './ScriptButtons.tsx'
import { registerComposer } from './composer-bus.ts'
import { usageLineGroups, usageSideShareSentences, usageSummaryRows } from './token-format.ts'
import { modelMenu } from './model-menu.ts'
import { effortInForce, effortPatch, effortShown, REASONING_EFFORTS } from './composer-bar.ts'
import { ComposerMenu, ComposerMenuItem, ComposerMenuLabel, ComposerMenuNote } from './ComposerMenu.tsx'
import { ContextCard, ContextRing } from './ContextMeter.tsx'
import { UsagePopover } from './UsagePopover.tsx'
import {
  commandArgumentCompletions,
  commandCompletions,
  commandLabel,
  irisCommands,
  resolveCommand,
  unknownCommandNotice,
  type CommandDescriptor,
  type ModelChoices,
} from './commands.ts'
import { describeError } from '../client/errors.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * The id of the completion menu's heading row.
 *
 * A leading space so it can never collide with a completion: every other row in
 * that menu is identified by a command name or by one of a command's argument
 * values, and `onSelect` hands back only an id. A sentinel a command could
 * legitimately be called would give two rows the same key.
 *
 * The model menu used to need two more of these — a heading and a note — and no
 * longer does: its rows are this file's own markup (`ComposerMenu.tsx`), where a
 * heading is a heading element and a sentence is a paragraph rather than a row
 * with a reserved id.
 */
const HEADING_ID = ' heading'

/**
 * What the menu is doing about a missing model list, for the row that says so.
 *
 * Keyed by the source it belongs to, because the reader can switch connections
 * with a menu's failure still in state: a refusal from one endpoint shown under
 * another endpoint's heading is a sentence blaming the wrong server.
 */
type ModelListRead =
  | { key: string, phase: 'reading' }
  | { key: string, phase: 'failed', reason: string }

/**
 * Render the composer.
 * @param props.chatId - the open chat, for extension contributions.
 * @param props.generating - whether a reply is arriving; Send becomes Stop.
 * @param props.onSend - called with the trimmed draft.
 * @param props.onStop - called to interrupt the reply in flight.
 * @param props.onPreviewPrompt - opens the breakdown of what would be sent next.
 * @param props.onOpenSettings - opens the settings drawer, for `/config`.
 * @returns the composer.
 */
export function Composer({
  chatId,
  generating,
  onSend,
  onStop,
  onPreviewPrompt,
  onOpenSettings,
  onPressButton,
}: {
  chatId: string
  generating: boolean
  onSend: (text: string) => void
  onStop: () => void
  onPreviewPrompt: () => void
  /**
   * Open the settings drawer.
   *
   * A prop because the drawer's open state is the shell's — above 1200px it is
   * a grid track, and only the shell can decide a track. `/config` is a
   * keyboard entry to the masthead's gear, not a second owner of that state.
   */
  onOpenSettings: () => void
  /**
   * Press one of the card-script buttons.
   *
   * A prop rather than something this component resolves, for the reason the
   * seam exists: the event name a press must emit is
   * `${scriptId}_${cyrb53(buttonName)}`, and that hash has to be bit-identical
   * to upstream’s or the card’s own listener is never called — silently. The
   * hash lives in one shared place; this file does not get a copy.
   */
  onPressButton: (button: ResolvedButton) => void
}): ReactElement {
  /*
   * Read here rather than threaded down. The script list is store state, and
   * this component already re-renders on every keystroke of the draft — one
   * more prop through that path is one more chance to hold a stale copy.
   */
  const scripts = useIris(state => state.scripts)
  /*
   * What the bar's two worded controls report.
   *
   * `model` may be absent (settings that never loaded), and the model control is
   * rendered only when it is not: a chevron over an empty name is a control that
   * cannot say what it would change.
   *
   * `effort` is the other half of that control's label, and is absent far more
   * often than it is set — `composer-bar.ts` says why the absent case prints no
   * word rather than 「auto」.
   *
   * `preset` and `presets` are read together because the control needs both: the
   * name to print, and the library to offer. Neither is loaded at boot
   * (`client/store.ts`: the preset panel asks, so a host with no library never
   * refuses at startup), which is why the effect below asks on mount — a bar
   * that said 「未启用预设」 about a host with a preset in force would be a
   * confident false statement, and it would be the *usual* one.
   */
  const model = useIris(state => state.settings?.model)
  const effort = useIris(state => state.settings?.reasoningEffort)
  const preset = useIris(state => state.activePreset)
  const presets = useIris(state => state.presets)
  /*
   * What the conversation has cost so far — every generation it ever paid for,
   * summed by the host (`ChatView.usage`), swipes included. Read here because
   * this is where the reader is when the question comes up: the number is
   * consulted before pressing send, not while reading back.
   *
   * Selected as the field rather than the whole view, so a delta arriving on a
   * streaming message does not re-render the composer through this line.
   */
  const usage = useIris(state => state.view?.usage)
  /*
   * How much of that figure a card's own script asked for.
   *
   * **Inside `usage`, and stated separately only on hover.** The visible line
   * is 「本对话累计计费」 and a card's request is billed to this conversation, so
   * excluding it would make the line disagree with the bill — that is the dsh
   * reading of this row and the reason the split is not a second visible
   * figure. What a reader does need, when the total is larger than the replies
   * they can count, is *why*, and the hover is where that belongs: the row is
   * one ellipsised line, and a fourth group in it is the group that gets cut.
   */
  const scriptUsage = useIris(state => state.view?.scriptUsage)
  /**
   * And how much of it this host's own compaction asked for.
   *
   * The same standing as the line above, on the same hover, for the same
   * reason: `#summarize` is billed to this conversation, so the visible figure
   * counts it, and "why is this bigger than the replies I can see" has a second
   * answer that is not the card's fault. Selected separately rather than read
   * off one `side` object because the two are separately absent — a
   * conversation can have compacted without ever running a card script.
   */
  const compactionUsage = useIris(state => state.view?.compactionUsage)
  /*
   * What the capacity ring divides by, and the two facts that make its
   * reading stale.
   *
   * `budget` is on the open chat rather than fetched, precisely so this mark
   * costs nothing to render (`ChatView.budget` says why). The other two are the
   * **invalidation key**: a reading is an account of one assembly, and an
   * assembly changes when the conversation gains a floor or when its head is
   * folded into a summary. Selected as narrow fields, not as `view`, because
   * this component re-renders on every keystroke and a streaming delta must not
   * come through here.
   */
  const budget = useIris(state => state.view?.budget)
  /*
   * What the host recorded for the newest real turn, so the ring's arc has
   * a measured number without a round trip (`ChatView.measured` says why it can
   * be read for free). A narrow selector for the same reason as every other one
   * here — this component re-renders on every keystroke.
   */
  const measured = useIris(state => state.view?.measured)
  /*
   * Which card this conversation belongs to — read for `/new`, which starts
   * another conversation with the same character. The field rather than the
   * view, for the reason every other selector here is narrow: this component
   * re-renders on every keystroke.
   */
  const characterId = useIris(state => state.view?.characterId)
  const floors = useIris(state => state.view?.messages.length ?? 0)
  const compactedAt = useIris(state => state.view?.compaction?.at)
  /*
   * What the model control needs to be a control rather than a readout: which
   * of the settings this conversation overrides, and the list the active
   * connection last reported. Selected narrowly (four fields, not the whole
   * store) because this component re-renders on every keystroke of the draft.
   */
  const overrides = useIris(state => state.settingsOverrides)
  const connections = useIris(state => state.connections)
  const activeConnectionId = useIris(state => state.activeConnectionId)
  /*
   * The host's own startup connection — the source the menu falls back to.
   *
   * Read here rather than left to the connection panel because of the reported
   * bug: with the route configured as `IRIS_*` variables and no profile ever
   * saved, `activeConnectionId` is undefined and the menu used to conclude
   * "no connection is active" about a host that was generating replies at the
   * time. The row was already on the wire (`connection.list`'s `host`); nothing
   * under the composer was reading it.
   */
  const hostConnection = useIris(state => state.hostConnection)
  const actions = useIrisActions()
  const [modelOpen, setModelOpen] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [listRead, setListRead] = useState<ModelListRead | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  /*
   * The three triggers, for the menus that hang off them: `ComposerMenu` places
   * itself from its trigger's own rect and hands focus back to it on the way
   * out, so each one needs a handle. Refs rather than a lookup, because a
   * portalled list cannot find its trigger in the tree above it.
   */
  const plusAnchor = useRef<HTMLButtonElement | null>(null)
  const presetAnchor = useRef<HTMLButtonElement | null>(null)
  const modelAnchor = useRef<HTMLButtonElement | null>(null)
  const [meterOpen, setMeterOpen] = useState(false)
  const [reading, setReading] = useState<{
    key: string
    itemization?: PromptItemization
    /**
     * Where the last request diverged from the one before it.
     *
     * On the same reading and keyed the same way, because the same three things
     * invalidate it: a new turn writes a new trace, so a comparison held across
     * one would describe a request that is no longer the newest. Absent is a
     * first-class answer — fewer than two recorded requests, or the record
     * switched off — and is not the reading having failed.
     */
    divergence?: PromptDivergence
    state: 'loading' | 'ready' | { error: string }
  } | undefined>(undefined)
  const meterAnchor = useRef<HTMLButtonElement | null>(null)
  /** The reading key a fetch is in flight for, or the last one that succeeded. */
  const fetching = useRef<string | undefined>(undefined)
  const [commandOpen, setCommandOpen] = useState(false)
  /*
   * The prefix for the model menu's two heading ids, so each group of rows is
   * labelled *by* its own visible heading. Generated rather than written down
   * because two composers on one page — the dev harness mounts one — would
   * otherwise both claim the same id, and `aria-labelledby` resolves to the
   * first match in the document.
   */
  const menuId = useId()
  // Subscribed so a language switch re-renders the composer's words.
  const { lang } = useLanguage()

  // Grow to fit. Measured in a layout effect rather than tracked as state: the
  // height is a function of the text, and holding it in state means a render
  // where the box and its contents disagree.
  useLayoutEffect(() => {
    const node = field.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [draft])

  // Focus follows the chat: opening a conversation puts the cursor where the
  // reader is going to type next.
  useEffect(() => {
    field.current?.focus()
  }, [chatId])

  /*
   * Ask for the preset library once, so the bar's left control can be true.
   *
   * The store loads presets from the preset panel rather than at boot, and the
   * reason is in `loadPresets` itself: a host with no library refuses
   * `preset.list`, and a refusal at startup would raise a notice about a feature
   * that host never had. That reason survives this call — `loadPresets`
   * swallows its own refusal and records the absence as `presets: undefined`, so
   * nothing is announced — and what it costs is one round trip per session
   * against what it buys, which is a control that names the preset in force
   * instead of a control that says 「未启用预设」 about every host until somebody
   * opens the settings drawer.
   *
   * Guarded on `presets === undefined` so the panel and the bar do not both
   * pay, and dependent on nothing else: this is a once-per-session ask, not a
   * subscription.
   */
  useEffect(() => {
    if (presets !== undefined) return
    void actions.loadPresets()
  }, [actions, presets])

  const empty = draft.trim() === ''
  const stats = usageLineGroups(usage, lang)
  /** The word beside the model, when a reader chose one. */
  const shownEffort = effortShown(effort)

  /*
   * The invalidation key.
   *
   * A reading belongs to one conversation at one length with one compaction
   * record. When any of those moves, the number the ring is drawing is an
   * account of a request that would no longer be assembled — so it is dropped
   * rather than kept with a caveat. Held as a string because that makes the
   * comparison one `!==` and the effect below have one dependency.
   */
  const readingKey = `${chatId}:${String(floors)}:${String(compactedAt ?? 0)}`

  /*
   * Fetched when the card opens, and only then. An itemization is a full
   * world-info scan and a macro pass, so a reading taken per render — or per
   * keystroke, which is what this component does — would be unaffordable. A
   * reading already held for this exact key is reused, so closing and
   * reopening the card costs nothing.
   *
   * **The in-flight key is a ref, not the `reading` state, and that is a
   * correction rather than a preference.** The first version guarded on
   * `reading` and had `reading` in its dependencies, so writing the `loading`
   * state re-ran the effect, its cleanup fired, and the fetch that was still in
   * flight had its own result discarded — the card stayed on 「正在算……」
   * forever. Nothing renders differently at first paint either way, which is
   * why it needed reading rather than looking.
   *
   * A failed read clears the ref, so reopening the card retries; a successful
   * one leaves it set, so reopening does not pay again.
   */
  useEffect(() => {
    if (!meterOpen || fetching.current === readingKey) return
    fetching.current = readingKey
    setReading({ key: readingKey, state: 'loading' })
    // Both readings in one round trip's worth of waiting, because both are
    // invalidated by the same key and the card shows them together. The
    // divergence is **not** allowed to decide the card's state: it is two file
    // reads and the itemization is the card, so a store that is switched off or
    // a comparison that refuses must leave the breakdown standing.
    void Promise.all([actions.itemize(), actions.divergence()]).then(([itemized, diverged]) => {
      // The conversation may have moved while this was in flight, in which case
      // the answer describes an assembly that is no longer the next one.
      if (fetching.current !== readingKey) return
      if (!itemized.ok) fetching.current = undefined
      setReading(itemized.ok
        ? {
            key: readingKey,
            itemization: itemized.itemization,
            ...diverged.ok && diverged.divergence !== undefined ? { divergence: diverged.divergence } : {},
            state: 'ready',
          }
        : { key: readingKey, state: { error: `${itemized.error.code}: ${itemized.error.message}` } })
    })
  }, [actions, meterOpen, readingKey])

  // A conversation that moved under a closed card drops the stale reading too,
  // so the ring stops drawing a fullness that is no longer true rather
  // than waiting to be pressed again.
  useEffect(() => {
    setReading(current => (current === undefined || current.key === readingKey ? current : undefined))
    setMeterOpen(false)
  }, [readingKey])

  const shownReading = reading?.key === readingKey ? reading : undefined

  /*
   * What the command table reads at **call** time rather than at build time.
   *
   * The table is memoised on `actions` so that it is built once rather than on
   * every keystroke — which means anything else a command needs would be
   * captured from the render that built it. Four of the new commands need facts
   * that move: which card this conversation belongs to, whether the host has
   * reported a context window, the endpoint's model list (which arrives from a
   * probe the reader fires *after* the table exists), and the shell's drawer
   * opener (a fresh arrow function on every shell render).
   *
   * A ref reassigned every render, read through thunks, so each command sees
   * the current values. Putting them in the memo's dependencies instead would
   * rebuild the table whenever any of them moved and — for `menu`, which is a
   * fresh object every render — on every keystroke, which is the cost the memo
   * exists to avoid.
   */
  const live = useRef<{
    characterId: string | undefined
    hasBudget: boolean
    choices: ModelChoices
    openSettings: () => void
  }>({
    characterId: undefined,
    hasBudget: false,
    choices: { current: '', models: [], overridden: false, listed: false },
    openSettings: () => {},
  })

  /*
   * Iris's own commands.
   *
   * Built here because `run` needs the store's actions and the table is the
   * only thing that closes over them; `commands.ts` stays a plain module with
   * the rules in it (the name grammar, the upstream fall-through, the
   * completion filter, `/chat-model`'s keyword and its refusal policy) so
   * `node --test` can load it without a DOM.
   *
   * Memoised on `actions`, which is identity-stable
   * (`client/provider.tsx` — `useIrisActions` returns a stable object for
   * exactly this reason), so the table is built once rather than on every
   * keystroke of the draft.
   */
  const commands: CommandDescriptor[] = useMemo(() => irisCommands({
    newChat: async () => {
      const id = live.current.characterId
      if (id === undefined) {
        actions.notify('error', t('commandNewNoCharacter'))
        return
      }
      await actions.createChat(id)
      actions.notify('info', t('commandNewDone'))
    },
    /*
     * **The chat id is a parameter, not a capture.** `run` is given the chat
     * that was open when the line was dispatched, and passing it through is
     * what keeps this table memoisable: closing over the `chatId` prop instead
     * would rename whichever conversation was open when the table was *built*,
     * and the memo's `[actions]` dependency is exactly what makes that
     * divergence possible.
     */
    rename: async (id, title) => { await actions.renameChat(id, title) },
    // `exportChat` says so itself (`chatExported`, with the filename), so
    // nothing is notified here — two notices for one action would be one of
    // them repeating the other with less information.
    exportChat: async (id) => { await actions.exportChat(id) },
    setModel: async (model) => { await actions.setChatModel(model) },
    modelChoices: () => live.current.choices,
    showCapacity: () => {
      if (!live.current.hasBudget) return false
      setMeterOpen(true)
      return true
    },
    openSettings: () => { live.current.openSettings() },
    compact: async () => {
      const result = await actions.compactChat()
      if (!result.ok) {
        actions.notify('error', t('commandCompactFailed', {
          reason: `${result.error.code}: ${result.error.message}`,
        }))
        return
      }
      if (result.compacted === null) {
        actions.notify('info', t('commandCompactNothing'))
        return
      }
      actions.notify('info', t('commandCompactDone', {
        floors: result.compacted.floors,
        before: result.compacted.spanTokens,
        after: result.compacted.summaryTokens,
      }))
    },
  }), [actions])

  /*
   * The model control's menu, decided in `model-menu.ts` and dressed here.
   *
   * The heading names the connection the list came from, because the list is
   * the *endpoint's* answer and a menu that showed model names with no
   * provenance would invite the reader to pick one that a different connection
   * offers. The host's own startup connection is named as such, with the
   * variable its key is read from, because that is the one route the reader
   * cannot edit from this app and has to go to a shell to change.
   *
   * There is always at least one row — the model in force — and there is always
   * a sentence when the endpoint's own list is missing: reading, refused, or
   * absent. A menu that opened onto nothing would read as broken, and a menu
   * that opened onto model names alone would not say which of them is running.
   *
   * Computed **above** the completion rows rather than beside the rest of its
   * own dressing, because `/chat-model`'s argument completions read it: this
   * order is what makes the list the menu would show and the list the command
   * would offer the same list in the same render, rather than one render apart.
   */
  const menu = modelMenu({
    model: model ?? '',
    overrides,
    connections,
    activeId: activeConnectionId,
    host: hostConnection,
  })

  /*
   * Hand this render's moving facts to the command table.
   *
   * `menu.empty === undefined` is the honest answer to "has the endpoint said
   * anything" — `menu.models` always carries the model in force, so its length
   * cannot answer that, and `/chat-model`'s refusal turns on the difference.
   */
  live.current = {
    characterId,
    hasBudget: budget !== undefined,
    choices: {
      current: menu.current,
      models: menu.models,
      overridden: menu.overridden,
      listed: menu.empty === undefined,
    },
    openSettings: onOpenSettings,
  }

  /*
   * The completion rows, and when the menu belongs.
   *
   * Open state is held separately from "there are completions": a reader who
   * has dismissed the menu with Escape while `/comp` is still in the field
   * should not have it spring back on the next keystroke of the same word.
   *
   * Two kinds of row, and they are computed apart because picking one means
   * different things: a **name** row replaces the line with `/name `, an
   * **argument** row completes the value the reader is already writing. Only
   * one can apply — `commandArgumentCompletions` answers nothing until the name
   * is settled, which is exactly when `commandCompletions` stops answering.
   */
  const completions = commandCompletions(draft, commands)
  const argument = commandArgumentCompletions(draft, commands)
  const showCommands = commandOpen && (completions.length > 0 || argument !== undefined)

  /** The heading's words: which connection this list belongs to. */
  const heading = menu.source === 'profile' && menu.connectionName !== undefined
    ? t('modelMenuFromConnection', { connection: menu.connectionName })
    : menu.source === 'host'
      ? menu.hostKeyEnv === undefined
        ? t('modelMenuFromHost')
        : t('modelMenuFromHostEnv', { keyEnv: menu.hostKeyEnv })
      : t('modelMenuHeading')
  /*
   * The one row about the list itself.
   *
   * The read's own phase outranks the plain emptiness — a refusal is the newer
   * and more specific fact, and it is the host's own named reason rather than a
   * sentence written here, because a probe that failed `unauthorized` and one
   * that failed `network` send the reader to different places.
   *
   * Two conditions gate it, and both are about not showing a stale sentence.
   * The read must belong to **this** source, or a refusal would still be on
   * screen under the next connection's heading. And the list must still be
   * missing: a probe that failed here and a list that arrived some other way —
   * the connection panel's own Test — would otherwise leave "could not read the
   * model list" sitting above the list it says is not there.
   */
  const read = menu.empty === undefined || listRead?.key !== menu.sourceKey ? undefined : listRead
  const note = read?.phase === 'reading'
    ? t('modelMenuReading')
    : read?.phase === 'failed'
      ? t('modelMenuReadFailed', { reason: read.reason })
      : menu.empty === 'no-connection'
        ? t('modelMenuNoConnection')
        : menu.empty === 'no-list' ? t('modelMenuNoList') : undefined
  /**
   * Choose a model, or put this conversation back on its connection's.
   *
   * `null` is the protocol's clear: it drops this chat's override so the
   * connection's model shows through again. Anything else is a model id straight
   * from the endpoint's own list.
   * @param id - the model, or null for the restore row.
   */
  const chooseModel = (id: string | null): void => {
    setModelOpen(false)
    void actions.setChatModel(id)
  }

  /**
   * Choose how hard a reasoning model thinks.
   *
   * **The same write the settings drawer makes, through the same action**, and
   * that is the whole of the layer rule: `patchSettings` scopes itself to the
   * open conversation when there is one and to the global defaults when there is
   * not (`client/store.ts`), which is the rule the model row beside it follows —
   * a choice made in the composer's bar is a choice about the scene the reader
   * is in. The composer only ever renders with a chat open, so in practice every
   * effort chosen here lands on this conversation's own layer, beside the model
   * override the dot reports.
   *
   * `auto` writes `null` rather than the word, because the two are one request
   * to a provider and a stored `'auto'` would be an override with no effect —
   * see `composer-bar.ts`.
   * @param chosen - the row the reader pressed.
   */
  const chooseEffort = (chosen: ReasoningEffort): void => {
    setModelOpen(false)
    void actions.patchSettings({ reasoningEffort: effortPatch(chosen) })
  }

  /**
   * Open or close the model menu, fetching a missing list on the way open.
   *
   * **The reader should not have to go to the connection panel and press
   * "Test" before the menu can answer.** Pressing the control is already the
   * question, so the press is what asks the endpoint — once, and only when
   * `model-menu.ts` says a list is missing and stale enough to be worth a round
   * trip. The ask carries no key: the host resolves the credential from what it
   * already holds (the profile's, or its own startup one, origin-checked on its
   * side), which is what makes a bare probe safe to fire from a menu.
   *
   * A success is **re-read rather than kept**: the host files the list — on the
   * profile, or in its own in-memory record for the host row — and
   * `loadConnections` brings back both, stamped. Holding the returned array in
   * component state instead would be a second copy of a fact the store already
   * carries, and the stamp is what suppresses the next probe.
   */
  const toggleModelMenu = (): void => {
    const opening = !modelOpen
    setModelOpen(opening)
    if (!opening) return
    const ask = menu.probe
    const key = menu.sourceKey
    if (ask === undefined || key === undefined) return
    setListRead({ key, phase: 'reading' })
    void (async () => {
      try {
        const verdict = await actions.testConnection(ask)
        if (verdict.ok) {
          setListRead(undefined)
          await actions.loadConnections()
          return
        }
        // The host's own words, code included. `ok: false` is an answer, not a
        // throw — the form-shaped surfaces render it, and so does this one.
        setListRead({
          key,
          phase: 'failed',
          reason: verdict.error === undefined
            ? String(verdict.latencyMs)
            : `${verdict.error.code}: ${verdict.error.message}`,
        })
      } catch (error: unknown) {
        // A refusal that never became a probe — a fake client, a malformed ask.
        // Shown rather than swallowed: the fake refuses `connection.test` by
        // design, and a menu that went blank there would look like the bug this
        // whole change is about.
        setListRead({ key, phase: 'failed', reason: describeError(error, lang) })
      }
    })()
  }

  /**
   * Open or close the preset menu, re-reading the library on the way open.
   *
   * The model menu's rule, for the same reason: pressing the control is the
   * question, so the press is what asks. A preset saved or deleted in the
   * settings drawer since this session started would otherwise be missing from
   * a list the reader is choosing out of — and `loadPresets` is a directory
   * listing that swallows its own refusal, so asking again costs a round trip
   * and can report nothing.
   */
  const togglePresetMenu = (): void => {
    const opening = !presetOpen
    setPresetOpen(opening)
    if (opening) void actions.loadPresets()
  }

  /**
   * Switch the active preset.
   *
   * **Global, unlike the model beside it** — `preset.select` is the host's own
   * active preset and applies that preset's scalars host-side, which is why the
   * menu says so in a sentence rather than leaving the reader to infer the
   * scope from the control next to it. The store's action re-reads the settings
   * in force afterwards, so the effort word in the bar follows a switch that
   * changed it.
   * @param name - the preset's library name.
   */
  const choosePreset = (name: string): void => {
    setPresetOpen(false)
    void actions.selectPreset(name)
  }

  /**
   * Open the command list, exactly as typing `/` does.
   *
   * The draft becomes `/`, which is the state the completion menu reads — not a
   * second code path that shows the same list. A reader who chose this from
   * 「+」 is now in the same place as a reader who typed the key, including
   * being able to keep typing to filter.
   */
  const openCommands = (): void => {
    setDraft('/')
    setCommandOpen(true)
    field.current?.focus()
  }

  /*
   * What the composer does with a line that starts with `/`.
   *
   * **One function, two callers** — the send key and the card bus below — so a
   * card that writes into the field and clicks send gets the same treatment a
   * reader typing gets, which is what SillyTavern does with its own composer.
   * The alternative, gating commands to the keyboard, would make the same text
   * mean two different things depending on who typed it.
   *
   * The three outcomes are `commands.ts`'s resolution, and the third one is the
   * rule this whole feature is subordinate to: a name Iris does not own goes to
   * the host verbatim, where upstream's own parser decides. It is never
   * rewritten here and never sent to the model as prose.
   * @param text - the trimmed draft.
   * @returns a refusal to report, or undefined when the line was acted on.
   */
  const dispatch = (text: string): string | undefined => {
    if (text === '') return 'the composer is empty, so there was nothing to send'
    const resolution = resolveCommand(text, commands)

    if (resolution.kind === 'message') {
      if (generating) return 'a generation is already running'
      setDraft('')
      onSend(text)
      return undefined
    }

    setCommandOpen(false)
    if (resolution.kind === 'iris') {
      if (resolution.command.idleOnly === true && generating) {
        actions.notify('error', t('commandBusy', { name: resolution.command.name }))
        return 'a generation is already running'
      }
      setDraft('')
      void Promise.resolve(resolution.command.run({
        args: resolution.args,
        chatId,
        generating,
        notify: (kind, message) => { actions.notify(kind, message) },
      }))
      return undefined
    }

    // Not Iris's. The host's parser answers — and its refusal names the
    // command, which is the half a sentence written here could not know.
    setDraft('')
    void actions.runSlash(resolution.line).catch((error: unknown) => {
      actions.notify(
        'error',
        unknownCommandNotice(resolution.line.replace(/^\/?/, '').split(/[\s|]/)[0] ?? '', describeError(error, lang)),
      )
    })
    return undefined
  }

  const submit = (): void => {
    dispatch(draft.trim())
  }

  /*
   * A card's way in, for the send path upstream gives it.
   *
   * Cards write `#send_textarea.value` and click `#send_but` — 44 measured that
   * in nine cards, eight of them from interface code — so Iris serves it rather
   * than refusing. What Iris adds is that the panel says it happened.
   *
   * **The send reads the field's DOM value, not `draft`.** In this build the
   * card's write already went through `setDraft`, so the two agree; the DOM is
   * the conservative source anyway, because it is what the *card* would have
   * seen and it is one indirection closer to what actually gets sent. It also
   * keeps this correct if anything ever writes the element directly, where
   * React's value tracker leaves `draft` stale.
   *
   * Re-registered whenever `generating` changes, so a card clicking send during
   * a generation is refused with the **current** answer rather than the one from
   * the render where it registered.
   */
  useEffect(() => registerComposer({
    setDraft: text => {
      setDraft(text)
    },
    // Through `dispatch`, so a card writing `/compact` into the field and
    // clicking send gets the command — the same thing SillyTavern's own
    // composer does with a card's write, and the reason the resolution lives
    // in one function rather than in the key handler.
    send: () => dispatch((field.current?.value ?? draft).trim()),
  }), [dispatch, draft])

  return (
    <div className="iris-composer">
      {/* The branch across the top edge, in place of the hairline. Outside
          `__inner` because `__inner` is the scroll container that reserves the
          scrollbar lane, and a scroll container clips what crosses its edge —
          `panels.css` says so where the two rules live. */}
      <PlumBranch />
      {/*
        The capacity card, above the composer.
        *
        * A sibling of the branch rather than a child of `__inner`, and for the
        * same reason the branch is: `__inner` is the scroll container that
        * reserves the scrollbar lane, and a scroll container clips its
        * absolutely-positioned children. This box paints and positions and has
        * no `overflow`, so a card anchored to its top edge can cross it — which
        * is why there is no portal here.
      */}
      {meterOpen && budget !== undefined && (
        <ContextCard
          budget={budget}
          itemization={shownReading?.itemization}
          state={shownReading?.state ?? 'loading'}
          usage={usage}
          divergence={shownReading?.divergence}
          // The card closes on the way through, because the panel it opens is a
          // modal: leaving the card standing behind it would put two dismissal
          // surfaces on screen, and the outside-pointerdown listener the card
          // installs would close it on the first press inside the modal.
          onOpenPanel={() => {
            setMeterOpen(false)
            onPreviewPrompt()
          }}
          anchor={meterAnchor}
          onClose={() => setMeterOpen(false)}
        />
      )}
      <div className="iris-composer__inner">
        {/*
          * Above the field, which is where upstream puts it — it prepends its bar
          * to the send form. Inside `__inner` rather than beside it so the bar
          * lines up with the field's own left edge instead of the panel's.
          */}
        <ScriptButtons scripts={scripts} onPress={onPressButton} />
        {/*
          The card: the writing surface and the bar on one sheet of paper.

          The textarea has no border or ground of its own — this box draws the
          paper, the corner and the focus ring (`:focus-within`, so no
          JavaScript has to know the field exists), which is also what lets the
          blossom sit *inside* the sheet. The bar is the card's own bottom edge
          rather than a strip under it, so a press on any control happens on the
          same piece of paper the draft is on.
        */}
        <div className="iris-composer__card">
          {/*
            The seal, in the corner and out of the writing lane.

            `aria-hidden` through the mark itself, and `pointer-events: none` in
            the stylesheet: it is a watermark on the paper now, which is what
            makes the space above the bar read as empty. The centre dot takes
            the raised paper it sits on, not white — under 墨 a white dot would
            be a hole in the mark.
          */}
          <span className="iris-composer__seal">
            <PlumBlossom size={14} on="var(--iris-bg-raised)" />
          </span>
          <textarea
            ref={field}
            className="iris-composer__field"
            rows={1}
            value={draft}
            placeholder={generating ? t('irisWriting') : t('writeYourPart')}
            aria-label={t('yourMessage')}
            onChange={(event) => {
              const next = event.target.value
              setDraft(next)
              // The menu opens on the `/` that starts the line and closes
              // when the line stops being one. It does not reopen on every
              // keystroke of a name the reader has already dismissed — see
              // `commandOpen`.
              if (!next.startsWith('/')) setCommandOpen(false)
              else if (draft === '') setCommandOpen(true)
            }}
            onKeyDown={(event) => {
              // The IME guard stays exactly where it was, and now guards
              // three keys instead of one: a Chinese reader composing a word
              // presses Enter and Escape to commit and cancel *the
              // composition*, and neither press is for this component.
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Escape' && showCommands) {
                event.preventDefault()
                setCommandOpen(false)
                return
              }
              /*
               * Tab completes the single remaining candidate — of whichever
               * menu is up. Only when it is unambiguous: completing to the
               * first of several would put a command, or a model, the reader
               * did not choose in their field. Ambiguous, Tab is left alone
               * and moves focus, as it did before there were commands.
               */
              if (event.key === 'Tab' && showCommands) {
                if (argument !== undefined) {
                  if (argument.values.length !== 1) return
                  event.preventDefault()
                  setDraft(`/${argument.command.name} ${argument.values[0] as string}`)
                  setCommandOpen(false)
                  return
                }
                if (completions.length !== 1) return
                event.preventDefault()
                const only = completions[0] as CommandDescriptor
                setDraft(`/${only.name} `)
                /*
                 * A command that takes an argument keeps the menu open, so
                 * the values come up in place of the name just chosen. This
                 * is the one place the menu reopens without a `/` being
                 * typed, and it is not the case `commandOpen` guards against:
                 * the reader just chose this command with this keystroke.
                 */
                setCommandOpen(only.argumentCompletions !== undefined)
                return
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          {/*
            The bar along the card's bottom edge.

            Left, the two acts that are not facts about the next request, plus
            whatever an extension contributed; right, what is in force, and the
            one saturated control on the page. The two halves are held apart by
            a flexing gap rather than by `space-between`, so the left group
            stays a group as it grows and the right one keeps its order.
          */}
          <div className="iris-composer__bar">
            <button
              ref={plusAnchor}
              type="button"
              className="iris-composer__disc iris-composer__disc--quiet"
              aria-label={t('composerMore')}
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              onClick={() => setPlusOpen(!plusOpen)}
            >
              <PlusMark />
            </button>
            {plusOpen && (
              <ComposerMenu
                anchor={plusAnchor}
                label={t('composerMore')}
                onClose={() => setPlusOpen(false)}
              >
                {/* The prompt breakdown: the old 「提示词 · 预设名」 capsule's
                    press, with the preset name it used to carry now standing on
                    its own control two places to the right. */}
                <ComposerMenuItem
                  onSelect={() => {
                    setPlusOpen(false)
                    onPreviewPrompt()
                  }}
                >
                  {t('promptButton')}
                </ComposerMenuItem>
                {/* Exactly what typing `/` does, because it *is* that: the
                    draft becomes `/` and the completion list opens over the
                    field. A second way in for a reader who has never been told
                    the interface has commands. */}
                <ComposerMenuItem
                  onSelect={() => {
                    setPlusOpen(false)
                    openCommands()
                  }}
                >
                  {t('composerSlash')}
                </ComposerMenuItem>
              </ComposerMenu>
            )}
            <button
              ref={presetAnchor}
              type="button"
              className="iris-composer__choice"
              aria-haspopup="menu"
              aria-expanded={presetOpen}
              title={t('presetMenuOpen', { preset: preset ?? t('presetNoneActive') })}
              onClick={togglePresetMenu}
            >
              <span className="iris-composer__choice-name">{preset ?? t('presetNoneActive')}</span>
              <Chevron />
            </button>
            {presetOpen && (
              <ComposerMenu
                anchor={presetAnchor}
                label={t('presetMenuHead')}
                onClose={() => setPresetOpen(false)}
              >
                <ComposerMenuLabel>{t('presetMenuHead')}</ComposerMenuLabel>
                {(presets ?? []).map(row => (
                  <ComposerMenuItem
                    key={row.name}
                    checked={row.name === preset}
                    onSelect={() => choosePreset(row.name)}
                  >
                    {row.name}
                  </ComposerMenuItem>
                ))}
                {/*
                  Two different nothings, like the model menu's: a host with no
                  preset library at all (`preset.list` refused, which
                  `loadPresets` records as `undefined`) and a library nobody has
                  saved a preset into. The next step differs, so one sentence
                  for both would send the reader to the wrong place.
                */}
                {presets === undefined
                  ? <ComposerMenuNote>{t('presetLibraryAbsent')}</ComposerMenuNote>
                  : presets.length === 0
                    ? <ComposerMenuNote>{t('presetLibraryEmpty')}</ComposerMenuNote>
                    : null}
                {/*
                  The scope, stated because the control beside this one has the
                  other one. A model chosen in this bar moves this conversation
                  and nothing else; a preset is the host's own active preset
                  (`preset.select`) and moves every conversation, so a reader
                  who learned the scope from the model control would guess wrong
                  here.
                */}
                <ComposerMenuNote>{t('presetGlobalNote')}</ComposerMenuNote>
              </ComposerMenu>
            )}
            {/*
              Whatever an extension put in the composer's row.

              Still in the bar rather than folded into 「+」, and wrapped rather
              than rendered bare: a contribution is a component, not a labelled
              action, so it cannot become a menu row without asking every
              extension to describe itself twice — and mounting the same
              component in two places would give one control two states. The
              wrapper is what lets the divider be structural: `:empty` is the
              only honest reading of 「the slot contributed nothing」, and it
              needs an element to be empty (`panels.css`).
            */}
            <span className="iris-composer__slot">
              <Slot name="iris.composer.actions" owner={{ chatId, generating }} />
            </span>
            <span className="iris-composer__gap" />
            {model === undefined || model === '' ? null : (
              <>
                <button
                  ref={modelAnchor}
                  type="button"
                  className="iris-composer__model"
                  aria-haspopup="menu"
                  aria-expanded={modelOpen}
                  title={t('modelMenuOpen', { model })}
                  onClick={toggleModelMenu}
                >
                  <span className="iris-composer__model-name">{model}</span>
                  {/*
                    The effort, in the same control and one tier quieter,
                    because it is the same decision at a lower resolution: which
                    model answers, and how hard it thinks. Absent when nobody
                    chose (`composer-bar.ts`).
                  */}
                  {shownEffort === undefined
                    ? null
                    : <span className="iris-composer__model-effort">{shownEffort}</span>}
                  {/*
                    The override marker. A dot rather than a word, because the
                    control is meant to be scannable — and `title` carries the
                    sentence for anyone who wonders what the dot means.
                  */}
                  {menu.overridden ? (
                    <span
                      className="iris-composer__model-dot"
                      title={t('modelOverriddenHere')}
                      aria-label={t('modelOverriddenHere')}
                    />
                  ) : null}
                  <Chevron />
                </button>
                {modelOpen && (
                  <ComposerMenu
                    anchor={modelAnchor}
                    label={heading}
                    align="end"
                    onClose={() => setModelOpen(false)}
                  >
                    <div role="group" aria-labelledby={`${menuId}-model`}>
                      <ComposerMenuLabel id={`${menuId}-model`}>{heading}</ComposerMenuLabel>
                      {menu.models.map(id => (
                        <ComposerMenuItem key={id} checked={id === model} onSelect={() => chooseModel(id)}>
                          {id}
                        </ComposerMenuItem>
                      ))}
                      {note === undefined ? null : <ComposerMenuNote>{note}</ComposerMenuNote>}
                    </div>
                    {/*
                      The undo, under the list it undoes. Offered only when
                      there is something to undo *and* a connection whose model
                      to name: "back to the default" with no default named is a
                      button whose effect the reader has to guess. Outside the
                      radio group above, because it is not a seventh model — it
                      clears this conversation's layer so whichever model the
                      connection carries shows through.
                    */}
                    {menu.overridden && menu.connectionModel !== undefined ? (
                      <ComposerMenuItem onSelect={() => chooseModel(null)}>
                        {t('modelRestoreConnectionDefault', { model: menu.connectionModel })}
                      </ComposerMenuItem>
                    ) : null}
                    {/*
                      The effort ladder, in this menu because it is part of the
                      same question and because the control already prints it.
                      A group of `menuitemradio` rows: six mutually exclusive
                      answers, exactly one in force — which is what
                      `ComposerMenu.tsx` exists to be able to say.
                    */}
                    <div role="group" aria-labelledby={`${menuId}-effort`}>
                      <ComposerMenuLabel id={`${menuId}-effort`}>{t('reasoningEffort')}</ComposerMenuLabel>
                      {REASONING_EFFORTS.map(row => (
                        <ComposerMenuItem
                          key={row}
                          checked={row === effortInForce(effort)}
                          onSelect={() => chooseEffort(row)}
                        >
                          {row}
                        </ComposerMenuItem>
                      ))}
                    </div>
                  </ComposerMenu>
                )}
              </>
            )}
            {/*
              How full the window is, as a mark rather than a line of figures —
              `ContextMeter.tsx` says why that is a correction and what it costs.
              Before the send disc, which is the last thing in the bar because it
              is the last thing a reader does.
            */}
            {budget === undefined ? null : (
              <ContextRing
                budget={budget}
                itemization={shownReading?.itemization}
                measured={measured}
                open={meterOpen}
                anchor={meterAnchor}
                busy={generating}
                onToggle={() => setMeterOpen(!meterOpen)}
              />
            )}
            {generating ? (
              /*
               * Stop, in the send disc's own place and shape. A second control
               * beside Send would be a second thing to aim at in a bar where
               * the reader has already learned where the one on the right is;
               * the square is the change of verb.
               */
              <Button
                variant="primary"
                size="sm"
                className="iris-composer__disc iris-composer__send iris-composer__send--stop"
                icon={<StopMark />}
                aria-label={t('stop')}
                onClick={onStop}
              />
            ) : (
              /*
               * The seal, now a disc. Still the primitives' `Button` under the
               * paint — `tools/render-check.tsx` pins that Send is `disabled`
               * while the field is empty, and a hand-rolled element would have
               * silently dropped both that behaviour and its check.
               *
               * **Quieter while there is nothing to send**, which overturns the
               * user's 2026-09-07 ruling that the seal stays saturated in both
               * states: the reference image draws the disc desaturated on an
               * empty draft (user, 2026-09-10: 空草稿时降饱和), and the concern
               * the older rule answered — a permanently-disabled primary
               * control reading as broken — is answered by the disc inking up
               * on the first keystroke, which is a change the reader causes and
               * therefore sees.
               *
               * The word is the `aria-label` rather than the content, because
               * the disc is 32px: 「发送」 inside it would either overflow it or
               * shrink to a size nobody can read. The arrow points up, as the
               * reference draws it.
               */
              <Button
                variant="primary"
                size="sm"
                className={`iris-composer__disc iris-composer__send iris-composer__send--${empty ? 'idle' : 'ready'}`}
                icon={<SendArrow />}
                aria-label={t('send')}
                onClick={submit}
                disabled={empty}
              />
            )}
          </div>
        </div>
        {/*
          The completion list for a `/` line.
          *
          * Anchored to the field's own rect through `getAnchorRect` rather than
          * by wrapping it: the textarea sits inside the card that draws the
          * paper, the seal and the bar, and wrapping it in the menu's anchor
          * slot would put a layout box between the two. `portal` because
          * `__inner` is a scroll container and would clip an in-place list;
          * `side="top"` because the composer is at the bottom of the page.
          *
          * A display and a click target, not a keyboard surface: focus stays in
          * the field so the reader keeps typing, which is what makes Tab the
          * completion key here rather than the arrow keys.
          *
          * **The one menu still using the primitive**, and deliberately: a
          * typeahead over a list the reader filters by typing is what it is
          * good at, and its rows are actions rather than a set exactly one
          * member of which is in force — which is the whole of why the bar's
          * three menus are `ComposerMenu.tsx` instead.
        */}
        {/* Mounted only while it is open, like the bar's three menus and for the
            same two reasons: no document listeners while it is closed, and no
            layout effect on every keystroke of an ordinary message. */}
        {showCommands && (
        <Menu
          open
          portal
          align="start"
          side="top"
          anchor={<span className="iris-composer__command-anchor" aria-hidden="true" />}
          getAnchorRect={() => field.current?.getBoundingClientRect() ?? null}
          /*
           * Names, or one command's values — never both. A value list gets the
           * heading naming its command, for the reason the model menu has one:
           * a bare column of model ids does not say whose they are, and here
           * the reader has typed a name that is already off the top of the box.
           */
          items={argument === undefined
            ? completions.map(row => ({
              id: row.name,
              label: t('commandRow', { command: commandLabel(row), summary: row.summary() }),
            }))
            : [
              {
                type: 'label' as const,
                id: HEADING_ID,
                text: t('commandArgHeading', { command: commandLabel(argument.command) }),
              },
              ...argument.values.map(value => ({ id: value, label: value })),
            ]}
          onSelect={(id) => {
            if (argument !== undefined) {
              setDraft(`/${argument.command.name} ${id}`)
              setCommandOpen(false)
            } else {
              setDraft(`/${id} `)
              // Same rule Tab follows: a command with an argument keeps the
              // menu, which then shows that command's values.
              setCommandOpen(completions.find(row => row.name === id)?.argumentCompletions !== undefined)
            }
            field.current?.focus()
          }}
          onClose={() => setCommandOpen(false)}
        />
        )}
        {/*
          Under the card: the two readings, on one line of the faintest type.

          Neither is a control and neither is about the next request — one says
          what the keyboard does, the other what this conversation has already
          cost — so they sit outside the paper, which is the layout saying
          「consult these」 without a word spent on saying it. The hint takes the
          left, the cost the right, and on a narrow window the hint is the one
          that goes (`panels.css`): a keyboard legend is worth nothing on a
          touch screen, and the figures are worth the same everywhere.
        */}
        <div className="iris-composer__under">
          <span className="iris-composer__hint">
            {t('composerHint')}
          </span>
          {/*
          * What the conversation has cost.
          *
          * **No row at all when there is nothing to report**, rather than an
          * empty one: `usage` is absent until a generation reports any, so a
          * conversation that has not been generated in yet would otherwise
          * reserve a line of blank height under the field for its whole life,
          * and the composer would jump the first time a reply arrived.
          *
          * Groups separated by `|`, items within a group by `·`, and a group
          * with no data disappears whole (`usageLineGroups`) — the harness's
          * stats strip, whose grouping is the part worth copying: it is what
          * lets a provider that reports no caching simply not have a cache
          * group, instead of having one that says nothing.
          *
          * The line carries the same rows as a hover card (`UsagePopover`),
          * built from the very rows the line flattens (`usageSummaryRows`), so
          * a reader on touch or a keyboard — or one whose line just elided —
          * gets the whole reading as a table, which is what the old native
          * `title` repeated itself for and could not deliver to anyone.
          *
          * The card's notes are where the split the old `title` used to carry
          * lives now: how much of the bill above the card a card's own script
          * asked for, and how much this host's own compaction did
          * (`usageSideShareSentences`). The visible groups already count both
          * — every one of those requests was billed to this conversation — so
          * the notes are a breakdown of the figures above them, never an
          * addition to them. Each appears only when the host reported that
          * share, so most conversations show one or none.
          */}
          {stats.length === 0 ? null : (
            <UsagePopover
              className="iris-composer__stats"
              heading={t('usageSummaryTitle')}
              rows={usageSummaryRows(usage, lang)}
              notes={usageSideShareSentences(scriptUsage, compactionUsage, lang)}
            >
              {stats.map((group, at) => (
                <Fragment key={group}>
                  {at === 0 ? null : (
                    <span className="iris-composer__stats-sep" aria-hidden="true">|</span>
                  )}
                  <span>{group}</span>
                </Fragment>
              ))}
            </UsagePopover>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The bar's four icons.
 *
 * Not in `marks.tsx`: that module is the 「梅花」 decoration, and these are icons
 * — the difference is that a reader is meant to read these. One stroke weight
 * and one cap style across all four, drawn in the same 16-unit box, because
 * four marks in one 40px bar are read as a set and a set with two weights in it
 * reads as a rendering fault.
 * @returns the mark.
 */
function SendArrow(): ReactElement {
  return (
    <Mark>
      {/* Up, as the reference draws it: the disc sends the draft *out* of the
          card rather than forward through a list. */}
      <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
    </Mark>
  )
}

/** @returns the stop mark: a square, the one shape that is not a direction. */
function StopMark(): ReactElement {
  return (
    <Mark>
      <rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </Mark>
  )
}

/** @returns the 「+」 mark, which opens the two acts that are not settings. */
function PlusMark(): ReactElement {
  return (
    <Mark>
      <path d="M8 3.5v9M3.5 8h9" />
    </Mark>
  )
}

/**
 * @returns the chevron every control that opens a list carries, so 「this one
 * opens something」 is one shape wherever it appears.
 */
function Chevron(): ReactElement {
  return (
    <svg
      className="iris-composer__chevron"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6.5 8 10.5 12 6.5" />
    </svg>
  )
}

/**
 * The frame the three disc marks share.
 * @param props.children - the paths.
 * @returns the sized, hidden, current-colour svg.
 */
function Mark({ children }: { children: ReactElement }): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}
