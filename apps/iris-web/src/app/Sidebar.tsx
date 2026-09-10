/**
 * Conversations and the character library.
 *
 * Two lists behind one pair of tabs, because those are the only two things a
 * reader navigates between: what they are reading and who they could read with.
 * Everything else an extension might want to put here goes through
 * `iris.sidebar.panels` rather than being added to the tab strip.
 *
 * Branches render **under** the conversation they left, indented — the shape
 * the list already carries (`ChatSummary.parentChatId`) and the one a reader
 * expects: a branch is a continuation of something, not a sibling of it. A
 * branch whose parent is not in the list is a top-level row; a wrong-looking
 * guess at the parent would be worse than a flat list.
 *
 * **Neither the open tab nor the chosen character is local state any more.**
 * Both live in the shell (`App.tsx`), because under 「梅花」 the library tab
 * changes the *main area* too: a row opens that character's page rather than
 * starting a conversation with it on the spot. That is the artboards' ruling
 * (`Library.dc.html`), and it also answers a real cost of the old behaviour — a
 * click that created a chat immediately left no way to look at a card first.
 *
 * **Two forms, both mounted.** The panel is either the 272px column or the
 * 44px rail (`Rail.dc.html`), and the rail is not a different component: both
 * subtrees are always in the tree and `shell.css` cross-fades them. Rendering
 * one and unmounting the other would have cost the two things the artboards ask
 * for and one they do not — the outgoing form cannot fade if it is already
 * gone, and the list's scroll position would reset on every collapse. The
 * hidden form is `visibility: hidden`, which takes it out of the accessibility
 * tree and out of the tab order, so "mounted" is not "reachable".
 *
 * @module iris-web/app/Sidebar
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import type { CharacterSummary, ChatSummary } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Slot } from '../slots/Slot.tsx'
import { Portrait } from './Portrait.tsx'
import { ApertureMark } from './marks.tsx'
import {
  AddIcon, ChevronToEdgeIcon, ConversationIcon, GripIcon, LibraryIcon, MoreIcon, SearchIcon,
} from './icons.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { chatMeta, since, toBase64 } from './format.ts'
import { matchesLibraryQuery } from './library-search.ts'
import { dropIndex, makeWay, moveItem } from './reorder.ts'
import { loadChatSort, saveChatSort, type ChatSort } from './sidebar-state.ts'
import { CARD_FILE_ACCEPT } from './card-files.ts'
import type { Language } from './i18n/strings.ts'
import type { ChatSearchHit } from '@iris/protocol'

/** Which list the sidebar is showing. */
export type SidebarTab = 'chats' | 'characters'

/** The orders a character list can be read in. */
type CharacterSort = 'name' | 'updated' | 'favorite'

/** One non-destructive row action, alongside the delete every row carries. */
interface RowAction {
  id: string
  label: string
  danger?: boolean
}

/**
 * How long a press has to last before it becomes a drag.
 *
 * The artboards' number (`DragReorder.dc.html`: 按住 150ms). It is the whole
 * reason the *row* can start a drag and not only its handle: without a delay,
 * a press that was going to be a click would start lifting the row under the
 * finger, and the list would feel like it was fighting the reader. 150ms is
 * also long enough that a flick-scroll on a touch screen resolves as a scroll
 * — the pointer has moved past {@link DRAG_SLOP} by then and the press is
 * abandoned.
 */
const PRESS_MS = 150

/**
 * How far a pointer may travel during the press before the press is abandoned.
 *
 * Six pixels: enough to survive the tremor of a real finger held still, small
 * enough that a deliberate scroll never turns into a drag.
 */
const DRAG_SLOP = 6

/**
 * How far outside the list the pointer has to go for the drag to be cancelled.
 *
 * The artboards give cancellation two triggers — Escape, and dragging out of
 * the list — and this is the second one's tolerance. Generous, because the
 * lifted row is 1.02 times its own size and tilted: its own edges leave the
 * list before the pointer does, and cancelling the moment a corner pokes out
 * would make the gesture feel brittle at the panel's edge.
 */
const DRAG_ESCAPE_PX = 48

/** A drag in flight. */
interface Drag {
  /** The root chat being carried. */
  chatId: string
  /** Its index among the root rows, before the move. */
  from: number
  /** Where it would land, as an index in the finished order. */
  to: number
  /** How far it has been carried, in pixels. */
  offset: number
  /** One row's pitch — its height plus the gap — for the make-way shift. */
  step: number
  /**
   * Every row's **resting** centre, measured once when the row went up.
   *
   * Measured once, and that is a correction rather than a shortcut. Re-reading
   * the rows on every move looks more honest and is not: a neighbour making way
   * carries a `translateY`, and `getBoundingClientRect` reports the transformed
   * box — so every row the drag had already passed measured one pitch away from
   * where it rests, and the drop index was being computed against positions the
   * drag itself had moved. What {@link dropIndex} needs is the resting list, and
   * the resting list is only knowable before anything has been shifted.
   */
  centres: readonly number[]
  /** Where the pointer went down, so travel is a delta rather than a re-anchor. */
  startY: number
  /** The list's scroll offset then; the rows move under the pointer if it changes. */
  startScroll: number
}

/**
 * Render the sidebar.
 * @param props.collapsed - whether the panel is showing as the 44px rail. On a
 *   narrow window this is also what hides the sliding drawer, which is the same
 *   question asked at a width where there is no room for a rail.
 * @param props.onCollapsed - collapse or expand the panel.
 * @param props.tab - which list is showing; held by the shell, because the main
 *   area follows it.
 * @param props.onTab - switch lists.
 * @param props.face - the character whose page is open, if any.
 * @param props.onFace - open a character's page.
 * @returns the sidebar.
 */
export function Sidebar({
  collapsed,
  onCollapsed,
  tab,
  onTab,
  face,
  onFace,
}: {
  collapsed: boolean
  onCollapsed: (collapsed: boolean) => void
  tab: SidebarTab
  onTab: (tab: SidebarTab) => void
  face: string | undefined
  onFace: (characterId: string) => void
}): ReactElement {
  /*
   * Kept under the name the tablist has always written, because
   * `sidebar-tabs.test.ts` pins each `data-tab="…"` against the `setTab('…')`
   * beside it — two literals for one identity, and that test is the only thing
   * that notices when they drift. Renaming the call to `onTab` in the JSX would
   * have silenced it rather than satisfied it.
   */
  const setTab = onTab
  const chats = useIris(state => state.chats)
  const ordered = useIris(state => state.chatsOrdered)
  const characters = useIris(state => state.characters)
  const chatId = useIris(state => state.chatId)
  const actions = useIrisActions()
  const picker = useRef<HTMLInputElement>(null)
  // Chats import under the character whose menu row opened the picker, so the
  // hidden input has to remember who it is picking for until the change fires.
  const chatPicker = useRef<HTMLInputElement>(null)
  const importFor = useRef<string>('')
  // Subscribed so a language switch re-renders the list's words, not just the
  // moment's rows; `lang` also drives the relative-time units in each row.
  const { lang } = useLanguage()

  // The content filter. `hits` is what the last completed search answered;
  // undefined means no search is in force and the plain list shows. A stale
  // reply is dropped by sequence number, never by trusting arrival order.
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ChatSearchHit[] | undefined>(undefined)
  const searchSeq = useRef(0)
  const searchBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setHits(undefined)
      return
    }
    const seq = searchSeq.current + 1
    searchSeq.current = seq
    const timer = setTimeout(() => {
      void actions.searchChats(trimmed).then(found => {
        if (searchSeq.current === seq) setHits(found)
      })
    }, 250)
    return () => { clearTimeout(timer) }
  }, [query, actions])

  // Which order the conversation list reads in, on this device. `manual` is the
  // default and costs nothing until a row has been dragged: with no arranged
  // sequence the host's own order *is* newest-first.
  const [chatSort, setChatSort] = useState<ChatSort>(loadChatSort)
  const chooseChatSort = (sort: ChatSort): void => {
    setChatSort(sort)
    saveChatSort(sort)
  }

  // The library's filter, sort and inline editors. All client-side state: the
  // whole list is already in the store, so a keystroke re-renders it at once —
  // a round trip per filter would be latency in front of a list this small.
  const [libraryQuery, setLibraryQuery] = useState('')
  const [sortBy, setSortBy] = useState<CharacterSort>('name')
  // At most one row edits at a time; `undefined` means none does.
  const [renaming, setRenaming] = useState<{ id: string, name: string } | undefined>(undefined)
  const [tagging, setTagging] = useState<{ id: string, tags: string } | undefined>(undefined)

  /** Chats grouped under the parent they were branched from, in list order. */
  const childrenOf = (parentChatId: string): ChatSummary[] =>
    chats.filter(row => row.parentChatId === parentChatId)
  const roots = chats.filter(row =>
    row.parentChatId === undefined || !chats.some(other => other.chatId === row.parentChatId))
  /*
   * The rows in the order they are about to be drawn.
   *
   * `manual` is the host's own answer, untouched — the sequence someone
   * arranged, with anything the sequence has never heard of on top by recency
   * (`chat-order.ts`, host side). `recent` re-sorts here, in the browser, and
   * deliberately does **not** tell the host: switching to newest-first is a way
   * of looking at the list, not a decision to throw the arrangement away, and
   * a reader who switches back has to find it exactly as they left it.
   */
  const rootRows = chatSort === 'recent'
    ? [...roots].sort((left, right) => right.updatedAt - left.updatedAt)
    : roots

  /*
   * One box over names, tags and the description's opening, which is what the
   * artboards' 「搜索角色或标签」 promises and what replaced the tag `<select>`.
   * The rule itself lives in `library-search.ts` — behaviour a `node --test`
   * file can import and check, which a filter inlined in this `.tsx` could only
   * ever have had pinned against its own source text.
   */
  const visibleCharacters = characters
    .filter(character => matchesLibraryQuery(character, libraryQuery))
    .sort((left, right) => {
      if (sortBy === 'updated') {
        return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      }
      if (sortBy === 'favorite' && (left.favorite === true) !== (right.favorite === true)) {
        return left.favorite === true ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })

  // ------------------------------------------------------------------- drag

  const listRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | undefined>(undefined)
  /*
   * The press that has not become a drag yet, and the live drag, both in refs.
   *
   * Refs rather than state because the pointer listeners are installed once and
   * read these on every move: state read inside a listener installed in an
   * effect is the state from the render that installed it, which is how a drag
   * comes to jump back to where it started halfway through.
   */
  const press = useRef<{ chatId: string, from: number, startY: number, timer: number } | undefined>(undefined)
  const live = useRef<Drag | undefined>(undefined)
  /*
   * The one click a finished drag has to eat.
   *
   * The row is a `<button>`, so the pointer-up that sets a conversation down
   * also fires a click on it — and that click would open the conversation the
   * reader had just finished moving, which is the single most annoying thing a
   * reorderable list can do. Scoped to the row that was carried and stamped
   * with a time, so a drag that ends with no click at all (the pointer
   * released off the panel, an Escape) cannot leave a trap for a genuine click
   * a minute later.
   */
  const swallow = useRef<{ chatId: string, at: number } | undefined>(undefined)

  /** Whether this row's click is the one a just-finished drag has to eat. */
  const swallowClick = (rowId: string): boolean => {
    const pending = swallow.current
    if (pending === undefined || pending.chatId !== rowId) return false
    swallow.current = undefined
    return Date.now() - pending.at < 1000
  }

  /** Forget a press that never became a drag. */
  const clearPress = useCallback((): void => {
    const pending = press.current
    if (pending !== undefined) window.clearTimeout(pending.timer)
    press.current = undefined
  }, [])

  /** Put every carried row back where it was, writing nothing. */
  const cancelDrag = useCallback((): void => {
    clearPress()
    const carried = live.current
    live.current = undefined
    setDrag(undefined)
    // A cancelled drag still ends in a click on the row, and that click is not
    // a request to open anything either.
    if (carried !== undefined) swallow.current = { chatId: carried.chatId, at: Date.now() }
  }, [clearPress])

  /**
   * Every root row's resting vertical centre, and one row's pitch.
   *
   * Measured, not computed: `reorder.ts` says why a constant row height is a
   * lie waiting to happen. The pitch comes from the gap between the first two
   * centres when there are two, and from one row's own height when there is
   * only one — a single row cannot be reordered anyway, so that branch only has
   * to not divide by zero.
   */
  const measureRows = useCallback((): { centres: number[], step: number } => {
    const list = listRef.current
    if (list === null) return { centres: [], step: 0 }
    const boxes = [...list.querySelectorAll<HTMLElement>('[data-drag-index]')]
      .map(element => element.getBoundingClientRect())
    const centres = boxes.map(box => box.top + box.height / 2)
    const first = centres[0]
    const second = centres[1]
    const step = first !== undefined && second !== undefined
      ? second - first
      : (boxes[0]?.height ?? 0)
    return { centres, step }
  }, [])

  /** Write the order the drag settled on, and remember that it is manual now. */
  const commitDrag = (settled: Drag): void => {
    const rootIds = rootRows.map(row => row.chatId)
    const nextRoots = moveItem(rootIds, settled.from, settled.to)
    if (nextRoots.every((id, at) => id === rootIds[at])) return
    /*
     * The host is sent the **whole** visible order, branches included, not just
     * the roots that were dragged.
     *
     * A branch's place is not the reader's to choose — it renders under the
     * conversation it left — but it is still a chat id, and an id the order
     * file has never heard of is treated as newer than the file and floats to
     * the top of the list. Sending only the roots would therefore have
     * detached every branch from its parent the moment anything was dragged.
     */
    const flat = nextRoots.flatMap(id => [id, ...childrenOf(id).map(row => row.chatId)])
    chooseChatSort('manual')
    void actions.reorderChats(flat)
  }

  /*
   * The committer, behind a ref the listeners read.
   *
   * `commitDrag` closes over the row order, so it is a different function on
   * every render; used as an effect dependency directly it would tear down and
   * reinstall four window listeners on every pointer move of a drag. The ref is
   * rewritten each render and the effect below installs once — which is also
   * the shape that guarantees the commit sees the order the *last* render drew,
   * not the one the drag started against.
   */
  const commitRef = useRef(commitDrag)
  commitRef.current = commitDrag

  // One set of window listeners for the whole list. On the window rather than
  // the row, because a pointer that leaves the panel still has to be able to
  // finish or cancel the gesture; each one returns immediately while no press
  // and no drag is live, which is why they can stay installed.
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const pending = press.current
      if (pending !== undefined) {
        // Still deciding what this press is. Movement past the slop means the
        // reader is scrolling or dragging the page, not lifting a row.
        if (Math.abs(event.clientY - pending.startY) > DRAG_SLOP) clearPress()
        return
      }
      const current = live.current
      if (current === undefined) return
      event.preventDefault()
      const list = listRef.current
      if (list !== null) {
        const box = list.getBoundingClientRect()
        const out = event.clientX < box.left - DRAG_ESCAPE_PX
          || event.clientX > box.right + DRAG_ESCAPE_PX
          || event.clientY < box.top - DRAG_ESCAPE_PX
          || event.clientY > box.bottom + DRAG_ESCAPE_PX
        if (out) {
          cancelDrag()
          return
        }
      }
      const resting = current.centres[current.from]
      if (resting === undefined) return
      /*
       * Travel is a delta from where the pointer went down, and the drop index
       * is read against the centres measured then — not against the rows as
       * they stand now. `Drag.centres` says why re-measuring here was wrong.
       *
       * The scroll drift is the one thing that can still move a resting row
       * under the pointer: a wheel over the panel mid-drag scrolls the list, so
       * every centre falls by exactly that much, and adding it to the pointer
       * is the same comparison with one subtraction moved.
       */
      const drift = (listRef.current?.scrollTop ?? current.startScroll) - current.startScroll
      const offset = event.clientY - current.startY
      const next = {
        ...current,
        offset,
        to: dropIndex(current.centres, current.from, resting + offset + drift),
      }
      live.current = next
      setDrag(next)
    }

    const onUp = (): void => {
      clearPress()
      const settled = live.current
      live.current = undefined
      setDrag(undefined)
      if (settled === undefined) return
      swallow.current = { chatId: settled.chatId, at: Date.now() }
      commitRef.current(settled)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (press.current === undefined && live.current === undefined) return
      event.preventDefault()
      cancelDrag()
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', cancelDrag)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', cancelDrag)
      window.removeEventListener('keydown', onKey)
    }
  }, [cancelDrag, clearPress])

  /** Begin the 150ms press that a root row's pointer-down opens. */
  const beginPress = (chatId: string, from: number) => (event: ReactPointerEvent<HTMLElement>): void => {
    // Primary button only, and never on the overflow trigger: a right-click is
    // a context menu and the middle button is a scroll.
    if (event.button !== 0) return
    clearPress()
    const startY = event.clientY
    press.current = {
      chatId,
      from,
      startY,
      timer: window.setTimeout(() => {
        press.current = undefined
        const { centres, step } = measureRows()
        // Nothing to reorder against, so nothing is lifted: a one-row list
        // cannot be rearranged, and a measurement that came back with no pitch
        // would put every make-way shift at zero and the drop index at 0.
        if (centres.length < 2 || step === 0) return
        const lifted: Drag = {
          chatId,
          from,
          to: from,
          offset: 0,
          step,
          centres,
          startY,
          startScroll: listRef.current?.scrollTop ?? 0,
        }
        live.current = lifted
        setDrag(lifted)
      }, PRESS_MS),
    }
  }

  /** Move one root row by a keyboard step, for a reader with no pointer. */
  const nudgeRow = (from: number, step: -1 | 1): void => {
    const to = from + step
    if (to < 0 || to >= rootRows.length) return
    // Nothing measured: a keyboard move has no geometry at all, and the
    // committer reads only `from` and `to`. The rest is filled in rather than
    // made optional, so a `Drag` always means the same thing.
    commitRef.current({
      chatId: rootRows[from]?.chatId ?? '',
      from,
      to,
      offset: 0,
      step: 0,
      centres: [],
      startY: 0,
      startScroll: 0,
    })
  }

  // ------------------------------------------------------------------ rows

  const renderChatRows = (rows: readonly ChatSummary[], depth: number): ReactElement[] =>
    rows.flatMap((row, index) => [
      <ChatRow
        key={row.chatId}
        title={row.title}
        meta={chatMeta(row.updatedAt, row.messageCount, Date.now(), lang)}
        current={row.chatId === chatId}
        depth={depth}
        branched={depth > 0}
        // Only a root row is dragged. A branch renders under the conversation
        // it left, so its position is derived rather than chosen — a handle on
        // it would offer a move the list would immediately undo.
        drag={depth > 0 ? undefined : {
          index,
          state: drag,
          onPress: beginPress(row.chatId, index),
          onNudge: nudgeRow,
        }}
        onOpen={() => {
          if (swallowClick(row.chatId)) return
          void actions.openChat(row.chatId)
        }}
        menu={{
          items: [
            ...(row.parentChatId === undefined ? [] : [{ id: 'parent', label: t('openParentChat') }]),
            { id: 'export', label: t('exportChat') },
            { id: 'delete', label: t('deleteConversation'), danger: true },
          ],
          onSelect: id => {
            if (id === 'export') void actions.exportChat(row.chatId)
            else if (id === 'parent' && row.parentChatId !== undefined) {
              void actions.openChat(row.parentChatId)
            } else if (id === 'delete') void actions.deleteChat(row.chatId)
          },
        }}
      />,
      ...renderChatRows(childrenOf(row.chatId), depth + 1),
    ])

  /** Bring the panel back and land on one list, which is what a rail icon does. */
  const openOn = (next: SidebarTab, focusSearch = false): void => {
    setTab(next)
    onCollapsed(false)
    if (focusSearch) {
      // After the panel has been told to open: the box is `visibility: hidden`
      // until then, and a hidden element cannot take focus.
      window.setTimeout(() => searchBox.current?.focus(), 0)
    }
  }

  return (
    <nav
      className={collapsed ? 'iris-sidebar iris-sidebar--rail' : 'iris-sidebar'}
      aria-label={t('sidebarAria')}
    >
      {/*
        The two pickers sit at the panel's own level rather than in its foot,
        because both forms open them: the expanded 「导入卡片」 button and the
        rail's `+`. Inside the foot they would have been inside the subtree the
        rail hides.
      */}
      <input
        ref={picker}
        type="file"
        accept={CARD_FILE_ACCEPT}
        multiple
        hidden
        onChange={async event => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          for (const file of files) await actions.importCard(file.name, await toBase64(file))
        }}
      />
      {/* Owned by the character whose menu opened it; `importFor` says who. */}
      <input
        ref={chatPicker}
        type="file"
        accept=".jsonl"
        multiple
        hidden
        onChange={async event => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          const characterId = importFor.current
          importFor.current = ''
          if (characterId === '' || files.length === 0) return
          await actions.importChats(
            characterId,
            await Promise.all(files.map(async file => ({ filename: file.name, base64: await toBase64(file) }))),
          )
        }}
      />

      <div className="iris-sidebar__full" id="iris-sidebar-body" aria-hidden={collapsed}>
        <div className="iris-brand">
          <span className="iris-brand__id">
            {/* The identity, and the one mark in the product that has states:
                the blades close and the hole shuts as the panel folds away
                (`marks.tsx`, `LogoMotion.dc.html`). */}
            <ApertureMark size={18} open={!collapsed} />
            <span className="iris-brand__word">Iris</span>
          </span>
          {/*
            The fold control, and it does not travel.
            The rail carries its own button (below) in the rail's own first
            position. Two buttons rather than one that moves, because the user's
            ruling is that neither crosses the panel while it folds: this one
            leaves with the content it belongs to, right to left, and the rail's
            arrives with the rail, left to right. A single button animated
            between two places was the earlier drawing and read as the control
            sliding out from under the pointer.
          */}
          <button
            type="button"
            className="iris-sidebar__ico"
            aria-label={t('collapseSidebar')}
            aria-expanded={!collapsed}
            aria-controls="iris-sidebar-body"
            onClick={() => onCollapsed(true)}
          >
            <ChevronToEdgeIcon />
          </button>
        </div>

        {/*
         * `data-tab` carries the tab's identity in the state's own vocabulary.
         *
         * Everything else that distinguishes these two buttons is translated text:
         * the class and the role are identical, so an instrument reaching for
         * "Characters" finds it on an English profile and finds `角色库` on this
         * one. Every acceptance script that located a tab by its label broke the
         * day the shell learned to speak the reader's language, and located-by-
         * position is the alternative nobody wants to debug.
         *
         * The value is the state value passed to `setTab` beside it, deliberately
         * — one vocabulary for the store, the DOM and the scripts — and a test
         * pins that they agree, because two spellings of one identity is the
         * failure this exists to prevent.
         */}
        <div className="iris-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="iris-tab"
            data-tab="chats"
            aria-selected={tab === 'chats'}
            onClick={() => setTab('chats')}
          >
            {t('tabReading')}
          </button>
          <button
            type="button"
            role="tab"
            className="iris-tab"
            data-tab="characters"
            aria-selected={tab === 'characters'}
            onClick={() => setTab('characters')}
          >
            {t('tabCharacters')}
          </button>
        </div>

        <div className="iris-list" role="tabpanel" ref={listRef}>
          {tab === 'chats' ? (
            <>
              <input
                ref={searchBox}
                type="search"
                className="iris-search"
                aria-label={t('chatSearchAria')}
                placeholder={t('chatSearchPlaceholder')}
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
              {/*
                The two orders, offered only once there is a choice to make.

                `ordered` is the host saying it holds an arrangement someone
                made. Before the first drag there is none, the two answers are
                the same list, and a permanent pair of capsules over every
                conversation list would be a control that never changes
                anything. The artboards draw the chat tab with nothing but a
                search box above the rows, and this keeps that drawing until the
                reader has done the thing that makes the row meaningful.
              */}
              {ordered === true ? (
                <div className="iris-sorts" role="group" aria-label={t('chatOrderAria')}>
                  {([
                    ['manual', t('chatOrderManual')],
                    ['recent', t('chatOrderRecent')],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className="iris-sort"
                      aria-pressed={chatSort === id}
                      onClick={() => chooseChatSort(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
              {hits === undefined ? (
                chats.length === 0 ? (
                  <p className="iris-list__empty">{t('chatsEmpty')}</p>
                ) : (
                  renderChatRows(rootRows, 0)
                )
              ) : hits.length === 0 ? (
                // The no-results row names the query: an empty state that does not
                // say what found nothing is indistinguishable from a broken box.
                <p className="iris-list__empty">{t('chatSearchEmpty', { query: query.trim() })}</p>
              ) : (
                hits.map(hit => (
                  <SearchRow
                    key={hit.chatId}
                    hit={hit}
                    current={hit.chatId === chatId}
                    lang={lang}
                    onOpen={() => void actions.openChat(hit.chatId)}
                  />
                ))
              )}
            </>
          ) : characters.length === 0 ? (
            <p className="iris-list__empty">
              {t('libraryEmpty')}
            </p>
          ) : (
            <>
              {/*
                A search box and three capsules, as the artboards draw it.

                This replaces two `<select>`s. The tag one is gone because the box
                above searches tags as well — a corpus-wide tag census runs to
                dozens of names, and a menu of them is a scroll rather than a
                filter. The sort one is gone because three words fit on the line:
                a menu that must be opened to reveal its whole set costs a click
                to learn nothing.
              */}
              <input
                type="search"
                className="iris-search"
                aria-label={t('librarySearchAria')}
                placeholder={t('librarySearchPlaceholder')}
                value={libraryQuery}
                onChange={event => setLibraryQuery(event.target.value)}
              />
              <div className="iris-sorts" role="group" aria-label={t('sortByAria')}>
                {([
                  ['favorite', t('sortByFavorite')],
                  ['updated', t('sortByUpdated')],
                  ['name', t('sortByName')],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className="iris-sort"
                    aria-pressed={sortBy === id}
                    onClick={() => setSortBy(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {visibleCharacters.length === 0 ? (
                <p className="iris-list__empty">{t('librarySearchEmpty', { query: libraryQuery.trim() })}</p>
              ) : (
                visibleCharacters.map(character =>
                  renaming?.id === character.characterId ? (
                    <InlineEditor
                      key={character.characterId}
                      label={t('characterNameAria')}
                      value={renaming.name}
                      onChange={name => setRenaming({ id: character.characterId, name })}
                      onSave={() => {
                        const name = renaming.name.trim()
                        setRenaming(undefined)
                        if (name.length > 0 && name !== character.name) {
                          void actions.renameCharacter(character.characterId, name)
                        }
                      }}
                      onCancel={() => setRenaming(undefined)}
                    />
                  ) : tagging?.id === character.characterId ? (
                    <InlineEditor
                      key={character.characterId}
                      label={t('tagsInputAria')}
                      value={tagging.tags}
                      onChange={tags => setTagging({ id: character.characterId, tags })}
                      onSave={() => {
                        const tags = tagging.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
                        setTagging(undefined)
                        void actions.setCharacterTags(character.characterId, tags)
                      }}
                      onCancel={() => setTagging(undefined)}
                    />
                  ) : (
                    <CharacterRow
                      key={character.characterId}
                      character={character}
                      lang={lang}
                      current={character.characterId === face}
                      onOpen={() => { onFace(character.characterId) }}
                      onToggleStar={() =>
                        void actions.favoriteCharacter(character.characterId, character.favorite !== true)}
                      menu={{
                        items: [
                          {
                            id: 'favorite',
                            label: t(character.favorite === true ? 'unfavorite' : 'favorite'),
                          },
                          { id: 'duplicate', label: t('duplicateCharacter') },
                          { id: 'rename', label: t('renameCharacterMenu') },
                          { id: 'tags', label: t('editTags') },
                          { id: 'exportPng', label: t('exportCardPng') },
                          { id: 'exportJson', label: t('exportCardJson') },
                          { id: 'importChats', label: t('importChats') },
                          { id: 'delete', label: t('removeFromLibrary'), danger: true },
                        ],
                        onSelect: id => {
                          if (id === 'favorite') {
                            void actions.favoriteCharacter(character.characterId, character.favorite !== true)
                          } else if (id === 'duplicate') {
                            void actions.duplicateCharacter(character.characterId)
                          } else if (id === 'rename') {
                            setRenaming({ id: character.characterId, name: character.name })
                          } else if (id === 'tags') {
                            setTagging({ id: character.characterId, tags: character.tags.join(', ') })
                          } else if (id === 'exportPng') {
                            void actions.exportCharacter(character.characterId, 'png')
                          } else if (id === 'exportJson') {
                            void actions.exportCharacter(character.characterId, 'json')
                          } else if (id === 'importChats') {
                            importFor.current = character.characterId
                            chatPicker.current?.click()
                          } else if (id === 'delete') {
                            void actions.deleteCharacter(character.characterId)
                          }
                        },
                      }}
                    />
                  ),
                )
              )}
            </>
          )}

          <Slot name="iris.sidebar.panels" owner={{ chats, characters }} />
        </div>

        <div className="iris-sidebar__foot">
          <Button variant="outline" size="sm" onClick={() => picker.current?.click()}>
            {t('importCard')}
          </Button>
        </div>
      </div>

      {/*
        The rail: the same four destinations, at 44px.

        Every icon here is a *button* and every one of them expands the panel as
        well as landing on its list. A rail that only switched tabs would leave
        the reader looking at a 44px column with no way to see what they had
        chosen, and one that only expanded would make the icons decoration.
      */}
      <div className="iris-sidebar__rail" aria-hidden={!collapsed}>
        <ApertureMark size={18} open={!collapsed} />
        <button
          type="button"
          className="iris-sidebar__ico iris-sidebar__ico--flip"
          aria-label={t('expandSidebar')}
          aria-expanded={!collapsed}
          aria-controls="iris-sidebar-body"
          onClick={() => onCollapsed(false)}
        >
          <ChevronToEdgeIcon />
        </button>
        <button
          type="button"
          className="iris-sidebar__ico"
          data-rail="chats"
          aria-current={tab === 'chats'}
          title={t('tabReading')}
          aria-label={t('tabReading')}
          onClick={() => openOn('chats')}
        >
          <ConversationIcon />
        </button>
        <button
          type="button"
          className="iris-sidebar__ico"
          data-rail="characters"
          aria-current={tab === 'characters'}
          title={t('tabCharacters')}
          aria-label={t('tabCharacters')}
          onClick={() => openOn('characters')}
        >
          <LibraryIcon />
        </button>
        <button
          type="button"
          className="iris-sidebar__ico"
          data-rail="search"
          title={t('chatSearchAria')}
          aria-label={t('chatSearchAria')}
          onClick={() => openOn('chats', true)}
        >
          <SearchIcon />
        </button>
        <span className="iris-sidebar__gap" />
        <button
          type="button"
          className="iris-sidebar__ico"
          data-rail="import"
          title={t('importCard')}
          aria-label={t('importCard')}
          onClick={() => picker.current?.click()}
        >
          <AddIcon />
        </button>
      </div>
    </nav>
  )
}

/**
 * One conversation: a handle, a title, a stamp, and the actions it offers.
 *
 * **One line and four columns** (`RowStates.dc.html`): 10px of handle, the
 * title, the stamp right-aligned, and 24px reserved for the overflow trigger.
 * It used to be two lines with the stamp under the title, which cost a row 20px
 * of height and put the least important thing on the page on a line of its own.
 *
 * **The trigger is in the row, and it is not inside the button.** The row is
 * still one press to open the conversation, so the whole rectangle is a
 * `<button>`; the trigger and the handle-side controls are its *siblings*,
 * absolutely positioned over the 24px the grid reserved for them. A button
 * inside a button is invalid markup that browsers repair by hoisting the inner
 * one out of the outer, which puts a control the reader can see in a place the
 * DOM does not have it — and that is the whole reason for the shell element
 * around the pair rather than the nesting the artboards' flat mock-up suggests.
 *
 * The menu's items come from the caller: a chat row exports and deletes, a
 * character row imports chats and is removed, and hard-coding either set here
 * would make this one row shape pretend to be two.
 */
function ChatRow({
  title,
  meta,
  current,
  depth = 0,
  branched = false,
  drag,
  onOpen,
  menu,
}: {
  title: string
  meta: string
  current: boolean
  /** Indent level, for a branch sitting under the conversation it left. */
  depth?: number
  /** Whether the row is a branch, which is marked as such for a reader. */
  branched?: boolean
  /**
   * Reordering, when this row is one a reader may move.
   *
   * Explicitly `| undefined` rather than only optional, because
   * `exactOptionalPropertyTypes` is on and a branch row passes the absence in
   * as a value — a conditional in the JSX, not an omitted attribute.
   */
  drag: {
    index: number
    state: Drag | undefined
    onPress: (event: ReactPointerEvent<HTMLElement>) => void
    onNudge: (from: number, step: -1 | 1) => void
  } | undefined
  onOpen: () => void
  menu: { items: RowAction[], onSelect: (id: string) => void }
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)

  const lifted = drag?.state !== undefined && drag.state.from === drag.index
  const away = drag?.state === undefined || lifted
    ? 0
    : makeWay(drag.index, drag.state.from, drag.state.to)

  /*
   * The two offsets a drag needs, as custom properties rather than a composed
   * `transform` string.
   *
   * `scale(1.02) rotate(-0.6deg)` and the make-way easing are design decisions
   * and belong in the stylesheet; only the distance is data. Writing the whole
   * transform here would have moved three of the artboards' numbers into this
   * file, where no theme and no reduced-motion rule can reach them.
   */
  const offsets: CSSProperties = {}
  if (lifted && drag?.state !== undefined) {
    (offsets as Record<string, string>)['--iris-drag-y'] = `${String(drag.state.offset)}px`
    ;(offsets as Record<string, string>)['--iris-slot-y'] =
      `${String((drag.state.to - drag.state.from) * drag.state.step)}px`
  } else if (away !== 0 && drag?.state !== undefined) {
    (offsets as Record<string, string>)['--iris-drag-y'] = `${String(away * drag.state.step)}px`
  }

  const classes = ['iris-row-shell']
  if (lifted) classes.push('iris-row-shell--lifted')
  else if (away !== 0) classes.push('iris-row-shell--away')
  if (menuOpen) classes.push('iris-row-shell--menu')

  return (
    <div
      className={classes.join(' ')}
      style={depth > 0
        ? { ...offsets, marginInlineStart: `${String(depth * 18)}px` }
        : offsets}
      {...drag === undefined ? {} : { 'data-drag-index': String(drag.index) }}
    >
      {/* The dashed well the row would drop into, drawn only while it is up.
          It travels with the drop position, which is why it carries an offset
          of its own rather than sitting under the lifted row. */}
      {lifted ? <span className="iris-row__slot" aria-hidden="true" /> : null}
      <button
        type="button"
        className="iris-row iris-row--chat"
        aria-current={current}
        onClick={onOpen}
        onPointerDown={drag?.onPress}
        onKeyDown={event => {
          // Alt+arrow, not a bare arrow: the arrows scroll the list, and a
          // reader stepping through rows with them must not reorder the list by
          // accident. The same pair upstream's own list uses for nothing, so
          // there is no key to be compatible with.
          if (drag === undefined || !event.altKey) return
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            drag.onNudge(drag.index, -1)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            drag.onNudge(drag.index, 1)
          }
        }}
      >
        <span className="iris-row__grip">
          {drag === undefined ? null : <GripIcon />}
        </span>
        <span className="iris-row__title">
          {branched ? <span className="iris-row__branch" aria-hidden="true">↳ </span> : null}
          {title}
        </span>
        <span className="iris-row__meta iris-meta">{meta}</span>
        {/* The fourth column is space, not content: the trigger beside this
            button is absolutely positioned into it. */}
        <span className="iris-row__well" aria-hidden="true" />
      </button>
      <span className="iris-row__acts">
        <Menu
          className="iris-row__menu"
          open={menuOpen}
          portal
          align="end"
          anchor={
            <button
              type="button"
              className="iris-row__more"
              aria-label={t('moreActionsFor', { title })}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <MoreIcon />
            </button>
          }
          items={menu.items}
          onSelect={id => {
            setMenuOpen(false)
            menu.onSelect(id)
          }}
          onClose={() => setMenuOpen(false)}
        />
      </span>
    </div>
  )
}

/**
 * One library row: a portrait, the name, its tags, a star, and the manager menu.
 *
 * The portrait is what makes this row a different shape from a chat row rather
 * than the same shape with different words — a library is scanned by face, and
 * the artboards give it 34px of one. The star is its own control rather than a
 * menu item *only*, because favouriting is the one action a reader does without
 * opening anything, and hiding it a menu deep would starve the sort-by-favorites
 * order of the rows that make it useful. The menu carries the rest: duplicate,
 * rename, tags, export and the chat import that was already here.
 *
 * The row's meta line is now the **tags**, not the date. Both were on it before
 * and the row could not hold both plus a portrait; the artboards choose tags,
 * and the choice is right — a date sorts a library and a tag identifies a card.
 * The date is on the character page, where there is room to say what it means.
 *
 * The star and the trigger sit **inside the row** now, over the space its grid
 * reserves for them, for the reason `ChatRow` explains: they used to be
 * siblings of the row in a flex line, which made the row narrower than the
 * panel and left the two controls outside the rectangle they act on.
 */
function CharacterRow({
  character,
  lang,
  current,
  onOpen,
  onToggleStar,
  menu,
}: {
  character: CharacterSummary
  /** The interface language, for the row's relative-time words. */
  lang: Language
  /** Whether this character's page is the one open. */
  current: boolean
  onOpen: () => void
  onToggleStar: () => void
  menu: { items: RowAction[], onSelect: (id: string) => void }
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const starred = character.favorite === true
  const meta = character.updatedAt === undefined
    ? character.creator === undefined
      ? t('noCreatorListed')
      : t('byCreator', { creator: character.creator })
    : since(character.updatedAt, Date.now(), lang)

  return (
    <div className={menuOpen ? 'iris-row-shell iris-row-shell--menu' : 'iris-row-shell'}>
      <button
        type="button"
        className="iris-row iris-row--character"
        aria-current={current}
        onClick={onOpen}
      >
        <Portrait character={character} size="row" />
        <span className="iris-row__lines">
          <span className="iris-row__title">{character.name}</span>
          {character.tags.length > 0 ? (
            <span className="iris-row__tags">
              {character.tags.slice(0, 3).map(tag => (
                <span className="iris-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          ) : (
            // No tags is not nothing to say: the row still has to report when
            // the card last changed, or a whole untagged library shows two
            // lines of name and one of blank.
            <span className="iris-row__meta iris-meta">{meta}</span>
          )}
        </span>
        <span className="iris-row__well" aria-hidden="true" />
      </button>
      <span className="iris-row__acts">
        {/*
          The star carries `iris-star` as well as `iris-row__more`: it is the
          same 24px cell as the overflow trigger and lights the same way, and
          only its colour when on is its own (`shell.css` — plum when starred,
          the faintest ink when not).
        */}
        <button
          type="button"
          className={starred ? 'iris-row__more iris-star iris-star--on' : 'iris-row__more iris-star'}
          aria-label={t(starred ? 'unfavorite' : 'favorite')}
          aria-pressed={starred}
          title={t(starred ? 'unfavorite' : 'favorite')}
          onClick={onToggleStar}
        >
          {starred ? '★' : '☆'}
        </button>
        <Menu
          className="iris-row__menu"
          open={menuOpen}
          portal
          align="end"
          anchor={
            <button
              type="button"
              className="iris-row__more"
              aria-label={t('moreActionsFor', { title: character.name })}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <MoreIcon />
            </button>
          }
          items={menu.items}
          onSelect={id => {
            setMenuOpen(false)
            menu.onSelect(id)
          }}
          onClose={() => setMenuOpen(false)}
        />
      </span>
    </div>
  )
}

/**
 * One row's in-place editor: rename and tags both, because they are the same
 * gesture — a field, a confirm, an escape. The editor replaces the row rather
 * than floating over it, so the row it edits stays exactly where the cursor
 * left it.
 */
function InlineEditor({
  label,
  value,
  onChange,
  onSave,
  onCancel,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  onSave: () => void
  onCancel: () => void
}): ReactElement {
  const focus = useRef<HTMLInputElement>(null)
  useEffect(() => { focus.current?.focus() }, [])
  return (
    <div className="iris-row-group">
      <input
        ref={focus}
        type="text"
        className="iris-search"
        aria-label={label}
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') onSave()
          else if (event.key === 'Escape') onCancel()
        }}
      />
      <button type="button" className="iris-act iris-act--primary" onClick={onSave}>
        {t('save')}
      </button>
      <button type="button" className="iris-act" onClick={onCancel}>
        {t('cancel')}
      </button>
    </div>
  )
}

/**
 * One content hit: the conversation, and the floor that matched.
 *
 * The snippet is why the row is here; the floor label is where to go. Opening
 * the chat is the whole action — jumping the reading window to the floor is
 * the reading view's business and does not exist yet, so the row says where
 * the hit is rather than pretending it scrolled for you.
 */
function SearchRow({
  hit,
  current,
  lang,
  onOpen,
}: {
  hit: ChatSearchHit
  current: boolean
  lang: Language
  onOpen: () => void
}): ReactElement {
  const first = hit.matches[0]
  return (
    <button type="button" className="iris-row iris-row--hit" aria-current={current} onClick={onOpen}>
      <span className="iris-row__title">{hit.title}</span>
      {first !== undefined ? (
        <span className="iris-row__snippet">{first.snippet}</span>
      ) : null}
      <span className="iris-row__meta iris-meta">
        {first === undefined
          ? since(hit.updatedAt, Date.now(), lang)
          : `${t('chatSearchFloor', { floor: first.messageId })}`
            + (hit.matches.length > 1 ? ` · ${t('chatSearchMore', { count: hit.matches.length - 1 })}` : '')}
      </span>
    </button>
  )
}
