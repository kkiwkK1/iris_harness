/**
 * `parent.document`, virtualized.
 *
 * The policy is `SANDBOX.md`; this is its implementation. Two members are real
 * — the viewport size and a container the card owns — and behind them is a wall.
 * That shape comes from measurement rather than from caution: across the 47
 * scripts in the local corpus, ten of the fourteen `parent.document` sites read
 * `documentElement.clientWidth`/`clientHeight` as a fallback beside
 * `parent.innerWidth`, and two want `body` as a mount point. Answering the first
 * ten truthfully grants nothing a frame cannot already read off its own
 * `window.screen`.
 *
 * Everything else throws, naming the member. See `errors.ts` for why that is not
 * negotiable.
 *
 * @module iris-web/sandbox/virtual-document
 */

import { ReadOnlyApiError, UnsupportedApiError } from './errors.ts'

/** The element `body` resolves to, and the root every lookup is scoped to. */
export interface ScopedRoot {
  /** Present so `getElementById` can match the container itself. */
  readonly id?: string
  querySelector(selector: string): unknown
  querySelectorAll(selector: string): unknown
}

/**
 * Node constructors, taken from the frame's own document.
 *
 * Real, and safe to be real: an unattached node carries no authority. A card can
 * build whatever tree it likes; the tree only means something once it is
 * inserted somewhere, and the only place this sandbox lets it insert is the
 * container.
 */
export interface NodeFactory {
  createElement(tagName: string): unknown
  createTextNode(data: string): unknown
  createDocumentFragment(): unknown
}

/** What the virtual document is built over. */
export interface VirtualDocumentSource {
  /** The card's own container element. */
  container: ScopedRoot
  /**
   * The real viewport size, read on every access rather than captured, so a card
   * that lays itself out on resize sees the new number.
   */
  viewport: () => { width: number, height: number }
  factory: NodeFactory
}

/**
 * Escape an id for use in an attribute selector.
 *
 * An attribute selector rather than `#id` with `CSS.escape`: it handles ids that
 * are not valid CSS identifiers (cards do carry them) and needs no global that a
 * test environment might not have.
 * @param id - the raw id.
 * @returns the selector.
 */
function byId(id: string): string {
  // Backslashes first, then quotes: doing it the other way round would
  // re-escape the backslashes this step just added.
  const escaped = id.split('\\').join('\\\\').split('"').join('\\"')
  return `[id="${escaped}"]`
}

/**
 * Build the `documentElement` stand-in.
 *
 * Its own proxy rather than a plain object, so that a card reaching past the two
 * measurements — `documentElement.style`, `.scrollTop`, `.classList` — is
 * refused with the full path rather than getting `undefined` from an object
 * literal.
 * @param viewport - live viewport reader.
 * @returns the stand-in.
 */
function documentElement(viewport: () => { width: number, height: number }): object {
  return new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      if (typeof property === 'symbol') return undefined
      if (property === 'clientWidth') return viewport().width
      if (property === 'clientHeight') return viewport().height
      throw new UnsupportedApiError(
        `document.documentElement.${property}`,
        'Only clientWidth and clientHeight are provided.',
      )
    },
    set(_target, property): boolean {
      throw new ReadOnlyApiError(`document.documentElement.${String(property)}`)
    },
    has(_target, property): boolean {
      return property === 'clientWidth' || property === 'clientHeight'
    },
  })
}

/**
 * Build the virtual document.
 *
 * @param source - the container, the viewport reader, and the node factory.
 * @returns an object to hand a card as `parent.document`.
 */
export function createVirtualDocument(source: VirtualDocumentSource): object {
  const element = documentElement(source.viewport)

  const members: Record<string, unknown> = {
    body: source.container,
    documentElement: element,

    getElementById: (id: string): unknown => {
      // The container itself is in scope: a card that mounts into `#app` and then
      // looks `#app` up should find it, and excluding the root would make the
      // scoping visible as a bug rather than as a boundary.
      if (source.container.id === id) return source.container
      return source.container.querySelector(byId(id)) ?? null
    },
    querySelector: (selector: string): unknown => source.container.querySelector(selector) ?? null,
    querySelectorAll: (selector: string): unknown => source.container.querySelectorAll(selector),

    createElement: (tagName: string): unknown => source.factory.createElement(tagName),
    createTextNode: (data: string): unknown => source.factory.createTextNode(data),
    createDocumentFragment: (): unknown => source.factory.createDocumentFragment(),
  }

  return new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      // Symbols are never a card asking for a DOM capability — they are the
      // language or a library introspecting (`Symbol.toStringTag` when something
      // is stringified, `Symbol.iterator` when it is spread). Throwing there
      // produces a failure with no relation to the policy, so they read as
      // absent. Named members follow the policy exactly.
      if (typeof property === 'symbol') return undefined
      if (Object.hasOwn(members, property)) return members[property]
      throw new UnsupportedApiError(
        `document.${property}`,
        'The sandbox provides body, documentElement, the three scoped lookups and the three node factories.',
      )
    },
    set(_target, property): boolean {
      // Every write is refused, including to the members that exist: `body` is
      // the container the shell owns, and letting a card replace it would hand
      // it the one thing the sandbox is built to keep.
      throw new ReadOnlyApiError(`document.${String(property)}`)
    },
    has(_target, property): boolean {
      return typeof property === 'string' && Object.hasOwn(members, property)
    },
    ownKeys(): string[] {
      return Object.keys(members)
    },
    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      if (typeof property !== 'string' || !Object.hasOwn(members, property)) return undefined
      return { value: members[property], writable: false, enumerable: true, configurable: true }
    },
  })
}

/** Every member the virtual document answers, for the settings panel to report. */
export const VIRTUAL_DOCUMENT_MEMBERS = [
  'body',
  'documentElement.clientWidth',
  'documentElement.clientHeight',
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'createElement',
  'createTextNode',
  'createDocumentFragment',
] as const
