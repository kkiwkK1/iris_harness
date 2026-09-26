/**
 * The store's variable-compare slice: the tree map's 「比较变量」 mode, the two
 * floors picked in it, and the host's answer for them.
 *
 * A slice file for the reason `branch-tree.ts` is one: the store spreads it in
 * and otherwise does not know it exists. Three surfaces share it — the tree map
 * picks (`TreeMap.tsx`), the margin shows the diff (`StatePanel.tsx`), and a
 * floor's ⑂N list can start a comparison (`Message.tsx`) — so it lives in the
 * store rather than in any one of them.
 *
 * `compare` is `undefined` while the mode is off. In the mode, a pick fills A,
 * then B; a pick with both filled starts over at A. The diff is asked for the
 * moment both are set, and an answer for picks the reader has since changed is
 * dropped rather than shown under the wrong header.
 *
 * @module iris-web/client/variable-compare
 */

import type { IrisClient, VariablesDiffView } from '@iris/protocol'

/** One side of a comparison: a floor of a conversation, and optionally a reading of it. */
export interface ComparePick {
  chatId: string
  floor: number
  swipe?: number
}

/** The mode's state. */
export interface VariableCompare {
  a?: ComparePick
  b?: ComparePick
  /** The answer for exactly the current `a` and `b`, once it has arrived. */
  result?: VariablesDiffView
  /** True while an answer for the current picks is on its way. */
  loading: boolean
}

/** What the slice keeps. */
export interface VariableCompareState {
  /** The compare mode, or `undefined` while it is off. */
  compare: VariableCompare | undefined
}

/** What the slice does. */
export interface VariableCompareActions {
  /** Turn the mode on with nothing picked, or off. */
  setCompareMode(on: boolean): void
  /** Pick a floor: A first, then B, then A again. Turns the mode on if it is off. */
  pickCompare(pick: ComparePick): void
  /** Compare two named floors at once (the ⑂N list's entry). */
  compareFloors(a: ComparePick, b: ComparePick): void
  /** Swap A and B. */
  swapCompare(): void
  /** Move one side to another floor of the same conversation (the header's floor field). */
  setCompareFloor(side: 'a' | 'b', floor: number): void
}

/** The slice's starting state. */
export function variableCompareState(): VariableCompareState {
  return { compare: undefined }
}

/** Whether two picks name the same floor and reading. */
export function samePick(one: ComparePick | undefined, other: ComparePick | undefined): boolean {
  return one !== undefined && other !== undefined
    && one.chatId === other.chatId && one.floor === other.floor && one.swipe === other.swipe
}

/**
 * The picks after one more click.
 *
 * A first, then B; with both set, the click starts a new comparison at A.
 * Clicking the floor that is already A while B is empty does nothing — a
 * floor compared with itself is a diff that can only say "identical".
 * @param current - the mode's state, or undefined when it is off.
 * @param pick - the floor clicked.
 * @returns the new A and B.
 */
export function nextPicks(current: VariableCompare | undefined, pick: ComparePick): Pick<VariableCompare, 'a' | 'b'> {
  const a = current?.a
  const b = current?.b
  if (a === undefined) return { a: pick }
  if (b === undefined) return samePick(a, pick) ? { a } : { a, b: pick }
  return { a: pick }
}

/** What the slice needs from the store it lives in (structural, as `branch-tree.ts` does it). */
export interface VariableCompareDeps {
  client: IrisClient
  get: () => VariableCompareState
  set: (patch: Partial<VariableCompareState>) => void
  guard: <T>(work: () => Promise<T>) => Promise<T | undefined>
}

/**
 * Build the slice's actions.
 * @param deps - the store's client, accessors and error guard.
 * @returns the actions.
 */
export function variableCompareActions({ client, get, set, guard }: VariableCompareDeps): VariableCompareActions {
  /** Put picks in place and, when both are set, ask for their diff. */
  const settle = (picks: Pick<VariableCompare, 'a' | 'b'>): void => {
    const { a, b } = picks
    const ready = a !== undefined && b !== undefined
    set({ compare: { ...a === undefined ? {} : { a }, ...b === undefined ? {} : { b }, loading: ready } })
    if (!ready) return
    void guard(async () => {
      // With the tables: the margin shows the unchanged rows around the
      // changes when 「只看变化」 is off.
      const { diff } = await client.call('chat.variablesDiff', { a, b, tables: true })
      // Last write wins by picks: an answer for a pair the reader has already
      // replaced is dropped rather than drawn under the new header.
      const now = get().compare
      if (now === undefined || !samePick(now.a, a) || !samePick(now.b, b)) return
      set({ compare: { ...now, result: diff, loading: false } })
    }).then(() => {
      const now = get().compare
      if (now?.loading === true && samePick(now.a, a) && samePick(now.b, b)) set({ compare: { ...now, loading: false } })
    })
  }

  return {
    setCompareMode(on) {
      if (!on) set({ compare: undefined })
      else if (get().compare === undefined) set({ compare: { loading: false } })
    },

    pickCompare(pick) {
      settle(nextPicks(get().compare, pick))
    },

    compareFloors(a, b) {
      settle({ a, b })
    },

    swapCompare() {
      const now = get().compare
      if (now === undefined) return
      settle({ ...now.b === undefined ? {} : { a: now.b }, ...now.a === undefined ? {} : { b: now.a } })
    },

    setCompareFloor(side, floor) {
      const now = get().compare
      const at = now?.[side]
      if (now === undefined || at === undefined || at.floor === floor) return
      // Another floor means the reading named for the old one no longer applies.
      const moved: ComparePick = { chatId: at.chatId, floor }
      settle(side === 'a'
        ? { a: moved, ...now.b === undefined ? {} : { b: now.b } }
        : { ...now.a === undefined ? {} : { a: now.a }, b: moved })
    },
  }
}
