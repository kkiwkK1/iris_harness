/**
 * The open conversation.
 *
 * Two behaviours here are worth more than they look. Autoscroll only follows
 * when the reader was already at the bottom — scrolling back to re-read a scene
 * while a reply streams must not yank them forward. And Alt+←/→ moves through a
 * turn's readings, addressed by turn rather than by message index, which is what
 * `chat.swipe` takes.
 *
 * @module iris-web/app/ChatPane
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { useDisplayedStream, useIris, useIrisActions } from '../client/provider.tsx'
import { buttonEventName } from '../sandbox/button-event.ts'
import { emitToCard } from './card-bus.ts'
import { FRAME_BAND_VARIABLE, frameBandPixels } from './frame-fit.ts'
import { FrameBudgetProvider, type BudgetedFloor } from './FrameBudget.tsx'
import { CompactionNote } from './CompactionNote.tsx'
import { Composer } from './Composer.tsx'
import { RegionBoundary } from './RegionBoundary.tsx'
import { TurnNavigator } from './TurnNavigator.tsx'
import { turnNavigation, type TurnNavigationItem } from './turn-navigation.ts'
import { PlumSpray } from './marks.tsx'
import { Message, type MessageHandlers } from './Message.tsx'
import { PromptPanel } from './PromptPanel.tsx'
import { repairStrayFences } from './stray-fences.ts'
import { groupByTurn, lastReplyId, swipeTarget, withStream } from './project.ts'
import { DEFAULT_WINDOW, grow, readingWindow } from './reading-window.ts'
import { stepReading } from './rail.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import type { ResolvedButton } from './script-buttons.ts'
import { useTreeSync } from './TreeMap.tsx'
import { branchesAt, type BranchLink } from './tree-map.ts'

/** How long a floor jumped to is held in place while the rows above it settle. */
const FLOOR_HOLD_MS = 2500

/**
 * Render the conversation pane.
 * @param props.onOpenSettings - open the settings drawer.
 *
 * Threaded through rather than read from anywhere, and the reason is the same
 * one `StatePanel`'s `drawerOpen` prop gives: **the shell holds the drawer's
 * state**, because above 1200px the drawer is a grid track and only the shell
 * can decide a track. The composer's `/config` command needs to open it, and
 * one prop through this pane is the whole cost — the alternative was a second
 * module-scope bus beside `composer-bus.ts` for a single boolean the shell
 * already owns.
 * @returns the pane, or the empty surface when no chat is open.
 */
export function ChatPane({ onOpenSettings }: { onOpenSettings: () => void }): ReactElement {
  const view = useIris(state => state.view)
  /*
   * The live reply at a bounded paint rate, not `state.stream` itself: a delta
   * per token used to re-render this pane per token. Start, end and abort are
   * published at once (`client/stream-display.ts`), so Stop, the caret and the
   * settled row are never late; only growth of the text waits for a paint.
   */
  const stream = useDisplayedStream()
  const chatId = useIris(state => state.chatId)
  const booting = useIris(state => state.booting)
  const tree = useIris(state => state.tree)
  const floorJump = useIris(state => state.floorJump)
  const actions = useIrisActions()
  // The margin's map and the floor badges both read the lineage; it is kept
  // fresh from here because this pane is mounted whenever a chat is open,
  // whether or not the margin has room to show the map.
  useTreeSync()
  // Subscribed so a language switch re-renders the pane's own words.
  useLanguage()

  const generating = stream !== undefined
  const all = useMemo(() => withStream(view, stream), [view, stream])

  /*
   * How much of the conversation is mounted. A tail, so a chat that grows
   * while the reader watches needs no recalculation — and so the anchor is the
   * end of the conversation, which is where a reader of a live chat already is.
   */
  const [shown, setShown] = useState(DEFAULT_WINDOW)
  const window_ = useMemo(() => readingWindow(all, shown, message => message.turn), [all, shown])
  const messages = window_.visible
  const groups = useMemo(() => groupByTurn(messages), [messages])
  /*
   * From the settled view, not from `all`: the rail's previews are excerpts of
   * each turn, and re-excerpting the whole conversation for every paint of the
   * streaming reply re-rendered the navigator with it. The streaming turn's
   * row keys are the settled ones (`withStream`), so the anchors are the same;
   * its reply preview catches up when the reply settles.
   */
  const navigation = useMemo(() => turnNavigation(view?.messages ?? []), [view])
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null)
  const pendingNavigation = useRef<string | null>(null)

  /*
   * What the frame budget plans over: the mounted rows, in conversation order.
   *
   * Derived here rather than in the provider because this is where the window is
   * known. Planning claims blocks over every mounted message, which is the one
   * part of this that is not free, so it is planned from the **settled view**,
   * whose identity holds still while a reply streams. It used to be derived
   * from the rows with the stream folded in, which change identity on every
   * delta — so every delta re-claimed every floor and handed every interface a
   * new budget context, and the whole window re-rendered per token (review
   * finding `streaming-render-path`).
   *
   * The streaming turn's reply plans as **empty text**: a streaming row builds
   * no frames (`MessageInterfaces`), and the settled text it is replacing — the
   * old reading, during a regenerate — is not on screen. Only the stream's
   * identity (live, turn, role) is read here, never its text, so a delta does
   * not re-plan. The window is the settled view's, so while a new turn streams
   * it can reach one floor further back than the rows on screen; that floor is
   * the oldest, and the budget spends from the newest, so at most it is
   * rationed a share it does not use until the reply settles.
   *
   * Each row's text gets the same settled stray-fence repair the row itself
   * applies (`MessageInterfaces`), so the budget plans over the text the view
   * actually renders — a stray fence that used to hide a bare-HTML region from
   * the claim would otherwise be rationed by a budget that never saw it.
   */
  const live = stream !== undefined
  const streamTurn = stream?.turn
  const streamIsUser = stream?.role === 'user'
  const budgeted = useMemo<BudgetedFloor[]>(
    () => readingWindow(view?.messages ?? [], shown, message => message.turn).visible.map(message => ({
      id: message.id,
      text: live && !streamIsUser && message.role === 'assistant' && message.turn === streamTurn
        ? ''
        : repairStrayFences(message.text),
      isUser: message.role === 'user',
    })),
    [view, shown, live, streamTurn, streamIsUser],
  )

  /*
   * A new chat starts at its own tail. Without this, opening a short
   * conversation after scrolling back through a long one would inherit the
   * widened window — harmless there, but it also means opening the long one
   * again would silently mount everything.
   */
  useEffect(() => {
    setShown(DEFAULT_WINDOW)
    pendingNavigation.current = null
    setActiveAnchor(null)
  }, [chatId])
  const retryId = lastReplyId(messages)

  // `undefined` means "preview the next request"; a number means "the record for
  // that turn". Both go to the same panel, which is why one piece of state
  // carries the distinction rather than two booleans that could disagree.
  const [explaining, setExplaining] = useState<{ turn: number | undefined } | undefined>(undefined)
  // Mutable (`| null`) because the attach callback below writes it: React 19
  // types a ref created with a non-null initial value as read-only.
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  /** The load-more control, so a press can ask whether it was on screen. */
  const more = useRef<HTMLButtonElement>(null)

  const syncActiveAnchor = useCallback(() => {
    const node = scroller.current
    if (node === null) return
    const rows = Array.from(node.querySelectorAll<HTMLElement>('[data-turn-anchor]'))
    const line = node.getBoundingClientRect().top + Math.min(96, node.clientHeight * 0.2)
    let active = rows[0]
    for (const row of rows) {
      if (row.getBoundingClientRect().top > line) break
      active = row
    }
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 64) active = rows.at(-1)
    setActiveAnchor(active?.dataset.turnAnchor ?? null)
  }, [])

  const landOnAnchor = useCallback((key: string): boolean => {
    const node = scroller.current
    const row = Array.from(node?.querySelectorAll<HTMLElement>('[data-turn-anchor]') ?? [])
      .find(element => element.dataset.turnAnchor === key)
    if (node === null || row === undefined) return false
    node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - 24
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
    syncActiveAnchor()
    return true
  }, [syncActiveAnchor])

  const navigateTo = useCallback((item: TurnNavigationItem) => {
    pinned.current = false
    if (landOnAnchor(item.key)) return
    pendingNavigation.current = item.key
    setShown(current => Math.max(current, all.length - item.start))
  }, [all.length, landOnAnchor])

  useLayoutEffect(() => {
    const key = pendingNavigation.current
    if (key !== null && landOnAnchor(key)) pendingNavigation.current = null
  }, [messages, landOnAnchor])

  /*
   * A jump from the tree map or a floor badge: bring one floor into view.
   *
   * The floor may be outside the mounted window, so the window is widened
   * first and the landing waits for the rows to exist — the same two-step the
   * turn navigator uses, addressed by floor rather than by turn. The row gets a
   * short wash so the eye finds it.
   */
  const pendingFloor = useRef<{ floor: number, seq: number } | null>(null)
  /**
   * The floor a jump landed on, held in place for a short while.
   *
   * Measured in the acceptance run: a branch cut at floor 1 of a card
   * conversation landed, and then the greeting's interface frame above it grew
   * by ~2200px as it loaded, carrying the floor off screen. So for a moment
   * after landing, a layout change above re-lands — until the reader scrolls,
   * clicks or types in the pane, which is theirs to move again.
   */
  const heldFloor = useRef<{ floor: number, until: number } | null>(null)
  const placeFloor = useCallback((floor: number): HTMLElement | undefined => {
    const node = scroller.current
    const row = node?.querySelector<HTMLElement>(`[data-floor="${String(floor)}"]`)
    if (node === null || node === undefined || row === null || row === undefined) return undefined
    node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - 24
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
    return row
  }, [])
  const landOnFloor = useCallback((floor: number): boolean => {
    const row = placeFloor(floor)
    if (row === undefined) return false
    row.setAttribute('data-iris-jumped', '')
    setTimeout(() => row.removeAttribute('data-iris-jumped'), 1700)
    heldFloor.current = { floor, until: Date.now() + FLOOR_HOLD_MS }
    syncActiveAnchor()
    return true
  }, [placeFloor, syncActiveAnchor])

  useEffect(() => {
    const node = scroller.current
    const column = node?.querySelector('.iris-column')
    if (node === null || node === undefined || column === null || column === undefined) return
    const hold = (): void => {
      const held = heldFloor.current
      if (held === null) return
      if (Date.now() > held.until) {
        heldFloor.current = null
        return
      }
      placeFloor(held.floor)
    }
    const release = (): void => { heldFloor.current = null }
    const resize = new ResizeObserver(hold)
    resize.observe(column)
    const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    for (const kind of inputs) node.addEventListener(kind, release, { passive: true })
    return () => {
      resize.disconnect()
      for (const kind of inputs) node.removeEventListener(kind, release)
    }
  }, [chatId, view !== undefined, placeFloor])

  useEffect(() => {
    if (floorJump === undefined || floorJump.chatId !== chatId || view === undefined) return
    const index = all.findIndex(message => message.id === floorJump.floor)
    if (index < 0) {
      actions.settleFloorJump(floorJump.seq)
      return
    }
    pinned.current = false
    if (landOnFloor(floorJump.floor)) {
      actions.settleFloorJump(floorJump.seq)
      return
    }
    pendingFloor.current = { floor: floorJump.floor, seq: floorJump.seq }
    setShown(current => Math.max(current, all.length - index))
  }, [floorJump, chatId, view, all, actions, landOnFloor])

  useLayoutEffect(() => {
    const pending = pendingFloor.current
    if (pending === null || !landOnFloor(pending.floor)) return
    pendingFloor.current = null
    actions.settleFloorJump(pending.seq)
  }, [messages, landOnFloor, actions])

  // Card frames can resize after mounting, without a message or scroll event.
  useEffect(() => {
    const node = scroller.current
    const column = node?.querySelector('.iris-column')
    if (node === null || column == null) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncActiveAnchor)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(node)
    resize.observe(column)
    node.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => {
      resize.disconnect()
      node.removeEventListener('scroll', schedule)
      cancelAnimationFrame(frame)
    }
  }, [chatId, view !== undefined, syncActiveAnchor])

  const onScroll = useCallback(() => {
    const node = scroller.current
    if (node === null) return
    // 64px of slack: a reader who is "at the bottom" is rarely exactly there.
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
  }, [])

  useEffect(() => {
    const node = scroller.current
    if (node === null || !pinned.current) return
    node.scrollTop = node.scrollHeight
  }, [messages])

  // Opening a chat starts at the bottom, which is where the conversation is.
  useEffect(() => {
    pinned.current = true
    const node = scroller.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [chatId])

  /*
   * Publish the visible band the viewport-mode message frames fill.
   *
   * A card that reports `data-iris-sizing='viewport'` is sized to this number
   * (`reading.css`), so its screen is only ever as true as this measurement. A
   * window resize reshapes the scroller without any React state changing, and
   * so does a panel opening beside it — nothing that re-renders this component
   * — which is why this is an observer on the box rather than a render-time
   * read: the value must stay true in exactly the moments nothing else is
   * watching.
   *
   * **A ref callback, not a mount effect.** The reading view renders in two
   * shapes — no chat open, then chat open — and React reworks the tree between
   * them: measured, the effect form ran while `scroller.current` was still null
   * and its dependencies never changed again, so the band was never published
   * and the clamp spent its life on the `100vh` fallback. A ref callback is
   * invoked at commit for exactly the element it is attached to, so there is no
   * state in which the box exists unobserved.
   *
   * `frameBandPixels` refuses to hand back zero, so a transient zero-height
   * reading (a tab being laid out) cannot clamp every frame to nothing.
   */
  const observer = useRef<ResizeObserver | undefined>(undefined)
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node
    observer.current?.disconnect()
    if (node === null) return
    const publish = (): void => {
      const band = frameBandPixels(node.clientHeight, window.innerHeight)
      if (band > 0) node.style.setProperty(FRAME_BAND_VARIABLE, `${band}px`)
    }
    publish()
    const next = new ResizeObserver(publish)
    next.observe(node)
    observer.current = next
  }, [])

  const target = swipeTarget(messages)
  useEffect(() => {
    if (target === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      if (step === 0) return
      // Not while the reader is typing. SillyTavern gates its own arrow-key
      // swipe on an empty composer and on focus being outside every input; the
      // second is the one that matters here, because it also covers an open
      // inline editor — changing a reading out from under a half-finished edit
      // would discard it silently.
      const focused = document.activeElement
      if (
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLInputElement ||
        (focused instanceof HTMLElement && focused.isContentEditable)
      ) {
        return
      }
      // Not while generating, for the same reason SillyTavern refuses: the turn
      // being written is about to replace what a swipe would have selected.
      if (generating) return
      // Same clamp the rail's own stepper uses, so the keyboard and the margin
      // cannot disagree about where the set ends.
      const next = stepReading(target.index, target.count, step)
      if (next === undefined) return
      event.preventDefault()
      void actions.swipe(target.turn, next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, generating, target?.turn, target?.count, target?.index])

  /*
   * The composer's callbacks, stable so `memo(Composer)` holds while a reply
   * streams. `onOpenSettings` comes from the shell as an inline arrow, so it
   * is read through a ref rather than depended on.
   */
  const openSettings = useRef(onOpenSettings)
  openSettings.current = onOpenSettings
  const onSend = useCallback((text: string) => void actions.send(text), [actions])
  const onStop = useCallback(() => void actions.abort(), [actions])
  const onPreviewPrompt = useCallback(() => setExplaining({ turn: undefined }), [])
  const onComposerSettings = useCallback(() => openSettings.current(), [])
  const onPressButton = useCallback((button: ResolvedButton) => {
    /*
     * The button id **is** the event name, computed here and computed
     * again by the card, with nothing checking that the two agree. When
     * they do not, the card's handler is simply never called — no error,
     * no warning, a button that does nothing. That is why the name comes
     * from one shared builder over one shared hash rather than being
     * assembled at either end.
     */
    const event = buttonEventName(button.scriptId, button.name)
    if (emitToCard(event)) return

    /*
     * Nothing was listening because no card is running — not the same as a
     * card that ignored it, and only this one is worth saying. A press that
     * vanishes silently is the failure this whole seam exists to avoid.
     */
    actions.addCardReport(
      `button "${button.name}" (${button.scriptName}) was pressed while no card scripts are running`,
    )
  }, [actions])

  const handlers: MessageHandlers = useMemo(
    () => ({
      onSwipe: (turn, index) => void actions.swipe(turn, index),
      onRegenerate: () => void actions.regenerate(),
      onContinue: () => void actions.continueReply(),
      onImpersonate: () => void actions.impersonate(),
      onEdit: (id, text) => void actions.editMessage(id, text),
      onDelete: id => void actions.deleteMessage(id),
      onNotify: text => actions.notify('info', text),
      onExplain: turn => setExplaining({ turn }),
      onBranch: (id, swipeId) => {
        if (chatId !== undefined) void actions.branchChat(chatId, id, swipeId)
      },
      onOpenBranch: (target, floor) => void actions.jumpToFloor(target, floor),
    }),
    [actions, chatId],
  )
  /** The lineage, when it is this conversation's: the badges read it. */
  const lineage = chatId !== undefined && tree?.chats.some(node => node.chatId === chatId) === true ? tree : undefined
  /*
   * The ⑂N badges, one array per floor for as long as the lineage holds.
   * `branchesAt` builds a fresh array on every call, and a fresh prop is a row
   * that `memo(Message)` has to re-render — every row, on every paint of the
   * streaming reply.
   */
  const branchCache = useMemo(
    () => new Map<number, readonly BranchLink[]>(),
    // `lineage` and `chatId` are what the answer is a function of; neither is
    // read in the body, which only makes the empty cache they invalidate.
    [lineage, chatId],
  )
  const branchesFor = (floor: number): readonly BranchLink[] => {
    const cached = branchCache.get(floor)
    if (cached !== undefined) return cached
    const found = chatId === undefined ? [] : branchesAt(lineage, chatId, floor)
    branchCache.set(floor, found)
    return found
  }

  if (chatId === undefined || view === undefined) {
    return (
      <div className="iris-scroll">
        <div className="iris-empty">
          <p className="iris-empty__line">
            {booting ? t('openingLastChat') : t('nothingOpen')}
          </p>
          {booting ? null : (
            <p className="iris-empty__hint">{t('pickCharacterHint')}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      {/*
       * The reading pane and the composer fail separately: a message row that
       * throws while rendering leaves the composer usable, and the other way
       * round (`RegionBoundary`). Without these one bad row unmounted the root.
       */}
      <RegionBoundary region="reading pane">
      <div className={`iris-scroll${navigation.length > 1 ? ' iris-scroll--navigable' : ''}`} ref={attachScroller} onScroll={onScroll}>
        <TurnNavigator key={chatId} items={navigation} activeTurn={activeAnchor} onNavigate={navigateTo} />
        <div className="iris-column">
          {/*
            First in the column, because what it describes is the beginning of
            the conversation — `CompactionNote` says why it is not spliced in at
            the boundary it names.
          */}
          {view.compaction === undefined ? null : <CompactionNote compaction={view.compaction} />}
          {window_.hidden === 0 ? null : (
            <button
              type="button"
              ref={more}
              className="iris-more"
              onClick={() => {
                /*
                 * Compensate the scroll position **only if this button was
                 * visible when it was pressed** — upstream measures the same
                 * thing before adjusting (`script.js:1445`, used at `:1466`).
                 *
                 * What it defends against: content growing above the viewport
                 * pushes everything down, so a reader who is not looking at the
                 * top has the passage they *are* reading yanked away. When the
                 * button is on screen the reader is at the top and expects the
                 * new messages to appear where they are looking; when it is not,
                 * they pressed it by keyboard or from far away and the sane
                 * outcome is that nothing under their eyes moves.
                 *
                 * Written out because copying a defensive line without knowing
                 * what it defends is how it gets deleted in the next refactor.
                 */
                const scroller_ = scroller.current
                const button = more.current
                const wasVisible =
                  scroller_ !== null &&
                  button !== null &&
                  button.getBoundingClientRect().bottom > scroller_.getBoundingClientRect().top
                const before = scroller_?.scrollHeight ?? 0
                const at = scroller_?.scrollTop ?? 0

                setShown(current => grow(current, DEFAULT_WINDOW, all.length))

                if (!wasVisible || scroller_ === null) return
                // After the new rows land, keep the reader's passage where it was.
                requestAnimationFrame(() => {
                  scroller_.scrollTop = at + (scroller_.scrollHeight - before)
                })
              }}
            >
              {t('showEarlier', { n: Math.min(DEFAULT_WINDOW, window_.hidden) })}
              <span className="iris-more__count">
                {t('hiddenAbove', { n: window_.hidden })}
              </span>
            </button>
          )}
          {messages.length === 0 ? (
            <div className="iris-empty">
              <p className="iris-empty__line">{t('pageBlank')}</p>
              <p className="iris-empty__hint">{t('writeFirstLine', { title: view.title })}</p>
            </div>
          ) : (
            /*
             * Keyed on the chat so opening another conversation starts with a
             * clean budget. Without the key, the grants and the reader's
             * per-interface opt-ins would carry over by floor index — and floor
             * 12 of the next chat is a different interface entirely.
             */
            <FrameBudgetProvider key={chatId} floors={budgeted}>
            {groups.map((group, at) => (
              <section className="iris-turn" key={group.turn ?? `loose-${at}`} data-turn-anchor={group.messages[0]?.key}>
                {/*
                  On the boundary, and only where there is one. The number names
                  the turn — the thing swipe and regenerate address — so it marks
                  where turns divide rather than being stamped on whichever rows
                  happen to be the reader's.
                */}
                {at > 0 && group.turn !== undefined ? (
                  <span className="iris-turn__ordinal" aria-hidden="true">
                    {group.turn}
                  </span>
                ) : null}
                {/*
                  回目分隔用一小段枝: the twig that marks a turn boundary. Keyed
                  to the boundary rather than to the turn, so the first turn's
                  top edge — which is the head of the page, not a division —
                  does not get one.
                */}
                {at > 0 ? (
                  <span className="iris-turn__seam">
                    <PlumSpray />
                  </span>
                ) : null}
                {group.messages.map(message => (
                  <Message
                    // `key`, not `id`: `id` is a position, so a delete shifts
                    // every later one and React would carry this row's local
                    // state (an open editor) onto its neighbour. The streaming
                    // row deliberately shares the key its settled row will
                    // have, so a finished reply updates in place.
                    key={message.key}
                    message={message}
                    canRegenerate={message.id === retryId && !generating}
                    handlers={handlers}
                    branches={message.streaming === true ? undefined : branchesFor(message.id)}
                    canBranch={!generating}
                  />
                ))}
              </section>
            ))}
            </FrameBudgetProvider>
          )}
        </div>
      </div>
      </RegionBoundary>
      <RegionBoundary region="composer">
      <Composer
        chatId={chatId}
        generating={generating}
        onSend={onSend}
        onStop={onStop}
        onPreviewPrompt={onPreviewPrompt}
        onOpenSettings={onComposerSettings}
        onPressButton={onPressButton}
      />
      </RegionBoundary>
      <PromptPanel
        open={explaining !== undefined}
        turn={explaining?.turn}
        onClose={() => setExplaining(undefined)}
      />
    </>
  )
}
