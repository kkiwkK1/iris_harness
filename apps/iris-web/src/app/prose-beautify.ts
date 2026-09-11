/**
 * The prose beautify: the reading surface's own typesetting, and its switch.
 *
 * 「正文美化」 in the SillyTavern ecosystem is not one extension but a practice —
 * beautify regex presets that wrap a model's prose in styled divs through the
 * display-regex extension, or card-bundled scripts that draw the page. The
 * measured install has none (no beautify extension, an empty global regex
 * table — see `notes/FEATURE-PROSE-BEAUTIFY.md` §一), and Iris's own answer to
 * the card-supplied half already exists (three regex layers, frontend-blocks).
 * What this module adds is the half no card supplies: the typesetting the
 * reading surface does for **every** reply — 段首缩进, a paragraph rhythm that
 * tracks the reader's prose size, and dialogue lines set off from narration —
 * as one reader-facing switch.
 *
 * The module is deliberately display-only, and the shape of the code is that
 * promise kept twice:
 *
 * - **It never rewrites a character.** The switch paints one attribute on the
 *   root element (`data-iris-prose-beautify`, the mechanism
 *   `data-iris-floors` uses) and every beautify rule in `reading.css` gates on
 *   it — turning the switch off leaves the rendering byte-for-byte as it was
 *   before the feature existed. The card display regex runs earlier and may
 *   rewrite text freely; this layer sits after it and touches nothing it read.
 * - **It never imports the claim pipeline.** The dialogue tagger runs at the
 *   row level (`Message.tsx`), after `MessageInterfaces` has already split the
 *   body around its claimed blocks, and works only on rendered `<p>` elements
 *   — setting and removing one attribute. It marks, it does not splice, so the
 *   offsets the claim computed stay someone else's invariant. A source test
 *   pins the non-import, because a future "small helper" reaching from here
 *   into `../sandbox/` is exactly how the two pipelines weld shut.
 *
 * Like tagging runs only on settled rows: while a reply streams the tagger
 * would re-walk the DOM per token, and the claim pipeline already ruled the
 * same way for the same reason.
 *
 * The choice persists per device (`localStorage` key `iris.proseBeautify`,
 * safeRead/safeWrite — a reader with site data blocked gets the beautified
 * page and no memory, the same tolerance `iris.theme` and `iris.bodyTag` run
 * on). The default is **on**: these rules are the reading surface's own
 * design language — tokens, hairlines, the indent CJK prose expects — not a
 * foreign skin; the switch exists so a reader can say no.
 *
 * @module iris-web/app/prose-beautify
 */

/** The `localStorage` key the switch persists under, per device. */
const PROSE_BEAUTIFY_KEY = 'iris.proseBeautify'

/** The root attribute every beautify rule in `reading.css` gates on. */
export const PROSE_BEAUTIFY_ATTR = 'data-iris-prose-beautify'

/** The attribute the dialogue tagger writes onto a paragraph it classified. */
export const DIALOGUE_ATTR = 'data-iris-dialogue'

let current: boolean = loadProseBeautify()

const listeners = new Set<() => void>()

/**
 * Whether the beautify is in force right now.
 * @returns the switch, `true` until a reader turned it off.
 */
export function getProseBeautify(): boolean {
  return current
}

/**
 * Watch for switch changes.
 * @param listener - called after every switch.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function subscribeProseBeautify(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Switch the beautify, apply it to the document, remember it, and tell every
 * reader. Applying here — not in an effect somewhere above the tree — is what
 * makes the switch instant and single-sourced, the same ruling `theme.ts`
 * made for the theme attribute.
 * @param on - the reader's choice.
 */
export function setProseBeautify(on: boolean): void {
  if (on === current) return
  current = on
  applyProseBeautifyDocument(on)
  safeWrite(PROSE_BEAUTIFY_KEY, on ? 'on' : 'off')
  for (const listener of listeners) listener()
}

/**
 * Read the stored switch, tolerating everything a store can be.
 *
 * Only the two words this module writes are honoured — an older build, a
 * hand-edit or another app's key reads as the default — and an unavailable
 * store (private-mode browsers throw on access) reads as the default too,
 * because a display preference is not worth a blank page.
 * @returns the stored choice, defaulting to on.
 */
export function loadProseBeautify(): boolean {
  let stored: string | null
  try {
    if (typeof window === 'undefined') return true
    stored = window.localStorage.getItem(PROSE_BEAUTIFY_KEY)
  } catch {
    return true
  }
  if (stored === 'off') return false
  return true
}

/**
 * Write the switch onto the root element.
 *
 * Where there is no `document` (node --test), the choice still switches and
 * still persists — the DOM is the presentation, not the state.
 */
function applyProseBeautifyDocument(on: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute(PROSE_BEAUTIFY_ATTR, on ? 'on' : 'off')
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The choice lives for this session; a blocked store is not worth a crash.
  }
}

/*
 * On first import in a browser, put the stored choice in force — the same
 * import-time apply `theme.ts` runs, so a reload lands already beautified
 * without waiting for a component to mount.
 */
if (typeof document !== 'undefined') {
  applyProseBeautifyDocument(current)
}

/* --------------------------------------------------------------- dialogue */

/**
 * The opening quotes a dialogue line may start with.
 *
 * The CJK family first — 「 corner brackets (the mainland and Taiwan web-novel
 * default), 『 for a quote within — then the curly and straight double quotes
 * English-model prose arrives with. Single quotes and half-width corner marks
 * are omitted on purpose: a paragraph opening on an apostrophe or a footnote
 * mark is narration far more often than speech, and a beautify that guesses
 * loud reads as a beautify that guesses wrong.
 */
const OPENERS = '「『“"'

/** How much narration may sit before the quote in the lead-in form. */
const LEAD_IN_CAP = 16

/**
 * A speaker lead-in: a short run of narration ending in a colon, then the
 * quote. `艾拉：「茶好了。」` — the colon is what separates naming a speaker
 * from narrating around one. Built from {@link LEAD_IN_CAP} so the cap the
 * doc comment promises and the cap the regex enforces are one number.
 */
const SPEAKER_LEAD = new RegExp(`^[^：:\\n]{1,${LEAD_IN_CAP}}[：:]\\s*`)

/**
 * Whether one paragraph opens with spoken dialogue, and should be set off.
 *
 * Two shapes are honoured, both from how Chinese web-novel prose actually
 * opens a speech:
 *
 * 1. **the quote opens the paragraph** — `「你来了。」她没有回头。`
 * 2. **a speaker lead-in** — up to {@link LEAD_IN_CAP} characters, then a
 *    full- or half-width colon, optional space, then the quote. The cap is
 *    the honesty device: `她沉默了很久，才终于开口：「……」` (twelve characters
 *    before the colon) is a narrated speech and still tagged, while a
 *    paragraph that reaches a colon after a full clause of narration is a
 *    paragraph that happens to contain speech, and tagging it would set off
 *    narration.
 *
 * A quotation mark **inside** a paragraph — `他想起了「旧日」的约定。` — tags
 * nothing: quoting a word is not speaking a line. That false-positive class
 * is the reason the rule is anchored to the paragraph's head at all.
 *
 * Leading whitespace and one `>` (a blockquote paragraph's markdown marker)
 * are stripped first; nothing else is read, so a paragraph the markdown
 * renderer turns into a list item or a heading is classified by its text
 * alone, exactly what `textContent` hands over.
 * @param text - the paragraph's text (as rendered — markdown has already run).
 * @returns whether the paragraph opens with dialogue.
 */
export function isDialogueParagraph(text: string): boolean {
  const body = text.replace(/^\s+/, '').replace(/^>\s?/, '')
  if (body === '') return false
  // `charAt`, not indexing: the head is a real character by the time the empty
  // case has returned, and `includes('')` would read an empty slice as a match.
  if (OPENERS.includes(body.charAt(0))) return true
  /*
   * The regex's `{1,16}` *is* the cap — a longer run before the colon cannot
   * match, because the run characters may not contain a colon to restart at.
   */
  const lead = SPEAKER_LEAD.exec(body)
  if (lead === null) return false
  return OPENERS.includes(body.charAt(lead[0].length))
}

/**
 * Classify every rendered paragraph in one message row.
 *
 * Runs on the row's settled DOM, after the markdown renderer and after the
 * claim's splice — the paragraphs it sees are the ones on screen, and the
 * claim's offsets were computed from a string this function never touches.
 *
 * **Which paragraphs.** A row's text shell holds the markdown render *and*
 * Iris's own machinery (interface slots, their over-budget placeholder and
 * state lines) as siblings, all under `.iris-msg__text`. The one rule that
 * separates them, shared with the `reading.css` beautify block: the markdown
 * render is the direct child of the shell that carries **no** `iris-` class —
 * the renderer's root class belongs to its CSS module, and every Iris wrapper
 * is prefixed. Selecting the shells by that rule (rather than naming the two
 * machinery classes to skip) is what keeps this honest when the next machine
 * part is added: it stops matching prose the day someone names it, not the
 * day someone remembers to extend a list.
 *
 * The contract is deliberately minimal — `:scope >` children,
 * `querySelectorAll('p')` and one attribute per element — which is why the
 * tests can hold it with stubs and why nothing here can disturb a frame: an
 * interface's DOM lives in its own document, not in this container's `<p>`
 * list.
 * @param container - the row's text shell (`.iris-msg__text`).
 */
export function tagDialogueParagraphs(container: Element): void {
  for (const shell of proseShellsOf(container)) {
    for (const paragraph of shell.querySelectorAll('p')) {
      if (isDialogueParagraph(paragraph.textContent ?? '')) {
        paragraph.setAttribute(DIALOGUE_ATTR, 'on')
      } else {
        paragraph.removeAttribute(DIALOGUE_ATTR)
      }
    }
  }
}

/**
 * Take the classification back off — the switch-off path, so a reader who
 * turns the beautify off does not keep attributes no rule reads.
 * @param container - the row's text shell (`.iris-msg__text`).
 */
export function untagDialogueParagraphs(container: Element): void {
  for (const shell of proseShellsOf(container)) {
    for (const paragraph of shell.querySelectorAll('p')) {
      paragraph.removeAttribute(DIALOGUE_ATTR)
    }
  }
}

/**
 * The row's markdown-render children — the direct children carrying no
 * `iris-` class. {@link tagDialogueParagraphs} says why the rule is the one
 * thing both this module and the stylesheet quote.
 */
function proseShellsOf(container: Element): Element[] {
  return Array.from(container.querySelectorAll(':scope > :not([class*="iris-"])'))
}
