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
/** Read-only page state a card may ask the virtual document for. */
export interface DocumentState {
  /** The real page's visibility, so "is the reader looking?" answers truly. */
  visibilityState?: string
  /** The same fact as a boolean, which is the older spelling cards use. */
  hidden?: boolean
  /** What a card sees as the document title — the character, not the app. */
  title?: string
  /** This frame's own URL, never the shell's. */
  url?: string
}

export interface VirtualDocumentSource {
  /** The card's own container element. */
  container: ScopedRoot
  /**
   * The frame's own `<head>`, as a real element.
   *
   * The same kind of thing `body` is: this frame's document is the card's own
   * page, and a `<style>` or `<link>` appended here styles that page and
   * nothing else. Cards reaching for it are the mirror of the two measured
   * `body` mount sites — a script that finishes mounting its markup and then
   * injects its own stylesheet through `document.head`. Optional so a realm
   * without a head refuses the member by name, as it does for any other member
   * it does not carry.
   */
  head?: unknown
  /**
   * The real viewport size, read on every access rather than captured, so a card
   * that lays itself out on resize sees the new number.
   */
  viewport: () => { width: number, height: number }
  factory: NodeFactory
  /**
   * SillyTavern's own element ids, as working stand-ins.
   *
   * Consulted **before** the container, so a card looking up `#send_but` gets
   * the composer's driver rather than whatever the card happened to give that
   * id inside its own subtree. That order is the compatible one: upstream's
   * `#send_but` is the page's, and a card that shadowed it there would be
   * shadowing SillyTavern's, not ours.
   */
  anchors?: Record<string, object>
  /**
   * Ids Iris knows belong to SillyTavern and does not provide.
   *
   * Named so a lookup can say which kind of nothing it found. A bare `null` is
   * how 不要被神隐's script dies — `Cannot read properties of null (reading
   * 'querySelector')`, one line after a lookup that said nothing.
   */
  knownIds?: readonly string[]
  /** Say something about a lookup. */
  report?: (message: string, failed: boolean) => void
  /**
   * Read-only page state, read on every access for the same reason `viewport`
   * is: a card polling `document.hidden` on an interval is asking a question
   * whose answer changes, and a captured value would answer the first one
   * forever.
   *
   * Optional so a test can build a document without it; each member falls back
   * to the value that is true of a frame nobody has told anything about.
   */
  state?: DocumentState
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


  /*
   * Say which kind of nothing a lookup found, once per id.
   *
   * Only for ids Iris **knows** are SillyTavern's: a card looking up its own
   * `#my-panel` before creating it is doing something ordinary, and reporting
   * that would bury the one case that matters in noise.
   */
  const saidAbout = new Set<string>()
  const reportKnown = (id: string): void => {
    if (!(source.knownIds ?? []).includes(id) || saidAbout.has(id)) return
    saidAbout.add(id)
    source.report?.(
      `a card looked up #${id}, which is SillyTavern's own element and Iris has no stand-in`
      + ' for — it returned null, which a card usually reads one line before it fails on'
      + ' something that null cannot do',
      false,
    )
  }

  const members: Record<string, unknown> = {
    body: source.container,
    /*
     * Present alongside `body` when the realm has one. It sits here rather than
     * in the fixed table below because a missing head must refuse by name —
     * the same treatment every other member the realm did not hand over gets —
     * rather than answer with `undefined`, which a card reading
     * `document.head.appendChild` would take for "no head yet" and fail on a
     * line later with nothing pointing here.
     */
    ...(source.head === undefined ? {} : { head: source.head }),
    documentElement: element,

    getElementById: (id: string): unknown => {
      const anchor = source.anchors?.[id]
      if (anchor !== undefined) return anchor
      // The container itself is in scope: a card that mounts into `#app` and then
      // looks `#app` up should find it, and excluding the root would make the
      // scoping visible as a bug rather than as a boundary.
      if (source.container.id === id) return source.container
      const found = source.container.querySelector(byId(id)) ?? null
      if (found === null) reportKnown(id)
      return found
    },
    querySelector: (selector: string): unknown => {
      /*
       * `#id` selectors reach the anchors too. A card writing
       * `document.querySelector('#send_but')` and one writing
       * `getElementById('send_but')` are asking the same question, and upstream
       * answers both — a stand-in that served only one spelling would work for
       * some cards and silently not for others.
       */
      const id = /^#([A-Za-z][\w:-]*)$/u.exec(selector.trim())?.[1]
      if (id !== undefined) {
        const anchor = source.anchors?.[id]
        if (anchor !== undefined) return anchor
      }
      const found = source.container.querySelector(selector) ?? null
      if (found === null && id !== undefined) reportKnown(id)
      return found
    },
    querySelectorAll: (selector: string): unknown => {
      /*
       * No injection: the element standing for this frame is a **real** node in
       * the container (`installSandbox` puts it there), so every query path
       * finds it — including a card's bare `$('iframe')`, which searches the
       * frame's own document and which no injection here could ever reach.
       *
       * That last path is why the element is real rather than synthesised.
       * Upstream's `$` is the page's, so upstream's `$('iframe')` **does** find
       * the card's own frame; a synthesised stand-in visible only through
       * `parent.document` would have left a mechanism difference behind, and the
       * standing discipline is to close those rather than to match the corpus's
       * current hit count.
       */
      return Array.from(source.container.querySelectorAll(selector) as ArrayLike<unknown>)
    },
    getElementsByTagName: (name: string): unknown =>
      Array.from(source.container.querySelectorAll(String(name)) as ArrayLike<unknown>),

    createElement: (tagName: string): unknown => source.factory.createElement(tagName),
    createTextNode: (data: string): unknown => source.factory.createTextNode(data),
    createDocumentFragment: (): unknown => source.factory.createDocumentFragment(),

    /*
     * **Read-only state, answered rather than refused, and a real card paid for
     * the difference.** 银麒赎世's system panel opens with `document.readyState`
     * and the refusal killed the whole script — for a **read** that cannot break
     * anything, of a value this frame genuinely knows.
     *
     * The refusal policy this file follows is "refuse where upstream would throw,
     * or where a return value would corrupt data". Neither applies to a status
     * read: upstream answers it, and the answer writes nothing. The policy was
     * right and the *list* had never been sorted by it — every name that was not
     * a lookup or a factory fell through to one refusal, so a benign read and an
     * unimplemented capability produced the same fatal sentence.
     *
     * So the split is now by **what a member does**, not by whether anyone
     * implemented it: reads answer, writes and structural operations keep the
     * old policy. Each value below is the frame's real state or the closest
     * constant to it, with the divergence named where there is one.
     */
    // The card's body runs after this frame's document has parsed: a script
    // frame is handed its body by message, and an interface frame's markup is
    // already in the document. So `'complete'` is not an approximation.
    readyState: 'complete',
    /*
     * The frame's real values where the frame has them. `visibilityState` and
     * `hidden` are properties of the *page*, and a card reading them is asking
     * "is the reader looking?" — which the shell's tab answers, not the frame's
     * own hidden-ness. Read through to the real document so a backgrounded tab
     * reads as hidden, which is what a card polling on an interval wants.
     */
    get visibilityState(): unknown {
      return source.state?.visibilityState ?? 'visible'
    },
    get hidden(): unknown {
      return source.state?.hidden ?? false
    },
    /*
     * `title` is a **write** as often as a read upstream, and the write is the
     * one that has to be refused: a card setting the browser tab's title would
     * be reaching out of its frame and relabelling the whole app. The read
     * answers the character's name, which is what upstream's title carries in a
     * chat, so a card that displays it shows something true.
     */
    get title(): unknown {
      return source.state?.title ?? ''
    },
    /*
     * The frame's own URL, which is `about:srcdoc`. Deliberately **not** the
     * shell's: a card reading `document.URL` to build a link or to decide which
     * host it is on must not be told it is the shell, and an opaque origin's
     * real answer is this one.
     */
    get URL(): unknown {
      return source.state?.url ?? 'about:srcdoc'
    },
    get documentURI(): unknown {
      return source.state?.url ?? 'about:srcdoc'
    },
    // A constant, and true of every document this project creates.
    characterSet: 'UTF-8',
    charset: 'UTF-8',
    // `'BackCompat'` would be a lie: the srcdoc carries a doctype.
    compatMode: 'CSS1Compat',
    /*
     * `9` is `Node.DOCUMENT_NODE`, and a document is always a document. Measured
     * on the 开场白2.0.1 component (哈人冰恋世界 and 绿茵好莱坞 carry the same
     * script): it duck-types with `document.nodeType`, and the refusal graded a
     * pure read as a script failure — the same shape 银麒赎世's `readyState` read
     * was, and the reason the reads-answer policy exists. A constant a frame
     * cannot get wrong is not a capability this sandbox needs to withhold.
     */
    nodeType: 9,
    /*
     * `''` rather than the shell's referrer, on the same reasoning as `URL`:
     * this frame was not navigated to from anywhere, and naming the shell would
     * hand a card a fact about the page it is isolated from.
     */
    referrer: '',
  }

  const virtual: object = new Proxy(Object.create(null) as object, {
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
        'The sandbox provides body, head, documentElement, the three scoped lookups and the three node factories.',
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

  return virtual
}

/** Every member the virtual document answers, for the settings panel to report. */
export const VIRTUAL_DOCUMENT_MEMBERS = [
  'body',
  'head',
  'documentElement.clientWidth',
  'documentElement.clientHeight',
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'createElement',
  'createTextNode',
  'createDocumentFragment',
] as const
