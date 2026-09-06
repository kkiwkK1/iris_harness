/**
 * The React side of the theme: the hook that subscribes a component to the
 * choice.
 *
 * `useThemeChoice()` is the theme's mirror of `useLanguage()` —
 * `useSyncExternalStore` over the module-level store, so switching the theme
 * re-renders exactly the components that show the choice (the drawer's
 * appearance card) while the repaint of everything else belongs to the CSS
 * cascade, which re-resolves the `--iris-*` tokens the moment the attribute
 * moves. No component re-renders the page to change its colours, and no
 * component can hold a stale copy of the choice.
 *
 * @module iris-web/theme/use-theme-choice
 */

import { useSyncExternalStore } from 'react'

import { getThemeChoice, setThemeChoice, subscribeTheme, type ThemeChoice } from './theme.ts'

/**
 * The current theme choice, subscribed.
 * @returns the choice, and a setter that switches it for the whole shell.
 */
export function useThemeChoice(): { theme: ThemeChoice, setTheme: (choice: ThemeChoice) => void } {
  const theme = useSyncExternalStore(subscribeTheme, getThemeChoice, getThemeChoice)
  return { theme, setTheme: setThemeChoice }
}
