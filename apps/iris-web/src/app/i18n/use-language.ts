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
import { getPluginCopyAll, subscribePluginCopy, translatePlugin } from './plugin-copy.ts'
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
 * The plugins' copy overlay, subscribed.
 * @returns the whole overlay, keyed by plugin id.
 */
export function usePluginCopy(): ReturnType<typeof getPluginCopyAll> {
  return useSyncExternalStore(subscribePluginCopy, getPluginCopyAll, getPluginCopyAll)
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

/**
 * The word from a plugin's bundled copy, in the language in force.
 *
 * Subscribes to the overlay as well as the language — a plugin's copy arrives
 * after the row renders (it is fetched from the manifest), and a `displayName`
 * that went on screen as the snapshot's name and stayed there when the real
 * one landed would defeat the feature. The `plugin:` namespace is applied
 * here and nowhere else.
 * @param pluginId - the plugin whose copy to read.
 * @param key - the key inside the plugin's own tables.
 * @param params - values for the string's `{slots}`, if it has any.
 * @returns the copy, or the runtime key itself when neither column has it.
 */
export function tPlugin(
  pluginId: string,
  key: string,
  params?: Record<string, string | number>,
): string {
  usePluginCopy()
  return translatePlugin(getLanguage(), pluginId, key, params)
}
