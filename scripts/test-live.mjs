/**
 * Run the opt-in live-provider tests.
 *
 * A runner rather than an inline env-var prefix, because PowerShell has no
 * `VAR=value cmd` form and a package script has to work in both shells.
 */

import { spawnSync } from 'node:child_process'

const result = spawnSync(
  process.execPath,
  ['--test', 'apps/iris/tests/live-provider.test.ts'],
  { stdio: 'inherit', env: { ...process.env, IRIS_LIVE: '1' } },
)

process.exit(result.status ?? 1)
