/**
 * ST manifest normalization — `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md` §4:
 * 保留原文件, read the fields this machine's SillyTavern actually consults,
 * and list everything else as unknown.
 *
 * The field list mirrors ST 1.18.0 `public/scripts/extensions.js` (verified
 * against commit `51ad27fb8`, line-cited in `notes/st-compat/pilot-lock.md`
 * §3): `requires` gates **Extras modules** and `minimum_client_version`
 * compares against **CLIENT_VERSION** — neither is an Iris-side dependency
 * or version, so both are carried verbatim, never interpreted here.
 *
 * Normalization refuses rather than repairs: a manifest whose declared entry
 * paths are not relative, in-tree POSIX-shaped paths produces issues, and
 * the caller does not get a half-normalized manifest to mis-install. What ST
 * itself tolerates (a non-numeric `loading_order`, fields it never reads) we
 * tolerate too — recorded, not fatal — because refusing what the host
 * accepts would invent incompatibility.
 */

/** The manifest as far as Iris needs to read it. Raw is preserved by the caller. */
export interface NormalizedManifest {
  /** ST sorts by this (`extensions.js:49-50`); absent falls back to the directory name. */
  displayName: string
  /** Entry script, artifact-relative POSIX; absent means a css-only extension. */
  js?: string
  /** Stylesheet, artifact-relative POSIX. */
  css?: string
  /** `extensions.js:49` parseInt's this; non-numeric reads as undefined here. */
  loadingOrder?: number
  /** Extras module ids — NOT plugin dependencies (§2 of the runbook). */
  readonly requires: readonly string[]
  /** Display-only requirement chips (`extensions.js:972-986`). */
  readonly optional: readonly string[]
  /** Extension ids this extension needs enabled (`extensions.js:579`). */
  readonly dependencies: readonly string[]
  /** Verbatim ST client version floor; never compared to an Iris version. */
  minimumClientVersion?: string
  /** locale → artifact-relative POSIX path (`extensions.js:849-855`). */
  readonly i18n?: Readonly<Record<string, string>>
  author?: string
  version?: string
  homePage?: string
  autoUpdate?: boolean
  /** Fields present in the file but outside the ST 1.18.0 read list. */
  readonly unknownFields: readonly string[]
}

/** One reason normalization refused. Field-scoped so a caller can point at the input. */
export interface ManifestIssue {
  field: string
  message: string
}

/** Fields SillyTavern 1.18.0's extensions.js actually reads (see module docblock). */
const KNOWN_FIELDS = [
  'display_name', 'loading_order', 'requires', 'optional', 'dependencies',
  'minimum_client_version', 'js', 'css', 'i18n', 'author', 'version',
  'homePage', 'auto_update',
] as const

/**
 * Validate one manifest-declared artifact path: relative, POSIX-shaped, and
 * free of parent traversal. ST serves these under `/scripts/extensions/<id>/`,
 * so an absolute path, a URL, a drive letter or a `..` segment is not a path
 * into the artifact — it is either broken or probing outside it, and both
 * are refused before any file is opened.
 */
function artifactPath(value: unknown, field: string, issues: ManifestIssue[]): string | undefined {
  if (typeof value !== 'string' || value === '') {
    issues.push({ field, message: 'must be a non-empty string' })
    return undefined
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    issues.push({ field, message: `must be relative to the extension root, got "${value}"` })
    return undefined
  }
  if (value.includes('\\') || /^[a-zA-Z]:/.test(value)) {
    issues.push({ field, message: `must use forward slashes, got "${value}"` })
    return undefined
  }
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      issues.push({ field, message: `must not traverse upward, got "${value}"` })
      return undefined
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/** Validate a field that must be a string array when present. */
function stringArray(value: unknown, field: string, issues: ManifestIssue[]): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    issues.push({ field, message: 'must be an array of strings' })
    return []
  }
  return value as readonly string[]
}

/**
 * Normalize one parsed manifest.
 *
 * @param raw - the parsed `manifest.json` value.
 * @returns the manifest, or the refusal reasons (never both).
 */
export function normalizeManifest(raw: unknown): { ok: true, manifest: NormalizedManifest } | { ok: false, issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: 'manifest', message: 'must be a JSON object' }] }
  }
  const source = raw as Record<string, unknown>

  const displayName = typeof source['display_name'] === 'string' && source['display_name'] !== ''
    ? source['display_name']
    : undefined
  if (displayName === undefined) issues.push({ field: 'display_name', message: 'must be a non-empty string' })

  let js: string | undefined
  if (source['js'] !== undefined && source['js'] !== '') js = artifactPath(source['js'], 'js', issues)
  let css: string | undefined
  if (source['css'] !== undefined && source['css'] !== '') css = artifactPath(source['css'], 'css', issues)

  let loadingOrder: number | undefined
  if (source['loading_order'] !== undefined) {
    const value = source['loading_order']
    if (typeof value === 'number' && Number.isSafeInteger(value)) loadingOrder = value
    else if (typeof value === 'string' && /^\d+$/.test(value)) loadingOrder = Number.parseInt(value, 10)
    // ST parseInt's whatever is there and sorts on the NaN; a non-numeric
    // value is tolerated and dropped, matching the host's reading.
  }

  const requires = stringArray(source['requires'], 'requires', issues)
  const optional = stringArray(source['optional'], 'optional', issues)
  const dependencies = stringArray(source['dependencies'], 'dependencies', issues)

  let minimumClientVersion: string | undefined
  if (source['minimum_client_version'] !== undefined) {
    if (typeof source['minimum_client_version'] === 'string') minimumClientVersion = source['minimum_client_version']
    else issues.push({ field: 'minimum_client_version', message: 'must be a string' })
  }

  let i18n: Readonly<Record<string, string>> | undefined
  if (source['i18n'] !== undefined) {
    const value = source['i18n']
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ field: 'i18n', message: 'must be an object of locale → path' })
    } else {
      const entries: Record<string, string> = {}
      for (const [locale, path] of Object.entries(value)) {
        const clean = artifactPath(path, `i18n.${locale}`, issues)
        if (clean !== undefined) entries[locale] = clean
      }
      i18n = entries
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  const manifest: NormalizedManifest = {
    displayName: displayName ?? '',
    requires,
    optional,
    dependencies,
    unknownFields: Object.keys(source).filter(key => !(KNOWN_FIELDS as readonly string[]).includes(key)),
    ...(js !== undefined ? { js } : {}),
    ...(css !== undefined ? { css } : {}),
    ...(loadingOrder !== undefined ? { loadingOrder } : {}),
    ...(minimumClientVersion !== undefined ? { minimumClientVersion } : {}),
    ...(i18n !== undefined ? { i18n } : {}),
    ...(typeof source['author'] === 'string' ? { author: source['author'] } : {}),
    ...(typeof source['version'] === 'string' ? { version: source['version'] } : {}),
    ...(typeof source['homePage'] === 'string' ? { homePage: source['homePage'] } : {}),
    ...(typeof source['auto_update'] === 'boolean' ? { autoUpdate: source['auto_update'] } : {}),
  }
  return { ok: true, manifest }
}
