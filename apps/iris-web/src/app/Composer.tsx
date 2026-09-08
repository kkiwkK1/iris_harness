/**
 * Where the reader writes their part.
 *
 * **The one place 「梅花」 lets the hand off the brake** (canvas.json: 这一屏唯一
 * 放开手的地方). A branch crosses the top edge in place of a hairline, the paper
 * is dyed 藕粉 downward, the writing surface is a sheet laid on it with a plum
 * blossom sealed into its corner, and the send key is a plum stamp. Everything
 * decorative on this page is here or over the character page; the rest of Iris
 * is 1px rules.
 *
 * It grows with the draft up to a cap, because a reader writing three paragraphs
 * of scene should see them. Under the field, two capsules say what is in force —
 * the prompt and the model — which is the pair of facts a reader checks before
 * pressing send and which previously lived only behind the settings drawer.
 *
 * **Both capsules are buttons**, and for the same reason: a capsule states a
 * fact, and the reader's next thought is about that fact. The prompt capsule
 * opens the breakdown of what would be sent. The model capsule changes the
 * model — **for this conversation only**, which is the scope the capsule is
 * already standing in. A model switched here does not follow the reader into
 * the next scene, and a dot beside the name says when this conversation is not
 * on its connection's model: an override nobody can see is one the reader will
 * eventually be surprised by.
 *
 * @module iris-web/app/Composer
 */

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptDivergence, PromptItemization } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import type { ResolvedButton } from './script-buttons.ts'
import { Slot } from '../slots/Slot.tsx'
import { PlumBlossom, PlumBranch } from './marks.tsx'
import { ScriptButtons } from './ScriptButtons.tsx'
import { registerComposer } from './composer-bus.ts'
import { usageLineGroups, usageScriptShareSentence, usageSummaryRows } from './token-format.ts'
import { modelMenu } from './model-menu.ts'
import { ContextCard, ContextPill } from './ContextMeter.tsx'
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
 * The menu row that returns this conversation to its connection's model.
 *
 * A leading space so it can never collide with a model id: every other row's id
 * *is* a model id, they come from an endpoint rather than from this file, and
 * `onSelect` hands back only an id. A sentinel that a provider could
 * legitimately mint would make one model unselectable and nobody would know
 * which.
 */
const RESTORE_ID = ' restore-connection-default'

/**
 * The ids of the menu's non-model rows.
 *
 * Leading space for the same reason {@link RESTORE_ID} has one: every other row
 * in this menu is identified by a model id minted by an endpoint, and a
 * sentinel a provider could legitimately mint would make one model
 * unselectable — or, for these two, give two rows the same key.
 */
const HEADING_ID = ' heading'
/** The one row that explains the list's state: reading, refused, or absent. */
const NOTE_ID = ' note'

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
   * What the two capsules report. Both may be absent and both are rendered only
   * when they are not: `activePreset` is loaded by the preset panel rather than
   * at boot (`client/store.ts`), so a reader who has never opened that panel has
   * no preset name to show — and 「提示词 · —」 would be a capsule reporting that
   * the interface does not know, which is worse than one fewer capsule.
   */
  const model = useIris(state => state.settings?.model)
  const preset = useIris(state => state.activePreset)
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
  /*
   * What the capacity capsule divides by, and the two facts that make its
   * reading stale.
   *
   * `budget` is on the open chat rather than fetched, precisely so this capsule
   * costs nothing to render (`ChatView.budget` says why). The other two are the
   * **invalidation key**: a reading is an account of one assembly, and an
   * assembly changes when the conversation gains a floor or when its head is
   * folded into a summary. Selected as narrow fields, not as `view`, because
   * this component re-renders on every keystroke and a streaming delta must not
   * come through here.
   */
  const budget = useIris(state => state.view?.budget)
  /*
   * What the host recorded for the newest real turn, so the capsule's gauge has
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
   * What the model capsule needs to be a control rather than a readout: which
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
  const [listRead, setListRead] = useState<ModelListRead | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
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

  const empty = draft.trim() === ''
  const stats = usageLineGroups(usage, lang)

  /*
   * The invalidation key.
   *
   * A reading belongs to one conversation at one length with one compaction
   * record. When any of those moves, the number the capsule is printing is an
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
  // so the capsule stops printing a fullness that is no longer true rather
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
   * The model capsule's menu, decided in `model-menu.ts` and dressed here.
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
  const modelItems: MenuEntry[] = [
    { type: 'label' as const, id: HEADING_ID, text: heading },
    ...menu.models.map(id => ({ id, label: id })),
    ...note === undefined ? [] : [{ id: NOTE_ID, label: note, disabled: true }],
  ]
  /*
   * The undo, pinned below the list so it stays reachable while a long model
   * list scrolls. Offered only when there is something to undo *and* a
   * connection whose model to name: "back to the default" with no default named
   * is a button whose effect the reader has to guess.
   */
  const modelFooter: MenuEntry[] = menu.overridden && menu.connectionModel !== undefined
    ? [{
      id: RESTORE_ID,
      label: t('modelRestoreConnectionDefault', { model: menu.connectionModel }),
    }]
    : []

  /**
   * Open or close the model menu, fetching a missing list on the way open.
   *
   * **The reader should not have to go to the connection panel and press
   * "Test" before the menu can answer.** Pressing the capsule is already the
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
        <div className="iris-composer__write">
          {/*
            The writing surface. The textarea has no border or ground of its own
            any more — this box draws the paper, the corner and the focus ring
            (`:focus-within`, so no JavaScript has to know the field exists) —
            which is what lets the blossom sit *inside* the sheet rather than
            beside it.
          */}
          <div className="iris-composer__sheet">
            <span className="iris-composer__seal">
              {/* The centre dot takes the raised paper it sits on, not white:
                  under 墨 a white dot would be a hole in the mark. */}
              <PlumBlossom size={18} on="var(--iris-bg-raised)" />
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
          </div>
          {generating ? (
            <Button
              variant="outline"
              size="sm"
              className="iris-composer__send iris-composer__send--idle"
              onClick={onStop}
            >
              {t('stop')}
            </Button>
          ) : (
            /*
             * The stamp. Still the primitives' `Button` under the paint, and
             * saturated in both states, as the artboards draw it (user ruling,
             * 2026-09-07, overturning the older "quiet until there is something
             * to send" rule). What the older rule guarded against - a
             * permanently-disabled primary button reading as broken - is met
             * differently now: the seal is `disabled` only while the field is
             * empty and inks up on the first keystroke, and `panels.css` gives
             * the idle state no cast shadow, so it sits *in* the page rather
             * than standing off it. `tools/render-check.tsx` pins the disabled
             * half.
             *
             * `icon` puts the arrow above the word, because the button is a flex
             * *column* here — the component's own `.icon` span is the slot, so
             * the geometry comes from CSS and no markup is duplicated.
             */
            <Button
              variant="primary"
              size="sm"
              className={`iris-composer__send iris-composer__send--${empty ? 'idle' : 'ready'}`}
              icon={<SendArrow />}
              onClick={submit}
              disabled={empty}
            >
              {t('send')}
            </Button>
          )}
        </div>
        {/*
          The completion list for a `/` line.
          *
          * Anchored to the field's own rect through `getAnchorRect` rather than
          * by wrapping it: the textarea sits inside the sheet that draws the
          * paper and the seal, and wrapping it in the menu's anchor slot would
          * put a layout box between the two. `portal` because `__inner` is a
          * scroll container and would clip an in-place list; `side="top"`
          * because the composer is at the bottom of the page.
          *
          * A display and a click target, not a keyboard surface: focus stays in
          * the field so the reader keeps typing, which is what makes Tab the
          * completion key here rather than the arrow keys.
        */}
        {/* Mounted only while it is open, unlike the model menu beside it: that
            one's anchor *is* the capsule and has to be on the page either way,
            while this one's anchor is a placeholder. Keeping it unmounted also
            keeps its layout effect off every keystroke of an ordinary message. */}
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
        <div className="iris-composer__row">
          {/*
            What is in force, as two controls. Each capsule states a fact and
            answers the question that fact raises when pressed: the prompt
            capsule opens the breakdown of what would actually be sent, and the
            model capsule changes the model for this conversation. The per-turn
            record hangs off each message instead.
          */}
          <button
            type="button"
            className="iris-composer__pill iris-composer__pill--action"
            onClick={onPreviewPrompt}
          >
            {preset === undefined ? t('promptButton') : `${t('promptButton')} · ${preset}`}
          </button>
          {model === undefined || model === '' ? null : (
            <Menu
              open={modelOpen}
              portal
              align="start"
              side="top"
              anchor={
                <button
                  type="button"
                  className="iris-composer__pill iris-composer__pill--action"
                  aria-haspopup="menu"
                  aria-expanded={modelOpen}
                  title={t('modelMenuOpen', { model })}
                  onClick={toggleModelMenu}
                >
                  {model}
                  {/*
                    The override marker. A dot rather than a word, because the
                    capsule's job is to be scannable — and `title` carries the
                    sentence for anyone who wonders what the dot means.
                  */}
                  {menu.overridden ? (
                    <span
                      className="iris-composer__pill-dot"
                      title={t('modelOverriddenHere')}
                      aria-label={t('modelOverriddenHere')}
                    />
                  ) : null}
                </button>
              }
              items={modelItems}
              selectedId={model}
              footer={modelFooter}
              onSelect={id => {
                setModelOpen(false)
                // `null` is the protocol's clear: it drops this chat's override
                // so the connection's model shows through again. Anything else
                // is a model id straight from the endpoint's own list.
                void actions.setChatModel(id === RESTORE_ID ? null : id)
              }}
              onClose={() => setModelOpen(false)}
            />
          )}
          {/*
            The third capsule: how full the window is.
            *
            * In this row rather than in the usage line below it, for two
            * reasons the two boxes' own comments give. `__stats` is
            * `display: block` so `text-overflow` can elide it, and a capsule
            * inside it would fight that; and that row disappears whole until a
            * generation has reported usage, while capacity is knowable on a
            * conversation nobody has generated in yet.
            *
            * Before `__hint`, which is `flex: 1` and pushes itself to the right
            * edge — anything after it lands past the hint.
          */}
          {budget === undefined ? null : (
            <ContextPill
              budget={budget}
              itemization={shownReading?.itemization}
              measured={measured}
              open={meterOpen}
              anchor={meterAnchor}
              onToggle={() => setMeterOpen(!meterOpen)}
            />
          )}
          <Slot name="iris.composer.actions" owner={{ chatId, generating }} />
          <span className="iris-composer__hint">
            {t('composerHint')}
          </span>
        </div>
        {/*
          * What the conversation has cost, under the two capsules.
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
          * The card's note is where the split the old `title` used to carry
          * lives now: how much of the bill above the card a card's own script
          * asked for (`usageScriptShareSentence`). The visible groups already
          * count those requests — they were billed to this conversation — so
          * the note is a breakdown of the figures above it, never an addition
          * to them.
          */}
        {stats.length === 0 ? null : (
          <UsagePopover
            className="iris-composer__stats"
            heading={t('usageSummaryTitle')}
            rows={usageSummaryRows(usage, lang)}
            note={usageScriptShareSentence(scriptUsage, lang)}
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
  )
}

/**
 * The stamp's arrow.
 *
 * Not in `marks.tsx`: that module is the 「梅花」 decoration, and this is an icon
 * — the difference is that a reader is meant to read this one.
 * @returns the arrow.
 */
function SendArrow(): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 8h9M8 4.5 11.5 8 8 11.5" />
    </svg>
  )
}
