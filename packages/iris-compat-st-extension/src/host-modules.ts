/**
 * The registered ST host-module table — §6 of
 * `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md`: 只映射精确的已登记宿主路径.
 *
 * Registration here means exactly one thing: an import that resolves to this
 * ST-public-relative path is **recognized** as a host-module dependency and
 * reported `mapped`. It does not assert the module's behavior exists, is
 * faithful, or is even scheduled — the facade matrix (§6's table) is what
 * claims behavior, and it is built per facade in P3, not here. An analyzer
 * finding that says `mapped` therefore reads "counted against a named
 * facade", never "works".
 *
 * The seed list is not aspiration — it is the measured static import set of
 * the locked pilot artifact (ST-Prompt-Template `f9a07da`, evidence in
 * `notes/st-compat/survey/st-prompt-template.report.json`), which is the
 * batch-P0 ruling for "first modules by real pilot usage". The two survey
 * ambiguities are resolved here the way upstream semantics resolve them
 * (`scripts/openai.js`, not the tts helper of the same tail name), because a
 * registry of exact paths is precisely the place that decision belongs once.
 */

/** Registered host paths: ST-`public/`-relative POSIX, no leading slash. */
export const ST_HOST_MODULE_PATHS: readonly string[] = [
  'script.js',
  'lib.js',
  'scripts/events.js',
  'scripts/extensions.js',
  'scripts/group-chats.js',
  'scripts/openai.js',
  'scripts/popup.js',
  'scripts/power-user.js',
  'scripts/reasoning.js',
  'scripts/slash-commands.js',
  'scripts/slash-commands/SlashCommand.js',
  'scripts/slash-commands/SlashCommandArgument.js',
  'scripts/slash-commands/SlashCommandParser.js',
  'scripts/tokenizers.js',
  'scripts/utils.js',
  'scripts/world-info.js',
  'scripts/extensions/regex/engine.js',
]

/** A host registry: the exact-path set the analyzer maps against. */
export interface HostRegistry {
  readonly paths: ReadonlySet<string>
}

/**
 * Build a host registry. The default is the seed table; a caller (tests, an
 * adapter archive) may narrow it to assert what a specific compat plan
 * actually covers.
 * @param paths - exact ST-public-relative POSIX paths.
 */
export function stHostRegistry(paths: readonly string[] = ST_HOST_MODULE_PATHS): HostRegistry {
  return { paths: new Set(paths) }
}

/**
 * The unique-suffix fallback for bundled artifacts. A webpack bundle keeps
 * the **original source specifier** for externals, whose `../` depth belonged
 * to a source file the artifact no longer names, so URL-resolution from the
 * entry can land a segment off — `extensions/world-info.js` instead of
 * `scripts/world-info.js`. When exact matching misses, a resolved path whose
 * tail matches exactly one registered path (as that path's own suffix, in
 * either direction) is reported `unknown` with the candidate named — never
 * silently `mapped`, and never `missing` when a plausible reading exists
 * (§2: 静态分析只能列出确定依赖和未知点).
 * @param path - the ST-public-relative path that failed exact matching.
 * @param registry - the registry to match against.
 * @returns the unique registered path the input's tail matches, if exactly one.
 */
export function uniqueSuffixMatch(path: string, registry: HostRegistry): string | undefined {
  const segments = path.split('/')
  const matches = new Set<string>()
  for (let start = 1; start < segments.length; start++) {
    const tail = segments.slice(start).join('/')
    if (registry.paths.has(tail)) matches.add(tail)
    for (const key of registry.paths) {
      if (key.endsWith(`/${tail}`)) matches.add(key)
    }
  }
  if (matches.size === 1) return [...matches][0]
  return undefined // no reading, or two: either way, no assertion
}
