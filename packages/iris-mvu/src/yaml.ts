/**
 * The YAML block form a variable tree is shown in.
 *
 * Lives here because this is the only package in the workspace that already
 * declares a YAML library, and adding one elsewhere would mean an install this
 * session may not run. It is generic, not MVU-specific — see the note on
 * {@link formatYamlBlock}.
 *
 * @module @iris/mvu/yaml
 */

import { dump } from 'js-yaml'

/**
 * Render a value as the YAML block `{{format_*_variable::…}}` produces.
 *
 * Upstream calls `YAML.stringify(value, { blockQuote: 'literal' }).trimEnd()`
 * from the `yaml` package. This is `js-yaml` instead, and the two were compared
 * rather than assumed equivalent: against the worked example in
 * `JS-Slash-Runner/CHANGELOG.md` (the `{{format_message_variable::stat_data}}`
 * block under 4.1.4) the output matches line for line, and a multi-line string
 * comes out as a `|-` literal block, which is what `blockQuote: 'literal'` asks
 * for.
 *
 * Two options are not defaults and both matter:
 *
 * - `lineWidth: -1` — `js-yaml` wraps at 80 columns otherwise, and a wrapped
 *   value in a status block reads to a model as two values.
 * - `noCompatMode: true` — without it `js-yaml` quotes YAML 1.1 booleans like
 *   `yes` and `on`, which the `yaml` package (1.2) leaves plain.
 *
 * A string is returned as itself, not as YAML: upstream substitutes a string
 * value raw, and quoting one here would put quotation marks into prose.
 * @param value - the value at the requested path.
 * @returns the block, without a trailing newline.
 */
export function formatYamlBlock(value: unknown): string {
  if (typeof value === 'string') return value
  return dump(value, { lineWidth: -1, noCompatMode: true }).trimEnd()
}
