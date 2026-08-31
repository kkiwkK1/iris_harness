/**
 * Phase-0 spike, steps 2, 3 and the sampling check.
 *
 * Boots a composition of DSH packages through `dsh-app-boot` — outside the
 * `dsh` CLI, outside the harness repository — then assembles a system prompt
 * and streams one completion through an Iris-authored adapter.
 *
 * What each assertion buys:
 *   - `boot()` works for a product that is not the coding agent;
 *   - `ctx.systemPrompt` assembles and interpolates Iris-registered variables;
 *   - `ctx.llm.registerAdapter` + `ctx.llm.stream` carry a full streaming turn;
 *   - a sampling field Iris declared onto `GenerateOptions` survives the trip
 *     to the adapter and reaches the wire.
 */

import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BlockAssembler, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { renderPrompt, type SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { startMockProvider } from './src/mock-provider.ts'
import type { IrisSampling } from './src/openai/index.ts'

/** Assert a condition, or mark the run failed. */
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  console.error(`  FAIL ${label}`, detail ?? '')
  process.exitCode = 1
}

const SAMPLING: IrisSampling = { topP: 0.92, topK: 40, minP: 0.05, repetitionPenalty: 1.1, seed: 7 }

const mock = await startMockProvider()
process.env.IRIS_SPIKE_BASE_URL = mock.baseURL

console.log(`spike-host: booting against ${mock.baseURL}\n`)

const ctx = await boot('iris-spike', fileURLToPath(new URL('./cordis.yml', import.meta.url)))
check('dsh-app-boot booted a non-coding-agent composition', true)

try {
  const systemPrompt = ctx.get('systemPrompt') as SystemPrompt | undefined
  if (systemPrompt === undefined) throw new Error('systemPrompt service was not provided')

  // Iris supplies the macro values the persona template references. Rendering
  // is strict: an unregistered reference throws rather than rendering blank.
  const disposeChar = systemPrompt.variable('char', () => 'Aria')
  const disposeUser = systemPrompt.variable('user', () => 'Traveller')

  // A character-card section, ordered after the persona.
  const disposeCard = systemPrompt.section({
    name: 'iris:character-description',
    order: 10,
    text: 'Aria is a retired cartographer who answers in short, wry sentences.',
  })

  const assembly = await systemPrompt.assemble()
  const system = renderPrompt(assembly)
  check('system prompt assembled from ordered sections', assembly.sections.length === 2, assembly.sections.map(s => s.name))
  check('{{char}} / {{user}} interpolated strictly', system.includes('Aria') && system.includes('Traveller'), system)
  check('sections concatenated in ascending order', system.indexOf('You are Aria') < system.indexOf('retired cartographer'), system)

  console.log('\n--- assembled system prompt ---')
  console.log(system)
  console.log('-------------------------------\n')

  // One streaming turn through the adapter.
  const assembler = new BlockAssembler()
  const seen: StreamChunk['type'][] = []
  let streamed = ''
  process.stdout.write('  streaming: ')
  for await (const chunk of ctx.llm.stream({
    provider: 'mock',
    model: 'mock-model',
    system,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello?' }], source: { kind: 'user' } })],
    temperature: 0.8,
    sampling: SAMPLING,
  })) {
    assembler.push(chunk)
    seen.push(chunk.type)
    if (chunk.type === 'text-delta') {
      streamed += chunk.text
      process.stdout.write(chunk.text)
    }
  }
  process.stdout.write('\n\n')

  check('stream delivered incremental text deltas', seen.filter(type => type === 'text-delta').length === 3, seen)
  check('reasoning arrived as its own block', seen.includes('reasoning-delta'), seen)
  check('stream terminated with a finish chunk', assembler.finish.kind === 'stop', assembler.finish)
  check('usage was reported with disjoint counts', assembler.usage?.inputTokens === 40 && assembler.usage.cacheReadTokens === 2, assembler.usage)

  const message = assembler.message({ kind: 'model', provider: 'mock', model: 'mock-model' })
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  check('assembled assistant message matches the streamed text', text === streamed && text.endsWith('traveller.'), text)
  check('reasoning is kept as a separate block, not merged into the reply', message.content.some(block => block.type === 'reasoning'), message.content.map(b => b.type))

  // The decisive check for the plan's yellow-flag item.
  const body = mock.capture.body ?? {}
  check(
    'Iris sampling fields declared onto GenerateOptions reached the wire',
    body.top_p === 0.92 && body.top_k === 40 && body.min_p === 0.05 && body.repetition_penalty === 1.1 && body.seed === 7,
    body,
  )
  check('the harness call config also reached the wire', body.temperature === 0.8, body)

  disposeCard()
  disposeUser()
  disposeChar()

  // Reversibility: the registry must forget every Iris registration. The
  // `deployment:persona` section stays because the dsh-system-prompt row owns
  // it through its own config — it is not ours to dispose.
  const afterDispose = await systemPrompt.assemble()
  const remaining = afterDispose.sections.map(section => section.name)
  check('disposing removed the Iris section (Cordis reversibility)', !remaining.includes('iris:character-description'), remaining)
  check('the plugin-owned persona section is untouched', remaining.length === 1 && remaining[0] === 'deployment:persona', remaining)

  // The variables went with it: strict rendering now refuses the persona
  // template rather than silently emitting a blank name.
  let refused = false
  try {
    renderPrompt(afterDispose)
  } catch {
    refused = true
  }
  check('disposed variables make strict rendering fail loudly, not silently blank', refused)
} finally {
  await ctx.fiber.dispose()
  await mock.close()
}

console.log(process.exitCode === 1 ? '\nSPIKE FAILED' : '\nspike passed')
