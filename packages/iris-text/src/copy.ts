/**
 * The bilingual-copy audit that the host's install gate and the shell's
 * dictionary test must compute identically.
 *
 * The membership rule, applied: a plugin ships its own interface copy as two
 * flat string tables (`i18n.en` / `i18n.zh` in the manifest), and the host
 * refuses a package whose tables break one of three rules — the columns cover
 * the same key set, the Chinese column actually contains Chinese, and both
 * columns fill the same `{slots}`. The shell's own dictionaries are held to
 * exactly the same three rules by `apps/iris-web/tests/i18n.test.ts`. Two
 * execution points, one rule: if the copies drifted, the host would admit at
 * install time what the gate only caught later — or never, for a plugin
 * installed before the test next ran — so the rule exists once, here, and both
 * callers import it. `stringHash` is the same shape with the frame on the
 * other end; here the second consumer is a test, which is *why* a drift would
 * be quiet: each side stays green alone, and only a shared implementation can
 * make the two answers disagree loudly.
 *
 * Zero imports, including Node builtins: everything below is computable from
 * the language alone, and the filesystem half of the host's audit (reading the
 * files, measuring bytes) stays in the host — this module receives tables that
 * are already parsed.
 *
 * @module @iris/text/copy
 */

/**
 * The languages a plugin's copy may ship, in the order the manifest states
 * them. A third language is a new ruling, not a parse tolerant of one.
 */
export const PLUGIN_COPY_LANGUAGES = ['en', 'zh'] as const

/** One of the two copy languages. */
export type CopyLanguage = (typeof PLUGIN_COPY_LANGUAGES)[number]

/**
 * The key grammar for a copy table: a letter, then letters or digits.
 *
 * Deliberately narrower than the shell's own `StringKey`: a plugin key is one
 * segment of a runtime key `plugin:<id>:<key>`, and holding it to
 * `[a-zA-Z][a-zA-Z0-9]*` keeps every character in that key unambiguous in a
 * URL, a DOM attribute and a log line. It also refuses `__proto__` and other
 * inheritable names outright, so a table merged into a plain object cannot
 * reach anything it did not declare.
 */
export const PLUGIN_COPY_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/

/**
 * How big one copy file may be.
 *
 * `maxBytes` is per **file**, not per plugin — one language's table — and is
 * a measurement, not a taste: the shell's whole `strings.ts` (both columns,
 * every sentence the app has) is about 300 KiB of source, and a single
 * plugin's copy has no business outweighing the shell that hosts it. The
 * overlay is resident memory on every reader's machine, which is not the same
 * ledger as `PLUGIN_TREE_LIMITS`' dead weight on disk. `maxKeys` is the point
 * past which the consent page's "N strings" stops meaning anything to the
 * person reading it.
 */
export const PLUGIN_COPY_LIMITS = {
  maxBytes: 256 * 1024,
  maxKeys: 2_000,
} as const

/** One refusal, in the shape `parsePluginManifestValue` speaks: the field is named. */
export interface CopyAuditFailure {
  /** Dotted path, prefixed by the caller (`i18n.zh.greeting`), so a consent page can point at a line. */
  readonly field: string
  /** A sentence a person can act on, naming the key where there is one. */
  readonly reason: string
}

const NO_NEUTRAL_KEYS: ReadonlySet<string> = new Set<string>()

/**
 * The `{name}` slots one string fills, as a sorted set.
 *
 * A set, not a multiset: a language's grammar may repeat a slot ("2 of 2")
 * where the other says it once ("2 个全部"), but a slot that exists in one
 * column and not the other is a broken sentence waiting. Sorted so two
 * implementations comparing arrays compare the same order.
 */
export function copySlots(value: string): readonly string[] {
  return [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!))].sort()
}

/**
 * One copy column on its own: every key in grammar, every value a string,
 * and the table within `PLUGIN_COPY_LIMITS.maxKeys`.
 *
 * `table` is typed to unknown values on purpose — the caller's rows come from
 * `JSON.parse`, which the compiler cannot vouch for — and the string check is
 * the runtime half of that honesty, not paranoia about typed callers.
 *
 * @param table - the parsed copy file.
 * @param field - the dotted prefix for failures (`i18n.en`); a bad key or
 *   value is named `field.key`.
 * @param limits - test-only override of {@link PLUGIN_COPY_LIMITS}, so a test
 *   can reach the refusal without building a maxKeys-row table. The byte
 *   ceiling is **not** applied here — a table arrives parsed and the byte
 *   count belongs to whoever holds the file; only `maxKeys` is consulted.
 * @returns the first refusal, or `null` when the column is clean.
 */
export function auditCopyTable(
  table: Readonly<Record<string, unknown>>,
  field: string,
  limits: { readonly maxKeys: number } = PLUGIN_COPY_LIMITS,
): CopyAuditFailure | null {
  const keys = Object.keys(table)
  if (keys.length > limits.maxKeys) {
    return {
      field,
      reason: `carries ${String(keys.length)} strings, over the ${String(limits.maxKeys)}-string limit`,
    }
  }
  for (const key of keys) {
    if (!PLUGIN_COPY_KEY_RE.test(key)) {
      return {
        field: `${field}.${key}`,
        reason: `key does not match ${String(PLUGIN_COPY_KEY_RE)} — a copy key is [a-zA-Z][a-zA-Z0-9]*, and becomes part of the runtime key plugin:<id>:<key>`,
      }
    }
    if (typeof table[key] !== 'string') {
      return { field: `${field}.${key}`, reason: `expected a string value, got ${describe(table[key])}` }
    }
  }
  return null
}

/**
 * The three bilingual rules, in the order they are checked: the columns cover
 * one key set; every non-neutral zh value contains Chinese; both columns fill
 * the same slot sets.
 *
 * Per-column questions (key grammar, value types, the key-count ceiling) are
 * {@link auditCopyTable}'s and are **not** repeated here — the host calls both,
 * and a test that only holds the shell dictionaries to these three rules
 * should not inherit the plugin-key ceiling, which the shell's own key count
 * is close to.
 *
 * @param en - the English column.
 * @param zh - the Chinese column.
 * @param options.neutralKeys - zh keys exempt from the Chinese check, for rows
 *   that are number formats or units and read the same in both languages. The
 *   whitelist is the caller's fact, not part of the rule: the shell carries
 *   its fourteen, a plugin's audit passes none.
 * @param options.field - the dotted failure prefix; the host passes `i18n` and
 *   a refusal reads `i18n.zh.greeting`.
 * @returns the first refusal, or `null` when the pair is clean.
 */
export function auditBilingualCopy(
  en: Readonly<Record<string, string>>,
  zh: Readonly<Record<string, string>>,
  options?: {
    readonly neutralKeys?: ReadonlySet<string>
    readonly field?: string
  },
): CopyAuditFailure | null {
  const prefix = options?.field ?? 'copy'
  const enKeys = Object.keys(en).sort()
  const zhKeys = Object.keys(zh).sort()
  if (!sameValues(enKeys, zhKeys)) {
    const missing = enKeys.filter(key => !Object.hasOwn(zh, key))
    const extra = zhKeys.filter(key => !Object.hasOwn(en, key))
    return {
      field: `${prefix}.zh`,
      reason: `the two columns cover different key sets — missing from zh: ${JSON.stringify(missing)}; only in zh: ${JSON.stringify(extra)}`,
    }
  }
  // The same character range the shell's own audit has always used. Changing
  // it is another task with both consumers in the room, not an improvement
  // made while moving the rule.
  const cjk = /[\u3400-\u9fff]/
  const neutral = options?.neutralKeys ?? NO_NEUTRAL_KEYS
  for (const [key, value] of Object.entries(zh)) {
    if (neutral.has(key)) continue
    if (!cjk.test(value)) {
      return { field: `${prefix}.zh.${key}`, reason: `zh["${key}"] has no Chinese: ${value}` }
    }
  }
  for (const [key, enValue] of Object.entries(en)) {
    const zhValue = zh[key] ?? ''
    if (!sameValues(copySlots(zhValue), copySlots(enValue))) {
      return { field: `${prefix}.zh.${key}`, reason: `placeholder drift on "${key}"` }
    }
  }
  return null
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}
