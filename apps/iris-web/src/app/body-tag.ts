/**
 * The body tag: a card preset's convention for which part of a reply is prose.
 *
 * Presets in the SillyTavern ecosystem increasingly teach the model a wrapper —
 * `狐神抚 V19.5`, the preset under acceptance, calls it the 正文标签 and ships
 * `<content>` as its default, explicitly telling the model the tag may be
 * renamed. Everything the model writes **outside** the wrapper is scaffolding:
 * the 【开始思考】 director notes, the scene planning, the self-check. Upstream
 * has no field for any of this — the convention lives entirely in prompt text —
 * and so nothing upstream shows or hides it either; whether a reader ever sees
 * the scaffolding is purely a question of whether the model obeyed.
 *
 * Iris gives the convention a mechanism (see `notes/apps/iris-web/BODY-TAG.md`):
 * `splitBodyTag` finds the wrapper and separates the prose from the scaffolding
 * so the reading surface can fold the latter away — **folded, not deleted**;
 * the stored message is never touched, and a reader who wants the director
 * notes can expand them. A message with no wrapper splits to itself, so a card
 * that never heard of the convention renders exactly as it always has.
 *
 * The tag name is a display preference (`iris.bodyTag` in `localStorage`, the
 * same home and reasoning as `iris.language`): it changes what the shell
 * *shows*, never what is stored or sent. The default is `content` — the
 * ecosystem's default tag — and a stored name is validated on read, because a
 * hand-edited or corrupt value must degrade to the default rather than build a
 * broken matcher.
 *
 * @module iris-web/app/body-tag
 */

const BODY_TAG_KEY = 'iris.bodyTag'

/** The ecosystem's default 正文标签 — what presets teach when they teach one. */
export const BODY_TAG_DEFAULT = 'content'

/** A tag name is an element name: letters first, then letters/digits/-/_ . */
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/

let current: string = detect()

const listeners = new Set<() => void>()

/**
 * The body tag name in force right now.
 * @returns the tag name, validated at every read.
 */
export function getBodyTag(): string {
  return current
}

/**
 * Switch the body tag name, remember it, and tell every reader.
 *
 * An invalid name is refused rather than coerced: the caller may be typing
 * half a name, and storing one would leave the reader silently un-split until
 * they noticed. The stored value is the source for later loads only after it
 * has passed the same check.
 * @param tag - the element name to read the prose from.
 * @returns whether the name was accepted.
 */
export function setBodyTag(tag: string): boolean {
  if (!TAG_NAME.test(tag)) return false
  if (tag === current) return true
  current = tag
  safeWrite(BODY_TAG_KEY, tag)
  for (const listener of listeners) listener()
  return true
}

/**
 * Watch for body-tag changes.
 * @param listener - called after every switch.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function subscribeBodyTag(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Same storage tolerance as `language.ts`: a blocked store is an absent value. */
function detect(): string {
  if (typeof window === 'undefined') return BODY_TAG_DEFAULT
  try {
    const stored = window.localStorage.getItem(BODY_TAG_KEY)
    if (stored !== null && TAG_NAME.test(stored)) return stored
  } catch {
    // Private-mode browsers throw on access; the default still works.
  }
  return BODY_TAG_DEFAULT
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The choice lives for this session; a blocked store is not worth a crash.
  }
}

/** What {@link splitBodyTag} found in one message. */
export interface BodyTagSplit {
  /**
   * Whether the message carries the body tag at all. Everything downstream
   * keys off this: an untagged message renders exactly as it did before the
   * mechanism existed, byte for byte.
   */
  tagged: boolean
  /** The prose inside the tag — `null` when {@link tagged} is false. */
  body: string | null
  /** Scaffolding before the opening tag. `''` when untagged. */
  head: string
  /** Scaffolding after the closing tag. `''` when untagged or unclosed. */
  tail: string
}

/** The result for a message with no wrapper, so callers need no branch. */
const UNTAGGED: BodyTagSplit = { tagged: false, body: null, head: '', tail: '' }

/**
 * Split one message into its prose and the scaffolding around it.
 *
 * **First opening tag, first closing tag after it.** A model that repeats
 * itself may emit several wrappers; the first pair is the reply it was asked
 * for and everything else is scaffolding by construction — matching greedily
 * would promote the text *between* two wrappers into prose, which is exactly
 * the leak this exists to fold.
 *
 * **An unclosed tag is a body to the end, not a refusal.** While a reply is
 * streaming, no closing tag yet is the normal case — the wrapper closes when
 * the model gets there — so the text after the opening tag is the body in
 * flight. A *settled* reply whose tag never closes is a model slip, and the
 * same reading is the honest one there: the model opened the wrapper, so the
 * rest was meant as prose. This is `repairStrayFences`' ruling one level up.
 *
 * Matching is by `indexOf`, not `RegExp`: the tag name arrives from a
 * preference and reaches this function verbatim, and a string search has
 * nothing to escape. The open tag matches `<tag` only where a real element
 * would start — followed by whitespace or `>` — so a card writing
 * `<content_notes>` is untagged under a `content` preference rather than
 * half-matched.
 * @param text - the message as it will be rendered (already display-regex'd
 *   and stray-fence-repaired — this runs at the same seam, on the same string).
 * @param tag - the body tag name, from {@link getBodyTag}.
 * @returns the split, with `tagged: false` for anything without a wrapper.
 */
export function splitBodyTag(text: string, tag: string): BodyTagSplit {
  if (!TAG_NAME.test(tag)) return UNTAGGED
  const open = findTag(text, tag, 0)
  if (open === -1) return UNTAGGED
  // The prose starts after the *open tag's* `>` — presets write bare tags, but
  // an attribute (`<content lang="zh">`) puts that `>` further out. A tag name
  // still being typed mid-stream (`<content` and nothing else yet) has no `>`
  // at all; the body then starts after the name and the `>` rides in it for
  // one frame, the same transient a streaming claim already tolerates.
  const gt = text.indexOf('>', open)
  const bodyStart = gt === -1 ? open + tag.length + 1 : gt + 1
  const close = text.indexOf(`</${tag}>`, bodyStart)
  if (close === -1) {
    return { tagged: true, body: text.slice(bodyStart), head: text.slice(0, open), tail: '' }
  }
  return {
    tagged: true,
    body: text.slice(bodyStart, close),
    head: text.slice(0, open),
    tail: text.slice(close + tag.length + 3),
  }
}

/**
 * Find the opening tag's index: `<tag` at a real element boundary.
 * @returns the index of `<`, or -1.
 */
function findTag(text: string, tag: string, from: number): number {
  let at = from
  while ((at = text.indexOf(`<${tag}`, at)) !== -1) {
    const next = text.charAt(at + tag.length + 1)
    if (next === '>' || next === ' ' || next === '\n' || next === '\t') return at
    at += 1
  }
  return -1
}
