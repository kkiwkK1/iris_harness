/**
 * The variant rail at every count, without generating anything.
 *
 * The rail has two forms and only one of them had ever been seen. Reaching the
 * compact form the honest way costs nine real generations against a real model,
 * which is a lot of money to look at a strip of ticks — so the ladder form was
 * verified in a browser and the compact form was carried by unit tests alone,
 * which cannot see a layout.
 *
 * `VariantRail` is a pure component over `count`, so nothing has to be faked to
 * fix that: no invented `ChatView` in the store, no synthetic candidates on a
 * real chat, nothing that could be mistaken for host state. It is the actual
 * component with a number handed to it.
 *
 * Dev-only, and deliberately not reachable from a production build behind a
 * query parameter. A preview surface shipped to users is dead weight in the one
 * place this project keeps insisting the interface must describe what is really
 * there. Whoever checks the compact form runs `npm run dev`; for a presentational
 * component the build mode does not change a pixel.
 *
 * @module iris-web/dev/RailPreview
 */
import { useState, type ReactElement } from 'react'

import { RAIL_MAX_TICKS, railMode } from '../app/rail.ts'
import { VariantRail } from '../app/VariantRail.tsx'
import { Section } from '../app/fields.tsx'

/** Counts worth seeing side by side: the boundary, and either side of it. */
const LANDMARKS = [2, RAIL_MAX_TICKS, RAIL_MAX_TICKS + 1, 24] as const

/**
 * Render the rail at a range of counts, live and inert.
 * @returns the preview panel.
 */
export function RailPreview(): ReactElement {
  const [count, setCount] = useState(RAIL_MAX_TICKS + 1)
  const [index, setIndex] = useState(0)

  return (
    <Section title="Variant rail preview">
      <p className="iris-field__note">
        The real component, given a number. Nothing here touches the store or the host.
      </p>

      <div className="iris-probe__sources">
        <span className="iris-label">
          {count} readings · {railMode(count)} · reading {Math.min(index, count - 1) + 1}
        </span>
        <input
          type="range"
          min={0}
          max={30}
          value={count}
          aria-label="readings"
          onChange={event => {
            const next = Number(event.target.value)
            setCount(next)
            // Kept in range as the count shrinks, or the rail would be asked to
            // mark a reading that no longer exists.
            setIndex(previous => Math.min(previous, Math.max(next - 1, 0)))
          }}
        />
        <VariantRail
          count={count}
          index={Math.min(index, Math.max(count - 1, 0))}
          interactive
          onSelect={setIndex}
        />
      </div>

      {/*
        Both forms at the boundary, and both states of each. The inert form is
        the one whose tick colour was twice too faint to see, so it is shown
        beside the live one rather than on its own — that is how the problem was
        eventually described: legible only next to something brighter.
      */}
      {LANDMARKS.map(landmark => (
        <div className="iris-probe__source" key={landmark}>
          <span className="iris-probe__source-name">
            {landmark} · {railMode(landmark)}
          </span>
          <VariantRail count={landmark} index={0} interactive onSelect={() => undefined} />
          <VariantRail count={landmark} index={0} interactive={false} onSelect={() => undefined} />
        </div>
      ))}
    </Section>
  )
}
