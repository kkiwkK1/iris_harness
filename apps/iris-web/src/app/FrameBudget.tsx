/**
 * Who holds the frame budget, and how one interface asks about its share.
 *
 * The budget is a property of the whole reading view — it spends from the newest
 * floor backwards — while the thing that needs the answer is one interface slot
 * inside one message row. So the plan is computed once where the window is
 * known and read through context, rather than each row deciding for itself:
 * a per-row decision cannot know what the rows above it already spent.
 *
 * @module iris-web/app/FrameBudget
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { claimFrontendBlocks } from '../sandbox/frontend-blocks.ts'
import { frameKey, planFrames, type FrameCandidate, type FramePlan } from './frame-budget.ts'

/** One mounted row, as the budget needs to see it. */
export interface BudgetedFloor {
  /** The floor's index in the conversation. */
  id: number
  /** Its text after display regex — the same string the row renders. */
  text: string
  /** Whether it is a user row, for the plan's report. */
  isUser: boolean
}

/** What a slot can find out and do. */
interface FrameBudgetValue {
  plan: FramePlan
  open: (key: string) => void
}

/**
 * No budget in force.
 *
 * Renders everything, which is what a row mounted outside the reading view
 * should do: a component that found no provider is being used somewhere the
 * window does not apply, and silently refusing every interface there would be a
 * blank panel with no explanation available.
 */
const UNLIMITED: FrameBudgetValue = {
  plan: {
    render: new Set(),
    refused: new Set(),
    spent: 0,
    userInterfaces: [],
  },
  open: () => undefined,
}

const FrameBudgetContext = createContext<FrameBudgetValue | undefined>(undefined)

/**
 * Compute one plan for the mounted window and share it.
 *
 * @param props - the mounted floors, newest last, and the tree to wrap.
 * @returns the provider element.
 */
export function FrameBudgetProvider({
  floors,
  children,
}: {
  floors: readonly BudgetedFloor[]
  children: ReactNode
}): ReactElement {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())

  /*
   * What the last plan granted, so growth cannot revoke it.
   *
   * A ref rather than state because it must not itself cause a render: it is an
   * output of planning fed back as an input, and as state that is a loop. The
   * write below happens during render, which is normally a mistake — it is safe
   * here only because grants are **monotone within one window**: planning twice
   * with the second run seeing the first's grants produces the same set, so
   * React's double invocation in development changes nothing.
   */
  const granted = useRef<ReadonlySet<string>>(new Set())

  /*
   * The blocks are claimed here as well as in each row's controller. That is
   * duplicated work, and it is the cheaper of the two ways to be correct: the
   * alternative is for rows to report their weight upward as they mount, which
   * would make the plan depend on mount order — and mount order is exactly what
   * "spend from the newest floor backwards" must not depend on.
   */
  const candidates = useMemo<FrameCandidate[]>(() => {
    const found: FrameCandidate[] = []
    for (const floor of floors) {
      claimFrontendBlocks(floor.text).forEach((block, instance) => {
        found.push({
          floor: floor.id,
          instance,
          body: block.body,
          ...(floor.isUser ? { isUser: true } : {}),
        })
      })
    }
    return found
  }, [floors])

  const plan = useMemo(() => {
    const next = planFrames(candidates, { granted: granted.current, opened })
    granted.current = next.render
    return next
  }, [candidates, opened])

  const open = useCallback((key: string) => {
    setOpened(current => {
      if (current.has(key)) return current
      const next = new Set(current)
      next.add(key)
      return next
    })
  }, [])

  const value = useMemo(() => ({ plan, open }), [plan, open])

  return <FrameBudgetContext.Provider value={value}>{children}</FrameBudgetContext.Provider>
}

/**
 * One message's share of the plan, in the two forms a row needs.
 *
 * The set is what the controller consults; the signature is what its effect
 * depends on. They are separate because the set is rebuilt on every plan and a
 * dependency on it would rebuild every frame in the view whenever any one
 * interface anywhere changed state — the frames are the expensive thing this
 * whole layer exists to ration.
 * @param floor - the floor index.
 * @returns the refused instances of that floor, and a stable signature of them.
 */
export function useFloorGate(floor: number): {
  refusedInstances: ReadonlySet<number>
  gate: string
  open: (instance: number) => void
} {
  const value = useContext(FrameBudgetContext) ?? UNLIMITED
  const { plan } = value

  const refusedInstances = useMemo(() => {
    const mine = new Set<number>()
    for (const key of plan.refused) {
      const [at, instance] = key.split(':')
      if (at === String(floor) && instance !== undefined) mine.add(Number(instance))
    }
    return mine
  }, [plan, floor])

  // Sorted, so two identical decisions always produce one string.
  const gate = useMemo(
    () => [...refusedInstances].sort((left, right) => left - right).join(','),
    [refusedInstances],
  )

  const open = useCallback(
    (instance: number) => {
      value.open(frameKey(floor, instance))
    },
    [value, floor],
  )

  return { refusedInstances, gate, open }
}

/** What one interface slot needs to know about its own budget. */
export interface FrameSlot {
  /** Whether this instance may build a frame. */
  allowed: boolean
  /** Whether it was refused and should show the named placeholder. */
  refused: boolean
  /** Render this one anyway, at the reader's request. */
  open: () => void
}

/**
 * Ask the budget about one interface.
 *
 * @param floor - the floor index.
 * @param instance - the block's index within the floor.
 * @returns this slot's decision.
 */
export function useFrameSlot(floor: number, instance: number): FrameSlot {
  const value = useContext(FrameBudgetContext) ?? UNLIMITED
  const key = frameKey(floor, instance)
  const open = useCallback(() => {
    value.open(key)
  }, [value, key])

  /*
   * Outside a provider, or before the first plan, `refused` is false and
   * `allowed` is true — absence of a decision is not a refusal. The distinction
   * matters at exactly one moment that a reader can see: the first paint of a
   * chat, where treating "no plan yet" as refused would flash a placeholder
   * under every interface that is about to render.
   */
  const refused = value.plan.refused.has(key)
  return { allowed: !refused, refused, open }
}
