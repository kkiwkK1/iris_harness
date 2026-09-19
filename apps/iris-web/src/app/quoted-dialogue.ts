/**
 * Dialogue inside quotation marks, coloured the way SillyTavern colours it.
 *
 * Upstream does this inside `messageFormatting`: one regex over the **raw**
 * message, before showdown converts it, wraps six kinds of quoted run in
 * `<q>…</q>` with the quote marks kept inside the element
 * (`public/script.js:1845-1871`), and `style.css:554` paints `.mes_text q` with
 * `--SmartThemeQuoteColor`. That is the whole feature: a `<q>` element and one
 * colour.
 *
 * **Iris cannot copy the mechanism, because the prose renderer takes text.**
 * `MarkdownText` renders assistant Markdown with raw HTML disabled — "no HTML
 * enters the DOM" is the renderer's stated policy — and it has no extension
 * point for inline decoration. Putting `<q>` into the string upstream-style
 * would therefore put the characters `<q>` on the reading surface, which is
 * the opposite of the wanted result. So the rule below is transcribed from
 * upstream and applied one seam later: to the **rendered prose**, as a DOM
 * pass over the message's own text nodes.
 *
 * What that seam costs, and why it is still the same feature, is
 * `notes/apps/iris-web/DEVIATIONS.md` §121. The short form: a quote that spans
 * inline markup (`"hello *world*"`) is one `<q>` upstream and one `<q>` per
 * text node here, which is the same colour on the same characters; and the
 * scan is fed a string built so that a quote can no more cross a paragraph
 * here than it can cross a newline upstream.
 *
 * @module iris-web/app/quoted-dialogue
 */

/**
 * Upstream's quote regex, transcribed character for character.
 *
 * `public/script.js:1846`. The leading alternatives are not decoration: they
 * are what keeps the scan out of code. A `<style>` block, a fenced block, a
 * `~~~` block, a double-backtick span and a single-backtick span each match
 * **as a whole** and return themselves unchanged, so a quotation mark inside
 * one is never seen by the six capturing alternatives that follow.
 *
 * The flags are upstream's too, and the one that matters is the one that is
 * **not** there: without `s`, `.` does not match a newline, so `".*?"` cannot
 * reach across a line. An unclosed quote is therefore left alone rather than
 * running to the end of the message — the property that makes this rule safe
 * to apply to text nobody proof-read.
 *
 * Rebuilt per call in {@link quotedDialogueRuns} rather than shared: a `g`
 * regex carries `lastIndex`, which is state two callers can hand each other.
 */
const QUOTE_SCAN
  = /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/

/**
 * Upstream's tag guard, transcribed.
 *
 * `public/script.js:1840-1842` replaces every `"` **inside a tag** with U+FFFE
 * before the quote scan and restores it after (`:1875`), so that
 * `<div class="panel">` does not come back with its attribute value coloured
 * as dialogue. It is gated there on `power_user.encode_tags` being false,
 * which is its default (`public/scripts/power-user.js:301`) and the measured
 * profile's value.
 *
 * It applies here for a reason Iris has that upstream does not: `MarkdownText`
 * renders raw HTML **as literal text**, so a card that writes a tag into its
 * prose puts those characters on the reading surface, quotes and all.
 *
 * The substitution is one character for one character, so every offset the
 * scan reports is an offset into the original string as well.
 */
const TAG = /<([^>]+)>/g

/** The sentinel upstream hides a tag's quotes behind. */
const HIDDEN_QUOTE = '￾'

/** One run of quoted dialogue, as half-open offsets into the scanned text. */
export interface QuoteRun {
  /** The offset of the opening quote mark. */
  start: number
  /** The offset just past the closing quote mark. */
  end: number
}

/**
 * Where the quoted dialogue in a run of text is.
 *
 * The six kinds are upstream's six, in upstream's order: `"…"`, `“…”`, `«…»`,
 * `「…」`, `『…』`, `＂…＂`. The marks are part of the run, because upstream
 * keeps them inside the `<q>`.
 *
 * @param text - the text to scan.
 * @returns the runs, in order, non-overlapping.
 */
export function quotedDialogueRuns(text: string): QuoteRun[] {
  const masked = text.replace(TAG, (_, contents: string) =>
    `<${contents.replace(/"/g, HIDDEN_QUOTE)}>`)
  const scan = new RegExp(QUOTE_SCAN.source, 'gim')
  const runs: QuoteRun[] = []
  let found = scan.exec(masked)
  while (found !== null) {
    // Groups 1-6 are the quote kinds; a match with none of them is one of the
    // code alternatives, which upstream returns unchanged.
    const quoted = found.slice(1, 7).some(group => group !== undefined)
    if (quoted) runs.push({ start: found.index, end: found.index + found[0].length })
    found = scan.exec(masked)
  }
  return runs
}

/**
 * Whether this row's dialogue is coloured at all.
 *
 * Upstream's gate is one condition and it is worth stating exactly: the whole
 * quote block lives under `if (!isSystem)` (`public/script.js:1837`) and under
 * nothing else — no `power_user` setting reaches it, and `isUser` is never
 * asked, so a reader's own line has its dialogue coloured exactly like a
 * reply's. Two lines above that gate, upstream also *clears* `isSystem` for a
 * comment message and for a hidden one (`:1770-1777`), which is why so few
 * messages actually miss out; a row reaching Iris with `role: 'system'` is the
 * host speaking about the conversation, which is the case that is left.
 *
 * The streaming half is Iris's, and it is a divergence
 * (`notes/apps/iris-web/DEVIATIONS.md` §121): upstream re-runs
 * `messageFormatting` over the whole message per token, and this pipeline has
 * declined that bargain at every other seam that faces it.
 *
 * Stated here rather than inline in the row, so that the condition a test
 * reads is the condition the component uses.
 *
 * @param role - the row's role.
 * @param streaming - whether the reply is still arriving.
 * @returns true when this row's quoted runs should be marked.
 */
export function marksQuotedDialogue(role: string, streaming: boolean): boolean {
  return !streaming && role !== 'system'
}

/**
 * Tag names whose text is not prose.
 *
 * `CODE` and `PRE` are upstream's code alternatives arriving as elements —
 * by the time the renderer is done, a fenced block and an inline code span
 * *are* these. `Q` is our own previous pass. The rest cannot hold reader-facing
 * prose at all.
 */
const OPAQUE_TAGS: ReadonlySet<string> = new Set([
  'CODE', 'PRE', 'Q', 'SCRIPT', 'STYLE', 'TEXTAREA', 'IFRAME', 'SVG',
])

/**
 * Regions of a message row that are not the message's prose.
 *
 * A card interface is a frame, and the fold holds the model's scaffolding
 * rendered verbatim (`notes/apps/iris-web/BODY-TAG.md`) — neither is text a
 * quote rule has any business in.
 */
const OPAQUE_CLASSES: readonly string[] = ['iris-interfaces__slot', 'iris-bodyleak']

/**
 * Element names that start a new line in the source the prose came from.
 *
 * This is how the missing `s` flag survives the trip through the renderer.
 * Upstream scans the message *as written*, where two paragraphs are two lines,
 * so no quote can span them; the rendered tree has thrown those newlines away.
 * Putting one back at every block boundary restores exactly that bound.
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

/**
 * What an opaque subtree contributes to the scanned string.
 *
 * One character, so that the text either side of a code span stays as far
 * apart as it looks — U+FFFC, the character whose entire job is standing in
 * for something that is not text. Deliberately not a newline: upstream's scan
 * reads straight through an inline code span (the alternation is tried at each
 * position in turn, so a `"` that opens *before* a backtick wins), and a
 * newline here would break a quote the upstream rule joins.
 */
const OPAQUE = '￼'

/** One text node's place in the scanned string. */
interface Piece {
  /** The node itself. */
  node: Text
  /** Where its first character sits in the scanned string. */
  start: number
}

/** The prose of one message row, flattened for the scan. */
interface Flattened {
  /** The text the scan runs on. */
  text: string
  /** Every contributing text node, in document order. */
  pieces: Piece[]
}

/**
 * Flatten a rendered message row into the string upstream would have scanned.
 *
 * @param root - the message's prose container.
 * @returns the string and the text nodes it was built from.
 */
function flatten(root: Element): Flattened {
  let text = ''
  const pieces: Piece[] = []

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? ''
      if (value === '') return
      pieces.push({ node: node as Text, start: text.length })
      text += value
      return
    }
    if (node.nodeType !== 1) return

    const element = node as Element
    const tag = element.tagName.toUpperCase()
    if (tag === 'BR') {
      text += '\n'
      return
    }
    if (OPAQUE_TAGS.has(tag) || OPAQUE_CLASSES.some(name => element.classList.contains(name))) {
      text += OPAQUE
      return
    }

    const block = BLOCK_TAGS.has(tag)
    if (block && text !== '' && !text.endsWith('\n')) text += '\n'
    for (const child of [...element.childNodes]) visit(child)
    if (block && !text.endsWith('\n')) text += '\n'
  }

  for (const child of [...root.childNodes]) visit(child)
  return { text, pieces }
}

/**
 * One decorated text node, and everything needed to put it back.
 *
 * The host keeps its identity and loses its **value**: React holds a reference
 * to that node and will write the next version of the message into it, so the
 * node has to stay where React left it. Emptying it and hanging the decorated
 * copy off its right-hand side means a React update lands somewhere visible
 * rather than inside a fragment nobody re-reads — and it makes the undo below
 * able to tell the two situations apart.
 */
interface Decorated {
  /** The node React owns. */
  host: Text
  /** What it held before this pass emptied it. */
  full: string
  /** The nodes this pass created, in order, immediately after the host. */
  created: Node[]
}

/**
 * What has been applied to which container.
 *
 * Weak on purpose: a message row that scrolls out of the window takes its
 * record with it, and nothing here keeps a detached tree alive.
 */
const applied = new WeakMap<Element, Decorated[]>()

/**
 * Take one container's quote marking back off.
 *
 * Called before every re-application and from the effect's cleanup, so the
 * tree React sees is always the tree React built.
 *
 * **The empty host is the discriminator.** If the host is still empty, this
 * pass is the last thing that wrote to it and its text is ours to restore. If
 * it is not, React has committed a new value into it since — the created nodes
 * are then stale duplicates of the *old* text and the only correct move is to
 * drop them and leave React's value alone.
 *
 * @param root - the container previously passed to {@link markQuotedDialogue}.
 */
export function clearQuotedDialogue(root: Element): void {
  const records = applied.get(root)
  if (records === undefined) return
  applied.delete(root)
  for (const record of records) {
    for (const node of record.created) node.parentNode?.removeChild(node)
    if (record.host.nodeValue === '') record.host.nodeValue = record.full
  }
}

/**
 * Colour this row's quoted dialogue, by putting it in `<q>` elements.
 *
 * Idempotent: it takes off whatever it put on last time before it looks.
 *
 * @param root - the message's prose container.
 * @returns how many `<q>` elements were created, which is what a test can
 *   assert a floor on without knowing how the renderer split its text nodes.
 */
export function markQuotedDialogue(root: Element): number {
  clearQuotedDialogue(root)

  const { text, pieces } = flatten(root)
  if (pieces.length === 0) return 0
  const runs = quotedDialogueRuns(text)
  if (runs.length === 0) return 0

  const document_ = root.ownerDocument
  const records: Decorated[] = []
  let made = 0

  for (const piece of pieces) {
    const from = piece.start
    const to = from + (piece.node.nodeValue ?? '').length
    const overlapping = runs.filter(run => run.start < to && run.end > from)
    if (overlapping.length === 0) continue

    const full = piece.node.nodeValue ?? ''
    const created: Node[] = []
    let at = 0
    for (const run of overlapping) {
      // The run clipped to this node: a quote that reaches across inline markup
      // is several nodes, and each of them gets its own `<q>`. Same characters,
      // same colour; see the module note and §121.
      const begin = Math.max(run.start - from, 0)
      const finish = Math.min(run.end - from, full.length)
      if (begin > at) created.push(document_.createTextNode(full.slice(at, begin)))
      const quote = document_.createElement('q')
      quote.setAttribute('data-iris-quote', '')
      quote.append(document_.createTextNode(full.slice(begin, finish)))
      created.push(quote)
      made += 1
      at = finish
    }
    if (at < full.length) created.push(document_.createTextNode(full.slice(at)))

    piece.node.nodeValue = ''
    const parent = piece.node.parentNode
    if (parent === null) continue
    let after: Node = piece.node
    for (const node of created) {
      parent.insertBefore(node, after.nextSibling)
      after = node
    }
    records.push({ host: piece.node, full, created })
  }

  applied.set(root, records)
  return made
}
