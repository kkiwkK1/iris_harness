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
 * @module iris-web/app/StatePanel
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

import { useIris } from '../client/provider.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { translate, type Language } from './i18n/strings.ts'
import {
  branchPaths,
  changeSentence,
  changedPaths,
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
              <summary className="iris-var__summary">
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
                />
              </div>
            </details>
          )
        }

        const stacked = shown.kind === 'text' && shown.text.length > RANGED_RIGHT_LIMIT
        const classes = ['iris-var__value']
        if (shown.kind === 'absent') classes.push('iris-var__value--absent')
        if (shown.kind === 'text' && shown.faint) classes.push('iris-var__value--faint')
        if (shown.kind === 'text' && shown.numeric) classes.push('iris-var__value--numeric')

        return (
          <div
            className={stacked ? 'iris-var__row iris-var__row--stacked' : 'iris-var__row'}
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
            <dd className={classes.join(' ')} title={shown.kind === 'text' ? shown.text : undefined}>
              {shown.kind === 'absent' ? '—' : shown.text}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/**
 * Render the state margin.
 * @returns the aside; hidden below the width where it has room.
 */
export function StatePanel(): ReactElement | null {
  const variables = useIris(state => state.view?.variables)
  const chatId = useIris(state => state.chatId)
  const open = useIris(state => state.chatId !== undefined)
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
   * Whether the margin is showing at all — a 236px column or the 36px 「变量」
   * strip (canvas.json: 固定 236px、可收起). Per device rather than per chat,
   * initialised from storage rather than in an effect, so a reader who folded
   * it away does not watch it open and shut on every load.
   */
  const [asideOpen, setAsideOpen] = useState(loadAsideOpen)

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
      data-iris-aside={asideOpen ? 'open' : 'shut'}
      aria-label={t('stateAria')}
    >
      {/*
        The heading row is the collapse control, and it sits outside the
        scroller: a toggle that scrolls away with the tree is a toggle the
        reader has to go and find. The whole row is the hit area, because 236px
        of margin gives a 12px chevron plenty of company.
      */}
      <button
        type="button"
        className="iris-aside__bar"
        aria-expanded={asideOpen}
        title={t(asideOpen ? 'stateCollapse' : 'stateExpand')}
        onClick={() => {
          const next = !asideOpen
          setAsideOpen(next)
          saveAsideOpen(next)
        }}
      >
        <span className="iris-label iris-aside__head">{t('stateHead')}</span>
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
      </button>

      {/*
        Collapsed, nothing below the strip renders. Not merely hidden: the tree
        is the expensive part of this panel — a real MVU card's `政局` branch
        alone is 34 rows — and a reader who folded the margin away should not go
        on paying to build it on every host event.
      */}
      {!asideOpen ? null : (
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
    </aside>
  )
}
