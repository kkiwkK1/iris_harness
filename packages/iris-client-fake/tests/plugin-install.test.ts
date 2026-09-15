/**
 * The fake's half of the system-plugin install path.
 *
 * The fake stages nothing: it has no filesystem, no git and no staging
 * directory, and pretending otherwise would be the lie
 * `packages/iris-client-fake/src/plugins.ts` says in its own docblock that it
 * exists not to tell. What it does model is the **handshake** — a token it
 * minted, a preview it will hold a confirm to, ruling 5's refusal of a taken
 * id on a fresh install, and the update handshake's `updateOf` preview whose
 * confirm replaces a row in place and keeps its `enabled`. Those are the parts
 * a page is written against, and every one of them can be got wrong in a way
 * that only shows up against a real host.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { testClient } from './helpers.ts'

test('preview then confirm seats a row with its provenance, and the row drives the normal lifecycle', async () => {
  const client = testClient()
  const source = { kind: 'git' as const, remote: 'https://example.invalid/acme/demo.git', commit: 'c'.repeat(40) }
  const preview = await client.call('plugin.previewInstall', { source })
  assert.match(preview.treeHash, /^[0-9a-f]{64}$/u)
  assert.match(preview.previewToken, /^preview-/u)
  assert.equal(preview.source, 'git')
  assert.equal(preview.remote, source.remote)
  assert.equal(preview.commit, source.commit)
  assert.equal(preview.compatible, true)

  const snapshot = await client.call('plugin.confirmInstall', {
    previewToken: preview.previewToken,
    id: preview.id,
    commit: preview.commit ?? null,
    treeHash: preview.treeHash,
  })
  const row = snapshot.plugins.find(plugin => plugin.id === preview.id)
  assert.equal(row?.installed, true)
  assert.equal(row?.enabled, false, 'installing is not enabling, on the fake as on the host')
  assert.equal(row?.status, 'disabled')
  assert.equal(row?.source, 'git')
  assert.equal(row?.provenance?.commit, source.commit)
  assert.equal(row?.provenance?.treeHash, preview.treeHash)

  const enabled = await client.call('plugin.enable', { id: preview.id })
  assert.equal(enabled.plugins.find(plugin => plugin.id === preview.id)?.status, 'enabled')
  const gone = await client.call('plugin.uninstall', { id: preview.id })
  assert.equal(gone.plugins.find(plugin => plugin.id === preview.id)?.installed, false)
  client.dispose()
})

test('a confirm whose echo disagrees with the preview is refused, and the token is spent either way', async () => {
  const client = testClient()
  const source = { kind: 'dev' as const, path: '/tmp/demo-package' }
  const preview = await client.call('plugin.previewInstall', { source })

  await assert.rejects(
    () => client.call('plugin.confirmInstall', {
      previewToken: preview.previewToken, id: preview.id, commit: null, treeHash: 'd'.repeat(64),
    }),
    /treeHash/u,
  )
  // Spent: a refused consent is not retryable with the same token. A fake that
  // let the second attempt through would teach a page the opposite of what the
  // host does.
  await assert.rejects(
    () => client.call('plugin.confirmInstall', {
      previewToken: preview.previewToken, id: preview.id, commit: null, treeHash: preview.treeHash,
    }),
    /no staged install/u,
  )

  const again = await client.call('plugin.previewInstall', { source })
  await assert.rejects(
    () => client.call('plugin.confirmInstall', {
      previewToken: again.previewToken, id: 'some-other-id', commit: null, treeHash: again.treeHash,
    }),
    /some-other-id/u,
  )
  client.dispose()
})

test('a cancelled token cannot be confirmed', async () => {
  const client = testClient()
  const preview = await client.call('plugin.previewInstall', { source: { kind: 'dev', path: '/tmp/cancel-me' } })
  assert.deepEqual(await client.call('plugin.cancelInstall', { previewToken: preview.previewToken }), { ok: true })
  await assert.rejects(
    () => client.call('plugin.confirmInstall', {
      previewToken: preview.previewToken, id: preview.id, commit: null, treeHash: preview.treeHash,
    }),
    /no staged install/u,
  )
  client.dispose()
})

test('ruling 5 on the fake: an id already in the catalog is refused at confirm, and warned about at preview', async () => {
  const client = testClient()
  const source = { kind: 'dev' as const, path: '/tmp/twice' }
  const first = await client.call('plugin.previewInstall', { source })
  assert.deepEqual(first.warnings, [], 'the first preview has nothing to warn about')
  await client.call('plugin.confirmInstall', {
    previewToken: first.previewToken, id: first.id, commit: null, treeHash: first.treeHash,
  })

  const second = await client.call('plugin.previewInstall', { source })
  assert.ok(
    second.warnings.some(warning => warning.includes('已被占用')),
    `expected the taken-id warning, saw ${JSON.stringify(second.warnings)}`,
  )
  await assert.rejects(
    () => client.call('plugin.confirmInstall', {
      previewToken: second.previewToken, id: second.id, commit: null, treeHash: second.treeHash,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid-request')
      assert.match((error as Error).message, /已被占用/u)
      return true
    },
  )
  client.dispose()
})

test('the fake mirrors the update handshake: a git row previews with updateOf, and confirming keeps enabled', async () => {
  const client = testClient()
  const remote = 'https://example.invalid/acme/updatable.git'
  const first = await client.call('plugin.previewInstall', { source: { kind: 'git', remote, commit: 'a'.repeat(40) } })
  await client.call('plugin.confirmInstall', {
    previewToken: first.previewToken, id: first.id, commit: first.commit ?? null, treeHash: first.treeHash,
  })
  await client.call('plugin.enable', { id: first.id })

  const preview = await client.call('plugin.update', { id: first.id, commit: 'b'.repeat(40) })
  assert.equal(preview.id, first.id, 'the preview names the row, not a derived package id')
  assert.equal(preview.commit, 'b'.repeat(40))
  assert.deepEqual(preview.updateOf, {
    id: first.id,
    fromCommit: 'a'.repeat(40),
    fromTreeHash: first.treeHash,
  })

  const snapshot = await client.call('plugin.confirmInstall', {
    previewToken: preview.previewToken, id: preview.id, commit: preview.commit ?? null, treeHash: preview.treeHash,
  })
  const row = snapshot.plugins.find(plugin => plugin.id === first.id)
  assert.equal(row?.enabled, true, 'the update preserved the enabled preference')
  assert.equal(row?.status, 'enabled')
  assert.equal(row?.installed, true)
  assert.equal(row?.provenance?.commit, 'b'.repeat(40))
  assert.equal(row?.provenance?.treeHash, preview.treeHash)
  client.dispose()
})

test('the fake refuses updates the way the host does: dev rows, builtin rows, unknown ids', async () => {
  const client = testClient()
  await assert.rejects(
    () => client.call('plugin.update', { id: 'tavern-helper', commit: 'e'.repeat(40) }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'unsupported')
      assert.match((error as Error).message, /builtin/u)
      return true
    },
  )
  await assert.rejects(
    () => client.call('plugin.update', { id: 'no-such-plugin', commit: 'e'.repeat(40) }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'not-found')
      return true
    },
  )
  const devPreview = await client.call('plugin.previewInstall', { source: { kind: 'dev', path: '/tmp/dev-row' } })
  await client.call('plugin.confirmInstall', {
    previewToken: devPreview.previewToken, id: devPreview.id, commit: null, treeHash: devPreview.treeHash,
  })
  await assert.rejects(
    () => client.call('plugin.update', { id: devPreview.id, commit: 'e'.repeat(40) }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'unsupported')
      assert.match((error as Error).message, /loaded in place/u)
      return true
    },
  )
  client.dispose()
})

test('the fake still refuses an id outside its catalog on every lifecycle method', async () => {
  const client = testClient()
  for (const method of ['plugin.install', 'plugin.enable', 'plugin.disable', 'plugin.uninstall', 'plugin.reload'] as const) {
    await assert.rejects(
      () => client.call(method, { id: 'not-in-this-catalog' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'not-found')
        return true
      },
      method,
    )
  }
  client.dispose()
})
