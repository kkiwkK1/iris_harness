/**
 * SillyTavern's popup API, as a card reaches it — the decisions, without a DOM.
 *
 * `callGenericPopup`, `callPopup`, `Popup`, `POPUP_TYPE` and `POPUP_RESULT` are
 * four names and one enum pair on `getContext()`
 * ([ST] `public/scripts/st-context.js:192-225`), and a card that reads
 * `SillyTavern.POPUP_TYPE.CONFIRM` off a surface that carries none does not
 * degrade — it throws `Cannot read properties of undefined`. That is the
 * measured failure this module exists for: MagVarUpdate's bundle reaches
 * `SillyTavern.POPUP_TYPE` on the first chat longer than 25 messages
 * (`cleanup/legacy_chat.ts:16-25`), and the read died inside a `jQuery(async…)`
 * with nothing to catch it.
 *
 * **Why the semantics live here rather than in the frame or the shell.** The
 * dialog has to be drawn by the shell — a card frame is clipped to a message's
 * height, so a modal drawn inside it is a modal nobody can see — but *what the
 * dialog means* is upstream's and belongs on one side of the boundary. So this
 * module turns a card's four arguments into a **plan**: the buttons in
 * upstream's render order, the result each one completes with, and the value
 * the promise resolves to. The shell renders the plan and reports which button
 * was pressed; it never computes a `POPUP_RESULT`.
 *
 * Everything here is pure, and the split is three ways: `popup-api.ts` owns the
 * promise and the message round trip, the shell owns the pixels, and this owns
 * the arithmetic — which is the half that can be tested against upstream's
 * source line by line (`tests/popup.test.ts`).
 *
 * @module iris-web/sandbox/popup
 */

/**
 * Upstream's popup kinds ([ST] `popup.js:9-20`).
 *
 * Plain and mutable, like upstream's own object. Freezing was considered and
 * rejected: upstream's module-level object can be written to, cards run as
 * modules (strict mode), and a frozen enum would turn a write upstream accepts
 * into a `TypeError`. Nothing in the corpus writes to it either way.
 */
export const POPUP_TYPE = {
  TEXT: 1,
  CONFIRM: 2,
  INPUT: 3,
  DISPLAY: 4,
  CROP: 5,
}

/**
 * Upstream's popup results ([ST] `popup.js:24-36`).
 *
 * `CANCELLED` is **`null`**, not a number, and that is load-bearing: MVU's
 * cleanup branch compares against it (`result === POPUP_RESULT.CANCELLED`), and
 * a stand-in that used `-1` or `undefined` would send a dismissal down the
 * wrong branch while looking correct.
 */
export const POPUP_RESULT = {
  AFFIRMATIVE: 1,
  NEGATIVE: 0,
  CANCELLED: null,
  CUSTOM1: 1001,
  CUSTOM2: 1002,
  CUSTOM3: 1003,
  CUSTOM4: 1004,
  CUSTOM5: 1005,
  CUSTOM6: 1006,
  CUSTOM7: 1007,
  CUSTOM8: 1008,
  CUSTOM9: 1009,
}

/**
 * The five names this API is, on `getContext()` and on the global.
 *
 * One list so the `get` trap and the `has` trap cannot drift: a member that
 * answers a read while `'name' in ctx` says no is the disagreement that made
 * every other unbuilt member here inconsistent, and it is the shape a card's
 * feature test walks into.
 *
 * The order is upstream's own declaration order in `st-context.js:192-225`.
 */
export const POPUP_MEMBERS: readonly string[] = [
  'callPopup',
  'callGenericPopup',
  'Popup',
  'POPUP_TYPE',
  'POPUP_RESULT',
]

/**
 * Which of upstream's default captions a button falls back to.
 *
 * A **token**, not a string, because the caption is the reader's language and
 * the frame does not hold the shell's dictionary. Upstream reads these off the
 * popup template's attributes ([ST] `index.html:6455`), which its own i18n
 * translates; here the shell resolves the token from
 * `app/i18n/strings.ts` at render time.
 */
export type PopupLabel = 'ok' | 'yes' | 'no' | 'cancel' | 'save' | 'crop' | 'close'

/** Which slot of upstream's control row a button came from. */
export type PopupSlot = 'custom' | 'ok' | 'cancel'

/** One button of the plan, in the order the shell must render it. */
export interface PopupButtonPlan {
  /** Its index in this plan, so a press names a button rather than a caption. */
  at: number
  /** Which slot it came from. Carried because the shell styles by slot. */
  slot: PopupSlot
  /**
   * The caption the card supplied. Absent when the card supplied none — the
   * shell then uses {@link label}, which is upstream's per-type default.
   */
  text?: string
  /** The default caption to use when {@link text} is absent. */
  label: PopupLabel
  /**
   * What the popup completes with when this is pressed.
   *
   * **Absent means the button does not close the popup** — upstream's rule for
   * a custom button declared with no `result` ([ST] `popup.js:69`). The shell
   * reports the press and leaves the dialog up.
   */
  result?: number | null
  /** Hover text, when the card gave one. */
  tooltip?: string
  /**
   * Which entry of the card's `customButtons` this is.
   *
   * Present only on a custom button, and it exists because the render order is
   * not the declaration order: customs are *prepended* before the ok button and
   * `appendAtEnd` sends one to the back, so `at` cannot be used to find the
   * card's own entry again. The frame needs to, in order to call that button's
   * `action` when the shell reports the press.
   */
  custom?: number
}

/**
 * Everything the shell needs to draw one popup, and nothing it has to interpret.
 *
 * Structured-clone safe by construction: numbers, strings, booleans and arrays
 * of those. A card's `onClosing`/`action` callbacks cannot cross a
 * `postMessage`, so they stay frame-side and are named in {@link ignored} when
 * they are not honoured at all.
 */
export interface PopupPlan {
  /** Upstream's `POPUP_TYPE` number, as the card passed it. */
  kind: number
  /** The content, normalised to one HTML string. See {@link normalizePopupContent}. */
  content: string
  /** The input box's starting text. Only an INPUT popup shows one. */
  inputValue: string
  /** Rows on the input box ([ST] `popup.js:512`). */
  rows: number
  /** Placeholder for the input box. */
  placeholder: string
  /** Hover text for the input box, or for the content area on every other kind. */
  tooltip: string
  /** The buttons, in upstream's render order: customs, then ok, then cancel. */
  buttons: readonly PopupButtonPlan[]
  /**
   * Whether the corner close control is shown — upstream's `closeButton`, which
   * only a DISPLAY popup gets, and which completes with `NEGATIVE`
   * ([ST] `popup.js:478-483` with `index.html:6471`).
   */
  closeCorner: boolean
  /** What Enter completes with ([ST] `popup.js:209`). */
  defaultResult: number | null
  /** Whether Escape may dismiss. */
  allowEscapeClose: boolean
  /** How wide to draw the card: upstream's `wide`/`wider`/`large` collapsed. */
  measure: 'normal' | 'wide' | 'large'
  /** Whether the body scrolls vertically rather than growing. */
  scrolling: boolean
  /** Whether the content is left-aligned rather than following the shell. */
  leftAlign: boolean
  /**
   * Option and button-property names the card passed that this surface does
   * **not** honour, so the card's report says so by name rather than the reader
   * discovering it as a dialog that behaves differently from upstream's.
   */
  ignored: readonly string[]
}

/**
 * What the reader did, on its way back to the card.
 *
 * `closed` rather than "is there a result", because `result` is legitimately
 * `null` — upstream's `CANCELLED` — so absence could not have meant "still
 * open" without two readings of one field.
 */
export interface PopupAnswer {
  /** Whether the popup is finished. `false` is a non-closing custom button. */
  closed: boolean
  /** Upstream's `POPUP_RESULT`, or a custom number. Meaningless when not closed. */
  result: number | null
  /** Which button was pressed, as its index in {@link PopupPlan.buttons}. */
  button?: number
  /** The input box's text at that moment, for an INPUT popup. */
  input?: string
}

/**
 * The options a card may pass, as upstream declares them ([ST] `popup.js:39-63`).
 *
 * Deliberately `unknown`-valued where a card's value decides behaviour: the
 * three-way `string | boolean | null` on `okButton` is upstream's own contract
 * and every branch of it is reproduced below, so narrowing here would be
 * narrowing away the cases.
 */
export interface PopupOptions {
  okButton?: unknown
  cancelButton?: unknown
  rows?: unknown
  placeholder?: unknown
  tooltip?: unknown
  wide?: unknown
  wider?: unknown
  large?: unknown
  transparent?: unknown
  allowHorizontalScrolling?: unknown
  allowVerticalScrolling?: unknown
  leftAlign?: unknown
  animation?: unknown
  defaultResult?: unknown
  customButtons?: unknown
  customInputs?: unknown
  allowEscapeClose?: unknown
  onClosing?: unknown
  onClose?: unknown
  onOpen?: unknown
  cropAspect?: unknown
  cropImage?: unknown
}

/**
 * Options this surface accepts and then does nothing with, by name.
 *
 * Each one is a deliberate omission rather than an oversight:
 *
 * - `transparent` — a chrome-less popup is upstream's own class on its dialog
 *   element; Iris's dialog is the shell's panel, and drawing one without its
 *   frame would leave card content floating over the reading column with no
 *   edge. Cost: a card that asked for it gets an ordinary panel.
 * - `allowHorizontalScrolling` — the shell's rule is that wide content scrolls
 *   inside its own container, never the panel; honouring this would put a
 *   horizontal scrollbar on the dialog itself.
 * - `animation` — upstream's three speeds ride its dialog element's classes.
 *   The shell has one appearance for every panel it owns.
 * - `customInputs` — checkboxes and text fields **below** the content, whose
 *   answers come back as `Popup.inputResults`. A real capability, deliberately
 *   not built: it needs its own value transport and nothing measured uses it
 *   (0 of 1,559 corpus bodies; 0 in MagVarUpdate's bundle).
 * - `onClosing` — a handler that may **veto** the close by returning false.
 *   Cannot be honoured across the boundary without reopening a dialog the shell
 *   has already dismissed, so it is ignored rather than half-kept: a card whose
 *   veto is dropped sees a closed popup, not a hung one.
 * - `cropAspect` / `cropImage` — the CROP kind needs a cropper. See
 *   {@link planPopup}.
 *
 * `onOpen` and `onClose` are **not** here: both are observational, both run
 * frame-side at the right moment, and dropping them would break a card that
 * cleans up after its own dialog.
 */
export const IGNORED_POPUP_OPTIONS: readonly string[] = [
  'transparent',
  'allowHorizontalScrolling',
  'animation',
  'customInputs',
  'onClosing',
  'cropAspect',
  'cropImage',
]

/** Custom-button properties this surface accepts and does nothing with. */
export const IGNORED_BUTTON_PROPERTIES: readonly string[] = ['classes', 'icon']

/**
 * Upstream's default caption for one slot of one popup kind.
 *
 * The table is `popup.js:454-503` read as data, and the two rows worth naming
 * are the ones a reimplementation gets wrong: a CONFIRM's buttons say **Yes/No**
 * rather than OK/Cancel, and an INPUT's ok says **Save**.
 * @param kind - the `POPUP_TYPE` number.
 * @param slot - which control.
 * @returns the token the shell resolves to a caption.
 */
export function defaultPopupLabel(kind: number, slot: PopupSlot): PopupLabel {
  if (slot === 'cancel') return kind === POPUP_TYPE.CONFIRM ? 'no' : 'cancel'
  if (slot === 'ok') {
    if (kind === POPUP_TYPE.CONFIRM) return 'yes'
    if (kind === POPUP_TYPE.INPUT) return 'save'
    if (kind === POPUP_TYPE.CROP) return 'crop'
    return 'ok'
  }
  return 'ok'
}

/**
 * Whether upstream shows this control for this kind, given what the card passed.
 *
 * Three different rules, and the difference is not decorative
 * ([ST] `popup.js:454-503`):
 *
 * - **ok** is hidden only by an explicit `false`, on every kind that has a row.
 * - **cancel** on TEXT is hidden unless the card asks for it (`if (!cancelButton)`),
 *   and on CONFIRM/INPUT/CROP it is shown unless explicitly `false`.
 * - **DISPLAY** hides the whole row and shows a corner close instead.
 *
 * A stand-in that used one rule for both controls shows a lone "OK" on a
 * confirm, or a "Cancel" on a text popup that upstream never draws.
 * @param kind - the `POPUP_TYPE` number.
 * @param slot - `'ok'` or `'cancel'`.
 * @param given - the option the card passed for that control.
 * @returns whether to render it.
 */
export function showsControl(kind: number, slot: 'ok' | 'cancel', given: unknown): boolean {
  if (kind === POPUP_TYPE.DISPLAY) return false
  if (slot === 'ok') return given !== false
  // TEXT is the odd one: its cancel is opt-in, not opt-out.
  if (kind === POPUP_TYPE.TEXT) return Boolean(given)
  return given !== false
}

/**
 * The caption a control carries, as upstream's two passes decide it.
 *
 * Upstream writes the caption twice: the constructor takes the option if it is a
 * string and otherwise writes a **literal** (`'OK'` for ok, the template's
 * `'Cancel'` for cancel), and then the per-type switch overwrites it *only when
 * the option is falsy* and *only for the types that have an override* — which is
 * where a CONFIRM's "Yes"/"No" and an INPUT's "Save" come from.
 *
 * Three edges fall out of that order, and all three are reproduced because each
 * is a place a tidier implementation says something different from upstream:
 *
 * | call | upstream shows | why |
 * | --- | --- | --- |
 * | TEXT, `okButton: ''` | an **empty** button | `''` is a string, and TEXT has no override |
 * | CONFIRM, `okButton: ''` | `Yes` | `!''` is true, and CONFIRM does have one |
 * | CONFIRM, `okButton: true` | `OK`, not `Yes` | `true` is truthy, so the override never runs |
 *
 * @param given - the option the card passed.
 * @param kind - the `POPUP_TYPE`, which decides whether an override exists.
 * @param slot - `'ok'` or `'cancel'`.
 * @returns the caption, or the token for the default that applies.
 */
export function controlCaption(
  given: unknown,
  kind: number,
  slot: 'ok' | 'cancel',
): { text?: string, label?: PopupLabel } {
  const hasOverride = slot === 'ok'
    ? kind === POPUP_TYPE.CONFIRM || kind === POPUP_TYPE.INPUT || kind === POPUP_TYPE.CROP
    : kind === POPUP_TYPE.CONFIRM
  if (!given && hasOverride) return { label: defaultPopupLabel(kind, slot) }
  // Every string, `''` included — that is the whole of the first table row.
  if (typeof given === 'string') return { text: given }
  // The constructor's literal, which is not the per-type default.
  return { label: slot === 'ok' ? 'ok' : 'cancel' }
}

/**
 * The custom buttons, in upstream's own order and with upstream's own results.
 *
 * Two things a reimplementation gets wrong, both measured against MVU's cleanup
 * dialog:
 *
 * 1. **A string-only button's result counts from 2**, not from `CUSTOM1`
 *    (=1001). Upstream's own JSDoc says so ([ST] `popup.js:55`) and its code is
 *    `{ text: x, result: index + 2 }` (`:284`). MVU's branch reads
 *    `result === POPUP_RESULT.CUSTOM1 || result === 2` — two spellings of one
 *    value only because the *first* string button happens to be neither.
 * 2. **They are prepended**, before the ok button (`popup.js:312-315`), unless
 *    the button asks for `appendAtEnd`. So MVU's "back up and clean" leads the
 *    row and "clean only" follows it.
 * @param customButtons - the option, whatever the card passed.
 * @returns the buttons, split by where they go.
 */
export function customPopupButtons(customButtons: unknown): {
  leading: readonly Omit<PopupButtonPlan, 'at'>[]
  trailing: readonly Omit<PopupButtonPlan, 'at'>[]
  ignored: readonly string[]
} {
  if (!Array.isArray(customButtons)) return { leading: [], trailing: [], ignored: [] }

  const leading: Omit<PopupButtonPlan, 'at'>[] = []
  const trailing: Omit<PopupButtonPlan, 'at'>[] = []
  const ignored = new Set<string>()

  customButtons.forEach((entry: unknown, index) => {
    const spec: Omit<PopupButtonPlan, 'at'> = { slot: 'custom', label: 'ok', custom: index }
    let appendAtEnd = false

    if (typeof entry === 'string') {
      Object.assign(spec, { text: entry, result: index + 2 })
    } else if (typeof entry === 'object' && entry !== null) {
      const bag = entry as Record<string, unknown>
      Object.assign(spec, { text: typeof bag['text'] === 'string' ? bag['text'] : '' })
      /*
       * `result` absent means the button does not close ([ST] `popup.js:69`),
       * which is a real state rather than a default to fill in — so the key is
       * only written when the card supplied a number or an explicit null.
       */
      const result = bag['result']
      if (typeof result === 'number' || result === null) Object.assign(spec, { result })
      if (typeof bag['tooltip'] === 'string') Object.assign(spec, { tooltip: bag['tooltip'] })
      appendAtEnd = bag['appendAtEnd'] === true
      /*
       * An `action` is honoured — the frame calls it when the shell reports the
       * press — so it is not in the ignored list. `classes` and `icon` reach
       * into upstream's own stylesheet and Font Awesome class names, which the
       * shell's panel does not carry.
       */
      for (const name of IGNORED_BUTTON_PROPERTIES) {
        if (bag[name] !== undefined) ignored.add(`customButtons[].${name}`)
      }
    } else {
      // Neither a string nor an object. Upstream would render `undefined` as the
      // caption; an empty button with no result is the closest honest thing.
      Object.assign(spec, { text: '' })
    }

    if (appendAtEnd) trailing.push(spec)
    else leading.push(spec)
  })

  return { leading, trailing, ignored: [...ignored] }
}

/**
 * One popup's content, as a single HTML string.
 *
 * Upstream accepts three shapes and branches on them ([ST] `popup.js:520-530`):
 * a jQuery set, an `HTMLElement`, or a string — and warns on anything else. All
 * three have to collapse to one string here, because the element a card built
 * lives in the frame's document and cannot cross a `postMessage` at all.
 *
 * Duck-typed rather than `instanceof`: this module is imported by the shell too
 * (for `POPUP_RESULT`), and a frame's jQuery is not the shell's. A jQuery set
 * carries a `jquery` version string; a DOM element carries `outerHTML`.
 *
 * **The string is not trusted by returning it.** It is card-authored markup and
 * the shell sanitizes it before rendering (`app/card-popups.ts` →
 * `app/inline-html.ts`); this only decides *which* string.
 * @param content - whatever the card passed.
 * @returns the HTML, and whether the shape was one upstream recognises.
 */
export function normalizePopupContent(content: unknown): { html: string, unknown: boolean } {
  if (typeof content === 'string') return { html: content, unknown: false }
  // Upstream's `BuildTextWithHeader` returns `text` unchanged when there is no
  // header, so `Popup.show.text(null, undefined)` really does reach here as
  // nullish — and upstream renders it as an empty popup rather than warning.
  if (content === undefined || content === null) return { html: '', unknown: false }

  if (typeof content === 'object') {
    const bag = content as Record<string, unknown>

    // A jQuery set: every element of it, concatenated, which is what
    // `$(content).append(set)` puts in the popup body.
    if (typeof bag['jquery'] === 'string') {
      const length = typeof bag['length'] === 'number' ? bag['length'] : 0
      let html = ''
      for (let at = 0; at < length; at += 1) {
        const node = bag[String(at)] as Record<string, unknown> | undefined
        const outer = node?.['outerHTML']
        if (typeof outer === 'string') html += outer
        else if (typeof node?.['textContent'] === 'string') html += escapeHtml(node['textContent'])
      }
      return { html, unknown: false }
    }

    if (typeof bag['outerHTML'] === 'string') return { html: bag['outerHTML'], unknown: false }
    /*
     * A text node has no `outerHTML`. Upstream's `content instanceof HTMLElement`
     * is false for one too, so it takes the warn branch — but its `textContent`
     * is exactly what the author meant to show, so it is escaped and kept and
     * the shape is still reported.
     */
    if (typeof bag['textContent'] === 'string') {
      return { html: escapeHtml(bag['textContent']), unknown: true }
    }
  }

  return { html: '', unknown: true }
}

/** The four characters that turn text into markup, and nothing else. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Upstream's `PopupUtils.BuildTextWithHeader` ([ST] `popup.js:888-898`).
 *
 * Reproduced including the part a reviewer will want to fix: the header is
 * **not escaped**. It is interpolated straight into an `<h3>`, so a header
 * carrying markup renders as markup upstream — and the three `Popup.show`
 * helpers are the only callers. Escaping it here would make Iris render a
 * different document than upstream for the same call; the shell's sanitizer is
 * where the safety comes from, and it runs over the whole string either way.
 * @param header - the heading, or nothing.
 * @param text - the body.
 * @returns the content string.
 */
export function buildTextWithHeader(header: unknown, text: unknown): string {
  const body = typeof text === 'string' ? text : ''
  if (typeof header !== 'string' || header === '') return body
  return `<h3>${header}</h3>\n            ${body}`
}

/**
 * Turn a card's four arguments into everything the shell needs.
 * @param content - the popup content, in any of upstream's three shapes.
 * @param type - the `POPUP_TYPE`.
 * @param inputValue - the input box's starting text.
 * @param options - upstream's `PopupOptions`.
 * @returns the plan.
 */
export function planPopup(
  content: unknown,
  type: unknown,
  inputValue: unknown,
  options: PopupOptions | undefined,
): PopupPlan {
  const bag: PopupOptions = options ?? {}
  /*
   * An unrecognised kind is upstream's `default: console.warn('Unknown popup
   * type.')`, which then renders the popup anyway with **both** controls: only
   * `mainInput`, `inputControls`, `closeButton` and `cropWrap` are hidden before
   * the switch ([ST] `popup.js:446-451`), so the default arm leaves the
   * template's [ok, cancel] row untouched. That falls out of the rules below
   * without a special case; the kind the card passed rides along unchanged so a
   * report can name it, and only a non-integer is replaced.
   */
  const kind = typeof type === 'number' && Number.isInteger(type) ? type : POPUP_TYPE.TEXT

  const normalized = normalizePopupContent(content)
  const customs = customPopupButtons(bag['customButtons'])

  const row: Omit<PopupButtonPlan, 'at'>[] = [...customs.leading]

  if (showsControl(kind, 'ok', bag['okButton'])) {
    const caption = controlCaption(bag['okButton'], kind, 'ok')
    row.push({
      slot: 'ok',
      ...(caption.text === undefined ? {} : { text: caption.text }),
      label: caption.label ?? 'ok',
      result: POPUP_RESULT.AFFIRMATIVE,
    })
  }
  if (showsControl(kind, 'cancel', bag['cancelButton'])) {
    const caption = controlCaption(bag['cancelButton'], kind, 'cancel')
    row.push({
      slot: 'cancel',
      ...(caption.text === undefined ? {} : { text: caption.text }),
      label: caption.label ?? 'cancel',
      result: POPUP_RESULT.NEGATIVE,
    })
  }
  row.push(...customs.trailing)

  const ignored = new Set<string>(customs.ignored)
  for (const name of IGNORED_POPUP_OPTIONS) {
    if ((bag as Record<string, unknown>)[name] !== undefined) ignored.add(name)
  }
  if (kind === POPUP_TYPE.CROP) ignored.add('POPUP_TYPE.CROP')

  const rows = typeof bag['rows'] === 'number' && bag['rows'] >= 1 ? Math.floor(bag['rows']) : 1
  const defaultResult = bag['defaultResult']

  return {
    kind,
    content: normalized.html,
    inputValue: typeof inputValue === 'string' ? inputValue : '',
    rows,
    placeholder: typeof bag['placeholder'] === 'string' ? bag['placeholder'] : '',
    tooltip: typeof bag['tooltip'] === 'string' ? bag['tooltip'] : '',
    buttons: row.map((button, at) => ({ at, ...button })),
    closeCorner: kind === POPUP_TYPE.DISPLAY,
    defaultResult:
      typeof defaultResult === 'number' || defaultResult === null
        ? defaultResult
        : POPUP_RESULT.AFFIRMATIVE,
    // Upstream's default is `true`; `false` asks for a double-Escape force-close
    // confirmation, which the shell reduces to "Escape does nothing".
    allowEscapeClose: bag['allowEscapeClose'] !== false,
    measure: bag['large'] === true ? 'large' : bag['wide'] === true || bag['wider'] === true ? 'wide' : 'normal',
    scrolling: bag['allowVerticalScrolling'] === true,
    leftAlign: bag['leftAlign'] === true,
    ignored: [...ignored],
  }
}

/**
 * The value `show()` resolves with, for a result and an input box.
 *
 * Upstream's `complete()` ([ST] `popup.js:750-770`), and the INPUT row is where
 * a reimplementation goes wrong: it is `result >= AFFIRMATIVE`, so **a custom
 * button on an INPUT popup also returns the text** — a card cannot tell its
 * custom buttons apart there, and that is upstream's behaviour rather than a
 * gap here. `NEGATIVE` returns `false`, `CANCELLED` returns `null`, and the two
 * are different answers that a `!value` check flattens.
 * @param kind - the `POPUP_TYPE`.
 * @param result - the result the popup completed with.
 * @param input - the input box's text at that moment.
 * @returns the resolved value.
 */
export function popupValue(
  kind: number,
  result: number | null,
  input: string,
): string | number | boolean | null {
  if (kind === POPUP_TYPE.INPUT) {
    if (result !== null && result >= POPUP_RESULT.AFFIRMATIVE) return input
    if (result === POPUP_RESULT.NEGATIVE) return false
    if (result === POPUP_RESULT.CANCELLED) return null
    return false
  }
  /*
   * CROP resolves with a cropped data URL upstream. Iris draws no cropper, so
   * there is nothing to crop and `null` — upstream's own answer for a cancelled
   * crop — is the honest value. The refusal is reported by name through
   * `plan.ignored`, so a card is not left guessing why its image never appeared.
   */
  if (kind === POPUP_TYPE.CROP) return null
  return result
}

/**
 * Upstream's `Popup.show.input` return contract ([ST] `popup.js:99-113`).
 *
 * An empty string is a **success** that returns `''`; every other falsy value
 * becomes `null`. Kept as its own function because it is the one place upstream
 * converts a result into a different type, and inlining it in three helpers is
 * how the three drift apart.
 * @param value - what `show()` resolved with.
 * @returns the string a card gets back.
 */
export function inputHelperValue(value: unknown): string | null {
  if (value === '') return ''
  return value ? String(value) : null
}
