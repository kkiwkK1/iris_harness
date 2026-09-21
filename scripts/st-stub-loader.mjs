/**
 * Module-hooks file for the regex differential (`regex-differential.mjs`).
 *
 * SillyTavern's regex engine is the oracle, and its module graph is the price
 * of using it: `engine.js` imports five specifiers from the ST app tree, and
 * the top of that tree (`script.js`) boots the whole application on import.
 * This loader intercepts exactly those five resolved files and serves small
 * stand-ins whose shape is what `engine.js` reads:
 *
 * - `script.js` — the persona/character globals (`characters`, `this_chid`),
 *   the macro expanders (identity: the differential deliberately compares the
 *   regex stage with macros out of scope, and both engines substitute through
 *   one injected function), and the settings saver (no-op).
 * - `extensions.js` — a **mutable** `extension_settings`, which is both the
 *   global tier's storage and the allow-list state (`preset_allowed_regex`,
 *   `character_allowed_regex`) the differential flips per case.
 * - `preset-manager.js` — a preset that serves the differential's preset-tier
 *   fixtures from `readPresetExtensionField`.
 * - `utils.js` — `regexFromString`, copied from the installed ST
 *   (`public/scripts/utils.js`): pattern compilation is part of the surface
 *   under test, not a liberty.
 * - `lib.js` — lodash, which `engine.js` only touches outside the paths the
 *   differential drives.
 *
 * Hooks run on a worker thread, so two things cross through `initialize`'s
 * data and worker-side globals: the ST location (for resolve) and the stub
 * objects (which the worker publishes onto its own `globalThis`, where the
 * stub modules read them). The *engine and the stub modules execute on the
 * main thread* — hooks only resolve and load — so the harness mutates those
 * published objects on the main thread and the engine's reads see it.
 *
 * @module scripts/st-stub-loader
 */

import { pathToFileURL } from 'node:url'

const STUB_SOURCE = {
  'script.js': `
export const characters = globalThis.__stStubCharacters
export const saveSettingsDebounced = () => {}
export const substituteParams = (value) => value
export const substituteParamsExtended = (value) => value
export let this_chid = 0
`,
  'extensions.js': `
export const extension_settings = globalThis.__stStubExtensionSettings
export const writeExtensionField = () => {}
`,
  'preset-manager.js': `
export const getPresetManager = () => ({
  // apiId and the selected preset name are what the preset tier's
  // allow-list is keyed by (preset_allowed_regex[apiId]); the harness seeds
  // that list to match.
  apiId: 'openai',
  getSelectedPresetName: () => 'fixture',
  readPresetExtensionField: ({ path }) => (
    path === 'regex_scripts' ? globalThis.__stStubPresetScripts : []
  ),
})
`,
  'utils.js': `
export function regexFromString(input) {
  try {
    var m = input.match(/(\\/?)(.+)\\1([a-z]*)/i);
    if (m[3] && !/^(?!.*?(.).*?\\1)[gmixXsuUAJ]+$/.test(m[3])) {
      return RegExp(input);
    }
    return new RegExp(m[2], m[3]);
  } catch {
    return undefined;
  }
}
`,
  'lib.js': `export const lodash = {}`,
}

const STUB_NAMES = new Set(Object.keys(STUB_SOURCE))

/** The ST location, read on the worker side by the same rule the harness uses. */
const ST_PUBLIC = process.env.IRIS_ST_SRC ?? 'E:/sillyTavern/SillyTavern/public'

export function resolve(specifier, context, nextResolve) {
  /*
   * Short-circuit on the specifier's base name before the real tree is ever
   * resolved: resolving into SillyTavern first would license its whole module
   * graph in (one real file imports another, which imports the app boot), and
   * the five stand-ins exist precisely so none of that loads. The parent must
   * be inside the ST tree, so the same-named file of some other project is
   * not swept up.
   */
  if (context.parentURL?.startsWith(pathToFileURL(ST_PUBLIC).href)) {
    const name = specifier.split('/').pop()
    if (STUB_NAMES.has(name)) {
      return { url: `st-stub:${name}`, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}

export function load(url, context, nextLoad) {
  if (url.startsWith('st-stub:')) {
    const name = url.slice('st-stub:'.length)
    return { format: 'module', source: STUB_SOURCE[name] ?? '', shortCircuit: true }
  }
  return nextLoad(url, context)
}
