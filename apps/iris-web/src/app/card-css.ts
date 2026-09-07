/**
 * Confining a card's own `<style>` to the one message it came in.
 *
 * The design is `notes/apps/iris-web/INLINE-HTML.md` §4.4 (3c). This is the half that needs no DOM
 * and no sanitizer: text in, text out, so it can be tested.
 *
 * **Scanned, not matched.** Upstream finds and rewrites its style blocks with
 * regular expressions, and `notes/apps/iris-web/INLINE-HTML.md` §2.3 records the hole that produced:
 * its scoping hangs off a literal pattern that does not allow attributes, so
 * `<style type="text/tailwindcss">` walks straight past it and lands unscoped.
 * That is a warning about the technique, not only about that pattern — CSS has
 * strings, comments and nesting, and a pattern that ignores them is wrong on
 * inputs nobody thought to write down. So this walks the text with a brace
 * scanner, the way `frontend-blocks.ts` walks fences.
 *
 * **Refusals are reported, never silent.** A card whose animation stopped
 * working needs to know its `@font-face` was dropped; a reader looking at a
 * panel that renders oddly needs to know something was removed rather than
 * broken. The names come back beside the CSS.
 *
 * @module iris-web/app/card-css
 */

/**
 * At-rules that never survive, whatever they contain.
 *
 * `@import` and `@font-face` both fetch, and [notes/apps/iris-web/INLINE-HTML.md §4.3] refuses every
 * external load with a measured cost of zero on the corpus — while noting the
 * thing that matters more: the corpus says the tightening hits nothing that
 * exists, not that it will never hit anything. Upstream filters `@import`
 * unconditionally and lets `@font-face { src: url(https://…) }` through
 * whenever external media is allowed, which is a hole we do not inherit because
 * we have no such switch.
 */
const REFUSED_AT_RULES: readonly string[] = ['import', 'font-face', 'namespace', 'charset']

/**
 * The stand-in for an `image-set()`, which refuses without naming a single URL.
 *
 * A sentinel rather than a bare string so the reporter can tell it apart from a
 * reference: it went through the URL naming path once and came out as a
 * hostname that does not exist.
 */
const IMAGE_SET = 'image-set()'

/** The custom-property prefix a card may not redefine. */
const RESERVED_PREFIX = '--iris-'

/**
 * Whether `@keyframes` names are made unique or left as the author wrote them.
 *
 * `rename` is the default, and it is why this function is careful at all:
 * keyframe names are **global**, so two cards that both define `pulse`
 * overwrite each other in a shared document.
 *
 * `keep` is for CSS installed into a document where there is no second card to
 * collide with — a message frame, which holds one region of one message. It
 * relaxes nothing: renaming is a collision measure, and inside a frame it has
 * no collision left to prevent while it *does* have something to break.
 * **Measured on the corpus: 5 of the 13 message-level sheets define keyframes
 * the message's own markup names from a `style=` attribute** (爱衣's `shimmer`;
 * 可攻略女主 and 暗渊 with `moon-halo`, `moon-pulse`, `stars-drift`,
 * `moonlight-sweep`). The rewrite below only reaches `animation` declarations
 * *in the sheet being renamed*, so those attributes would go on naming an
 * animation nobody defines any more — a decoration that stops with no error
 * attached, which is the failure shape this project keeps removing. The other
 * direction stays renamed and stays correct: a name referenced from inside the
 * same sheet (`contentSlideIn`) is rewritten along with its definition.
 */
export type KeyframePolicy = 'rename' | 'keep'

/** What one scoping pass produced. */
export interface ScopedCss {
  /** The CSS to install, already confined. */
  css: string
  /**
   * What was removed, in words a card author could act on.
   *
   * Deduplicated, because one refusal repeated forty times teaches a reader to
   * skip the whole list.
   */
  refused: readonly string[]
}

/**
 * Walk to the end of the block that starts at `open`.
 *
 * Strings and comments are tracked because a brace inside either is not a
 * brace: `content: "}"` is ordinary CSS and a counter that took it seriously
 * would close the block early and scope the rest of the sheet to nothing.
 * @param text - the whole sheet.
 * @param open - index of the `{`.
 * @returns index just past the matching `}`, or the text length if unterminated.
 */
function endOfBlock(text: string, open: number): number {
  let depth = 0
  let at = open
  while (at < text.length) {
    const char = text[at]
    if (char === '/' && text[at + 1] === '*') {
      const close = text.indexOf('*/', at + 2)
      at = close === -1 ? text.length : close + 2
      continue
    }
    if (char === '"' || char === "'") {
      at += 1
      while (at < text.length && text[at] !== char) {
        // A backslash escapes the next character, quote included.
        at += text[at] === '\\' ? 2 : 1
      }
      at += 1
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return at + 1
    }
    at += 1
  }
  return text.length
}

/** Split a sheet into top-level pieces, each a prelude plus an optional block. */
function topLevelPieces(css: string): { prelude: string, block: string }[] {
  const pieces: { prelude: string, block: string }[] = []
  let at = 0
  let preludeStart = 0
  while (at < css.length) {
    const char = css[at]
    if (char === '/' && css[at + 1] === '*') {
      const close = css.indexOf('*/', at + 2)
      at = close === -1 ? css.length : close + 2
      continue
    }
    if (char === '"' || char === "'") {
      at += 1
      while (at < css.length && css[at] !== char) at += css[at] === '\\' ? 2 : 1
      at += 1
      continue
    }
    if (char === '{') {
      const end = endOfBlock(css, at)
      pieces.push({ prelude: css.slice(preludeStart, at).trim(), block: css.slice(at, end) })
      at = end
      preludeStart = at
      continue
    }
    // A statement at-rule ends at its semicolon and has no block.
    if (char === ';') {
      const prelude = css.slice(preludeStart, at).trim()
      if (prelude !== '') pieces.push({ prelude, block: '' })
      at += 1
      preludeStart = at
      continue
    }
    at += 1
  }
  const rest = css.slice(preludeStart).trim()
  if (rest !== '') pieces.push({ prelude: rest, block: '' })
  return pieces
}

/**
 * A prelude with its leading comments removed, which is where its rule starts.
 *
 * **A comment before an at-rule used to hide the at-rule.** `topLevelPieces`
 * hands back everything between the last block and this one as the prelude, so
 * a card that writes a CSS comment on the line above `@keyframes shimmer` — as
 * cards do, to label the animation — produced a prelude whose first characters
 * are the comment's. `atRuleName` then said "not an at-rule", and the whole
 * piece was pushed in as if it were a selector — which for `@keyframes` means
 * **inside `@scope`, where it defines nothing at all**. Measured on 爱衣's
 * `[美化]变量更新中`: its `@keyframes shimmer` is labelled exactly like that,
 * and the `animation: shimmer 2s linear infinite` in the markup had nothing to
 * run. The same hole sat under the nested-frame path, silently, before a
 * message's sheet ever went through here.
 *
 * The comment is dropped from an at-rule's own output (a comment changes no
 * behaviour) and kept on a plain selector, which is the caller's choice, not
 * this function's.
 * @param prelude - the text between the previous block and this one.
 * @returns the prelude from its first non-comment character.
 */
function ruleHead(prelude: string): string {
  let at = 0
  for (;;) {
    while (at < prelude.length && /\s/.test(prelude[at] ?? '')) at += 1
    if (!prelude.startsWith('/*', at)) return prelude.slice(at)
    const close = prelude.indexOf('*/', at + 2)
    // An unterminated comment swallows the rest, which is what a CSS parser
    // does too — there is no rule left in it to name.
    if (close === -1) return ''
    at = close + 2
  }
}

/** The at-rule's name, lowercased, or undefined for a plain selector. */
function atRuleName(prelude: string): string | undefined {
  if (!prelude.startsWith('@')) return undefined
  const match = /^@([A-Za-z-]+)/.exec(prelude)
  return match?.[1]?.toLowerCase()
}

/**
 * Whether a declaration block reaches outside the message for a resource.
 *
 * `url(#…)` is a same-document reference — an SVG filter or gradient — and stays.
 * Everything else in a `url()` is a fetch, and [§4.3] refuses all of them.
 * @param block - the declaration text.
 * @returns whether it fetches.
 */
function fetchesExternally(block: string): string | undefined {
  let at = block.toLowerCase().indexOf('url(')
  while (at !== -1) {
    const inner = block.slice(at + 4).trimStart()
    const quote = inner.startsWith('"') || inner.startsWith("'") ? inner[0] : undefined
    const body = quote === undefined ? inner : inner.slice(1)
    if (!body.startsWith('#')) {
      const end = quote === undefined ? body.search(/[)\s]/) : body.indexOf(quote)
      return body.slice(0, end === -1 ? body.length : end).trim()
    }
    at = block.toLowerCase().indexOf('url(', at + 4)
  }
  return block.toLowerCase().includes('image-set(') ? IMAGE_SET : undefined
}

/**
 * The host a refusal should name, or the whole reference when there is no host.
 *
 * **The refusal has to name what it refused.** [notes/TEST-CARDS.md, and
 * `docs/OBSERVABILITY.md` gap 8] the corpus contains cards that print their own
 * message when a resource fails to arrive — one says the user's tavern is
 * broken. A report that says only "an external resource was refused" loses the
 * race against that: the reader sees the card's explanation, believes it, and
 * goes looking at their installation. Naming the host is what makes our report
 * the more specific of the two, and specific is what gets believed.
 * @param reference - the raw value from inside `url()`.
 * @returns something a reader can act on.
 */
function nameOf(reference: string): string {
  if (reference === IMAGE_SET) return 'an image-set() candidate'
  if (reference.toLowerCase().startsWith('data:')) return 'a data: URL'

  /*
   * Only an absolute reference is resolved. The first version handed everything
   * to `new URL(ref, 'https://placeholder.invalid')`, so a relative
   * `url(/local/thing.png)` was reported as coming from **placeholder.invalid**
   * — this module's own parser base, printed to a card author as though it were
   * their URL. A report that invents a hostname is worse than one that says
   * nothing, and it was found by reading the strings this function actually
   * produces rather than by testing that it produced one.
   */
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(reference) || reference.startsWith('//')
  if (!absolute) return reference.slice(0, 60)
  try {
    return new URL(reference.startsWith('//') ? `https:${reference}` : reference).host || reference
  } catch {
    // A malformed reference is still worth quoting back, trimmed: the card
    // author needs to see the text they wrote, not a parser's opinion of it.
    return reference.slice(0, 60)
  }
}

/** Drop declarations that redefine a reserved custom property. */
function stripReserved(block: string, refused: Set<string>): string {
  if (!block.includes(RESERVED_PREFIX)) return block
  const inner = block.slice(1, -1)
  const kept = inner
    .split(';')
    .filter(declaration => {
      if (!declaration.trimStart().startsWith(RESERVED_PREFIX)) return true
      refused.add(`a declaration setting a reserved ${RESERVED_PREFIX}* variable`)
      return false
    })
    .join(';')
  return `{${kept}}`
}

/**
 * Confine a card's stylesheet to one message.
 *
 * `@keyframes` cannot live inside `@scope` and its names are **global**, so two
 * cards that both define `pulse` overwrite each other — [§4.4] records that
 * upstream has this collision today. So they are lifted out, renamed with the
 * candidate's prefix, and every `animation` declaration that names them is
 * rewritten to match. The rewrite and the rename are done from **one list**, so
 * they cannot drift apart: [§ checklist item 6] asks for one invariant rather
 * than two coincidences, and the assertion is that a name is only renamed if it
 * was collected, and only collected if it was defined here.
 *
 * @param css - the card's stylesheet text.
 * @param candidateSeq - the message's stable identity. **Not the floor index**:
 * upstream deletes a floor with `chat.splice(index, 1)`, which shifts every
 * later floor, so styles hung off a floor number land on someone else's message
 * after one deletion.
 * @param scopeSelector - the scope root; defaults to this message's element.
 * @param keyframes - whether keyframe names are made unique. See
 * {@link KeyframePolicy}: `keep` is for a document with only one card's CSS in
 * it, where the rename has nothing to prevent and something to break.
 * @returns the confined CSS and what was refused.
 */
export function scopeCardCss(
  css: string,
  candidateSeq: string,
  scopeSelector?: string,
  keyframes: KeyframePolicy = 'rename',
): ScopedCss {
  const refused = new Set<string>()
  const prefix = `iris-c${candidateSeq}`
  /*
   * The scope root, which defaults to the message this CSS came in.
   *
   * Overridable for the **second** place a card's CSS has to be confined: a
   * nested frame's stand-in, where the card copies the frame's own stylesheets
   * into what it believes is a separate document. That confinement wants
   * everything this function does — brace-accurate scanning, the refused
   * at-rules, keyframe renaming — and differs only in which subtree it points
   * at, so it is a parameter rather than a second implementation. A second
   * implementation is how the two would come to disagree about `@font-face`.
   */
  const scopeRoot = scopeSelector ?? `#iris-msg-${candidateSeq}`

  /** Keyframe names defined in this sheet, and their new names. */
  const renamed = new Map<string, string>()
  const lifted: string[] = []
  const scoped: string[] = []

  for (const piece of topLevelPieces(css)) {
    /*
     * The rule's own start, past any comment a card put above it. Read through
     * `ruleHead` and not from `piece.prelude` directly, because a labelled
     * `@keyframes` otherwise reads as a selector and lands inside `@scope`,
     * where it defines nothing — see `ruleHead`.
     */
    const head = ruleHead(piece.prelude)
    const name = atRuleName(head)

    if (name !== undefined && REFUSED_AT_RULES.includes(name)) {
      refused.add(`@${name}`)
      continue
    }

    const fetched = piece.block === '' ? undefined : fetchesExternally(piece.block)
    if (fetched !== undefined) {
      refused.add(`a rule loading an external resource from ${nameOf(fetched)}`)
      continue
    }

    if (name !== undefined && name.endsWith('keyframes')) {
      // `@-webkit-keyframes` counts: the name it defines is just as global.
      const declared = head.replace(/^@[A-Za-z-]+\s*/, '').trim()
      if (declared === '') {
        refused.add('@keyframes with no name')
        continue
      }
      /*
       * Lifted either way — `@keyframes` cannot live inside `@scope` — and
       * renamed only when something could collide with it. See
       * `KeyframePolicy` for the 5-of-13 measurement behind the second half.
       */
      if (keyframes === 'keep') {
        lifted.push(`@${name} ${declared} ${piece.block}`)
        continue
      }
      const fresh = `${prefix}-${declared}`
      renamed.set(declared, fresh)
      lifted.push(`@${name} ${fresh} ${piece.block}`)
      continue
    }

    if (piece.block === '') {
      // A statement at-rule that is not on the refusal list, or a stray
      // fragment. Neither is a rule, and passing it through would put text of
      // unknown shape inside `@scope`.
      refused.add(`a statement this scoper does not model: ${head.slice(0, 40)}`)
      continue
    }

    scoped.push(`${piece.prelude} ${stripReserved(piece.block, refused)}`)
  }

  let body = scoped.join('\n')
  for (const [from, to] of renamed) {
    /*
     * Only inside `animation` declarations, and only as a whole word. A keyframe
     * called `spin` must not rewrite the word `spin` in a `content:` string or
     * in a class name, and a name that is a prefix of another (`fade`,
     * `fade-in`) must not be rewritten inside it.
     */
    body = body.replace(
      /(animation(?:-name)?\s*:)([^;}]*)/gi,
      (_whole: string, head: string, values: string) =>
        head + values.replace(new RegExp(`(^|[\\s,])${from}($|[\\s,])`, 'g'), `$1${to}$2`),
    )
  }

  const parts: string[] = []
  if (lifted.length > 0) parts.push(lifted.join('\n'))
  if (body.trim() !== '') parts.push(`@scope (${scopeRoot}) {\n${body}\n}`)

  return { css: parts.join('\n'), refused: [...refused] }
}
