/**
 * The two places a sandbox plugin may put something in the frame's document.
 *
 * Split from `plugin-tree.ts` so the tree — which is where the ordering, the
 * deadlines and the teardown checklist live — needs no DOM to test, and so the
 * DOM work is one small file that can be read against the two precedents it
 * copies:
 *
 * - **style tags** follow `data-iris-style` (`message-preset-styles.ts:46`),
 *   which is this frame's existing convention for "who put this sheet here".
 *   A **second** attribute name rather than the same one, because that one
 *   means "the message preset put it here": sharing it would let either side's
 *   clean-up take the other's sheets away.
 * - **the panel container** is a concrete element, not a concept. A slot that is
 *   only a name is a slot nobody can screenshot.
 *
 * @module iris-web/sandbox/plugin-surface
 */
import type { SandboxPluginPanelSink, SandboxPluginStyleSink } from './plugin-tree.ts'
import { rewriteStylesheetLinks, unblockFontStylesheets } from './srcdoc.ts'

/** The attribute a plugin's stylesheet carries, and the value is the owner's id. */
export const PLUGIN_STYLE_ATTRIBUTE = 'data-iris-plugin-style'
/** The attribute on the one container, which belongs to the frame. */
export const PLUGIN_PANELS_ATTRIBUTE = 'data-iris-plugin-panels'
/** The attribute on one plugin's cell, and the value is the owner's id. */
export const PLUGIN_PANEL_ATTRIBUTE = 'data-iris-plugin-panel'

/**
 * Escape a plugin id for a CSS attribute selector.
 *
 * `CSS.escape` when the realm has it, and a conservative quoted form when it
 * does not: the ids the host mints pass `isSafeId`, but this file is handed the
 * id by a message and cannot assume the host minted it.
 * @param realm - the frame's global, for `CSS.escape`.
 * @param id - the plugin id.
 * @returns a selector-safe token.
 */
function escapeId(realm: { CSS?: { escape?: (value: string) => string } }, id: string): string {
  const escape = realm.CSS?.escape
  return typeof escape === 'function' ? escape(id) : id.replace(/["\\]/gu, '\\$&')
}

/**
 * Build the style sink for a real document.
 * @param document - the frame's own document.
 * @param realm - the frame's global, for `CSS.escape`.
 * @returns the sink.
 */
export function createPluginStyleSink(
  document: Document,
  realm: { CSS?: { escape?: (value: string) => string } } = globalThis as never,
): SandboxPluginStyleSink {
  let seq = 0
  return {
    insert: (pluginId, css) => {
      const style = document.createElement('style')
      style.setAttribute(PLUGIN_STYLE_ATTRIBUTE, pluginId)
      // A sequence number, so two sheets from one plugin are two elements a
      // reader can tell apart — and so the later one wins a specificity tie by
      // document order, which is the rule CSS already has.
      seq += 1
      style.setAttribute('data-seq', String(seq))
      /*
       * **`textContent`, never `innerHTML`.** The text is a plugin's, which is
       * a model's; assigning it as markup would make a `</style>` inside it the
       * end of the element and everything after it document content. `textContent`
       * has no such reading.
       */
      style.textContent = css
      const head: Element | null = document.head ?? document.body
      head?.append(style)
      return () => style.remove()
    },
    clear: pluginId => {
      const found = document.querySelectorAll(`[${PLUGIN_STYLE_ATTRIBUTE}="${escapeId(realm, pluginId)}"]`)
      for (const element of found) element.remove()
      return found.length
    },
  }
}

/**
 * Build the panel sink for a real document, creating the container on demand.
 *
 * **One cell per plugin, list semantics** (§5.5). Not dsh's four slot kinds and
 * emphatically not its `chain`: a chain is "entries nominate themselves and the
 * first match renders", whose first question is who may take over from whom —
 * and dsh's own notes record that its slot admission has no carrier. A list has
 * no such question.
 *
 * The cells are kept in id order, which is the order the tree mounts in, so what
 * a reader sees down the container matches what the mount log says.
 * @param document - the frame's own document.
 * @param realm - the frame's global, for `CSS.escape`.
 * @param origin - the shell's origin, for the same stylesheet rewrite a card's
 *   interface markup goes through.
 * @returns the sink.
 */
export function createPluginPanelSink(
  document: Document,
  realm: { CSS?: { escape?: (value: string) => string } } = globalThis as never,
  origin = '',
): SandboxPluginPanelSink {
  const container = (): Element | undefined => {
    const existing = document.querySelector(`[${PLUGIN_PANELS_ATTRIBUTE}]`)
    if (existing !== null) return existing
    const body = document.body
    if (body === null || body === undefined) return undefined
    const made = document.createElement('div')
    made.setAttribute(PLUGIN_PANELS_ATTRIBUTE, '')
    body.append(made)
    return made
  }

  const cellFor = (pluginId: string): Element | undefined => {
    const host = container()
    if (host === undefined) return undefined
    const selector = `[${PLUGIN_PANEL_ATTRIBUTE}="${escapeId(realm, pluginId)}"]`
    const existing = host.querySelector(selector)
    if (existing !== null) return existing
    const cell = document.createElement('div')
    cell.setAttribute(PLUGIN_PANEL_ATTRIBUTE, pluginId)
    /*
     * Inserted in id order rather than appended, so the container's reading
     * order is the mount order the tree computes. Appending would make the cell
     * order depend on when a plugin happened to first draw, which is a fact
     * about timing rather than about the card.
     */
    const before = [...host.children].find(child => (child.getAttribute(PLUGIN_PANEL_ATTRIBUTE) ?? '') > pluginId)
    if (before === undefined) host.append(cell)
    else host.insertBefore(cell, before)
    return cell
  }

  return {
    mount: (pluginId, node) => {
      const cell = cellFor(pluginId)
      if (cell === undefined) return () => undefined
      if (typeof node === 'string') {
        /*
         * A string goes through the **same** two rewrites a card's interface
         * markup does, and no others. This is deliberately not a new markup
         * path: `rewriteStylesheetLinks` points a `<link rel=stylesheet>` at the
         * shell's own origin, and `unblockFontStylesheets` is what stops a font
         * sheet being refused by the frame's CSP. Anything beyond that would be
         * a sanitiser this project does not have and would have to maintain a
         * second opinion about HTML to write.
         */
        cell.innerHTML = unblockFontStylesheets(rewriteStylesheetLinks(node, origin))
      } else if (node !== null && typeof node === 'object' && 'nodeType' in (node as object)) {
        cell.replaceChildren(node as Node)
      } else {
        cell.replaceChildren()
      }
      return () => cell.replaceChildren()
    },
    remove: pluginId => {
      const host = document.querySelector(`[${PLUGIN_PANELS_ATTRIBUTE}]`)
      // The cell goes whole; the container stays. It belongs to the frame, not
      // to any plugin, so a teardown that took it would break the next mount.
      host?.querySelector(`[${PLUGIN_PANEL_ATTRIBUTE}="${escapeId(realm, pluginId)}"]`)?.remove()
    },
    setVisible: visible => {
      const host = container()
      if (host === undefined) return
      if (visible) host.removeAttribute('hidden')
      else host.setAttribute('hidden', '')
    },
  }
}
