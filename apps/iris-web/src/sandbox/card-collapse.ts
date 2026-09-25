/**
 * The frame's half of the reader's 「收起卡片界面」 control, when the frame also
 * holds sandbox plugins.
 *
 * **Why this exists at all.** The collapse control used to hide the overlay
 * surface element — the shell-side `<div>` the card-script frame sits in. That
 * is the right tool for a card alone, and the wrong one once a conversation has
 * grown sandbox plugins: they live in **the same frame** (`docs/SANDBOX-PLUGINS.md`
 * §5.1 — one realm on purpose, so a plugin can use what the card publishes), and
 * their panel container is a child of that frame's `body` (§5.5). Hiding the
 * frame from outside hid the reader's own plugins along with the card's
 * interface, which is not what "collapse the *card's* interface" says.
 *
 * The frame is the one place the two can be told apart, because it is the one
 * place both are elements. So when plugins are present the shell leaves its
 * surface visible and asks the frame, and the frame does two things:
 *
 * 1. **hides the card's own surfaces** — every `body` child except the plugin
 *    panel container — with `visibility`, never `display` (the same reason the
 *    shell used `visibility`: a card measuring itself must keep getting real
 *    numbers, and showing it again is a style change, not a relayout);
 * 2. **narrows the clip to the panel container** (`collapsedRoots`), so outside
 *    the plugins' box the frame paints nothing and catches nothing, and the
 *    shell under it is reachable exactly as it was with the whole surface
 *    hidden.
 *
 * Plugin **styles** need nothing here: they are `<style>` elements in `head`
 * and stay applied whatever `body` shows. The ones fanned out to message frames
 * (§5.1, PR-C) were never touched by the collapse, which only ever reached this
 * frame.
 *
 * **The limit, stated.** The hide rule is an author stylesheet with
 * `!important`; a card rule that is also `!important` and more specific, or an
 * inline `visibility: visible !important`, beats it. That can only show inside
 * the panel container's box, because the clip still removes everything else.
 *
 * @module iris-web/sandbox/card-collapse
 */
import { PLUGIN_PANELS_ATTRIBUTE } from './plugin-surface.ts'

/** On `<html>` while the card's interface is collapsed. */
export const CARD_COLLAPSED_ATTRIBUTE = 'data-iris-card-collapsed'
/** On the one `<style>` this module owns, so it is found rather than duplicated. */
export const CARD_COLLAPSE_STYLE_ATTRIBUTE = 'data-iris-card-collapse'

/**
 * The sheet, keyed on the attribute so toggling is one attribute write.
 *
 * Three rules, and each covers a case the others miss:
 * - `body` itself, so the card's **text nodes** directly under `body` (no
 *   element to match) inherit hidden;
 * - every `body` child that is not the panel container, **and its whole
 *   subtree** — a descendant rule, because a card's own `visibility: visible`
 *   on an inner element would otherwise re-show it under a hidden parent;
 * - the panel container back to `visible`, and only the container: its
 *   descendants inherit that, so a plugin that hides one of its own elements
 *   keeps it hidden.
 */
export const CARD_COLLAPSE_CSS = [
  `html[${CARD_COLLAPSED_ATTRIBUTE}] body { visibility: hidden !important; }`,
  `html[${CARD_COLLAPSED_ATTRIBUTE}] body > :not([${PLUGIN_PANELS_ATTRIBUTE}]),`
  + ` html[${CARD_COLLAPSED_ATTRIBUTE}] body > :not([${PLUGIN_PANELS_ATTRIBUTE}]) *`
  + ' { visibility: hidden !important; }',
  `html[${CARD_COLLAPSED_ATTRIBUTE}] body > [${PLUGIN_PANELS_ATTRIBUTE}] { visibility: visible !important; }`,
].join('\n')

/**
 * Collapse or restore the card's interface in this frame.
 *
 * The sheet is written once and left in place; the attribute is what changes.
 * @param document - the frame's own document.
 * @param collapsed - whether the card's interface is collapsed.
 */
export function applyCardCollapse(document: Document, collapsed: boolean): void {
  const root = document.documentElement
  if (collapsed) {
    if (document.querySelector(`style[${CARD_COLLAPSE_STYLE_ATTRIBUTE}]`) === null) {
      const style = document.createElement('style')
      style.setAttribute(CARD_COLLAPSE_STYLE_ATTRIBUTE, '')
      style.textContent = CARD_COLLAPSE_CSS
      ;(document.head ?? root).append(style)
    }
    root.setAttribute(CARD_COLLAPSED_ATTRIBUTE, '')
  } else {
    root.removeAttribute(CARD_COLLAPSED_ATTRIBUTE)
  }
}

/**
 * Which top-level nodes the clip is measured from while collapsed.
 *
 * Only the plugin panel container: everything else is hidden, and a hidden
 * node's box in the clip would be a hole that catches the reader's clicks over
 * something they cannot see. With no container (no plugin has drawn yet) the
 * answer is empty, so the clip is the zero-area path — the same "nothing here"
 * the shell's own hide produced.
 * @param document - the frame's own document.
 * @param roots - the roots the clip would be measured from when not collapsed.
 * @returns the roots to measure.
 */
export function collapsedRoots(document: Document, roots: readonly Element[]): readonly Element[] {
  if (!document.documentElement.hasAttribute(CARD_COLLAPSED_ATTRIBUTE)) return roots
  return roots.filter(root => root.hasAttribute(PLUGIN_PANELS_ATTRIBUTE))
}
