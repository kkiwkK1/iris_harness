import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { localNamespace, IrisGenerationService, IrisStorageService, type GenerationRecord } from '../src/extensions.ts'

/** One minimal record, shaped as the hook carries it. */
function record(sentAt: number): GenerationRecord {
  return {
    apiVersion: 1,
    // The fields the record's readers touch; the hook dispatches, it does not
    // validate the request's own shape.
    request: { provider: 'p', model: 'm' } as GenerateOptions,
    target: { chatId: 'chat', kind: 'test', turn: -1 },
    sentAt,
  }
}

/**
 * The storage face extensions reach the host through.
 *
 * The ruling's forbidden list names raw filesystem paths and a second write
 * path, so the face has to prove both closed: a name cannot leave the
 * namespace whatever it carries, and every write lands through the atomic
 * writer the host's own stores use. The other half — absent reading as
 * `undefined`, not as an error — is what makes an empty namespace an ordinary
 * first state rather than a failure to be guarded against at every call site.
 */

test('a namespace writes, reads, lists and removes JSON documents atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-ext-store-'))
  try {
    const ns = localNamespace(dir)
    await ns.write('chats/Aria/0.json', { seq: 0, body: 'first' })
    assert.deepEqual(await ns.read('chats/Aria/0.json'), { seq: 0, body: 'first' })
    // Rewriting whole: the second write replaces the first's bytes entirely.
    await ns.write('chats/Aria/0.json', { seq: 0, body: 'second' })
    assert.deepEqual(await ns.read('chats/Aria/0.json'), { seq: 0, body: 'second' })
    // Directories were created on the way; only files are listed, names
    // relative to the namespace root.
    await ns.write('chats/Aria/1.json', { seq: 1 })
    assert.deepEqual(await ns.list('chats/Aria/'), ['chats/Aria/0.json', 'chats/Aria/1.json'])
    // Directories are not listed: the face enumerates documents, and a caller
    // walks the tree through the prefixes it knows (`chats/` here).
    assert.deepEqual(await ns.list(), [])
    await ns.remove('chats/Aria/0.json')
    assert.equal(await ns.read('chats/Aria/0.json'), undefined)
    // Removing what is not there is not an error: rotation runs beside writes
    // and must not have to race existence checks.
    await ns.remove('chats/Aria/0.json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a name that would leave the namespace is refused, at every segment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-ext-store-'))
  try {
    const ns = localNamespace(dir)
    // The classic, and the Windows spellings of it.
    await assert.rejects(ns.write('../outside.json', {}), /not a valid storage name/)
    await assert.rejects(ns.read('..\\outside.json'), /not a valid storage name/)
    await assert.rejects(ns.remove('chats/../../outside.json'), /not a valid storage name/)
    // An empty segment is not a name, and the namespace root is not a
    // document to write into.
    await assert.rejects(ns.write('chats//0.json', {}), /not a valid storage name/)
    // The id the directory is named after goes through the same guard, so a
    // namespace can never be derived outside the profile's extensions root.
    const storage = new IrisStorageService(new Context(), dir)
    assert.throws(() => storage.namespace('..'), /not a valid extension id/)
    assert.throws(() => storage.namespace('a/b'), /not a valid extension id/)
    // And nothing was written anywhere in the attempts above.
    assert.deepEqual(await ns.list(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an absent namespace lists empty, and a malformed document is a fault, not a silence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-ext-store-'))
  try {
    const ns = localNamespace(dir)
    // Never written: the ordinary state, an empty list and no document.
    assert.deepEqual(await ns.list('chats/'), [])
    assert.equal(await ns.read('chats/0.json'), undefined)
    // A file present but unparsable is reported, because reading a corrupt
    // document as "never written" is how a half-write becomes invisible.
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
    await assert.rejects(ns.read('broken.json'), SyntaxError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a generation record reaches the registered sink, and a sink that throws cannot fail the record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-ext-hooks-'))
  try {
    const ctx = new Context()
    const storage = new IrisStorageService(ctx, dir)
    const hooks = new IrisGenerationService(ctx)
    const received: unknown[] = []
    let boom = false
    // Registered first, so its failure must not swallow the second sink's
    // delivery: the dispatcher isolates per sink, in registration order.
    hooks.registerSink('broken', {
      apiVersion: 1,
      record: () => {
        if (boom) throw new Error('the instrument broke')
      },
    })
    hooks.registerSink('listener', {
      apiVersion: 1,
      record: payload => { received.push(payload) },
    })
    await hooks.record(record(1))
    assert.equal(received.length, 1)
    // A version the face does not speak is refused at registration, not at
    // the first record.
    assert.throws(
      () => hooks.registerSink('future', { apiVersion: 2, record: () => {} } as never),
      /this host provides 1/,
    )
    // Re-registration replaces the owner's own sink, and the disposer removes
    // exactly what it registered.
    const dispose = hooks.registerSink('listener', { apiVersion: 1, record: () => {} })
    dispose()
    await hooks.record(record(2))
    assert.equal(received.length, 1)
    // `boom` on makes the first sink throw; the dispatcher logs and carries
    // on, and the second sink still receives its record.
    boom = true
    hooks.registerSink('listener', { apiVersion: 1, record: () => { received.push('again') } })
    await hooks.record(record(3))
    assert.deepEqual(received, [received[0], 'again'])
    // The namespace a service derives sits under the profile's extensions
    // root, one directory per id.
    const ns = storage.namespace('cache-trace')
    await ns.write('probe.json', { ok: true })
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'extensions', 'cache-trace', 'probe.json'), 'utf8')), { ok: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the extensions root is derived from the profile, one directory per id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-ext-root-'))
  try {
    const storage = new IrisStorageService(new Context(), dir)
    await storage.namespace('alpha').write('a.json', 1)
    await storage.namespace('beta').write('b.json', 2)
    const entries = await readdir(join(dir, 'extensions'), { withFileTypes: true })
    assert.deepEqual(entries.map(entry => entry.name).sort(), ['alpha', 'beta'])
    // Two extensions cannot share a directory by accident: the id decides.
    const names = await storage.namespace('alpha').list()
    assert.deepEqual(names, ['a.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
