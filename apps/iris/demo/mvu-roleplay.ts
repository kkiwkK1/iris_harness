/**
 * A stateful roleplay session against a real provider.
 *
 * This is the acid test for the MVU compatibility layer: the parser has to
 * survive whatever the model actually emits, not the tidy input a unit test
 * feeds it. Models drop the `[0]` suffix, quote numbers, invent keys, wander
 * outside the `<UpdateVariable>` block and occasionally narrate a command — all
 * of which the scanner and the apply pass are supposed to absorb without
 * corrupting state.
 *
 * Run: `node apps/iris/demo/mvu-roleplay.ts`
 */

import { fileURLToPath } from 'node:url'

import { boot } from '@deepseek-ai/dsh-app-boot'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { applyCommands, extractCommands, loadInitVars, normalizeCommandPaths, type MvuData } from '@iris/mvu'
import type { Contribution } from '@iris/pipeline'
import { historyFromSession, TurnDriver } from '@iris/turn'
import { memoryBackend, sessionMessageBackend, VariableStore } from '@iris/variables'

/**
 * The key, from the environment and nowhere else. Never printed.
 *
 * There used to be a second source — a plaintext key file at the repository
 * root, read when the variable was unset. It is gone deliberately: a file the
 * tooling reads is a file the tooling can print, and `CONTRIBUTING.md` promises
 * that nothing here reads it. A promise with a reader in the tree is not a
 * promise; `apps/iris/tests/key-file.test.ts` is what makes it one.
 * The environment variable is the one source, which is also what the connection
 * panel and `IRIS_API_KEY_ENV` already describe.
 */
function apiKey(): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined
}

const key = apiKey()
if (key === undefined) {
  console.error('demo: no provider key. Set DEEPSEEK_API_KEY in the environment.')
  process.exit(1)
}

const MODEL = process.env.IRIS_LIVE_MODEL ?? 'deepseek-v4-flash'
process.env.DEEPSEEK_API_KEY = key
process.env.IRIS_BASE_URL = 'https://api.deepseek.com/v1'
process.env.IRIS_MODEL = MODEL
process.env.IRIS_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** The `[InitVar]` entry a card would ship in its world book. */
const WORLD_BOOK = {
  name: '络络的世界书',
  entries: [{
    comment: '[InitVar]初始变量',
    content: [
      '当前时间: ["2026-03-15 09:00", "每次行动后按实际经历的时间推进，格式 yyyy-MM-dd HH:mm"]',
      '络络:',
      '  好感度: [10, "[-100,100] 之间，互动让她高兴则升高，冷淡或冒犯则降低"]',
      '  当前所想: ["又是安静的一天。", "她此刻脑子里想的事，随互动更新"]',
      '  着装: [["工作围裙", "袖套", "布鞋"], "当前穿戴，换装时更新"]',
      '  在场: [true, "她是否在场"]',
    ].join('\n'),
  }],
}

/** Render the state and its update rules the way an MVU card does. */
function statusPrompt(data: MvuData): string {
  return [
    '<status_current_variable>',
    JSON.stringify(data.stat_data, null, 1),
    '</status_current_variable>',
    '',
    '每次回复的最后，必须输出一个 <UpdateVariable> 块，用命令更新上面的变量。',
    '规则：',
    '- 用 _.set(\'路径[0]\', 旧值, 新值);//原因 修改值；用 _.add(\'路径[0]\', 增量);//原因 增减数值。',
    '- 路径必须精确到 [0] 后缀，指向 [值, 描述] 里的值，不要改描述。',
    '- 每条命令必须以分号结尾，原因写在 // 之后。',
    '- 只更新真正发生变化的变量。不要新增上面没有的变量。',
    '示例：',
    `_.add('络络.好感度[0]', 3);//她被夸奖了`,
    `_.set('当前时间[0]', '2026-03-15 09:00', '2026-03-15 09:20');//交谈过去二十分钟`,
  ].join('\n')
}

/** One line summarising a leaf, unwrapping the description pair. */
function show(value: unknown): string {
  if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string') return show(value[0])
  if (Array.isArray(value)) return `[${value.map(item => show(item)).join(', ')}]`
  return String(value)
}

/** Print the tree's leaves, flattened. */
function printState(label: string, data: MvuData): void {
  console.log(`\n  ${label}`)
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node) && node.length === 2 && typeof node[1] === 'string') {
      console.log(`    ${path.padEnd(18)} ${show(node)}`)
      return
    }
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [name, child] of Object.entries(node)) walk(child, path === '' ? name : `${path}.${name}`)
      return
    }
    console.log(`    ${path.padEnd(18)} ${show(node)}`)
  }
  walk(data.stat_data, '')
}

const ctx = await boot('iris-demo', fileURLToPath(new URL('../cordis.yml', import.meta.url)))

try {
  const session = Session.create(SessionId('mvu-demo'))
  const variables = new VariableStore({
    message: sessionMessageBackend(session),
    chat: memoryBackend(),
    global: memoryBackend(),
  })

  // The world book declares the tree. Nothing outside it may be created.
  let state = loadInitVars([WORLD_BOOK], { initialized_lorebooks: {}, stat_data: {} }).data
  printState('初始状态（由世界书 [InitVar] 声明）', state)

  const contributions = (): Contribution[] => [
    {
      id: 'persona',
      placement: { kind: 'system', order: 0 },
      text: '你是络络，一个话少但心细的制图师。用两到三句话回应，保持角色，不要解释自己。',
    },
    // The status block rides at depth 0 — after the whole conversation — so the
    // model reads the CURRENT state last, right before it answers. This is the
    // placement a system-prompt registry cannot express, and the reason Iris
    // assembles messages itself.
    { id: 'mvu-status', placement: { kind: 'depth', depth: 0, role: 'system' }, text: statusPrompt(state) },
  ]

  const driver = new TurnDriver({
    stream: options => ctx.llm.stream(options),
    provider: 'default',
    model: MODEL,
    contributions,
    history: current => historyFromSession(current),
    budget: { context: 60_000, reserve: 4_000, count: text => Math.ceil(text.length / 2) },
    temperature: 0.85,
    sampling: { topP: 0.95 },
    maxTokens: 600,
  })

  const script = [
    '（我推门进来，把一枚旧铜制指北针放在她的工作台上）这个能修吗？',
    '（我笑了笑）你画的这张海岸线，比官图准得多。',
    '（我把围巾解下来递给她）外面起风了，你手都凉了。',
  ]

  for (const [index, line] of script.entries()) {
    console.log(`\n${'─'.repeat(72)}\n  第 ${index + 1} 轮 · 我：${line}`)
    process.stdout.write('  络络：')

    const candidate = await driver.send(session, line, {
      onText: delta => process.stdout.write(delta),
    })
    process.stdout.write('\n')

    const reply = candidate.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')

    // What the model actually emitted, before anything is applied.
    const commands = normalizeCommandPaths(extractCommands(reply))
    console.log(`\n  解析出 ${commands.length} 条命令：`)
    for (const command of commands) {
      console.log(`    ${command.type.padEnd(7)} ${command.args[0]?.padEnd(20) ?? ''} ${command.reason}`)
    }

    const result = applyCommands(commands, state)
    state = result.data
    variables.replaceVariables(state as unknown as Record<string, unknown>, { type: 'message' })

    if (result.failures.length > 0) {
      console.log('\n  被拒绝的命令（这正是 set 拒绝凭空建键的地方）：')
      for (const failure of result.failures) console.log(`    ${failure.command.full_match} → ${failure.reason}`)
    }
    if (Object.keys(result.display_data).length > 0) {
      console.log('\n  状态变化：')
      for (const [path, change] of Object.entries(result.display_data)) {
        console.log(`    ${path.padEnd(18)} ${change}`)
      }
    }
  }

  printState('最终状态', state)

  // Swipe consistency against a real model: regenerate the last turn from the
  // turn's own baseline, then swipe back and confirm the first generation's
  // state returns intact.
  console.log(`\n${'─'.repeat(72)}\n  重新生成最后一轮，然后切回原来的候选`)
  const beforeRegen = variables.getVariables({ type: 'message' }) as unknown as MvuData
  const lastTurn = script.length - 1

  const second = await driver.regenerate(session)
  const secondText = second.message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
  console.log(`\n  另一个候选：${secondText.split('<UpdateVariable>')[0]?.replace(/\s+/g, ' ').trim()}`)

  // The second generation folds into the state as it was BEFORE the first one.
  const regenerated = applyCommands(normalizeCommandPaths(extractCommands(secondText)), state)
  variables.replaceVariables(regenerated.data as unknown as Record<string, unknown>, { type: 'message' })
  printState('候选 2 的状态', regenerated.data)

  driver.swipe(session, lastTurn, 0)
  const restored = variables.getVariables({ type: 'message' }) as unknown as MvuData
  printState('切回候选 1 后的状态', restored)

  const same = JSON.stringify(restored.stat_data) === JSON.stringify(beforeRegen.stat_data)
  console.log(`\n  候选 1 的状态是否完整恢复：${same ? '是' : '否'}`)
  console.log(`  日志长度：${session.seq} 条事件，surface：${session.surface.nodes.length} 个节点`)
} finally {
  await ctx.fiber.dispose()
}
