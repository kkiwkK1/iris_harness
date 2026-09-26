/**
 * The branch tree map: a conversation's whole lineage as a vertical git graph.
 *
 * Floor 0 is at the top and each conversation (each SillyTavern chat file) has
 * its own lane. Runs of floors that nothing branches from fold into one
 * "N floors" segment, so a 600-floor conversation is a handful of rows. The
 * conversation on screen, and the floor the reader is on, are drawn in the
 * accent colour. Clicking a dot goes **straight** to that conversation at that
 * floor, with no preview step (owner ruling 2026-09-25). Swipes are a count on
 * the dot and never a lane, because a reading has no continuation.
 *
 * Each lane wears its own colour (the root is the neutral trunk) and is drawn
 * as thick as the conversation is active; hovering a lane says what the width
 * means. A lane's name carries a 「⋯」 menu to rename it in place or delete
 * it, with a confirm dialog that says where its sub-branches go (owner
 * request 2026-09-26).
 *
 * Each branch segment — a run of floors between fork points — carries a
 * hover card with its model-written summary (`SegmentSummary.tsx`), and the
 * header a 「总结所有分支段」; summaries are made only on request, never on
 * hover (2026-09-26).
 *
 * In the margin the map also has a 「比较变量」 mode (owner request
 * 2026-09-26): a click then picks a floor as A, then B, instead of going there,
 * the picks wear A/B marks, and the margin's upper half shows the variable
 * diff between them (`StatePanel.tsx`). Shift-click picks at any time; Escape
 * leaves the mode. The picks live in the store (`client/variable-compare.ts`).
 *
 * What is drawn is decided in `tree-map.ts`. This file only renders it, in the
 * margin under the variables (`StatePanel`) and in the narrow-window overlay
 * (`TreeMapOverlay`).
 *
 * @module iris-web/app/TreeMap
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { segmentsOf } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { deleteSummary, layoutTree, TRUNK, type TreeLane, type TreeNodeCell, type TreeRow } from './tree-map.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import { gapSegments, segmentHits, segmentOfFloor } from './segment-summary.ts'
import {
  focusedByKeyboard,
  SegmentCard,
  SegmentHits,
  SummarizeAllButton,
  useFamilySummaries,
  useSegmentHover,
  useSegmentSummarySync,
} from './SegmentSummary.tsx'
import type { VariableCompare } from '../client/variable-compare.ts'
import './tree-map.css'

/** Row heights, in CSS pixels: a floor gets room for a dot and its label, a folded run a little less. */
const FLOOR_ROW = 26
const GAP_ROW = 22
/** Lane spacing, and the narrowest it may shrink to when a family has many lanes. */
const LANE_STEP = 14
const LANE_MIN = 8
/** The graph column's widest allowance inside the 236px margin. */
const GRAPH_MAX = 96
const EDGE = 9

/**
 * Keep the open conversation's lineage fresh.
 *
 * Re-read when the conversation changes, when its floor count changes (a turn
 * landed or a floor was deleted), and when the chat list changes (a branch was
 * made, renamed or deleted anywhere).
 */
export function useTreeSync(): void {
  const chatId = useIris(state => state.chatId)
  const floors = useIris(state => state.view?.messages.length)
  const chats = useIris(state => state.chats)
  const actions = useIrisActions()
  useEffect(() => {
    if (chatId === undefined || floors === undefined) return
    void actions.loadTree(chatId)
  }, [actions, chatId, floors, chats])
}

/** Which side of the comparison a floor is, if either. */
function compareSide(compare: VariableCompare | undefined, chatId: string, floor: number): 'a' | 'b' | undefined {
  if (compare?.a?.chatId === chatId && compare.a.floor === floor) return 'a'
  if (compare?.b?.chatId === chatId && compare.b.floor === floor) return 'b'
  return undefined
}

/** The A/B mark beside a picked floor's label. */
function PickMark({ side }: { side: 'a' | 'b' | undefined }): ReactElement | null {
  if (side === undefined) return null
  const name = side.toUpperCase()
  return <span className="iris-tree__pick" data-side={side} title={t('compareMarkTitle', { side: name })}>{name}</span>
}

/**
 * The map itself.
 * @param props.onPicked - called after a click has switched conversations, so
 *   the overlay can close itself.
 * @param props.comparable - whether this map can pick floors for the variable
 *   comparison: true in the margin, whose upper half shows the diff; false in
 *   the narrow-window overlay, where there is nowhere to show one.
 * @returns the map, or a sentence when there is nothing to draw yet.
 */
export function TreeMap({ onPicked, comparable = false }: { onPicked?: () => void, comparable?: boolean }): ReactElement | null {
  const tree = useIris(state => state.tree)
  const chatId = useIris(state => state.chatId)
  const focus = useIris(state => state.treeFocus)
  const compare = useIris(state => state.compare)
  const actions = useIrisActions()
  useLanguage()
  // One lane name edits at a time, and one delete asks at a time.
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  // The segment-summary layer: its store sync, the one open card, the summaries.
  useSegmentSummarySync()
  const hover = useSegmentHover()
  const summaries = useFamilySummaries(tree)

  if (chatId === undefined) return null
  if (tree === undefined || !tree.chats.some(node => node.chatId === chatId)) {
    return <p className="iris-aside__empty iris-tree__empty">{t('treeLoading')}</p>
  }

  // The floor last jumped to in this conversation, else its newest floor.
  const head = Math.max(0, (tree.chats.find(node => node.chatId === chatId)?.floorCount ?? 1) - 1)
  const layout = layoutTree(tree, focus?.chatId === chatId ? focus : { chatId, floor: head })

  const laneCount = layout.lanes.length
  const step = laneCount <= 1 ? LANE_STEP : Math.max(LANE_MIN, Math.min(LANE_STEP, (GRAPH_MAX - EDGE * 2) / (laneCount - 1)))
  const graphWidth = EDGE * 2 + step * Math.max(0, laneCount - 1)
  const x = (lane: number): number => EDGE + lane * step

  // Row geometry, top down.
  const tops: number[] = []
  let height = 0
  for (const row of layout.rows) {
    tops.push(height)
    height += row.kind === 'floor' ? FLOOR_ROW : GAP_ROW
  }
  const centre = (index: number): number => (tops[index] ?? 0) + (layout.rows[index]?.kind === 'floor' ? FLOOR_ROW : GAP_ROW) / 2
  const rowOf = (floor: number): number => layout.rows.findIndex(row => row.kind === 'floor' && row.floor === floor)

  const jump = (target: string, floor: number): void => {
    void actions.jumpToFloor(target, floor).then(() => onPicked?.())
  }
  /*
   * Every target on the map goes through here. In compare mode, or on a
   * Shift-click, the floor is picked for the comparison and the reader stays
   * where they are; otherwise it is the ordinary straight jump.
   */
  const picking = comparable && compare !== undefined
  const go = (target: string, floor: number, shift = false): void => {
    if (comparable && (picking || shift)) actions.pickCompare({ chatId: target, floor })
    else jump(target, floor)
  }
  const byLane = new Map(layout.lanes.map(lane => [lane.lane, lane]))

  /** The node a row's label stands for: the one on the reader's line, else the first. */
  const primary = (row: Extract<TreeRow, { kind: 'floor' }>): TreeNodeCell | undefined => {
    const onPath = row.nodes.filter(cell => {
      const lane = byLane.get(cell.lane)
      return lane?.pathEnd !== undefined && cell.floor <= lane.pathEnd
    })
    return onPath.at(-1) ?? row.nodes[0]
  }

  const solo = tree.chats.length === 1

  // Branch segments, cut by the same rule the host summarizes by.
  const segments = segmentsOf(tree)
  const titles = new Map(layout.lanes.map(lane => [lane.chatId, lane.title]))
  const rowHeight = (index: number): number => (layout.rows[index]?.kind === 'floor' ? FLOOR_ROW : GAP_ROW)
  /** The card, drawn inside the row it hangs under so Tab walks from the trigger into it. */
  const card = (index: number): ReactElement | null => (hover.open?.row !== index ? null : (
    <SegmentCard hover={hover} chatId={chatId} top={(tops[index] ?? 0) + rowHeight(index)} titles={titles} summaries={summaries} />
  ))
  /** A floor label or lane name focused by the keyboard opens its segment's card. */
  const focusFloor = (element: Element, target: string, floor: number, index: number): void => {
    if (!focusedByKeyboard(element)) return
    const segment = segmentOfFloor(tree, segments, target, floor)
    if (segment !== undefined) hover.show({ segments: [segment], row: index })
  }

  return (
    <div className="iris-tree" role="group" aria-label={t('treeAria')}>
      <div className="iris-tree__graph" style={{ height }}>
        <svg className="iris-tree__svg" width={graphWidth} height={height} aria-hidden="true" focusable="false">
          {layout.lanes.map(lane => (
            <LaneLines key={lane.chatId} lane={lane} x={x} centre={centre} rowOf={rowOf} tip={laneTip(lane)} />
          ))}
          <SegmentHits hits={segmentHits(layout, segments)} x={x} centre={centre} hover={hover} />
          {layout.rows.map((row, index) => row.kind !== 'floor' ? null : row.nodes.map(cell => {
            const lane = byLane.get(cell.lane)
            const onPath = lane?.pathEnd !== undefined && cell.floor <= lane.pathEnd
            return (
              <g
                key={`${cell.chatId}:${String(cell.floor)}`}
                className="iris-tree__dot"
                data-iris-hue={hueAttr(lane?.hue)}
                data-current={lane?.current === true ? '' : undefined}
                data-path={onPath ? '' : undefined}
                data-focus={cell.focus ? '' : undefined}
                data-compare={comparable ? compareSide(compare, cell.chatId, cell.floor) : undefined}
                onClick={event => go(cell.chatId, cell.floor, event.shiftKey)}
              >
                {cell.focus ? <circle className="iris-tree__halo" cx={x(cell.lane)} cy={centre(index)} r={7.5} /> : null}
                {comparable && compareSide(compare, cell.chatId, cell.floor) !== undefined
                  ? <circle className="iris-tree__pickring" cx={x(cell.lane)} cy={centre(index)} r={6.5} />
                  : null}
                <circle cx={x(cell.lane)} cy={centre(index)} r={cell.focus ? 4.5 : 3.5} />
                <title>{t('treeNodeAria', { title: lane?.title ?? '', floor: cell.floor })}</title>
              </g>
            )
          }))}
        </svg>
        <ol className="iris-tree__rows" style={{ paddingLeft: graphWidth }}>
          {layout.rows.map((row, index) => {
            if (row.kind === 'gap') {
              const lane = row.lanes.find(entry => {
                const drawn = byLane.get(entry.lane)
                return drawn?.pathEnd !== undefined && row.from <= drawn.pathEnd
              }) ?? row.lanes[0]
              // The folded run's own card: the segment of every lane it is
              // drawn on, and where a click goes — the words its tooltip had.
              const openGap = (): void => hover.show({
                segments: gapSegments(row, segments),
                row: index,
                hint: t('treeGapTitle', { from: row.from, to: row.to }),
              })
              return (
                <li key={`gap-${String(row.from)}`} className="iris-tree__row iris-tree__row--gap" style={{ height: GAP_ROW }}>
                  {lane === undefined ? null : (
                    <button
                      type="button"
                      className="iris-tree__label iris-tree__label--gap"
                      aria-describedby={hover.open?.row === index ? hover.id : undefined}
                      onClick={event => go(lane.chatId, row.from, event.shiftKey)}
                      onPointerEnter={openGap}
                      onPointerLeave={hover.leave}
                      onFocus={openGap}
                      onBlur={hover.leave}
                    >
                      ⋯ {t('treeGap', { n: row.count })}
                    </button>
                  )}
                  {card(index)}
                </li>
              )
            }
            const main = primary(row)
            const heads = row.nodes.filter(cell => cell.head)
            const forks = row.nodes.reduce((sum, cell) => sum + cell.forks, 0)
            const swipes = Math.max(...row.nodes.map(cell => cell.swipes))
            const focused = row.nodes.some(cell => cell.focus)
            const lane = main === undefined ? undefined : byLane.get(main.lane)
            const side = !comparable || main === undefined ? undefined : compareSide(compare, main.chatId, main.floor)
            return (
              <li
                key={`floor-${String(row.floor)}-${String(index)}`}
                className="iris-tree__row"
                data-focus={focused ? '' : undefined}
                data-compare={side}
                style={{ height: FLOOR_ROW }}
                onFocus={event => {
                  // Delegated, so the floor label and every lane name on the
                  // row open their segment's card without a prop each.
                  const target = event.target as Element
                  const head = target.closest('.iris-tree__head')
                  const heads = [...event.currentTarget.querySelectorAll('.iris-tree__head')]
                  const cell = head === null ? main : row.nodes.filter(one => one.head)[heads.indexOf(head)]
                  if (cell !== undefined && target.classList.contains('iris-tree__label')) {
                    focusFloor(target, cell.chatId, cell.floor, index)
                  }
                }}
                onBlur={hover.leave}
              >
                {/*
                  Two kinds of target on one row, each saying where it goes:
                  the floor number goes to that floor on the reader's own line
                  (or the first lane that draws it), and each title is the
                  newest floor of the conversation it names. One button that
                  showed a branch's title but went to the parent was the first
                  version, and a reader clicking a name would land somewhere
                  else.
                */}
                {main === undefined ? null : (
                  <button
                    type="button"
                    className="iris-tree__label iris-tree__label--floor"
                    aria-current={focused ? 'location' : undefined}
                    aria-label={t('treeNodeAria', { title: lane?.title ?? '', floor: row.floor })}
                    title={focused ? t('treeYouAreHere') : undefined}
                    onClick={event => go(main.chatId, main.floor, event.shiftKey)}
                  >
                    <PickMark side={side} />
                    <span className="iris-tree__floor">#{row.floor}</span>
                    {swipes > 1 ? <span className="iris-tree__badge" title={t('treeSwipes', { n: swipes })}>×{swipes}</span> : null}
                    {forks > 0 ? <span className="iris-tree__badge iris-tree__badge--fork" title={t('treeForks', { n: forks })}>⑂{forks}</span> : null}
                  </button>
                )}
                {heads.map(cell => {
                  const owner = byLane.get(cell.lane)
                  if (owner === undefined) return null
                  return (
                    <LaneHead
                      key={cell.chatId}
                      lane={owner}
                      floor={cell.floor}
                      editing={renaming === cell.chatId}
                      pick={comparable ? compareSide(compare, cell.chatId, cell.floor) : undefined}
                      onGo={shift => go(cell.chatId, cell.floor, shift)}
                      onRename={() => setRenaming(cell.chatId)}
                      onRenamed={title => {
                        setRenaming(undefined)
                        if (title !== '' && title !== owner.title) void actions.renameChat(cell.chatId, title)
                      }}
                      onDelete={() => setDeleting(cell.chatId)}
                    />
                  )
                })}
                {card(index)}
              </li>
            )
          })}
        </ol>
      </div>
      {tree.chats[0]?.detachedFrom === undefined ? null : (
        <p className="iris-aside__empty iris-tree__note">{t('treeDetached')}</p>
      )}
      {solo ? <p className="iris-aside__empty iris-tree__note">{t('treeSolo')}</p> : null}
      {deleting === undefined ? null : (
        <BranchDeleteDialog
          chatId={deleting}
          viewing={chatId}
          onClose={() => setDeleting(undefined)}
          onConfirm={subBranches => {
            setDeleting(undefined)
            void actions.deleteChat(deleting, { subBranches })
          }}
        />
      )}
    </div>
  )
}

/**
 * One lane's strokes: its own run, its connector from the parent, and the
 * accent overlay for the part the reader's conversation runs through.
 *
 * The lane is drawn in its own colour (`data-iris-hue`, the same slot the
 * sidebar's row marker wears) and as thick as it is active
 * (`lane.activity.width`). The accent overlay is drawn a little wider than
 * the lane under it, so the reader's path covers the lane's colour rather
 * than sitting beside it. A wide transparent stroke on top carries the
 * tooltip that says what the width means.
 */
function LaneLines({
  lane,
  x,
  centre,
  rowOf,
  tip,
}: {
  lane: TreeLane
  x: (lane: number) => number
  centre: (index: number) => number
  rowOf: (floor: number) => number
  tip: string
}): ReactElement {
  const top = centre(rowOf(lane.start))
  const bottom = centre(rowOf(lane.end))
  const lx = x(lane.lane)
  const width = lane.activity.width
  const pathWidth = Math.max(width + 0.6, 2.4)
  const parts: ReactElement[] = []
  let d: string | undefined
  if (lane.parentLane !== undefined && lane.from !== undefined) {
    const px = x(lane.parentLane)
    const py = centre(rowOf(lane.from))
    // Out of the parent sideways, then down into the lane: the git-graph elbow.
    d = py === top
      ? `M ${String(px)} ${String(py)} L ${String(lx)} ${String(top)}`
      : `M ${String(px)} ${String(py)} C ${String(px)} ${String((py + top) / 2)}, ${String(lx)} ${String((py + top) / 2)}, ${String(lx)} ${String(top)}`
    parts.push(
      <path
        key="fork"
        className="iris-tree__edge"
        data-path={lane.pathEnd !== undefined ? '' : undefined}
        style={{ strokeWidth: lane.pathEnd !== undefined ? pathWidth : width }}
        d={d}
      />,
    )
  }
  if (bottom > top) {
    parts.push(<line key="run" className="iris-tree__run" style={{ strokeWidth: width }} x1={lx} y1={top} x2={lx} y2={bottom} />)
  }
  if (lane.pathEnd !== undefined) {
    const end = centre(rowOf(Math.min(lane.pathEnd, lane.end)))
    if (end > top) {
      parts.push(
        <line key="path" className="iris-tree__run iris-tree__run--path" style={{ strokeWidth: pathWidth }} x1={lx} y1={top} x2={lx} y2={end} />,
      )
    }
  }
  // The hover target: the connector and the run, widened and invisible.
  const hit = `${d === undefined ? '' : `${d} `}M ${String(lx)} ${String(top)} L ${String(lx)} ${String(Math.max(bottom, top + 0.01))}`
  parts.push(
    <path key="hit" className="iris-tree__hit" d={hit}>
      <title>{tip}</title>
    </path>,
  )
  return (
    <g
      className="iris-tree__lane"
      data-iris-hue={hueAttr(lane.hue)}
      data-current={lane.current ? '' : undefined}
      data-weight={String(width)}
    >
      {parts}
    </g>
  )
}

/** The `data-iris-hue` value for a palette slot: `trunk` for a root. */
function hueAttr(hue: number | undefined): string | undefined {
  if (hue === undefined) return undefined
  return hue === TRUNK ? 'trunk' : String(hue)
}

/** How long before the family's newest activity, in the tooltip's words. */
function ageText(days: number): string {
  if (days < 1 / 24) return t('treeAgeNone')
  if (days < 1) return t('treeAgeHours', { n: Math.round(days * 24) })
  return t('treeAgeDays', { n: days < 10 ? Math.round(days * 10) / 10 : Math.round(days) })
}

/** The lane tooltip: what its line weight is made of. */
function laneTip(lane: TreeLane): string {
  return t('treeActivity', {
    title: lane.title,
    width: lane.activity.width,
    pct: Math.round(lane.activity.score * 100),
    own: lane.activity.own,
    age: ageText(lane.activity.ageDays),
  })
}

/**
 * A lane's name at its newest floor, with the two ways to manage it: a
 * 「⋯」 menu (rename, delete), and F2 or a double-click to rename in place.
 *
 * Renaming replaces the name with a field. Enter or leaving the field keeps
 * the new name, Escape keeps the old one; an empty name is not sent. The
 * title then updates everywhere at once, because the sidebar, the map and the
 * masthead all read the list `chat.rename` answers with.
 */
function LaneHead({
  lane,
  floor,
  editing,
  pick,
  onGo,
  onRename,
  onRenamed,
  onDelete,
}: {
  lane: TreeLane
  floor: number
  editing: boolean
  /** The comparison side this lane's newest floor was picked as, if either. */
  pick?: 'a' | 'b' | undefined
  onGo: (shift: boolean) => void
  onRename: () => void
  onRenamed: (title: string) => void
  onDelete: () => void
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState(lane.title)
  const field = useRef<HTMLInputElement | null>(null)
  const done = useRef(false)
  useEffect(() => {
    if (!editing) return
    done.current = false
    setDraft(lane.title)
    field.current?.focus()
    field.current?.select()
  }, [editing, lane.title])

  if (editing) {
    const finish = (keep: boolean): void => {
      if (done.current) return
      done.current = true
      onRenamed(keep ? draft.trim() : lane.title)
    }
    return (
      <span className="iris-tree__head iris-tree__head--editing" data-iris-hue={hueAttr(lane.hue)}>
        <input
          ref={field}
          className="iris-text iris-tree__rename"
          type="text"
          value={draft}
          maxLength={200}
          data-control="tree-rename"
          aria-label={t('treeRenameAria', { title: lane.title })}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              finish(true)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              finish(false)
            }
          }}
          onBlur={() => finish(true)}
        />
      </span>
    )
  }

  return (
    <span className="iris-tree__head" data-iris-hue={hueAttr(lane.hue)} data-menu={menuOpen ? '' : undefined}>
      <button
        type="button"
        className="iris-tree__label iris-tree__label--head"
        data-current={lane.current ? '' : undefined}
        aria-label={t('treeNodeAria', { title: lane.title, floor })}
        title={lane.unreadable ? t('treeUnreadable') : lane.title}
        onClick={event => onGo(event.shiftKey)}
        onDoubleClick={event => {
          event.preventDefault()
          onRename()
        }}
        onKeyDown={event => {
          if (event.key === 'F2') {
            event.preventDefault()
            onRename()
          }
        }}
      >
        <PickMark side={pick} />
        <span className="iris-tree__swatch" aria-hidden="true" />
        <span className="iris-tree__title">{lane.title}</span>
        {lane.unreadable ? <span className="iris-tree__badge">!</span> : null}
      </button>
      <Menu
        open={menuOpen}
        portal
        align="end"
        compact
        anchor={
          <button
            type="button"
            className="iris-tree__more"
            data-control="tree-lane-actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('treeActionsFor', { title: lane.title })}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            ⋯
          </button>
        }
        items={[
          { id: 'rename', label: t('treeRename') },
          { id: 'delete', label: lane.parentLane === undefined ? t('deleteConversation') : t('treeDelete'), danger: true },
        ]}
        onSelect={id => {
          setMenuOpen(false)
          if (id === 'rename') onRename()
          else if (id === 'delete') onDelete()
        }}
        onClose={() => setMenuOpen(false)}
      />
    </span>
  )
}

/**
 * The confirm dialog for deleting one conversation of the lineage.
 *
 * It names the conversation and its floor count and says what happens to its
 * sub-branches: by default they re-attach to its parent (or, for a root, the
 * first of them becomes the root), and a checkbox takes them along instead.
 * It says where the reader goes when the conversation being read is among
 * the ones deleted. Backups are kept either way (owner ruling 5).
 *
 * Exported for the floor's ⑂N list (`Message.tsx`), which offers the same
 * delete from the reading surface.
 */
export function BranchDeleteDialog({
  chatId,
  viewing,
  onClose,
  onConfirm,
}: {
  chatId: string
  viewing: string
  onClose: () => void
  onConfirm: (subBranches: 'reattach' | 'delete') => void
}): ReactElement | null {
  const tree = useIris(state => state.tree)
  const [cascade, setCascade] = useState(false)
  useLanguage()
  const summary = deleteSummary(tree, chatId)
  if (summary === undefined) return null

  // Whether the reader is inside what goes, and where they will land.
  const byId = new Map((tree?.chats ?? []).map(node => [node.chatId, node]))
  const inSubtree = (id: string): boolean => {
    const seen = new Set<string>()
    for (let at: string | undefined = id; at !== undefined && !seen.has(at); at = byId.get(at)?.parentChatId) {
      if (at === chatId) return true
      seen.add(at)
    }
    return false
  }
  const readerGoes = viewing === chatId || (cascade && inSubtree(viewing))
  const next = summary.parent ?? (cascade ? undefined : summary.promoted)
  const total = cascade ? summary.descendants + 1 : 1

  return (
    <Modal
      open
      onClose={onClose}
      title={t('treeDeleteTitle', { title: summary.title })}
      closeLabel={t('close')}
      className="iris-tree-delete"
    >
      <div className="iris-tree-delete__body">
        <p>{t('treeDeleteFloors', { title: summary.title, floors: summary.floors })}</p>
        {summary.children === 0 || cascade ? null : summary.parent !== undefined ? (
          <p>{t('treeDeleteReattach', { n: summary.children, parent: summary.parent.title })}</p>
        ) : summary.promoted !== undefined ? (
          <p>{t('treeDeletePromote', { child: summary.promoted.title })}</p>
        ) : null}
        {summary.descendants === 0 ? null : (
          <label className="iris-tree-delete__cascade">
            <input
              type="checkbox"
              checked={cascade}
              data-control="tree-delete-cascade"
              onChange={event => setCascade(event.target.checked)}
            />
            <span>{t('treeDeleteCascade', { n: summary.descendants, total: summary.descendants + 1 })}</span>
          </label>
        )}
        {readerGoes && next !== undefined ? <p>{t('treeDeleteViewing', { next: next.title })}</p> : null}
      </div>
      <div className="iris-tree-delete__actions">
        <Button variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="outline"
          size="sm"
          className="iris-tree-delete__go"
          data-control="tree-delete-confirm"
          onClick={() => onConfirm(cascade ? 'delete' : 'reattach')}
        >
          {total > 1 ? t('treeDeleteConfirmMany', { n: total }) : t('treeDeleteConfirm')}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * The map as an overlay, for a window too narrow for the margin.
 * @param props.open - whether it shows.
 * @param props.onClose - closes it.
 * @returns the dialog.
 */
export function TreeMapOverlay({ open, onClose }: { open: boolean, onClose: () => void }): ReactElement {
  useLanguage()
  return (
    <Modal open={open} onClose={onClose} title={t('treeHead')} closeLabel={t('close')} className="iris-tree-dialog">
      <div className="iris-tree-dialog__tools"><SummarizeAllButton /></div>
      <TreeMap onPicked={onClose} />
    </Modal>
  )
}

/** Where the reader's split between variables and map is remembered, per device. */
const SPLIT_KEY = 'iris.aside.treeHeight'
/** The map's smallest and the variables' smallest share of the margin, in px. */
const SPLIT_MIN = 96
const VARS_MIN = 140

/** Read the remembered split; storage can be absent or refuse. */
function loadSplit(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(SPLIT_KEY)
    const value = raw === null || raw === undefined ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value >= SPLIT_MIN ? value : undefined
  } catch {
    return undefined
  }
}

/** Remember the split; a refusal only costs the next load its memory. */
function saveSplit(height: number): void {
  try {
    globalThis.localStorage?.setItem(SPLIT_KEY, String(Math.round(height)))
  } catch {
    // Storage refused: the split still holds for this page.
  }
}

/**
 * The margin's lower half: a divider, the "分支" heading and the map.
 *
 * Rendered by `StatePanel` under the variables, and only while the margin is
 * showing. The divider drags (pointer) and steps (arrow keys); the split is
 * remembered per device, the way the margin's own open/shut choice is.
 * @returns the section.
 */
export function AsideTreeSection(): ReactElement {
  const tree = useIris(state => state.tree)
  const chatId = useIris(state => state.chatId)
  const comparing = useIris(state => state.compare !== undefined)
  const actions = useIrisActions()
  useLanguage()
  // Escape leaves the compare mode — unless something nearer the key (a dialog,
  // a menu, the rename field) has already answered it.
  useEffect(() => {
    if (!comparing) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      actions.setCompareMode(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [actions, comparing])
  const section = useRef<HTMLElement | null>(null)
  const [height, setHeight] = useState<number | undefined>(loadSplit)
  const [dragging, setDragging] = useState(false)

  const clamp = (next: number): number => {
    const aside = section.current?.parentElement
    const room = aside === null || aside === undefined ? next : aside.clientHeight - VARS_MIN
    return Math.max(SPLIT_MIN, Math.min(next, Math.max(SPLIT_MIN, room)))
  }
  const count = tree !== undefined && tree.chats.some(node => node.chatId === chatId) ? tree.chats.length : undefined

  return (
    <>
      <button
        type="button"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('treeHead')}
        className="iris-aside__divider"
        data-dragging={dragging ? '' : undefined}
        onPointerDown={event => {
          const aside = section.current?.parentElement
          if (aside === null || aside === undefined) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={event => {
          if (!dragging) return
          const aside = section.current?.parentElement
          if (aside === null || aside === undefined) return
          setHeight(clamp(aside.getBoundingClientRect().bottom - event.clientY))
        }}
        onPointerUp={event => {
          if (!dragging) return
          event.currentTarget.releasePointerCapture(event.pointerId)
          setDragging(false)
          if (height !== undefined) saveSplit(height)
        }}
        onKeyDown={event => {
          const step = event.key === 'ArrowUp' ? 24 : event.key === 'ArrowDown' ? -24 : 0
          if (step === 0) return
          event.preventDefault()
          const next = clamp((height ?? section.current?.clientHeight ?? SPLIT_MIN) + step)
          setHeight(next)
          saveSplit(next)
        }}
      />
      <section
        ref={section}
        className="iris-aside__tree"
        aria-label={t('treeAria')}
        style={height === undefined ? undefined : { height }}
      >
        <div className="iris-aside__treebar">
          <span className="iris-label iris-aside__head">{t('treeHead')}</span>
          <span className="iris-aside__treetools">
            <SummarizeAllButton />
            {count === undefined || count < 2 ? null : <span className="iris-aside__treecount">{count}</span>}
            <button
              type="button"
              className="iris-var__tool iris-var__tool--toggle iris-aside__treetool"
              data-control="tree-compare"
              aria-pressed={comparing}
              title={t('compareModeTitle')}
              onClick={() => actions.setCompareMode(!comparing)}
            >
              {t('compareMode')}
            </button>
          </span>
        </div>
        <div className="iris-aside__treebody" data-comparing={comparing ? '' : undefined}>
          <TreeMap comparable />
        </div>
      </section>
    </>
  )
}
