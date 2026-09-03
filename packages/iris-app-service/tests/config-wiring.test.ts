import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config } from '../src/index.ts'

/**
 * Every configurable option is read by something.
 *
 * **Written because one was not.** `pruneVariables`, `pruneSnapshotInterval` and
 * `pruneKeepRecent` were declared on this schema by the commit that added the
 * cleanup feature, and the pass-through into `IrisAppService` was never written.
 * The service supported cleanup and the schema advertised it, so the feature was
 * configurable, documented, fully tested — and unreachable. It could not run at
 * any setting.
 *
 * Nothing caught it, and nothing was going to: the unit tests construct the
 * service directly and hand it the option the plugin never handed over, so they
 * exercise the feature perfectly while saying nothing about whether anyone calls
 * it. Declaring an option and consuming it are two edits in two places, and a
 * correct schema is exactly what makes the missing second edit invisible.
 *
 * This is a structural check rather than a behavioural one, which is the point:
 * the failure has no behaviour to observe.
 */
test('every config key is read off the parsed config by something', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
  const keys = Object.keys((Config as unknown as { dict: Record<string, unknown> }).dict)
  assert.ok(keys.length > 10, `only ${String(keys.length)} config keys found; the schema is not being read`)

  // **`config.<key>`, not the bare name.** The first version of this check looked
  // for the name anywhere outside the schema block, and it had no teeth: every key
  // is also declared on the options interface above the schema, so it matched there
  // and passed with the wiring deleted. Verified by deleting it — the check still
  // went green. What distinguishes a read from a declaration is the `config.`
  // prefix, because only the parsed object carries a value.
  const unread = keys.filter(key => !source.includes(`config.${key}`))
  assert.deepEqual(unread, [], `declared on the config and never read: ${unread.join(', ')}`)
})