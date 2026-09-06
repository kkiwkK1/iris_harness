/**
 * Page-side locators for the app's own chrome, shared by the QA scripts.
 *
 * **The rule these encode is not "never locate by text".** It is:
 *
 *  - the app's **chrome** — tabs, the settings button, the consent buttons —
 *    must never be found by its visible text, because that text is translated.
 *    A headless Chrome inherits the machine's `navigator.language`, so the shell
 *    comes up in Chinese here and every English-worded locator misses;
 *  - a **chat or character name** is user data, not chrome, and its text is the
 *    only honest handle there is. Those locators stay text-based on purpose.
 *
 * Measured, not assumed: `Sidebar.tsx` renders the two tabs as `role="tab"` with
 * the same class and no id, differing only by `aria-selected` (state, not
 * identity) and their translated label — so **there is no attribute to key on
 * today**, and these use order plus a structural confirmation that the click
 * took effect. When `data-tab="chats|characters"` lands, swap the query here and
 * every script follows; that is why this file exists rather than five copies.
 *
 * Every locator returns what it did, including the label it happened to land on
 * — the visible text is recorded as **evidence**, never used as the handle.
 *
 * @module qa/locators
 */

/** Tab order in `Sidebar.tsx`: reading first, characters second. */
export const TAB_INDEX = { chats: 0, characters: 1 }

/**
 * Click a sidebar tab and confirm it took.
 * @param which - `'chats'` or `'characters'`.
 * @returns an expression for `Runtime.evaluate`, resolving to
 *   `{clicked, ariaSelected, rows, label}` or `{error, label?}`.
 */
export function clickTabExpr(which) {
  const index = TAB_INDEX[which]
  if (index === undefined) throw new Error(`unknown tab ${String(which)}`)
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const tabs = [...document.querySelectorAll('[role=tab]')]
    if (tabs.length <= ${String(index)}) {
      return { error: 'wanted [role=tab] #${String(index)}, page has ' + tabs.length }
    }
    const tab = tabs[${String(index)}]
    tab.click()
    for (let at = 0; at < 20; at += 1) {
      await sleep(100)
      if (tab.getAttribute('aria-selected') === 'true') {
        return {
          clicked: ${String(index)},
          ariaSelected: true,
          rows: document.querySelectorAll('.iris-list .iris-row').length,
          label: (tab.textContent ?? '').trim(),
        }
      }
    }
    return { error: 'tab #${String(index)} never became aria-selected', label: (tab.textContent ?? '').trim() }
  })()`
}

/**
 * Open the settings drawer and confirm it opened.
 *
 * The button is the last one in the masthead — `Masthead.tsx` gives it no
 * `aria-label` and no id, and its text is translated. Confirmation is
 * `.iris-drawer--open`, which is structure.
 */
export const openDrawerExpr = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const buttons = [...document.querySelectorAll('.iris-masthead button')]
  const settings = buttons[buttons.length - 1]
  if (settings === undefined) return { error: 'no button inside .iris-masthead' }
  settings.click()
  for (let at = 0; at < 20; at += 1) {
    await sleep(100)
    if (document.querySelector('.iris-drawer--open') !== null) {
      return { opened: true, label: (settings.textContent ?? '').trim() }
    }
  }
  return { error: 'the drawer never got .iris-drawer--open', label: (settings.textContent ?? '').trim() }
})()`

/**
 * Answer the script-consent gate with "run them", if it is showing.
 *
 * `ScriptPanel.tsx` renders run first and decline second inside
 * `.iris-grant__actions`; order is the handle, the words are not. A profile that
 * already granted shows no gate at all, which is `{asked: false}` — not an
 * error, and deliberately distinguishable from "the gate was there and the
 * click missed".
 */
export const answerConsentExpr = `(() => {
  const buttons = [...document.querySelectorAll('.iris-grant__actions button')]
  if (buttons.length === 0) return { asked: false }
  buttons[0].click()
  return { asked: true, answered: 'run', label: (buttons[0].textContent ?? '').trim() }
})()`
