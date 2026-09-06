import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config } from '../src/index.ts'
import { DEFAULT_TIMEOUTS } from '@iris/llm-openai-compat'

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

/**
 * The two defaults a reader is most likely to assume the other way.
 *
 * `pruneVariables` defaults **off**. It reached this state the hard way: the
 * schema said `true` while the docstring three lines above it said
 * "Off by default", and the ledger (`notes/packages/iris-app-service/DEVIATIONS.md` §8) argued at length for
 * `true` on compatibility grounds. One of those had to move, and the ruling
 * was that a sweep which deletes state nothing restores is an opt-out — never
 * a silent opt-in. Pinned here so the next person to read §8's original
 * paragraph does not "restore" it.
 *
 * The timeout budgets default to the adapter's own constants rather than to
 * numbers repeated here, and this pins that they are the same object: two
 * schemas each naming 30000 are two places to change it, and the one nobody
 * changes is the one that runs.
 */
test('the defaults that a reader would guess wrong', () => {
  const parsed = Config({
    dataDir: '/tmp/iris',
    presetPath: '/tmp/iris/preset.json',
    webDistIndex: '/tmp/iris/index.html',
  } as never) as unknown as Record<string, unknown>

  assert.equal(parsed['pruneVariables'], false, 'the periodic sweep is an opt-out, not a silent opt-in')
  assert.equal(parsed['connectTimeoutMs'], DEFAULT_TIMEOUTS.connectMs)
  assert.equal(parsed['firstByteTimeoutMs'], DEFAULT_TIMEOUTS.firstByteMs)
  assert.equal(parsed['idleTimeoutMs'], DEFAULT_TIMEOUTS.idleMs)
})
