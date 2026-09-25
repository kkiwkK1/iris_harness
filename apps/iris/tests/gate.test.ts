import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ciStepsOf, readCiSteps } from '../../../scripts/lib/ci-steps.ts'

/**
 * `pnpm gate` runs what CI runs, because it reads the steps out of ci.yml.
 *
 * That makes the reader the thing to pin. A reader that silently found fewer
 * steps would make the local gate pass having skipped checks CI still runs,
 * the failure the old `verify` script had (two of six checks, 2026-09-25).
 * So: the reader finds every check CI runs, in CI's order, and it refuses the
 * YAML shapes it cannot run instead of dropping them.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

test('the gate reads every check step of the CI job, in order', () => {
  const steps = readCiSteps(ROOT)
  const runs = steps.map(step => step.run)

  // The checks, named by command so a renamed step title does not matter.
  // Order is part of the contract: the build must come before the steps that
  // read its output.
  const expected = [
    'pnpm install --frozen-lockfile',
    'npm ci',
    'pnpm run typecheck',
    'npm run typecheck',
    'pnpm run typecheck:scripts',
    'npm run build',
    'node --test apps/iris/tests/shell-csp-live.test.ts apps/iris-web/tests/frame-bootstrap-live.test.ts',
    'pnpm run test:no-corpus',
    'npm run check:render',
  ]
  assert.deepEqual(runs, expected, 'ci.yml and the gate reader disagree about the job; update this list with the workflow, in the same commit')

  // Working directories and env are read too, because a step run in the
  // wrong directory, or without its flag, runs something else.
  const web = steps.filter(step => step.workingDirectory === 'apps/iris-web').map(step => step.run)
  assert.deepEqual(web, ['npm ci', 'npm run typecheck', 'npm run build', 'npm run check:render'])
  const browser = steps.find(step => step.run.includes('shell-csp-live'))
  assert.equal(browser?.env['IRIS_BROWSER'], '1', 'the browser step lost IRIS_BROWSER=1, so its tests would skip and pass')
})

test('the reader refuses a multi-line run and reads a planted step fully', () => {
  const planted = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - uses: actions/checkout@0000000000000000000000000000000000000000 # v1.0.0',
    '      - name: A step',
    '        run: echo one',
    '        working-directory: sub/dir',
    '        env:',
    "          FLAG: '1'",
    '          OTHER: two',
    '      - name: Second',
    '        run: "echo two"',
  ].join('\n')
  assert.deepEqual(ciStepsOf(planted), [
    { name: 'A step', run: 'echo one', workingDirectory: 'sub/dir', env: { FLAG: '1', OTHER: 'two' } },
    { name: 'Second', run: 'echo two', workingDirectory: '.', env: {} },
  ])

  const block = ['    steps:', '      - name: Many', '        run: |', '          echo a', '          echo b'].join('\n')
  assert.throws(() => ciStepsOf(block), /multi-line run/)
})

test('`pnpm gate` is the gate, and `verify` is gone', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
    packageManager?: string
  }
  assert.equal(manifest.scripts['gate'], 'node scripts/gate.mjs')
  assert.equal(manifest.scripts['verify'], undefined, 'the old two-check `verify` script is back')

  // One declared pnpm version, which pnpm/action-setup reads. The action
  // refuses to run when a `version:` in the workflow disagrees with it, so
  // the workflow must not name one.
  assert.match(manifest.packageManager ?? '', /^pnpm@\d+\.\d+\.\d+$/, 'package.json must declare packageManager pnpm@x.y.z')
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.doesNotMatch(workflow, /^\s+version:\s*\d/m, 'ci.yml names a pnpm version again; packageManager is the one source')

  // And CONTRIBUTING points at the one command.
  const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8')
  assert.match(contributing, /pnpm gate/, 'CONTRIBUTING.md no longer names `pnpm gate`')
})
