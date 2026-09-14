/**
 * The extension's own settings blob as the pilot stores it per profile.
 *
 * Upstream persists into SillyTavern's `extension_settings.EjsTemplate`
 * (21 keys, `ui.ts` DEFAULT_SETTINGS) plus whatever the global variable layer
 * and the regex table hold. The pilot keeps the same nested shape under one
 * namespaced key in the host's profile store, so a settings file copied from a
 * real ST install could seed the extension without translation.
 *
 * The defaults are upstream's own (`DEFAULT_SETTINGS`), including
 * `enabled: true` and `raw_message_evaluation_enabled: true` — the two that
 * make a freshly-installed extension behave on the UC paths without seeding.
 */

export const ST_COMPAT_SETTINGS_KEY_PREFIX = 'st-compat'

export function settingsKeyFor(extensionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(extensionId)) {
    throw new TypeError(`settings key: extension id "${extensionId}" is not a safe store key part`)
  }
  return `${ST_COMPAT_SETTINGS_KEY_PREFIX}/${extensionId}`
}

/** Upstream DEFAULT_SETTINGS, verbatim (`src/modules/ui.ts` 5-27 @ f9a07da). */
export const EJS_TEMPLATE_DEFAULTS: Record<string, boolean | string | number> = {
  enabled: true,
  generate_enabled: true,
  generate_loader_enabled: true,
  render_enabled: true,
  render_loader_enabled: true,
  with_context_disabled: false,
  debug_enabled: false,
  autosave_enabled: false,
  preload_worldinfo_enabled: true,
  code_blocks_enabled: false,
  raw_message_evaluation_enabled: true,
  filter_message_enabled: true,
  cache_enabled: 0,
  cache_size: 64,
  cache_hasher: 'h32ToString',
  inject_loader_enabled: false,
  invert_enabled: true,
  depth_limit: -1,
  compile_workers: false,
  sandbox: false,
  code_editor: false,
}

/** The blob handed to the kernel on hydrate and persisted back on save. */
export interface StCompatSettingsBlob {
  EjsTemplate: Record<string, boolean | string | number>
  variables: { global: Record<string, unknown> }
  regex: unknown[]
  [key: string]: unknown
}

export function defaultSettingsBlob(): StCompatSettingsBlob {
  return {
    EjsTemplate: { ...EJS_TEMPLATE_DEFAULTS },
    variables: { global: {} },
    regex: [],
  }
}

/**
 * Merge a stored blob over the defaults. Unknown top-level keys pass through
 * (upstream's extension_settings namespace is open), but the three surfaces
 * the facades hydrate are shaped if missing — a stored blob from an older
 * pilot build must not hand the extension `undefined` where an object belongs.
 */
export function hydrateSettingsBlob(stored: unknown): StCompatSettingsBlob {
  const blob = defaultSettingsBlob()
  if (typeof stored !== 'object' || stored === null) return blob
  const record = stored as Record<string, unknown>
  if (typeof record['EjsTemplate'] === 'object' && record['EjsTemplate'] !== null) {
    Object.assign(blob.EjsTemplate, record['EjsTemplate'])
  }
  const variables = record['variables']
  if (typeof variables === 'object' && variables !== null) {
    const global = (variables as { global?: unknown }).global
    if (typeof global === 'object' && global !== null) blob.variables.global = { ...global }
  }
  if (Array.isArray(record['regex'])) blob.regex = record['regex']
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'EjsTemplate' && key !== 'variables' && key !== 'regex') blob[key] = value
  }
  return blob
}
