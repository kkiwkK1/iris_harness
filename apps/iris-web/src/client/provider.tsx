/**
 * Publishing the store to the React tree.
 *
 * A context rather than a module-level singleton, because the store is created
 * by a Cordis plugin and dies with it. A singleton would outlive an unmount and
 * quietly hold the previous client's event subscription — the exact class of
 * leak Iris's plugin model exists to make impossible.
 *
 * @module iris-web/client/provider
 */

import { createContext, useContext } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useStore } from 'zustand'

import { actionsOf } from './store.ts'
import type { IrisActions, IrisState, IrisStore } from './store.ts'

const StoreContext = createContext<IrisStore | undefined>(undefined)

/**
 * Publish a store.
 * @param props.store - the store this tree reads.
 * @param props.children - the application.
 * @returns the provider element.
 */
export function StoreProvider({ store, children }: { store: IrisStore, children: ReactNode }): ReactElement {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

/** The store, or a thrown error — a component outside the provider is a bug, not a state. */
function useIrisStore(): IrisStore {
  const store = useContext(StoreContext)
  if (store === undefined) throw new Error('iris: no store in context')
  return store
}

/**
 * Read a slice of state.
 * @param select - projection from the whole state.
 * @returns the selected value, re-rendering only when it changes by identity.
 */
export function useIris<T>(select: (state: IrisState & IrisActions) => T): T {
  return useStore(useIrisStore(), select)
}

/**
 * Read the action set.
 *
 * Returns a **stable** object — see `actionsOf`. The obvious implementation,
 * `store.getState()`, returns a new object after every write, which turns any
 * `useEffect(..., [actions])` that calls an action into an infinite loop. That is
 * not a hypothetical: it wedged a browser renderer.
 * @returns every action, with an identity that does not change.
 */
export function useIrisActions(): IrisActions {
  return actionsOf(useIrisStore())
}
