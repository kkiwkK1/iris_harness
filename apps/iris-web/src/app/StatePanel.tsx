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
 * Marginalia, in other words. Same figure as the variant rail, one scale up.
 *
 * **Why this stopped using `JsonTree`.** It was the first debugging panel and it
 * survived into the product: a syntax-coloured tree with red and purple string
 * literals, brace punctuation, and its own horizontal scrollbar, sitting beside a
 * serif reading surface. The reader was being told, in the strongest visual terms
 * available, that this column belongs to a different program. The same data is
 * drawn here now as an **index**: keys in the annotation sans, values ranged
 * right, nesting shown by indentation under a hairline instead of by punctuation,
 * and no colour carrying meaning at all.
 *
 * Three things the old tree got wrong that are rules here rather than preferences:
 *
 * - **No horizontal scrollbar.** A long value wraps, the way every other body of
 *   text on this page wraps. A 260px column that scrolls sideways cannot show the
 *   start and the end of a line at once, which is unreadable in the literal sense.
 * - **Keys are never uppercased or letter-spaced.** The label treatment that suits
 *   "STATE" destroys CJK, and most of the corpus's variable names are Chinese.
 * - **Colour is not a type system.** Kind is carried typographically — numerals
 *   are tabular, absence is an em dash — so the panel reads correctly in both
 *   themes and for anyone who does not separate red from purple.
 *
 * @module iris-web/app/StatePanel
 */

import { useState, type ReactElement } from 'react'

import { useIris } from '../client/provider.tsx'

/** How one value wants to be typeset. */
type Shown =
  | { kind: 'text', text: string, numeric: boolean }
  | { kind: 'absent' }
  | { kind: 'branch', entries: [string, unknown][] }

/** The scalar types that can share one line with their key. */
const SCALARS: readonly string[] = ['string', 'number', 'boolean']

/**
 * Decide how a value is drawn, which is the only place kinds are distinguished.
 *
 * An array of scalars collapses to a single line rather than becoming a branch: a
 * list of three tags is a value, and giving it a disclosure triangle and three
 * numbered rows buries it under more structure than it has.
 * @param value - the raw value from the snapshot.
 * @returns how to draw it.
 */
function describe(value: unknown): Shown {
  if (value === null || value === undefined) return { kind: 'absent' }
  if (typeof value === 'boolean') return { kind: 'text', text: value ? 'yes' : 'no', numeric: false }
  if (typeof value === 'number') return { kind: 'text', text: String(value), numeric: true }
  if (typeof value === 'string') {
    // An empty string and a missing key are the same thing to a reader, and
    // drawing one as a blank line leaves them wondering whether it failed to load.
    return value.trim() === '' ? { kind: 'absent' } : { kind: 'text', text: value, numeric: false }
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'absent' }
    const flat = value.every(entry => entry === null || SCALARS.includes(typeof entry))
    if (flat) {
      return {
        kind: 'text',
        text: value.map(entry => (entry === null ? '—' : String(entry))).join(', '),
        numeric: false,
      }
    }
    // One-based, because these are positions a reader counts, not indices.
    return { kind: 'branch', entries: value.map((entry, at) => [String(at + 1), entry]) }
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.length === 0 ? { kind: 'absent' } : { kind: 'branch', entries }
  }

  return { kind: 'text', text: String(value), numeric: false }
}

/**
 * Beyond this many characters a value stops sharing a line with its key.
 *
 * Ranged-right values are the point of an index — the eye runs down a column of
 * numbers — but this column is 260px wide, so a sentence set against its key
 * squeezes the key to two characters a line. Past this length the value takes its
 * own full-width line underneath, which is what a marginal note does when it has
 * something to say rather than something to tally.
 */
const RANGED_RIGHT_LIMIT = 22

/**
 * How deep a branch may be before it arrives closed.
 *
 * The top two levels are the scene's own shape and are worth seeing at a glance.
 * Below that a card's bookkeeping starts, and opening all of it by default turns
 * the margin into a wall.
 */
const OPEN_TO_DEPTH = 2

/**
 * One level of the variable index.
 * @param props - the entries, their depth, and the shared disclosure state.
 * @returns the rows.
 */
function StateRows({
  entries,
  depth,
  path,
  opened,
  onToggle,
}: {
  entries: [string, unknown][]
  depth: number
  path: string
  opened: ReadonlyMap<string, boolean>
  onToggle: (path: string, open: boolean) => void
}): ReactElement {
  return (
    <dl className="iris-var">
      {entries.map(([key, value]) => {
        const shown = describe(value)
        const here = `${path}/${key}`

        if (shown.kind === 'branch') {
          /*
           * Disclosure state is held by the panel rather than by the `<details>`
           * element. This margin now refreshes on every host event, and an
           * uncontrolled element would have React reassert the default `open` on
           * each one — so a reader who opened a branch would watch it shut itself
           * every time the chat moved.
           */
          const isOpen = opened.get(here) ?? depth < OPEN_TO_DEPTH
          return (
            <details
              className="iris-var__branch"
              key={key}
              open={isOpen}
              onToggle={event => onToggle(here, event.currentTarget.open)}
            >
              <summary className="iris-var__summary">
                <span className="iris-var__key">{key}</span>
                <span className="iris-var__count">{shown.entries.length}</span>
              </summary>
              <div className="iris-var__children">
                <StateRows
                  entries={shown.entries}
                  depth={depth + 1}
                  path={here}
                  opened={opened}
                  onToggle={onToggle}
                />
              </div>
            </details>
          )
        }

        const stacked = shown.kind === 'text' && shown.text.length > RANGED_RIGHT_LIMIT
        const valueClass
          = shown.kind === 'absent'
            ? 'iris-var__value iris-var__value--absent'
            : shown.numeric
              ? 'iris-var__value iris-var__value--numeric'
              : 'iris-var__value'

        return (
          <div
            className={stacked ? 'iris-var__row iris-var__row--stacked' : 'iris-var__row'}
            key={key}
          >
            <dt className="iris-var__key">{key}</dt>
            <dd className={valueClass}>{shown.kind === 'absent' ? '—' : shown.text}</dd>
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
  const open = useIris(state => state.chatId !== undefined)
  /*
   * Keyed by path rather than by object identity, so a branch stays open across a
   * refresh that replaced the objects underneath it — which is every refresh.
   */
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map())

  if (!open) return null

  const entries = Object.entries(variables ?? {})

  return (
    <aside className="iris-aside" aria-label="Conversation state">
      <div className="iris-aside__inner">
        <h2 className="iris-label iris-aside__head">State</h2>
        {entries.length === 0 ? (
          <p className="iris-aside__empty">
            Nothing tracked yet. A card that keeps variables will fill this in as the scene moves.
          </p>
        ) : (
          <StateRows
            entries={entries}
            depth={0}
            path=""
            opened={opened}
            onToggle={(at, isOpen) => {
              setOpened(previous => {
                const next = new Map(previous)
                next.set(at, isOpen)
                return next
              })
            }}
          />
        )}
      </div>
    </aside>
  )
}
