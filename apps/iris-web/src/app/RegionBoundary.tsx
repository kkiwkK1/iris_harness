/**
 * A render failure that stays the size of the region it happened in.
 *
 * The shell is one React root, and under React 18 an uncaught render error
 * unmounts **the whole root**: one throwing settings panel, one message row or
 * one plugin's slot contribution left a blank page with no notice. All the
 * settings pages mount at boot (a page is hidden, never unmounted), so a throw
 * in a panel nobody had opened took the reading surface down with it.
 *
 * This boundary is placed around each region that can fail on its own — every
 * settings page child, every slot contribution, the reading pane and the
 * composer. When its subtree throws it renders one line in place saying which
 * region failed and why, and raises the failure into the notice log (the
 * durable shadow), so the rest of the shell stays usable and the fault leaves
 * a trace a reader can find after the fact.
 *
 * @module iris-web/app/RegionBoundary
 */
import { Component, useContext, type ErrorInfo, type ReactElement, type ReactNode } from 'react'

import { StoreContext } from '../client/provider.tsx'
import { actionsOf } from '../client/store.ts'
import { t } from './i18n/use-language.ts'

/** What the boundary does with a caught failure beyond drawing its line. */
type Report = (text: string) => void

interface BoundaryProps {
  readonly region: string
  readonly report: Report | undefined
  readonly children?: ReactNode
}

interface BoundaryState {
  readonly failure: string | undefined
}

/**
 * The class half: React offers render-error containment only to class
 * components (`getDerivedStateFromError`), so this is the one class in the app.
 */
class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failure: undefined }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failure: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error)
    // Raised from the commit phase, never from render: a notice is a store
    // write, and a write during render is its own warning.
    this.props.report?.(t('regionFailedNotice', { region: this.props.region, detail: message }))
  }

  override render(): ReactNode {
    if (this.state.failure === undefined) return this.props.children
    return (
      <p className="iris-region-failed" role="alert" data-region={this.props.region}>
        {t('regionFailed', { region: this.props.region, detail: this.state.failure })}
      </p>
    )
  }
}

/**
 * Contain a render failure to one named region.
 * @param props.region - the region's name, as the failure line and the notice
 *   will say it (a settings route, a slot point and entry id, "composer").
 * @param props.children - the region.
 * @returns the region, or one line in its place once it has thrown.
 */
export function RegionBoundary({ region, children }: { region: string, children?: ReactNode }): ReactElement {
  /*
   * Read through the context directly rather than `useIrisStore`, which throws
   * outside a provider: a boundary is the last thing that may itself fail, and
   * a slot can render in a tree with no store (a test, a plugin preview).
   */
  const store = useContext(StoreContext)
  const report: Report | undefined = store === undefined
    ? undefined
    : text => actionsOf(store).notify('error', text, { lasting: true })
  return <Boundary region={region} report={report}>{children}</Boundary>
}
