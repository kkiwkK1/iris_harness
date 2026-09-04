/**
 * The React side of the shell's language: the hook and the word lookup.
 *
 * Two exports, one job each. `useLanguage()` subscribes the calling component
 * to the language through `useSyncExternalStore`, so a switch re-renders
 * exactly the components that show words — the same shape the store's own
 * selectors use, and the reason a switch needs no reload. `t()` reads the
 * current value without subscribing; it is safe to call anywhere in a render
 * **of a component that called the hook**, and from helpers that take the
 * language as an argument instead.
 *
 * The split keeps React out of the modules the sentence builders live in:
 * `strings.ts` and `language.ts` are plain modules (the store's notices and
 * the `node --test` suites read them directly), and this file is the only one
 * that pays for the import.
 *
 * @module iris-web/app/i18n/use-language
 */

import { useSyncExternalStore } from 'react'

import { getLanguage, setLanguage, subscribeLanguage } from './language.ts'
import { translate, type Language, type StringKey } from './strings.ts'

/**
 * The current language, subscribed.
 * @returns the language, and a setter that switches it for the whole shell.
 */
export function useLanguage(): { lang: Language, setLang: (lang: Language) => void } {
  const lang = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage)
  return { lang, setLang: setLanguage }
}

/**
 * The word for a key, in the language in force.
 *
 * @param key - the string's key.
 * @param params - values for the string's `{slots}`, if it has any.
 * @returns the copy in the current language.
 */
export function t(key: StringKey, params?: Record<string, string | number>): string {
  return translate(getLanguage(), key, params)
}
