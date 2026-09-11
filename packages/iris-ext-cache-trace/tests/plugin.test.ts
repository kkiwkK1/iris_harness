import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { IrisGenerationService, IrisStorageService, type GenerationRecord } from '@iris/app-service/src/extensions.ts'

import { apply, Config, EXTENSION_ID, inject, name } from '../src/index.ts'

/**
 * The plugin row itself, against a hand-built context carrying the two faces
 * the host provides.
 *
 * The store's behaviour is `cache-trace.test.ts`'s subject; what is proved
 * here is the *composition*: the package speaks one plugin name, injects only
 * the capability face, takes its retention from the row config, registers a
 * sink under its own id, and a generation record pushed through the host's
 * hook lands as a trace file inside the namespace the host granted — the
 * whole journey a `cordis.yml` row takes, with the loader's config schema
 * standing in for the loader.
 */

/** One minimal real request, shaped as the adapter serializes it. */
function record(sentAt: number): GenerationRecord {
  return {
    apiVersion: 1,
    request: {
      provider: 'test',
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as GenerateOptions,
    target: { chatId: 'chat', kind: 'test', turn: -1 },
    sentAt,
  }
}

async function start(t: TestContext, keep?: number): Promise<{ ctx: Context, hooks: IrisGenerationService, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-ext-plugin-'))
  const ctx = new Context()
  new IrisStorageService(ctx, dir)
  const hooks = new IrisGenerationService(ctx)
  const row = keep === undefined ? {} : { keep }
  apply(ctx, Config(row) as never)
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, hooks, dir }
}

test('the plugin speaks its name, injects only the capability face, and defaults its retention', () => {
  assert.equal(name, 'iris-ext-cache-trace')
  assert.deepEqual(inject, ['irisGeneration', 'irisStorage'])
  assert.equal((Config({}) as { keep: number }).keep, 8)
  assert.equal((Config({ keep: 0 }) as { keep: number }).keep, 0)
  assert.equal(EXTENSION_ID, 'cache-trace')
})

test('a record pushed through the host hook lands as a trace file in the granted namespace', async (t) => {
  const { hooks, dir } = await start(t)
  await hooks.record(record(1))
  // Under `<profile>/extensions/<id>/`, one file per recorded request.
  const body = JSON.parse(
    await readFile(join(dir, 'extensions', EXTENSION_ID, 'chat', '0.json'), 'utf8'),
  ) as { seq: number, kind: string, chatId: string, provider: string, body: string }
  assert.equal(body.seq, 0)
  assert.equal(body.kind, 'test')
  assert.equal(body.chatId, 'chat')
  assert.equal(body.provider, 'test')
  // And the sink answers comparisons: one request is not a pair, and absence
  // is the answer rather than an error.
  assert.equal(await hooks.divergence('chat'), undefined)
  await hooks.record(record(2))
  const divergence = await hooks.divergence('chat')
  assert.ok(divergence !== undefined, 'two recorded requests must yield a comparison')
  assert.equal(divergence.chatId, 'chat')
  assert.equal(divergence.previousSeq, 0)
})

test('a retention of zero records nothing, and the file the row leaves is its own', async (t) => {
  const { hooks, dir } = await start(t, 0)
  await hooks.record(record(1))
  // The `extensions/` root exists only once something writes into it — a
  // profile the extension never touched leaves no directory behind.
  const root = await readFile(join(dir, 'extensions', EXTENSION_ID, 'chat', '0.json'), 'utf8')
    .then(() => 'written', (cause: unknown) => (cause as { code?: string }).code)
  assert.equal(root, 'ENOENT')
})
