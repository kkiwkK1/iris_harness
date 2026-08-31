/**
 * Rendering an Iris extension point.
 *
 * `SlotCore` owns the ledger and the change notifications; this owns turning
 * them into React. The split is deliberate: the ledger's rules (one declarer
 * per point, priority shadowing, cascading collapse on dispose) are the part
 * that is hard to get right and are worth borrowing, while the rendering is
 * eight lines and has to fit Iris's own tree.
 *
 * @module iris-web/slots/Slot
 */

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

import type { IrisSlotName } from './slots.ts'

const SlotsContext = createContext<SlotCore | undefined>(undefined)

/**
 * Publish the registry to the tree.
 * @param props.core - the registry built by `createIrisSlots`.
 * @param props.children - the application.
 * @returns the provider.
 */
export function SlotProvider({ core, children }: { core: SlotCore, children: ReactNode }): ReactElement {
  return <SlotsContext.Provider value={core}>{children}</SlotsContext.Provider>
}

/**
 * Read the registry.
 * @returns the registry, or undefined outside a provider (an extension-less build).
 */
export function useSlots(): SlotCore | undefined {
  return useContext(SlotsContext)
}

/**
 * Owner props for one point, read off the declared contract.
 *
 * Indirecting through `SlotMap` rather than restating the shape means adding a
 * field to a point is one edit, in `slots.ts`.
 */
type OwnerOf<K extends IrisSlotName> =
  import('@deepseek-ai/dsh-client-ui-slots').SlotMap[K] extends { owner: infer O extends object }
    ? O
    : Record<string, never>

/**
 * Render every contribution to one extension point.
 *
 * Nothing registered renders nothing — no wrapper, no gap. That is what lets
 * Iris put points in tight places (a message's action row) without paying for
 * them in an install with no extensions.
 * @param props.name - the declared point.
 * @param props.owner - the props the point's contract says the owner supplies.
 * @returns the contributions in declared order, or null.
 */
export function Slot<K extends IrisSlotName>({
  name,
  owner,
}: {
  name: K
  owner: OwnerOf<K>
}): ReactElement | null {
  const core = useSlots()

  // `entries` returns a cached, mutation-stable array — the shape
  // useSyncExternalStore requires. `entriesOfSlot` builds a fresh array per
  // call, so it is read in the render body below instead.
  const subscribe = useCallback(
    (onChange: () => void) => (core === undefined ? () => undefined : core.subscribe(name, onChange)),
    [core, name],
  )
  const snapshot = useCallback(() => (core === undefined ? EMPTY : core.entries(name)), [core, name])
  const ledger = useSyncExternalStore(subscribe, snapshot, snapshot)

  const entries = useMemo(() => {
    if (core === undefined || ledger.length === 0) return []
    return [...core.entriesOfSlot(name)].sort(
      (left, right) => (left.options.order ?? 0) - (right.options.order ?? 0),
    )
  }, [core, name, ledger])

  if (entries.length === 0) return null

  return (
    <>
      {entries.map((entry, at) => (
        <SlotEntry key={entry.options.id ?? String(at)} entry={entry} owner={owner} />
      ))}
    </>
  )
}

/** Stable empty ledger, so the no-registry case never allocates per render. */
const EMPTY: readonly StoredEntry[] = []

/**
 * Render one contribution.
 *
 * The entry's component is type-erased at the ledger boundary — the register
 * call site already proved its props against the point's contract — so this is
 * the one place a cast is correct rather than lazy.
 */
function SlotEntry({ entry, owner }: { entry: StoredEntry, owner: object }): ReactElement {
  const Component = entry.component as (props: object) => ReactNode
  // `renderSlot` is part of the standard props every slot component may accept.
  // Iris declares no nested points yet, so contributions are handed a
  // dispatcher that renders nothing rather than one that would silently work
  // for keys Iris never declared.
  return <>{Component({ ...owner, renderSlot: () => null })}</>
}
