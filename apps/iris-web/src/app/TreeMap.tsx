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
 * What is drawn is decided in `tree-map.ts`. This file only renders it, in the
 * margin under the variables (`StatePanel`) and in the narrow-window overlay
 * (`TreeMapOverlay`).
 *
 * @module iris-web/app/TreeMap
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { layoutTree, type TreeLane, type TreeNodeCell, type TreeRow } from './tree-map.ts'
import { useLanguage, t } from './i18n/use-language.ts'
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

/**
 * The map itself.
 * @param props.onPicked - called after a click has switched conversations, so
 *   the overlay can close itself.
 * @returns the map, or a sentence when there is nothing to draw yet.
 */
export function TreeMap({ onPicked }: { onPicked?: () => void }): ReactElement | null {
  const tree = useIris(state => state.tree)
  const chatId = useIris(state => state.chatId)
  const focus = useIris(state => state.treeFocus)
  const actions = useIrisActions()
  useLanguage()

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

  const go = (target: string, floor: number): void => {
    void actions.jumpToFloor(target, floor).then(() => onPicked?.())
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

  return (
    <div className="iris-tree" role="group" aria-label={t('treeAria')}>
      <div className="iris-tree__graph" style={{ height }}>
        <svg className="iris-tree__svg" width={graphWidth} height={height} aria-hidden="true" focusable="false">
          {layout.lanes.map(lane => (
            <LaneLines key={lane.chatId} lane={lane} x={x} centre={centre} rowOf={rowOf} />
          ))}
          {layout.rows.map((row, index) => row.kind !== 'floor' ? null : row.nodes.map(cell => {
            const lane = byLane.get(cell.lane)
            const onPath = lane?.pathEnd !== undefined && cell.floor <= lane.pathEnd
            return (
              <g
                key={`${cell.chatId}:${String(cell.floor)}`}
                className="iris-tree__dot"
                data-current={lane?.current === true ? '' : undefined}
                data-path={onPath ? '' : undefined}
                data-focus={cell.focus ? '' : undefined}
                onClick={() => go(cell.chatId, cell.floor)}
              >
                {cell.focus ? <circle className="iris-tree__halo" cx={x(cell.lane)} cy={centre(index)} r={7.5} /> : null}
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
              return (
                <li key={`gap-${String(row.from)}`} className="iris-tree__row iris-tree__row--gap" style={{ height: GAP_ROW }}>
                  {lane === undefined ? null : (
                    <button
                      type="button"
                      className="iris-tree__label iris-tree__label--gap"
                      title={t('treeGapTitle', { from: row.from, to: row.to })}
                      onClick={() => go(lane.chatId, row.from)}
                    >
                      ⋯ {t('treeGap', { n: row.count })}
                    </button>
                  )}
                </li>
              )
            }
            const main = primary(row)
            const heads = row.nodes.filter(cell => cell.head)
            const forks = row.nodes.reduce((sum, cell) => sum + cell.forks, 0)
            const swipes = Math.max(...row.nodes.map(cell => cell.swipes))
            const focused = row.nodes.some(cell => cell.focus)
            const lane = main === undefined ? undefined : byLane.get(main.lane)
            return (
              <li
                key={`floor-${String(row.floor)}-${String(index)}`}
                className="iris-tree__row"
                data-focus={focused ? '' : undefined}
                style={{ height: FLOOR_ROW }}
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
                    onClick={() => go(main.chatId, main.floor)}
                  >
                    <span className="iris-tree__floor">#{row.floor}</span>
                    {swipes > 1 ? <span className="iris-tree__badge" title={t('treeSwipes', { n: swipes })}>×{swipes}</span> : null}
                    {forks > 0 ? <span className="iris-tree__badge iris-tree__badge--fork" title={t('treeForks', { n: forks })}>⑂{forks}</span> : null}
                  </button>
                )}
                {heads.map(cell => {
                  const owner = byLane.get(cell.lane)
                  return (
                    <button
                      key={cell.chatId}
                      type="button"
                      className="iris-tree__label iris-tree__label--head"
                      data-current={owner?.current === true ? '' : undefined}
                      aria-label={t('treeNodeAria', { title: owner?.title ?? '', floor: cell.floor })}
                      title={owner?.unreadable === true ? t('treeUnreadable') : owner?.title}
                      onClick={() => go(cell.chatId, cell.floor)}
                    >
                      <span className="iris-tree__title">{owner?.title}</span>
                      {owner?.unreadable === true ? <span className="iris-tree__badge">!</span> : null}
                    </button>
                  )
                })}
              </li>
            )
          })}
        </ol>
      </div>
      {tree.chats[0]?.detachedFrom === undefined ? null : (
        <p className="iris-aside__empty iris-tree__note">{t('treeDetached')}</p>
      )}
      {solo ? <p className="iris-aside__empty iris-tree__note">{t('treeSolo')}</p> : null}
    </div>
  )
}

/**
 * One lane's strokes: its own run, its connector from the parent, and the
 * accent overlay for the part the reader's conversation runs through.
 */
function LaneLines({
  lane,
  x,
  centre,
  rowOf,
}: {
  lane: TreeLane
  x: (lane: number) => number
  centre: (index: number) => number
  rowOf: (floor: number) => number
}): ReactElement {
  const top = centre(rowOf(lane.start))
  const bottom = centre(rowOf(lane.end))
  const lx = x(lane.lane)
  const parts: ReactElement[] = []
  if (lane.parentLane !== undefined && lane.from !== undefined) {
    const px = x(lane.parentLane)
    const py = centre(rowOf(lane.from))
    // Out of the parent sideways, then down into the lane: the git-graph elbow.
    const d = py === top
      ? `M ${String(px)} ${String(py)} L ${String(lx)} ${String(top)}`
      : `M ${String(px)} ${String(py)} C ${String(px)} ${String((py + top) / 2)}, ${String(lx)} ${String((py + top) / 2)}, ${String(lx)} ${String(top)}`
    parts.push(
      <path
        key="fork"
        className="iris-tree__edge"
        data-path={lane.pathEnd !== undefined ? '' : undefined}
        d={d}
      />,
    )
  }
  if (bottom > top) {
    parts.push(<line key="run" className="iris-tree__run" x1={lx} y1={top} x2={lx} y2={bottom} />)
  }
  if (lane.pathEnd !== undefined) {
    const end = centre(rowOf(Math.min(lane.pathEnd, lane.end)))
    if (end > top) parts.push(<line key="path" className="iris-tree__run iris-tree__run--path" x1={lx} y1={top} x2={lx} y2={end} />)
  }
  return <g data-current={lane.current ? '' : undefined}>{parts}</g>
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
  useLanguage()
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
          {count === undefined || count < 2 ? null : <span className="iris-aside__treecount">{count}</span>}
        </div>
        <div className="iris-aside__treebody">
          <TreeMap />
        </div>
      </section>
    </>
  )
}
