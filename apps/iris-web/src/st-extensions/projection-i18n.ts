/**
 * The translation rules the settings projection depends on, kept pure.
 *
 * The panel is translated **in place**: upstream appended the settings nodes
 * into the fixture root and bound its change handlers to them, so the panel can
 * never be re-rendered from source — a rebuild would leave every control dead.
 * Translation therefore has to be reversible, which is the whole point of this
 * module: applying a locale writes each declared slot's translation, and a
 * locale with no entry for a slot writes the ORIGINAL back.
 *
 * That second half is what the pilot was missing. The extension ships
 * `zh-cn`/`zh-tw` only, so the app's English setting produces an empty table —
 * and a one-way applier (translate what the table has, touch nothing else)
 * leaves the Chinese text from the previous pass stranded on screen after the
 * user switches back to English. Recording the source on the first pass and
 * resolving every declared slot every time makes both directions work with the
 * same code.
 *
 * DOM-free on purpose: the frame mutates elements with these answers, and the
 * rules are verifiable without a document.
 */

/** One slot an element declares: its text, or one of its attributes. */
export interface TranslationSlot {
  /** The attribute to write, or absent for the element's text content. */
  attribute?: string
  /** The locale-table key, as upstream's `data-i18n` spells it. */
  key: string
}

/** The element's source values, captured before its first translation. */
export interface TranslationOriginals {
  text: string
  attributes: Map<string, string>
}

/**
 * Parse one `data-i18n` value into the slots it declares.
 *
 * Upstream's rule (`extensions.js applyTranslations`): a bare `key` replaces
 * the element's text, `[attribute]key` replaces that attribute, and several
 * slots may be separated by `;`.
 */
export function translationSlots(spec: string): TranslationSlot[] {
  const slots: TranslationSlot[] = []
  for (const part of spec.split(';').map(part => part.trim()).filter(Boolean)) {
    const attributeForm = /^\[([^\]]+)\](.+)$/u.exec(part)
    if (attributeForm === null) {
      slots.push({ key: part })
      continue
    }
    const attribute = attributeForm[1]
    const key = attributeForm[2]
    if (attribute !== undefined && key !== undefined) slots.push({ attribute, key })
  }
  return slots
}

/**
 * What one slot should read after a locale pass.
 *
 * A key the table does not carry resolves to the original — never to the
 * previous locale's text, and never to empty. An empty attribute original is
 * legitimate (upstream declares `[title]` on elements that may not set one),
 * so absence from {@link TranslationOriginals.attributes} is treated as the
 * empty string rather than as "leave alone".
 */
export function resolveTranslation(
  slot: TranslationSlot,
  table: Record<string, string>,
  originals: TranslationOriginals,
): string {
  const translated = table[slot.key]
  if (translated !== undefined) return translated
  if (slot.attribute === undefined) return originals.text
  return originals.attributes.get(slot.attribute) ?? ''
}
