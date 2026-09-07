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
 * These key on the product's own identity attributes — `data-tab="chats"` /
 * `"characters"` on the sidebar tabs, `data-control="settings"` on the masthead
 * button. They did not exist when this file was written: the tabs were two
 * `role="tab"` buttons with the same class, no id, and nothing but
 * `aria-selected` (state, not identity) and a translated label between them, so
 * the first version located them **by order**. The attributes landed in
 * `aec4fef`, and swapping to them was one edit **here** — which is the whole
 * reason this is a module and not five copies of the same query.
 *
 * A missing attribute is refused by name rather than falling back to order: a
 * silent fallback would make the day the attribute is dropped look like a
 * normal run.
 *
 * Every locator returns what it did, including the label it happened to land on
 * — the visible text is recorded as **evidence**, never used as the handle.
 *
 * @module qa/locators
 */

/** The tab identities `Sidebar.tsx` stamps, in the store's own vocabulary. */
export const TABS = ['chats', 'characters']

/**
 * Click a sidebar tab and confirm it took.
 * @param which - `'chats'` or `'characters'`.
 * @returns an expression for `Runtime.evaluate`, resolving to
 *   `{clicked, ariaSelected, rows, label}` or `{error, label?}`.
 */
export function clickTabExpr(which) {
  if (!TABS.includes(which)) throw new Error(`unknown tab ${String(which)}`)
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const tab = document.querySelector('[data-tab=${JSON.stringify(which)}]')
    if (tab === null) {
      return {
        error: 'no [data-tab=${which}] on the page',
        tabsSeen: [...document.querySelectorAll('[role=tab]')].map(t => t.getAttribute('data-tab') ?? '(no data-tab)'),
      }
    }
    tab.click()
    for (let at = 0; at < 20; at += 1) {
      await sleep(100)
      if (tab.getAttribute('aria-selected') === 'true') {
        return {
          clicked: ${JSON.stringify(which)},
          ariaSelected: true,
          rows: document.querySelectorAll('.iris-list .iris-row').length,
          label: (tab.textContent ?? '').trim(),
        }
      }
    }
    return { error: 'tab ${which} never became aria-selected', label: (tab.textContent ?? '').trim() }
  })()`
}

/**
 * Open the settings drawer and confirm it opened.
 *
 * `data-control="settings"` names the button; it used to be "the last button in
 * the masthead", which was true and would have quietly become false the first
 * time anything was added beside it. Confirmation is `.iris-drawer--open`,
 * which is structure rather than a word.
 */
export const openDrawerExpr = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const settings = document.querySelector('[data-control="settings"]')
  if (settings === null) return { error: 'no [data-control="settings"] on the page' }
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
