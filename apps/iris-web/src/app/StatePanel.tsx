/**
 * The chat's variables, in the desk's margin.
 *
 * This exists because a wide window had nothing in it. The reading column must
 * not grow — the measure is the thing that works — so past 1360px the space
 * beside the sheet gets real content rather than more emptiness. The variables
 * are the obvious candidate: the protocol already carries them, MVU cards spend
 * their whole life writing them, and "what is the state right now" is a question
 * a reader of a long scene actually asks.
 *
 * **Why it stopped being a flat index.** The first version drew every leaf of
 * the tree as a row, and against a real MVU card that is a wall: the political
 * simulator's `政局` branch alone is 34 rows in a 260px column, and "what did
 * this turn change" — the question the panel exists for — meant eyeballing two
 * scrolls. The margin now works the way a game's inventory screen does, which
 * is the one interface idiom people already read fluently at this size:
 *
 * - **Folded by default, counts on the headings.** A branch renders as one row
 *   with its child count, so 34 items are *countable* without being *shown*.
 *   The top level stays open — the reader should see the shape of the data —
 *   and everything below waits for a click. Folds are remembered per chat
 *   (`localStorage`, keyed by chat and path), because re-folding the same tree
 *   on every floor is the panel training its reader to leave it closed.
 * - **This round's changes are marked.** The panel diffs the variables it sees
 *   against the round baseline — the tree the round started from, where a
 *   round is one story turn plus the status-bar card's trailing writes, which
 *   arrive as several snapshots and must sum, not replace each other. Added
 *   and changed rows are marked; a changed row's hover says `old → new`;
 *   removals list in their own section; a "changes only" switch prunes the
 *   tree to the marked paths. The diff itself is a pure function
 *   (`state-panel.ts`) with its own tests.
 * - **Search is a key filter, not a find-in-page.** A hit keeps its whole
 *   subtree and the headings above it; everything else drops. Matched paths
 *   render open regardless of fold memory, so a hit is readable immediately.
 *
 * Two rules the old tree got right and are still rules here:
 *
 * - **No horizontal scrollbar.** A long value clamps and puts its full text on
 *   hover, the way every other body of text on this page refuses to scroll
 *   sideways. A 260px column that scrolls horizontally cannot show the start
 *   and the end of a line at once.
 * - **Keys are never uppercased or letter-spaced.** The label treatment that
 *   suits "STATE" destroys CJK, and most of the corpus's variable names are
 *   Chinese.
 *
 * **Everything here works on data shape.** No branch names a card, a Chinese
 * key, or `stat_data`: a branch is a value `branchEntries` can take apart, a
 * leaf is everything else, and "未知" is weakened by being a value that says
 * nothing — not because any particular card writes it. One panel, every MVU
 * card.
 *
 * **The data source is untouched.** `view.variables` arrives as it always did;
 * the diff watches the snapshots the store already delivers and keeps no
 * protocol of its own.
 *
 * **The margin has two halves since 2026-09-25**: the variables on top and the
 * branch tree map below (`TreeMap.tsx`'s `AsideTreeSection`), with a divider
 * between them (owner placement ruling; web ledger §128).
 *
 * **While the tree map's 「比较变量」 mode is on, the upper half is the
 * comparison instead** (owner request 2026-09-26): the variable diff between
 * the two floors picked on the map, drawn with this same tree and these same
 * marks — B's table as the tree, 新 only in B, 改 with `A → B` in place, what
 * only A holds listed underneath — under a header naming both sides, with a
 * swap and a close. Closing (or Escape) brings the variables back.
 *
 * @module iris-web/app/StatePanel
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

import { useIris, useIrisActions } from '../client/provider.tsx'
import type { ComparePick } from '../client/variable-compare.ts'
import { AsideTreeSection } from './TreeMap.tsx'
import './variable-compare.css'
import { useLanguage, t } from './i18n/use-language.ts'
import { translate, type Language } from './i18n/strings.ts'
import {
  ASIDE_OVERLAY_QUERY,
  ASIDE_YIELD_QUERY,
  asideShowing,
  FLANK_SLIDE_MS,
  branchPaths,
  changeSentence,
  changedPaths,
  compareMarks,
  describe,
  diffStats,
  EMPTY_DIFF,
  filterByName,
  keepChanged,
  loadAsideOpen,
  loadFoldMemory,
  loadLastTree,
  previewValue,
  RANGED_RIGHT_LIMIT,
  ROUND_QUIET_MS,
  sameValue,
  saveAsideOpen,
  saveFoldMemory,
  saveLastTree,
  type StateDiff,
} from './state-panel.ts'

/**
 * How deep a branch may be before it arrives closed.
 *
 * Depth 0 is the variable table's own shape — `stat_data` and whatever else
 * the card scopes in — and stays open, so the reader sees the data's real
 * sections (`政局 34`) without a click. Everything below that is a section's
 * contents and waits to be asked for. A deeper default was tried and made the
 * margin a wall again; a shallower one made it a one-row list that hid the
 * shape entirely.
 */
const DEFAULT_OPEN_DEPTH = 1

/** How long the search box waits for the reader to stop typing. */
const SEARCH_DEBOUNCE_MS = 250

/**
 * The round of changes the panel is currently showing, per chat.
 *
 * A round is one or more snapshots arriving inside `ROUND_QUIET_MS` of each
 * other — one story turn, plus the status-bar card's trailing writes — and is
 * differenced against the tree the round started from. The baseline is kept in
 * sessionStorage, so the round survives a page reload and a stream whose end
 * landed while the event socket was reconnecting; a chat this session has
 * never seen starts unmarked until its first witnessed change.
 *
 * Held in a ref during render rather than in state, so the derivation is
 * idempotent under StrictMode's double render and a remount (a theme switch,
 * a drawer drag) does not read as a new floor.
 */
function useVariableDiff(chatId: string | undefined, variables: unknown): StateDiff {
  const memo = useRef<{
    chatId: string | undefined
    tree: unknown
    diff: StateDiff
    baseline: unknown
    lastChangeAt: number | undefined
  }>({ chatId: undefined, tree: undefined, diff: EMPTY_DIFF, baseline: undefined, lastChangeAt: undefined })

  if (memo.current.chatId !== chatId) {
    // First sight of this chat in this session. A remembered round that is
    // still fresh continues where it left off — the panel answers "what
    // changed since I last looked" across a reload; a stale one is yesterday's
    // news, and today's baseline is the tree as found. `openChat` clears the
    // view before the settled one arrives, so a first sight may hold no tree
    // at all; the arrival branch below does the rest.
    const remembered = chatId === undefined ? undefined : loadLastTree(chatId)
    const fresh = remembered !== undefined && Date.now() - remembered.at < ROUND_QUIET_MS * 2
    const baseline = fresh ? remembered.tree : variables
    memo.current = {
      chatId,
      tree: variables,
      diff: fresh && variables !== undefined ? diffStats(remembered.tree, variables) : EMPTY_DIFF,
      baseline,
      lastChangeAt: fresh ? remembered.at : undefined,
    }
  } else if (variables === undefined) {
    // The chat's own view is being refetched (`openChat` clears it first).
    // Hold the round exactly as it stands: no tree is on screen to witness,
    // and treating "no view" as a change measures the round against nothing —
    // observed live as a baseline of `undefined` and a diff that could never
    // be non-empty.
    if (memo.current.tree !== undefined) memo.current = { ...memo.current, tree: undefined }
  } else if (memo.current.tree === undefined) {
    /*
     * The settled view arrived for a round this panel already holds — the
     * ordinary openChat clearing, or a snapshot that landed while the page had
     * no view. If the round is still quiet-fresh it is measured against the
     * baseline it had; otherwise what arrived becomes the new round's
     * baseline, unmarked.
     */
    const now = Date.now()
    const continues = memo.current.baseline !== undefined
      && memo.current.lastChangeAt !== undefined
      && now - memo.current.lastChangeAt < ROUND_QUIET_MS
    const baseline = continues ? memo.current.baseline : variables
    const diff = continues ? diffStats(baseline, variables) : EMPTY_DIFF
    memo.current = { chatId, tree: variables, diff, baseline, lastChangeAt: now }
    if (chatId !== undefined && continues) saveLastTree(chatId, { tree: baseline, at: now })
  } else if (memo.current.tree !== variables && !sameValue(memo.current.tree, variables)) {
    /*
     * A new snapshot for the same chat. Identical content under a new identity
     * (the store replaces the view wholesale on every settled fetch, and a
     * card's no-op rewrite arrives this way) is not a change. A real one
     * continues the current round when it lands inside the quiet window and
     * opens a new round — measured from the tree just replaced — when it does
     * not.
     */
    const now = Date.now()
    const continues = memo.current.lastChangeAt !== undefined
      && now - memo.current.lastChangeAt < ROUND_QUIET_MS
    const baseline = continues ? memo.current.baseline : memo.current.tree
    memo.current = {
      chatId,
      tree: variables,
      diff: diffStats(baseline, variables),
      baseline,
      lastChangeAt: now,
    }
    if (chatId !== undefined) saveLastTree(chatId, { tree: baseline, at: now })
  }
  return memo.current.diff
}

/**
 * The round's change badges for one row, or nothing.
 * @param props - which marks the row carries, and the sentence a changed row hovers.
 * @returns the badges, or `null`.
 */
function DeltaBadge({
  added,
  changed,
  hover,
  lang,
}: {
  added: boolean
  changed: boolean
  /** The `old → new` sentence; set exactly when `changed` is. */
  hover: string | undefined
  lang: Language
}): ReactElement | null {
  if (!added && !changed) return null
  return (
    <>
      {added && <span className="iris-var__delta iris-var__delta--new">{translate(lang, 'stateBadgeNew')}</span>}
      {changed && (
        <span className="iris-var__delta iris-var__delta--chg" title={hover}>
          {translate(lang, 'stateBadgeChanged')}
        </span>
      )}
    </>
  )
}

/**
 * One level of the variable index.
 *
 * Rendering only — what a search keeps, what a diff marks, whether a branch
 * starts open are all decided above this component or in `state-panel.ts`.
 * @param props - the entries, their depth and path, the fold and diff state.
 * @returns the rows.
 */
function StateRows({
  entries,
  depth,
  path,
  opened,
  searchToggled,
  searching,
  added,
  changed,
  changeHover,
  onToggle,
  lang,
  changeInline = false,
}: {
  entries: [string, unknown][]
  depth: number
  path: string
  /** Fold overrides the reader set by hand, remembered per chat. */
  opened: ReadonlyMap<string, boolean>
  /** Branches collapsed inside the current search — ephemeral, not remembered. */
  searchToggled: ReadonlySet<string>
  /** True while a name filter is live, which force-opens rendered branches. */
  searching: boolean
  added: ReadonlySet<string>
  changed: ReadonlySet<string>
  /** `old → new` sentences keyed by changed path, for the hover. */
  changeHover: ReadonlyMap<string, string>
  onToggle: (path: string, open: boolean) => void
  lang: Language
  /**
   * Show a changed leaf's `before → after` in place of its value, rather than
   * only on hover. The compare view's rows, where the two readings are the
   * point; the round diff keeps the hover, because its "before" is a moment ago.
   */
  changeInline?: boolean
}): ReactElement {
  /*
   * The `open` value each branch was last rendered with, per path.
   *
   * The `toggle` event fires whenever a `<details>` changes state — including
   * when **this panel changed the attribute itself** (a chat switch, a search
   * forcing hits open, a diff view pruning branches back in). Treating those
   * echoes as reader input would write one chat's forced-open paths into
   * another chat's fold memory — observed live: a chat that was merely
   * *visited* grew a memory record. A real click always flips the DOM to the
   * *opposite* of what was rendered, so an event that agrees with the last
   * render is the panel's own echo and is dropped.
   */
  const renderedOpen = useRef<Map<string, boolean>>(new Map())
  return (
    <dl className="iris-var">
      {entries.map(([key, value]) => {
        const shown = describe(value, lang)
        const here = `${path}/${key}`

        if (shown.kind === 'branch') {
          /*
           * Disclosure state is held by the panel rather than by the `<details>`
           * element. This margin refreshes on every host event, and an
           * uncontrolled element would have React reassert the default `open`
           * on each one — so a reader who opened a branch would watch it shut
           * itself every time the chat moved.
           *
           * During a search every rendered branch is a hit or the path to one,
           * so it opens regardless of memory; the reader can still fold it for
           * the length of the search, and that fold is deliberately forgotten.
           */
          const isOpen = searching
            ? !searchToggled.has(here)
            : opened.get(here) ?? depth < DEFAULT_OPEN_DEPTH
          renderedOpen.current.set(here, isOpen)
          return (
            <details
              className="iris-var__branch"
              key={key}
              open={isOpen}
              onToggle={event => {
                const now = event.currentTarget.open
                if (renderedOpen.current.get(here) === now) return
                onToggle(here, now)
              }}
            >
              <summary className="iris-var__summary" data-changed={added.has(here) || changed.has(here) ? '' : undefined}>
                <DeltaBadge
                  added={added.has(here)}
                  changed={changed.has(here)}
                  hover={changeHover.get(here)}
                  lang={lang}
                />
                <span className="iris-var__key">{key}</span>
                <span className="iris-var__count">{shown.entries.length}</span>
              </summary>
              <div className="iris-var__children">
                <StateRows
                  entries={shown.entries}
                  depth={depth + 1}
                  path={here}
                  opened={opened}
                  searchToggled={searchToggled}
                  searching={searching}
                  added={added}
                  changed={changed}
                  changeHover={changeHover}
                  onToggle={onToggle}
                  lang={lang}
                  changeInline={changeInline}
                />
              </div>
            </details>
          )
        }

        const inline = changeInline && changed.has(here) ? changeHover.get(here) : undefined
        const stacked = inline !== undefined
          ? inline.length > RANGED_RIGHT_LIMIT
          : shown.kind === 'text' && shown.text.length > RANGED_RIGHT_LIMIT
        const classes = ['iris-var__value']
        if (inline !== undefined) classes.push('iris-var__value--change')
        if (shown.kind === 'absent') classes.push('iris-var__value--absent')
        if (shown.kind === 'text' && shown.faint) classes.push('iris-var__value--faint')
        if (shown.kind === 'text' && shown.numeric) classes.push('iris-var__value--numeric')

        return (
          <div
            className={stacked ? 'iris-var__row iris-var__row--stacked' : 'iris-var__row'}
            data-changed={added.has(here) || changed.has(here) ? '' : undefined}
            key={key}
          >
            <dt className="iris-var__key">
              <DeltaBadge
                added={added.has(here)}
                changed={changed.has(here)}
                hover={changeHover.get(here)}
                lang={lang}
              />
              {key}
            </dt>
            {inline !== undefined ? (
              <dd className={classes.join(' ')} title={inline}>{inline}</dd>
            ) : (
              <dd className={classes.join(' ')} title={shown.kind === 'text' ? shown.text : translate(lang, 'stateValueEmpty')} aria-label={shown.kind === 'absent' ? translate(lang, 'stateValueEmpty') : undefined}>
                {shown.kind === 'absent' ? '—' : shown.text}
              </dd>
            )}
          </div>
        )
      })}
    </dl>
  )
}

/** One side of the compare header: its letter, its conversation, and its floor as a field. */
function CompareSide({
  side,
  pick,
  title,
  floors,
  reading,
  onFloor,
}: {
  side: 'a' | 'b'
  pick: ComparePick | undefined
  title: string | undefined
  /** The conversation's floor count, for the field's bounds. */
  floors: number | undefined
  /** The reading compared, when the floor has several. */
  reading: { swipe: number, swipes: number } | undefined
  onFloor: (floor: number) => void
}): ReactElement {
  const name = side.toUpperCase()
  const [draft, setDraft] = useState(pick === undefined ? '' : String(pick.floor))
  useEffect(() => { setDraft(pick === undefined ? '' : String(pick.floor)) }, [pick])
  const commit = (): void => {
    const value = Number(draft)
    if (pick === undefined || draft.trim() === '' || !Number.isInteger(value) || value < 0) {
      setDraft(pick === undefined ? '' : String(pick.floor))
      return
    }
    const top = floors === undefined ? value : Math.max(0, floors - 1)
    onFloor(Math.min(value, top))
  }
  return (
    <span className="iris-compare__side" data-side={side}>
      <span className="iris-tree__pick" data-side={side}>{name}</span>
      {pick === undefined ? (
        <span className="iris-compare__title iris-compare__title--empty">—</span>
      ) : (
        <>
          <span className="iris-compare__title" title={title}>{title ?? pick.chatId}</span>
          <span className="iris-compare__floor">
            #
            <input
              className="iris-compare__floorfield"
              type="number"
              inputMode="numeric"
              min={0}
              {...floors === undefined ? {} : { max: Math.max(0, floors - 1) }}
              value={draft}
              data-control={`compare-floor-${side}`}
              aria-label={t('compareFloorAria', { side: name })}
              onChange={event => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commit()
                } else if (event.key === 'Escape') {
                  // The field answers Escape itself: it puts the floor back,
                  // and the mode stays on.
                  event.preventDefault()
                  setDraft(String(pick.floor))
                }
              }}
            />
          </span>
          {reading !== undefined && reading.swipes > 1 ? (
            <span className="iris-compare__reading">{t('compareReading', { n: reading.swipe + 1 })}</span>
          ) : null}
        </>
      )}
    </span>
  )
}

/**
 * The comparison, in the margin's upper half while the compare mode is on.
 *
 * Rendering only: the diff is the host's (`chat.variablesDiff`), and how its
 * paths become this tree's marks is `compareMarks` in `state-panel.ts`.
 * @param props.lang - the interface language.
 * @returns the header, the tools and the tree.
 */
function VariableCompareView({ lang }: { lang: Language }): ReactElement | null {
  const compare = useIris(state => state.compare)
  const tree = useIris(state => state.tree)
  const chats = useIris(state => state.chats)
  const actions = useIrisActions()
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  // 「只看变化」 starts on here: the differences are what was asked for.
  const [onlyChanges, setOnlyChanges] = useState(true)
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [forced, setForced] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput.trim().toLowerCase()), SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [queryInput])

  if (compare === undefined) return null
  const node = (chatId: string | undefined): { title: string, floorCount: number } | undefined => {
    if (chatId === undefined) return undefined
    const drawn = tree?.chats.find(entry => entry.chatId === chatId)
    if (drawn !== undefined) return drawn
    const listed = chats.find(entry => entry.chatId === chatId)
    return listed === undefined ? undefined : { title: listed.title, floorCount: listed.messageCount }
  }
  const { a, b, result, loading } = compare
  const nodeA = node(a?.chatId)
  const nodeB = node(b?.chatId)

  const header = (
    <div className="iris-compare__head">
      <div className="iris-compare__sides">
        <CompareSide
          side="a"
          pick={a}
          title={nodeA?.title}
          floors={nodeA?.floorCount}
          reading={result?.a}
          onFloor={floor => actions.setCompareFloor('a', floor)}
        />
        <span className="iris-compare__arrow" aria-hidden="true">↔</span>
        <CompareSide
          side="b"
          pick={b}
          title={nodeB?.title}
          floors={nodeB?.floorCount}
          reading={result?.b}
          onFloor={floor => actions.setCompareFloor('b', floor)}
        />
      </div>
      <div className="iris-compare__actions">
        <button
          type="button"
          className="iris-var__tool iris-compare__action"
          data-control="compare-swap"
          disabled={a === undefined || b === undefined}
          aria-label={t('compareSwap')}
          title={t('compareSwap')}
          onClick={() => actions.swapCompare()}
        >
          ⇅
        </button>
        <button
          type="button"
          className="iris-var__tool iris-compare__action"
          data-control="compare-close"
          aria-label={t('compareClose')}
          title={t('compareClose')}
          onClick={() => actions.setCompareMode(false)}
        >
          ✕
        </button>
      </div>
    </div>
  )

  let body: ReactElement
  if (a === undefined || b === undefined) {
    body = <p className="iris-aside__empty" data-control="compare-hint">{t(a === undefined ? 'comparePickA' : 'comparePickB')}</p>
  } else if (result === undefined) {
    body = <p className="iris-aside__empty">{loading ? t('compareLoading') : t('comparePickB')}</p>
  } else {
    const marks = compareMarks(result.entries, result.tables ?? {}, lang)
    const searching = query !== ''
    const keep = new Set([...marks.added, ...marks.changed.keys()])
    let shown: [string, unknown][] | undefined = marks.entries
    if (onlyChanges) shown = keepChanged(shown, keep)
    if (searching) shown = filterByName(shown ?? [], query)
    const removed = searching
      ? marks.removed.filter(row => row.label.toLowerCase().includes(query))
      : marks.removed
    // With 「只看变化」 on, or a search live, every branch drawn is a change or
    // the way to one, so it opens; folds made then are forgotten, as a search's are.
    const forcing = onlyChanges || searching
    const why = (side: 'a' | 'b'): string | undefined => {
      const missing = result[side].missing
      if (missing === undefined) return undefined
      const reason = missing === 'no-floor' ? 'compareMissingFloor' : missing === 'no-swipe' ? 'compareMissingSwipe' : 'compareMissingTable'
      return t('compareMissing', { side: side.toUpperCase(), why: t(reason) })
    }
    const notes = [
      why('a'),
      why('b'),
      ...(['a', 'b'] as const).map(side => result[side].source === 'turn' ? t('compareFromTurn', { side: side.toUpperCase() }) : undefined),
      ...(['a', 'b'] as const).map(side => result[side].pruned === true ? t('comparePruned', { side: side.toUpperCase() }) : undefined),
      marks.byIndex ? t('compareByIndex') : undefined,
    ].filter((note): note is string => note !== undefined)

    body = (
      <>
        <div className="iris-var__tools">
          <input
            type="search"
            className="iris-search iris-var__search"
            aria-label={t('stateSearchAria')}
            placeholder={t('stateSearchPlaceholder')}
            value={queryInput}
            data-control="compare-filter"
            onChange={event => setQueryInput(event.target.value)}
          />
          <div className="iris-var__toolrow">
            <button
              type="button"
              className="iris-var__tool iris-var__tool--toggle"
              aria-pressed={onlyChanges}
              data-control="compare-only-changes"
              title={t('stateOnlyChangesTitle')}
              onClick={() => setOnlyChanges(value => !value)}
            >
              {t('stateOnlyChanges')}
            </button>
          </div>
          <p
            className="iris-var__diffmeta"
            data-control="compare-summary"
            aria-label={translate(lang, 'compareSummaryAria', {
              added: result.summary.added,
              changed: result.summary.changed,
              removed: result.summary.removed,
            })}
          >
            <span className="iris-var__diffadd">+{result.summary.added}</span>
            {' '}
            <span className="iris-var__diffchg">~{result.summary.changed}</span>
            {' '}
            <span className="iris-var__diffrem">−{result.summary.removed}</span>
          </p>
        </div>
        {notes.length === 0 ? null : (
          <ul className="iris-compare__notes">
            {notes.map(note => <li key={note}>{note}</li>)}
          </ul>
        )}
        {result.identical ? <p className="iris-aside__empty">{t('compareIdentical')}</p> : null}
        {!result.identical && (shown === undefined || shown.length === 0) && removed.length === 0 ? (
          <p className="iris-aside__empty">{t('compareNoChanges')}</p>
        ) : null}
        {shown === undefined || shown.length === 0 ? null : (
          <StateRows
            entries={shown}
            depth={0}
            path=""
            opened={opened}
            searchToggled={forced}
            searching={forcing}
            added={marks.added}
            changed={new Set(marks.changed.keys())}
            changeHover={marks.changed}
            lang={lang}
            changeInline
            onToggle={(at, isOpen) => {
              if (forcing) {
                setForced(previous => {
                  const next = new Set(previous)
                  if (isOpen) next.delete(at)
                  else next.add(at)
                  return next
                })
                return
              }
              const next = new Map(opened)
              next.set(at, isOpen)
              setOpened(next)
            }}
          />
        )}
        {removed.length === 0 ? null : (
          <section className="iris-var__removed" data-control="compare-removed">
            <h3 className="iris-var__removedhead">{t('compareRemovedHead')}</h3>
            <dl className="iris-var">
              {removed.map(row => (
                <div className="iris-var__row" key={row.path} title={previewValue(row.value, lang)}>
                  <dt className="iris-var__key">
                    <span className="iris-var__delta iris-var__delta--gone">−</span>
                    {row.label}
                  </dt>
                  <dd className="iris-var__value iris-var__value--absent">{previewValue(row.value, lang)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </>
    )
  }

  return (
    <section className="iris-compare" aria-label={t('compareAria')} data-control="variable-compare">
      {header}
      {body}
    </section>
  )
}

/**
 * Whether the window is in the range where an open drawer costs this margin.
 *
 * A media query rather than a resize listener, so the browser decides when the
 * answer changed and this panel re-renders once per crossing instead of once
 * per frame of a drag. The initial value is read synchronously, because a first
 * paint at 236px followed by a jump to the strip is exactly the flicker the
 * stored preference is initialised eagerly to avoid.
 * @returns whether the window is tight, `false` where there is no `matchMedia`.
 */
function useTightWindow(): boolean {
  const [tight, setTight] = useState(() => probeTight())
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(ASIDE_YIELD_QUERY)
    const onChange = (): void => { setTight(query.matches) }
    // Read once on mount as well: a server render and the first client render
    // may disagree, and the effect is the first moment a real window is certain.
    onChange()
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [])
  return tight
}

/**
 * Ask the window whether it is tight, where there is a window to ask.
 * @returns the media query's answer, or `false` under `node --test`.
 */
function probeTight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(ASIDE_YIELD_QUERY).matches
}

/**
 * Whether an open margin is, right now, a panel over the page rather than a
 * docked column (`ASIDE_OVERLAY_QUERY`). Read at the moment of a keypress, not
 * subscribed: Escape is the only thing that asks.
 * @returns the media query's answer, or `false` where there is no `matchMedia`.
 */
function overlayNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(ASIDE_OVERLAY_QUERY).matches
}

/**
 * The margin's chevron, drawn once for both forms. It points the way the panel
 * will move; the strip's copy is mirrored in CSS (`panels.css`).
 * @returns the icon.
 */
function AsideChevron(): ReactElement {
  return (
    <svg
      className="iris-aside__chevron"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 2.5 7.5 6 4 9.5" />
    </svg>
  )
}

/**
 * Render the state margin.
 * @param props.drawerOpen - whether the settings drawer is showing. The margin
 *   yields its column to the drawer on a window that cannot pay for both
 *   (`state-panel.ts`, 让位) — which is a derivation, never a stored choice.
 * @returns the aside; hidden below the width where it has room.
 */
export function StatePanel({ drawerOpen }: { drawerOpen: boolean }): ReactElement | null {
  const variables = useIris(state => state.view?.variables)
  const chatId = useIris(state => state.chatId)
  const open = useIris(state => state.chatId !== undefined)
  const comparing = useIris(state => state.compare !== undefined)
  // Subscribed so a language switch re-renders the margin's words. Before the
  // early return: hook order must not depend on whether a chat is open.
  const { lang } = useLanguage()

  /*
   * Keyed by path rather than by object identity, so a branch stays open across
   * a refresh that replaced the objects underneath it — which is every refresh.
   */
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map())
  /** Folds made while a search is live; the search's openness is its own. */
  const [searchToggled, setSearchToggled] = useState<ReadonlySet<string>>(new Set())
  /** What the box holds right now; the filter waits for the reader to stop. */
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [onlyChanges, setOnlyChanges] = useState(false)
  /*
   * The reader's **own** choice: a 236px column or the 36px 「变量」 strip
   * (canvas.json: 固定 236px、可收起). Per device rather than per chat,
   * initialised from storage rather than in an effect, so a reader who folded
   * it away does not watch it open and shut on every load.
   *
   * What is on screen is `showing` below, which is this choice minus the yield.
   * Only the click writes here, and that is the whole discipline: the window is
   * allowed to override the choice, never to edit it.
   */
  const [asideOpen, setAsideOpen] = useState(loadAsideOpen)
  /*
   * 让位: an open drawer takes a whole column, and on a window that cannot pay
   * for sidebar + margin + drawer + a readable measure, this margin is the one
   * that stands down. Derived, never stored — `asideShowing` says why, and the
   * reader's stored choice comes back the moment the drawer closes.
   */
  const tight = useTightWindow()
  const showing = asideShowing(asideOpen, drawerOpen, tight)
  /** The reader asked for the column and the window took it: say so on hover. */
  const yielding = asideOpen && !showing
  /*
   * The tree stays mounted for one slide after the margin shuts (web §135).
   *
   * Collapsed, the margin renders no tree — that is the whole point of
   * collapsing it (see the comment at the render below). But the panel now
   * leaves by sliding out at its full 400px, and a panel emptied the moment
   * the slide starts would slide away blank. So the tree is dropped when the
   * slide has finished, not when it begins; on the way in there is nothing to
   * wait for, because `showing` itself mounts it.
   */
  const [leaving, setLeaving] = useState(false)
  const wasShowing = useRef(showing)
  useEffect(() => {
    if (wasShowing.current === showing) return
    wasShowing.current = showing
    if (showing) {
      setLeaving(false)
      return
    }
    setLeaving(true)
    const timer = setTimeout(() => setLeaving(false), FLANK_SLIDE_MS)
    return () => clearTimeout(timer)
  }, [showing])
  const rendered = showing || leaving
  /*
   * Focus follows the control across the two forms. The strip and the panel's
   * bar are two buttons now, and the one a reader pressed is hidden by its own
   * press — so without this, opening the margin as a panel over the page left
   * focus behind on an invisible strip, and closing it dropped focus to the
   * document. Only a reader's own toggle moves focus: a yield to the drawer is
   * the window's doing, and stealing focus for it would pull the reader out of
   * the drawer they just opened.
   */
  const strip = useRef<HTMLButtonElement>(null)
  const bar = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<'strip' | 'bar' | undefined>(undefined)
  useEffect(() => {
    const target = pendingFocus.current
    pendingFocus.current = undefined
    if (target === 'bar' && showing) bar.current?.focus()
    if (target === 'strip' && !showing) strip.current?.focus()
  }, [showing])
  const toggle = (): void => {
    const next = !asideOpen
    setAsideOpen(next)
    saveAsideOpen(next)
    pendingFocus.current = next ? 'bar' : 'strip'
  }

  const diff = useVariableDiff(chatId, variables)
  const searching = query !== ''

  // A new chat refolds the world: its own remembered folds, no search, no
  // diff view. The memory load is an effect rather than an initialiser because
  // the chat can change without the panel remounting.
  useEffect(() => {
    setOpened(loadFoldMemory(chatId ?? ''))
    setSearchToggled(new Set())
    setQueryInput('')
    setQuery('')
    setOnlyChanges(false)
  }, [chatId])

  // The debounce: filtering is cheap, but re-filtering between a reader's
  // keystrokes re-renders the tree under their fingers.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput.trim().toLowerCase()), SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [queryInput])

  if (!open) return null

  const entries = Object.entries(variables ?? {})
  const hasVariables = entries.length > 0

  // The diff view first, the search within it: both filters together keep the
  // changed entries whose names the reader is looking for.
  let shown: [string, unknown][] | undefined = entries
  if (onlyChanges) shown = keepChanged(shown, changedPaths(diff))
  if (searching) shown = filterByName(shown ?? [], query)

  const addedPaths = new Set(diff.added)
  /** Only true changes take the 改 badge — an added path is already marked 新,
   * and marking it twice reads as two facts where there is one. */
  const changedOnly = new Set(diff.changed.map(row => row.path))
  /** The hover sentence per changed row, built once per render. */
  const changeHover = new Map(diff.changed.map(row => [row.path, changeSentence(row.from, row.to, lang)]))
  const branchCount = branchPaths(entries).length
  const nothingMoved = diff.added.length + diff.changed.length + diff.removed.length === 0

  /** Apply a fold override and remember it — except during a search, whose
   * forced-open hit paths must not be written into memory wholesale. */
  const remember = (next: ReadonlyMap<string, boolean>): void => {
    setOpened(next)
    if (!searching) saveFoldMemory(chatId ?? '', next)
  }

  return (
    /*
     * `data-iris-aside` rather than a second class, and that is load-bearing:
     * `tools/render-check.tsx` matches `class="iris-aside"` **literally**, so a
     * modifier class here would fail the render check in the collapsed state and
     * in no test in this package. The attribute carries the state where CSS can
     * still read it (`panels.css`) and the class attribute stays one word.
     */
    <aside
      className="iris-aside"
      data-iris-aside={showing ? 'open' : 'shut'}
      aria-label={t('stateAria')}
      onKeyDown={event => {
        // A panel over the page closes on Escape, as a drawer does; a docked
        // column is part of the layout and leaves Escape to whatever has focus.
        if (event.key !== 'Escape' || !showing || !overlayNow()) return
        // The search box's own Escape (clear the query) comes first, and so does
        // the compare mode's (`TreeMap.tsx` listens on the document): while a
        // comparison is up, Escape leaves the comparison and the panel stays.
        // Returning before `stopPropagation` is what lets that listener hear it.
        if (event.target instanceof HTMLInputElement || comparing) return
        event.stopPropagation()
        toggle()
      }}
    >
      {/*
        The collapsed form: the 36px strip, a vertical 「变量」 under a chevron.
        Its own button since web §135, not the bar restyled — the panel has to
        keep its 400px layout while it slides out over the strip. Hidden (and
        so out of the tab order) while the panel is open.
      */}
      <button
        ref={strip}
        type="button"
        className="iris-aside__strip"
        aria-expanded={showing}
        title={yielding ? t('stateYielded') : t(asideOpen ? 'stateCollapse' : 'stateExpand')}
        onClick={toggle}
      >
        <span className="iris-label iris-aside__head">{t('stateHead')}</span>
        <AsideChevron />
      </button>

      {/*
        The open form: a 400px panel, absolutely positioned against the track's
        right edge (`panels.css`). Always mounted, so it can slide; what it holds
        is mounted only while it is showing or still sliding away.
      */}
      <div className="iris-aside__panel">
      {/*
        The heading row is the collapse control, and it sits outside the
        scroller: a toggle that scrolls away with the tree is a toggle the
        reader has to go and find. The whole row is the hit area, because 400px
        of margin gives a 12px chevron plenty of company.
      */}
      <button
        ref={bar}
        type="button"
        className="iris-aside__bar"
        aria-expanded={showing}
        /*
         * While yielding, the hover says why the column is not there — and the
         * control stays live rather than disabled: the click writes the same
         * per-device preference it always wrote, and it takes effect the moment
         * the drawer closes. A disabled toggle would have to explain itself
         * through a tooltip browsers do not reliably show on disabled elements.
         */
        title={yielding ? t('stateYielded') : t(asideOpen ? 'stateCollapse' : 'stateExpand')}
        onClick={toggle}
      >
        <span className="iris-label iris-aside__head">{t('stateHead')}</span>
        <AsideChevron />
      </button>

      {/*
        Collapsed, nothing below the bar renders. Not merely hidden: the tree
        is the expensive part of this panel — a real MVU card's `政局` branch
        alone is 34 rows — and a reader who folded the margin away should not go
        on paying to build it on every host event.

        `showing`, not the stored choice: while the margin is yielding to the
        drawer the strip is all there is room for. `rendered` adds the one slide
        after it shuts, so the panel does not leave empty (see `leaving`).
      */}
      {!rendered ? null : comparing ? (
        <div className="iris-aside__inner">
          <VariableCompareView lang={lang} />
        </div>
      ) : (
      <div className="iris-aside__inner">
        {hasVariables && (
          <div className="iris-var__tools">
            <input
              type="search"
              className="iris-search iris-var__search"
              aria-label={t('stateSearchAria')}
              placeholder={t('stateSearchPlaceholder')}
              value={queryInput}
              onChange={event => setQueryInput(event.target.value)}
            />
            <div className="iris-var__toolrow">
              <button
                type="button"
                className="iris-var__tool"
                disabled={branchCount === 0}
                onClick={() => remember(new Map(branchPaths(entries).map(at => [at, false])))}
              >
                {t('stateCollapseAll')}
              </button>
              <button
                type="button"
                className="iris-var__tool"
                disabled={branchCount === 0}
                onClick={() => remember(new Map(branchPaths(entries).map(at => [at, true])))}
              >
                {t('stateExpandAll')}
              </button>
              <button
                type="button"
                className="iris-var__tool iris-var__tool--toggle"
                aria-pressed={onlyChanges}
                title={t('stateOnlyChangesTitle')}
                disabled={nothingMoved}
                onClick={() => setOnlyChanges(value => !value)}
              >
                {t('stateOnlyChanges')}
              </button>
            </div>
            {nothingMoved ? null : (
              <p
                className="iris-var__diffmeta"
                aria-label={translate(lang, 'stateDiffSummaryAria', {
                  added: diff.added.length,
                  changed: diff.changed.length,
                  removed: diff.removed.length,
                })}
              >
                <span className="iris-var__diffadd">+{diff.added.length}</span>
                {' '}
                <span className="iris-var__diffchg">~{diff.changed.length}</span>
                {' '}
                <span className="iris-var__diffrem">−{diff.removed.length}</span>
              </p>
            )}
          </div>
        )}

        {/*
          Four empty states, each saying which one it is: no variables at all,
          a search with no hits, a diff view with nothing moved — and, under
          the diff view, the removals the tree cannot show in place.
        */}
        {!hasVariables ? (
          <p className="iris-aside__empty">{t('stateEmpty')}</p>
        ) : shown === undefined ? (
          <p className="iris-aside__empty">{t('stateSearchEmpty', { query })}</p>
        ) : shown.length === 0 && onlyChanges ? (
          <p className="iris-aside__empty">{t('stateNoChanges')}</p>
        ) : (
          <>
            <StateRows
              entries={shown}
              depth={0}
              path=""
              opened={opened}
              searchToggled={searchToggled}
              searching={searching}
              added={addedPaths}
              changed={changedOnly}
              changeHover={changeHover}
              lang={lang}
              onToggle={(at, isOpen) => {
                if (searching) {
                  setSearchToggled(previous => {
                    const next = new Set(previous)
                    // During a search, only a fold *against* the forced-open
                    // default says anything worth remembering.
                    if (isOpen) next.delete(at)
                    else next.add(at)
                    return next
                  })
                  return
                }
                const next = new Map(opened)
                next.set(at, isOpen)
                remember(next)
              }}
            />
            {onlyChanges && diff.removed.length > 0 && (
              <section className="iris-var__removed">
                <h3 className="iris-var__removedhead">{t('stateRemovedHead')}</h3>
                <dl className="iris-var">
                  {diff.removed.map(row => (
                    <div
                      className="iris-var__row"
                      key={row.path}
                      title={previewValue(row.value, lang)}
                    >
                      <dt className="iris-var__key">{row.path.split('/').pop()}</dt>
                      <dd className="iris-var__value iris-var__value--absent">
                        {previewValue(row.value, lang)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </>
        )}
      </div>
      )}
      {/*
        The margin's lower half: the branch tree map (owner placement ruling
        2026-09-25 — variables on top, tree map below). Same rule as the tree
        above it: not rendered at all while the margin is folded or yielding.
      */}
      {!rendered ? null : <AsideTreeSection />}
      </div>
    </aside>
  )
}
