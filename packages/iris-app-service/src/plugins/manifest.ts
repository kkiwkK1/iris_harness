/**
 * The system-plugin package manifest: a package's `package.json` and the
 * `iris.plugin` block inside it (`docs/SYSTEM-PLUGIN-INSTALL.md` §3).
 *
 * This is the artifact contract for the *other* kind of tree the installer can
 * promote — the ST extension's `manifest.json` + `js` is one format, a Node
 * system plugin's `package.json` + `iris.plugin` is the other — and it is the
 * only plugin-shaped thing PR-1 adds. Nothing here installs, downloads,
 * imports, or activates: it reads files and describes what it found.
 *
 * **Why it lives in `@iris/app-service` and not in the two places the design
 * sketch named.** `docs/SYSTEM-PLUGIN-INSTALL.md` §10 proposed
 * `@iris/plugin-api`; that package's own test forbids it
 * (`packages/iris-plugin-api/tests/contract.test.ts:33` — "this package
 * imports nothing at runtime", and a manifest parser imports `node:fs` and
 * `node:path`), so putting it there would have traded a rule with teeth for a
 * document's convenience. `@iris/extension-installer` was the other candidate
 * and is the wrong one for the mirror-image reason: after PR-1 that package is
 * artifact-blind by construction, and teaching it what a system plugin is
 * would put back the coupling this round removed. The `iris.plugin` shape is
 * owned by whoever owns the plugin control plane, which is this package
 * (`plugins/builtins.ts` already anchors the bundled ids here), so the
 * contract lives beside the runtime that consumes it and is handed *to* the
 * installer as a value.
 *
 * **Every refusal is a typed result, never a thrown generic Error.** The
 * consumers are a preview page (§5.1) that must render *why*, a boot scan (§7)
 * that must mark a row and move on, and the installer gate that must refuse a
 * promotion. A thrown `Error` gives all three a string; `field` is what lets
 * the consent page point at a line of someone's `package.json`. The one place
 * a throw appears is `SYSTEM_PLUGIN_ARTIFACT_CONTRACT.validate`, which is the
 * installer's exception-shaped boundary and converts at it.
 *
 * **`incompatible` is not `manifest-invalid`.** A manifest that is well-formed
 * but declares an `apiVersion` this host does not implement is a correct
 * manifest for a different host; §3 makes it a named state whose row stays in
 * the catalog, unactivated. So the range check runs *last*, after the shape
 * and the path checks, and the incompatible result carries the parsed manifest
 * — the preview page needs the displayName and the version of a plugin it is
 * about to tell the user it cannot run.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { isValidExtensionId, type ArtifactContract } from '@iris/extension-installer'

/** The file the `iris.plugin` block lives in, at the root of the tree. */
export const PLUGIN_MANIFEST_FILE = 'package.json'

/**
 * The closed permission vocabulary a plugin declares, one name per thing
 * `SystemPluginActivationScope` hands over
 * (`packages/iris-plugin-api/src/index.ts:95`).
 *
 * **This is a declaration, not a boundary.** A system plugin is Node code
 * running with the host's own privileges, in the host's own process
 * (`docs/SYSTEM-PLUGIN-INSTALL.md` §4, ruling 1). It can read the filesystem,
 * open sockets and reach every global whether or not it lists a permission
 * here, and nothing in this file or downstream of it revokes a scope member
 * that went undeclared. What the list buys is exactly two things: the consent
 * page can show the user what the author says the plugin will do, and the host
 * can check the *spelling*, so a plugin declaring `registerRPC` or
 * `network-access` is refused as `manifest-invalid` instead of silently
 * declaring nothing. Treating it as an enforcement surface would be the
 * "looks like a permission list but is not one" risk §12 question 4 names; the
 * answer to that question was to keep the list and say so, here and on the
 * consent page.
 *
 * The mapping, name to scope member:
 *
 * | permission | scope member |
 * | --- | --- |
 * | `provide-capability` | `provide(name, value)` |
 * | `get-dependency` | `getDependency(pluginId, name)` |
 * | `register-rpc` | `registerRpc(method, schema, handler)` |
 * | `host-context` | `context` — the host's Cordis `Context`, a property and not a method, and the largest thing the scope hands over |
 *
 * `pluginId` and `revision` are the activation's own identity, not something
 * it reaches with, so they have no permission name. If the scope gains a
 * member, this array gains a name in the same commit — that is the whole
 * maintenance rule, and `plugin-manifest.test.ts` pins the mapping so a scope
 * member added without one goes red.
 *
 * Exported as a readonly array so the consent page can render it in
 * declaration order rather than re-deriving a list it might get wrong.
 */
export const PLUGIN_PERMISSIONS = [
  'provide-capability',
  'get-dependency',
  'register-rpc',
  'host-context',
] as const

export type PluginPermission = typeof PLUGIN_PERMISSIONS[number]

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PLUGIN_PERMISSIONS)

/**
 * The `apiVersion` range this host implements, as `major.minor` bounds,
 * inclusive at both ends.
 *
 * It is declared here because no document declares it.
 * `docs/PLUGIN-CONTRACT-PACKAGING.md` §5 fixes the *alignment* — contract
 * `apiVersion: 1` travels with npm major `1` — and explicitly declines to name
 * a number ("版本号由协调者决定并作为 `--version` 传入。本文不替任何一次发布定这个数")，
 * and `docs/SYSTEM-PLUGINS.md` has no `iris.apiVersion` rule at all (the
 * reference to one in PLUGIN-CONTRACT-PACKAGING §5 is a forward announcement;
 * `docs/SYSTEM-PLUGIN-INSTALL.md` §2 item 2 records that). So the one number
 * lives beside the check that reads it, and moves only with this file.
 *
 * Today's value says the same thing §3 does — the host supports `[1, 1]` —
 * spelled at `major.minor` granularity because that is the granularity of the
 * scope surface: a plugin declaring `1.1` wants a member this host's scope
 * does not have, and that is exactly the `incompatible` case, not a warning.
 */
export const SUPPORTED_PLUGIN_API_RANGE = { min: '1.0', max: '1.0' } as const

/**
 * `major.minor`, optionally `.patch`, optionally a `-prerelease` tail.
 *
 * Leading zeros are refused (`01.0` is not `1.0`), so one version has one
 * spelling and a treeHash-pinned record cannot disagree with a catalog row
 * over whitespace. A bare major (`"1"`) is refused too: the range is compared
 * at `major.minor`, and a manifest that names only half of the compared value
 * is asking the host to guess the other half.
 */
const API_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

/** One parsed `iris.plugin` block, with every optional list present and empty when unstated. */
export interface SystemPluginManifest {
  readonly id: string
  /**
   * The declared API version, normalized: the integer form `1` that §3's
   * sketch and `SystemPluginDefinition.apiVersion` both use reads as `'1.0'`.
   */
  readonly apiVersion: string
  /** The two numbers the range compares; patch and prerelease are not part of the surface. */
  readonly apiVersionParts: { readonly major: number; readonly minor: number }
  /** Relative, forward-slash, in-tree path to the host ESM module. */
  readonly host: string
  /** Relative, forward-slash, in-tree path to the browser bundle, when the package ships one. */
  readonly client?: string
  readonly displayName: string
  readonly description: string
  /** The package's own `version` field, which §5.1's preview shows beside the commit. */
  readonly version: string
  /** Free-form names the plugin says it provides. Declaration only; the host has no capability registry to check them against (§3). */
  readonly capabilities: readonly string[]
  /** Closed vocabulary; see `PLUGIN_PERMISSIONS` for what it is and is not. */
  readonly permissions: readonly PluginPermission[]
  /** Other plugin ids, fed to the definition's existing DFS ordering. */
  readonly dependencies: readonly string[]
}

export interface PluginManifestOk {
  readonly ok: true
  readonly manifest: SystemPluginManifest
}

/** A manifest this host cannot read: the field is always named. */
export interface PluginManifestInvalid {
  readonly ok: false
  readonly state: 'manifest-invalid'
  /** Dotted path of the offending field, list entries indexed (`permissions[1]`). */
  readonly field: string
  readonly reason: string
}

/** A well-formed manifest for a host that is not this one. */
export interface PluginManifestIncompatible {
  readonly ok: false
  readonly state: 'incompatible'
  readonly field: 'apiVersion'
  readonly reason: string
  readonly declared: string
  readonly supported: string
  /** Parsed anyway: the row and the consent page still have to name the plugin. */
  readonly manifest: SystemPluginManifest
}

export type PluginManifestResult = PluginManifestOk | PluginManifestInvalid | PluginManifestIncompatible

function invalid(field: string, reason: string): PluginManifestInvalid {
  return { ok: false, state: 'manifest-invalid', field, reason }
}

/** The refusal in the shape the installer's failure path speaks. */
export class PluginManifestError extends Error {
  readonly state: 'manifest-invalid' | 'incompatible'
  readonly field: string
  readonly reason: string
  constructor(failure: PluginManifestInvalid | PluginManifestIncompatible) {
    super(`${failure.state}: ${failure.field} — ${failure.reason}`)
    this.state = failure.state
    this.field = failure.field
    this.reason = failure.reason
  }
}

function nonEmptyString(value: unknown, field: string): PluginManifestInvalid | string {
  if (typeof value !== 'string') return invalid(field, `expected a string, got ${describe(value)}`)
  if (value.trim() === '') return invalid(field, 'expected a non-empty string')
  return value
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

function isInvalid(value: unknown): value is PluginManifestInvalid {
  return typeof value === 'object' && value !== null && (value as { state?: unknown }).state === 'manifest-invalid'
}

/**
 * Parses one already-read `package.json` value. Shape only: no filesystem, so
 * `host`/`client` are checked as *paths* (relative, in-tree, no escape) but
 * not for existence, and the API range is not applied.
 *
 * Split out from `parsePluginManifest` because the path grammar and the field
 * rules are the half that a test can drive exhaustively without a tree on
 * disk, and because §5.1's preview and §7's boot scan read the same bytes from
 * two different places.
 */
export function parsePluginManifestValue(raw: unknown): PluginManifestOk | PluginManifestInvalid {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid(PLUGIN_MANIFEST_FILE, `expected a JSON object, got ${describe(raw)}`)
  }
  const pkg = raw as Record<string, unknown>

  const version = nonEmptyString(pkg.version, 'version')
  if (isInvalid(version)) return version

  const iris = pkg.iris
  if (typeof iris !== 'object' || iris === null || Array.isArray(iris)) {
    return invalid('iris', `expected an object carrying the plugin block, got ${describe(iris)}`)
  }
  const block = (iris as Record<string, unknown>).plugin
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return invalid('iris.plugin', `expected an object, got ${describe(block)} — a package without this block is not a system plugin`)
  }
  const plugin = block as Record<string, unknown>

  // id: the installer's grammar, not a second one. The id becomes a directory
  // name under <profile>/system-plugins/installed/, a URL segment under
  // /plugins/<id>/client.js, and the catalog's primary key; the rule that
  // takes responsibility for the first of those is EXTENSION_ID_RE
  // (packages/iris-extension-installer/src/lock.ts:28), reached here through
  // its exported predicate so there is exactly one copy in the tree.
  const id = plugin.id
  if (typeof id !== 'string' || !isValidExtensionId(id)) {
    return invalid('id', `expected [a-z0-9][a-z0-9._-]{0,63} — the id becomes a directory name and a URL segment; got ${JSON.stringify(id)}`)
  }

  const apiVersion = normalizeApiVersion(plugin.apiVersion)
  if (isInvalid(apiVersion)) return apiVersion

  const host = checkTreePathShape(plugin.host, 'host')
  if (isInvalid(host)) return host

  let client: string | undefined
  if (plugin.client !== undefined) {
    const checked = checkTreePathShape(plugin.client, 'client')
    if (isInvalid(checked)) return checked
    client = checked
  }

  const displayName = nonEmptyString(plugin.displayName, 'displayName')
  if (isInvalid(displayName)) return displayName
  const description = nonEmptyString(plugin.description, 'description')
  if (isInvalid(description)) return description

  const capabilities = stringList(plugin.capabilities, 'capabilities', entry => entry.trim() !== '' ? null : 'expected a non-empty string')
  if (isInvalid(capabilities)) return capabilities

  const permissions = stringList(plugin.permissions, 'permissions', (entry, index, seen) => {
    if (!PERMISSION_SET.has(entry)) {
      return `unknown permission ${JSON.stringify(entry)} — the vocabulary is ${PLUGIN_PERMISSIONS.join(', ')}`
    }
    if (seen.has(entry)) return `permission ${JSON.stringify(entry)} is declared twice; a declaration the consent page renders is a set, not a tally`
    return null
  })
  if (isInvalid(permissions)) return permissions

  const dependencies = stringList(plugin.dependencies, 'dependencies', entry => (
    isValidExtensionId(entry) ? null : `expected a plugin id matching [a-z0-9][a-z0-9._-]{0,63}, got ${JSON.stringify(entry)}`
  ))
  if (isInvalid(dependencies)) return dependencies

  return {
    ok: true,
    manifest: {
      id,
      apiVersion: apiVersion.normalized,
      apiVersionParts: { major: apiVersion.major, minor: apiVersion.minor },
      host,
      ...(client !== undefined ? { client } : {}),
      displayName,
      description,
      version,
      capabilities,
      permissions: permissions as readonly PluginPermission[],
      dependencies,
    },
  }
}

function stringList(
  value: unknown,
  field: string,
  check: (entry: string, index: number, seen: ReadonlySet<string>) => string | null,
): readonly string[] | PluginManifestInvalid {
  if (value === undefined) return []
  if (!Array.isArray(value)) return invalid(field, `expected an array, got ${describe(value)}`)
  const seen = new Set<string>()
  const out: string[] = []
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index]
    if (typeof entry !== 'string') {
      return invalid(`${field}[${String(index)}]`, `expected a string, got ${describe(entry)}`)
    }
    const problem = check(entry, index, seen)
    if (problem !== null) return invalid(`${field}[${String(index)}]`, problem)
    seen.add(entry)
    out.push(entry)
  }
  return out
}

function normalizeApiVersion(value: unknown): PluginManifestInvalid | { normalized: string; major: number; minor: number } {
  // The integer spelling is accepted because it is the one the contract uses:
  // SystemPluginDefinition.apiVersion is the numeric literal type `1`
  // (packages/iris-plugin-api/src/index.ts:60) and §3's manifest sketch writes
  // `"apiVersion": 1`. Refusing it would have made the design document's own
  // example invalid; it normalizes to `n.0`, so there is still one compared
  // value.
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return invalid('apiVersion', `expected a non-negative integer or a "major.minor" string, got ${String(value)}`)
    }
    return { normalized: `${String(value)}.0`, major: value, minor: 0 }
  }
  if (typeof value !== 'string') {
    return invalid('apiVersion', `expected a non-negative integer or a "major.minor" string, got ${describe(value)}`)
  }
  const match = API_VERSION_RE.exec(value)
  if (match === null) {
    return invalid('apiVersion', `expected "major.minor", optionally ".patch" and a "-prerelease" tail, with no leading zeros; got ${JSON.stringify(value)}`)
  }
  return { normalized: value, major: Number(match[1]), minor: Number(match[2]) }
}

/**
 * C0 controls and DEL, by code point rather than by a character class: this
 * file is edited by tools that have been measured to eat a lone backslash, and
 * a range escape that silently became a literal control character would still
 * compile and still pass every input a test thinks to write.
 */
function hasControlCharacter(segment: string): boolean {
  for (const ch of segment) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The path grammar for `host` and `client`: relative, forward-slash, and
 * inside the tree (invariant #7).
 *
 * Refused: an absolute path, a Windows drive letter, a backslash anywhere, an
 * empty or `.` or `..` segment, and a trailing slash. `..` is rejected as a
 * *segment* rather than as a substring, so `a..b.js` is a legal filename while
 * `a/../../x` is not — and the resolved-prefix check in
 * `resolveTreePath` is the independent second net for whatever the grammar
 * failed to imagine, the same two-nets shape `guardEntryName` and
 * `auditContainment` already have
 * (`packages/iris-extension-installer/src/archive.ts:59`, `:303`).
 */
function checkTreePathShape(value: unknown, field: string): string | PluginManifestInvalid {
  const raw = nonEmptyString(value, field)
  if (isInvalid(raw)) return raw
  if (raw.includes('\\')) {
    return invalid(field, `contains a backslash — paths in the manifest are forward-slash relative paths: ${JSON.stringify(raw)}`)
  }
  if (raw.startsWith('/') || path.isAbsolute(raw) || /^[a-zA-Z]:/u.test(raw)) {
    return invalid(field, `is an absolute path; the entry must be relative to the package root: ${JSON.stringify(raw)}`)
  }
  const segments = raw.split('/')
  for (const segment of segments) {
    if (segment === '') return invalid(field, `has an empty path segment: ${JSON.stringify(raw)}`)
    if (segment === '.' || segment === '..') {
      return invalid(field, `has a ${JSON.stringify(segment)} segment — the entry must stay inside the package tree: ${JSON.stringify(raw)}`)
    }
    if (hasControlCharacter(segment)) {
      return invalid(field, `has a control character in a path segment: ${JSON.stringify(raw)}`)
    }
  }
  return raw
}

/**
 * The filesystem half of the path check: the entry resolves inside `root`,
 * exists, is a regular file, and no component of the way there is a
 * symlink/junction (invariant #10).
 *
 * Every component is `lstat`ed, not just the last one, because `lstat` only
 * declines to follow the final component: a junction planted as an
 * intermediate directory would be silently traversed by a single `lstat` of
 * the full path. The notion of "symlink" is `hashTree`'s
 * (`packages/iris-extension-installer/src/hash.ts:38`) —
 * `lstat().isSymbolicLink()`, which is what reports a Windows junction through
 * libuv — so a tree this function accepts is a tree `hashTree` can hash and
 * `auditContainment` can clear, rather than three different opinions of the
 * same word.
 */
async function resolveTreePath(root: string, rel: string, field: string): Promise<string | PluginManifestInvalid> {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...rel.split('/'))
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    return invalid(field, `resolves outside the package tree: ${JSON.stringify(rel)}`)
  }
  let walked = resolvedRoot
  const segments = rel.split('/')
  for (let index = 0; index < segments.length; index++) {
    walked = path.join(walked, segments[index] as string)
    const stat = await fsp.lstat(walked).catch(() => null)
    if (stat === null) {
      return invalid(field, `names a file that is not in the package: ${JSON.stringify(rel)}`)
    }
    if (stat.isSymbolicLink()) {
      return invalid(field, `reaches through a symlink/junction at ${JSON.stringify(segments.slice(0, index + 1).join('/'))} — an installed tree is hashed, and a hashed tree has no links`)
    }
    const last = index === segments.length - 1
    if (last && !stat.isFile()) {
      return invalid(field, `is not a regular file: ${JSON.stringify(rel)}`)
    }
    if (!last && !stat.isDirectory()) {
      return invalid(field, `walks through a non-directory at ${JSON.stringify(segments.slice(0, index + 1).join('/'))}`)
    }
  }
  return target
}

/**
 * The host's compatibility judgement, separated from the parse so a caller
 * that only wants to ask "would this run here?" does not have to re-read a
 * tree. Returns `null` when the manifest is in range.
 */
export function checkPluginApiVersion(manifest: SystemPluginManifest): PluginManifestIncompatible | null {
  const [minMajor, minMinor] = splitBound(SUPPORTED_PLUGIN_API_RANGE.min)
  const [maxMajor, maxMinor] = splitBound(SUPPORTED_PLUGIN_API_RANGE.max)
  const { major, minor } = manifest.apiVersionParts
  const below = major < minMajor || (major === minMajor && minor < minMinor)
  const above = major > maxMajor || (major === maxMajor && minor > maxMinor)
  if (!below && !above) return null
  return {
    ok: false,
    state: 'incompatible',
    field: 'apiVersion',
    reason: `the plugin declares apiVersion ${manifest.apiVersion}; this host implements ${SUPPORTED_PLUGIN_API_RANGE.min}–${SUPPORTED_PLUGIN_API_RANGE.max}`,
    declared: manifest.apiVersion,
    supported: `${SUPPORTED_PLUGIN_API_RANGE.min}–${SUPPORTED_PLUGIN_API_RANGE.max}`,
    manifest,
  }
}

function splitBound(bound: string): [number, number] {
  const [major, minor] = bound.split('.')
  return [Number(major), Number(minor)]
}

/**
 * Reads and validates one staged or installed package tree.
 *
 * Order is deliberate and observable: shape, then the filesystem, then the API
 * range. A manifest that is both malformed and out of range answers
 * `manifest-invalid`, because a host that cannot read a field has not earned
 * the right to an opinion about the version; and an `incompatible` result is
 * therefore always one whose `host`/`client` were checked, which is what lets
 * it carry a manifest the preview page can render.
 */
export async function parsePluginManifest(contentDir: string): Promise<PluginManifestResult> {
  let raw: string
  try {
    raw = await fsp.readFile(path.join(contentDir, PLUGIN_MANIFEST_FILE), 'utf8')
  } catch {
    return invalid(PLUGIN_MANIFEST_FILE, `the package has no ${PLUGIN_MANIFEST_FILE} at its root`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    return invalid(PLUGIN_MANIFEST_FILE, `is not valid JSON: ${(err as Error).message}`)
  }
  const parsed = parsePluginManifestValue(value)
  if (!parsed.ok) return parsed

  const hostPath = await resolveTreePath(contentDir, parsed.manifest.host, 'host')
  if (isInvalid(hostPath)) return hostPath
  if (parsed.manifest.client !== undefined) {
    const clientPath = await resolveTreePath(contentDir, parsed.manifest.client, 'client')
    if (isInvalid(clientPath)) return clientPath
  }

  return checkPluginApiVersion(parsed.manifest) ?? parsed
}

/**
 * The system-plugin format, as the installer's injected gate.
 *
 * `incompatible` refuses here too, and that is not the same ruling as §3's
 * "the row stays in the catalog, unactivated": a row can only exist once
 * something is installed, and installing a tree this host has no way to run
 * would leave the user a directory and a catalog entry in exchange for a
 * download. The boot scan's leniency is about a plugin that was installable
 * when it was installed; the install gate's strictness is about one that never
 * was.
 */
export const SYSTEM_PLUGIN_ARTIFACT_CONTRACT: ArtifactContract = {
  name: 'iris-system-plugin',
  async validate(contentDir: string): Promise<void> {
    const result = await parsePluginManifest(contentDir)
    if (!result.ok) throw new PluginManifestError(result)
  },
}
