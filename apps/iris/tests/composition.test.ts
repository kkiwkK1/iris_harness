import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { Config } from '@iris/app-service'

/**
 * What the product composition actually hands the app service.
 *
 * `packages/iris-app-service/tests/config-wiring.test.ts` pins the **schema**
 * defaults. That is necessary and it is not sufficient: a row in `cordis.yml`
 * sits between the schema and the running host, and a row can override a
 * default without any schema test noticing. It did — commit b8bd8cd moved
 * `pruneVariables` to `false` in the schema while this file still carried
 * `pruneVariables: !!js process.env.IRIS_PRUNE_VARIABLES !== "false"`, so every
 * `pnpm start` ran the sweep and the schema default was a fact about a code
 * path the product never took.
 *
 * So this test reads **the file in the repository**, not a copy of its rows:
 * the same YAML dialect the boot uses (`!!js` scalars as expression nodes, from
 * the js-yaml the boot package itself resolves), the loader's own `interpolate`
 * to evaluate them, and the app service's own `Config` to apply the schema. A
 * literal transcribed into the test would drift from the file the way the file
 * drifted from the schema.
 *
 * `end-to-end.test.ts` boots this same file, but a booted tree does not expose
 * the parsed config of one row, and a behavioural probe for "did the sweep
 * run" would need a long chat. Reading the composition is the direct measure.
 */

/** The slice of js-yaml this test uses; typed here because this app does not depend on js-yaml itself. */
interface YamlModule {
  Type: new (tag: string, options: { kind: 'scalar', construct: (data: string) => unknown }) => object
  JSON_SCHEMA: { extend: (types: object) => object }
  load: (content: string, options: { schema: object }) => unknown
}

/** One row of the composition, as far as this test reads it. */
interface Row {
  id?: unknown
  name?: unknown
  config?: unknown
}

/**
 * Parse `cordis.yml` the way `@deepseek-ai/dsh-app-boot` does.
 *
 * The parser is resolved **from the boot package**, not from this app: js-yaml
 * is not a dependency here, and importing it from where the boot imports it is
 * the only way to be sure it is the same parser. The `!!js` tag is the one the
 * boot's include defines (`tag:yaml.org,2002:js`, a scalar that constructs an
 * expression node); the boot does not export its schema, so the tag is
 * restated here and the loader's `isJsExpr` shape — `{ __jsExpr }` — is what
 * `interpolate` then recognises.
 * @returns the top-level rows, expressions still unevaluated.
 */
async function parseComposition(): Promise<Row[]> {
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-app-boot'))
  const yaml = require('js-yaml') as YamlModule
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({ __jsExpr: data }),
  })
  const content = await readFile(fileURLToPath(new URL('../cordis.yml', import.meta.url)), 'utf8')
  const rows = yaml.load(content, { schema: yaml.JSON_SCHEMA.extend(JsExpr) })
  assert.ok(Array.isArray(rows), 'cordis.yml must be a top-level array of rows')
  return rows as Row[]
}

test('the app row composes pruneVariables to false, from the file the host boots', async () => {
  const rows = await parseComposition()
  const app = rows.find(row => row.name === '@iris/app-service')
  assert.ok(app !== undefined, 'the composition must have an @iris/app-service row; the test found nothing to check')
  assert.ok(typeof app.config === 'object' && app.config !== null, 'the app row must carry a config block')

  // Evaluated the way the loader evaluates them at entry activation. `{}` is a
  // stand-in for the Cordis context; the expressions in this file reach
  // `process` through the global scope, as they do at boot.
  const config = interpolate({}, app.config) as Record<string, unknown>
  // Proof the interpolation ran: an unevaluated row would still be an
  // expression node here, and `Config` below might coerce it into something
  // that reads as a passing value.
  assert.equal(typeof config['dataDir'], 'string', 'dataDir must have interpolated to a string')

  // The first invariant is structural: nothing in the composition decides this
  // key. A row that computes it from an environment variable turns the schema
  // default into dead code, whatever value it computes today.
  assert.equal(
    'pruneVariables' in config,
    false,
    'cordis.yml must not carry a pruneVariables row: the schema default is the decision, and a row here '
    + 'silently overrides it for everyone who never heard of the variable it reads',
  )

  // The second is the composed value, through the schema the plugin applies.
  const parsed = Config(config as never) as unknown as Record<string, unknown>
  assert.equal(
    parsed['pruneVariables'],
    false,
    'pruneVariables must compose to false: the sweep deletes variable tables off older floors and nothing '
    + 'restores them (upstream can replay from a snapshot, this host cannot), so an irreversible deletion '
    + 'is an opt-out a user writes into cordis.yml — never a default, and never something an env var turns on quietly',
  )
})
