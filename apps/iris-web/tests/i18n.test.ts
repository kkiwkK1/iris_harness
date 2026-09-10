import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DICTIONARIES, en, translate, interpolate, type StringKey } from '../src/app/i18n/strings.ts'
import { detectLanguage, getLanguage, setLanguage, subscribeLanguage } from '../src/app/i18n/language.ts'
import { chatMeta, since, describeBytes } from '../src/app/format.ts'
import { describeError } from '../src/client/errors.ts'
import { describeRun, summariseRuns, type ScriptRunState } from '../src/sandbox/script-run-state.ts'
import { consentFigures, describeConsentAsk } from '../src/sandbox/consent.ts'
import { describeInterface } from '../src/sandbox/message-frames.ts'

/** A run state with only the fields a given phase needs. */
function run(phase: ScriptRunState['phase'], extra: Partial<ScriptRunState> = {}): ScriptRunState {
  return { scriptId: 's', name: 's', phase, ...extra }
}

test('the zh dictionary covers exactly the en key set, and nothing else', () => {
  const enKeys = Object.keys(en).sort()
  const zhKeys = Object.keys(DICTIONARIES.zh).sort()
  assert.deepEqual(zhKeys, enKeys)
})

test('every zh string is actually Chinese, and every en string is not', () => {
  // One mis-filed column would show a reader a language they cannot read. The
  // check is blunt, so the few deliberately language-neutral rows — the shared
  // parameter names and the language option shown in its own language — are
  // allowlisted by key.
  const cjk = /[\u3400-\u9fff]/
  // `tokensThousand` / `tokensMillion` / `thousandsSeparator` / `usageCount`
  // are number *formats*, not sentences: `12.2K`, `1,234`, `300 tok` read the
  // same in both columns. They sit in the dictionary because a third language
  // changes the separator before it changes anything else.
  // `contextCardFigures` (`2,048 / 7,168 · 28%`), `compactedFigures`
  // (`4.1K → 780`) and `commandRow` (`/compact —— …`) are the same kind of row:
  // a layout for figures and names the surrounding copy supplies, with no words
  // of their own in either column.
  const neutral = new Set([
    'topP', 'topK', 'minP', 'langEn',
    'tokensThousand', 'tokensMillion', 'thousandsSeparator', 'usageCount',
    'contextCardFigures', 'compactedFigures', 'commandRow',
  ])
  for (const [key, value] of Object.entries(DICTIONARIES.zh)) {
    if (neutral.has(key)) continue
    assert.match(value, cjk, `zh["${key}"] has no Chinese: ${value}`)
  }
})

test('both columns use the same placeholder names', () => {
  // Compared as sets, not multisets: a language's grammar may repeat a slot
  // ("2 of 2") where the other says it once ("2 个全部"), but a slot that
  // exists in one column and not the other is a broken sentence waiting.
  const slots = (value: string): readonly string[] =>
    [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!))].sort()
  for (const [key, enValue] of Object.entries(en)) {
    assert.deepEqual(slots(DICTIONARIES.zh[key as StringKey]), slots(enValue), `placeholder drift on "${key}"`)
  }
})

test('interpolate fills named slots and leaves unknown ones alone', () => {
  assert.equal(interpolate('{a} + {b}', { a: 1, b: 'x' }), '1 + x')
  assert.equal(interpolate('{gone}', {}), '{gone}')
})

test('a browser language starting with zh reads Chinese, everything else English', () => {
  assert.equal(detectLanguage('zh'), 'zh')
  assert.equal(detectLanguage('zh-CN'), 'zh')
  assert.equal(detectLanguage('zh-Hant-TW'), 'zh')
  assert.equal(detectLanguage('en'), 'en')
  assert.equal(detectLanguage('en-US'), 'en')
  assert.equal(detectLanguage('fr'), 'en')
  assert.equal(detectLanguage(undefined), 'en')
})

test('the module starts English under node and a manual switch moves every reader', () => {
  // No `window` here, so nothing was ever persisted: the default is English
  // regardless of the host machine's locale.
  assert.equal(getLanguage(), 'en')

  let notified = 0
  const dispose = subscribeLanguage(() => {
    notified += 1
  })

  setLanguage('zh')
  assert.equal(getLanguage(), 'zh')
  assert.equal(notified, 1)
  assert.equal(translate(getLanguage(), 'send'), '发送')

  setLanguage('en')
  assert.equal(notified, 2)
  dispose()
})

test('core shell copy renders in Chinese after the switch', () => {
  setLanguage('zh')
  try {
    assert.equal(translate('zh', 'settings'), '设置')
    assert.equal(translate('zh', 'importCard'), '导入卡片')
    assert.equal(translate('zh', 'writeYourPart'), '写下你的部分…')
    assert.equal(translate('zh', 'composerHint'), 'Enter 发送 · Shift+Enter 换行 · Alt+←/→ 切换读法')
    assert.equal(translate('zh', 'sectionCardScripts'), '卡片脚本')
    assert.equal(translate('zh', 'deleteConversation'), '删除对话')
    assert.equal(translate('zh', 'messageCount', { count: 12 }), '12 条消息')
    assert.equal(translate('zh', 'turns', { n: 3 }), '3 回合')
  } finally {
    setLanguage('en')
  }
})

test('the sentence builders follow the language parameter', () => {
  const NOON = Date.UTC(2026, 7, 31, 12, 0, 0)

  assert.equal(since(NOON - 4 * 60 * 1000, NOON, 'zh'), '4 分钟前')
  assert.equal(since(NOON - 20 * 1000, NOON, 'zh'), '刚刚')
  // English stays the default, which is what the older suites assert against.
  assert.equal(since(NOON - 4 * 60 * 1000, NOON), '4m ago')

  /*
   * The sidebar row's whole stamp, in both columns.
   *
   * Asserted here rather than beside `since` because it is the *joined* string
   * that a 272px row has to fit, and the join is where the two columns can
   * disagree without either half being wrong - a separator with spaces in one
   * dictionary and without in the other reads as two different products.
   */
  assert.equal(chatMeta(NOON - 2 * 86_400_000, 3, NOON, 'zh'), '2 天前 · 3 条')
  assert.equal(chatMeta(NOON - 2 * 86_400_000, 3, NOON), '2d ago · 3 msg')
  // The long spelling still exists, for the character page's wider column.
  assert.equal(translate('zh', 'messageCount', { count: 3 }), '3 条消息')

  assert.equal(describeBytes(0, 'zh'), '空')
  assert.equal(describeBytes(-1, 'zh'), '大小未知')
  assert.equal(describeBytes(4_820, 'zh'), '5 kB', 'units are shared, only the words translate')

  assert.equal(describeError({ code: 'busy', message: '' }, 'zh'), '这个对话还在生成中。请先停止。')
  assert.equal(describeError({ code: 'provider-error', message: 'upstream refused' }, 'zh'), 'upstream refused')

  assert.equal(describeRun(run('running'), 'zh'), '运行中')
  assert.equal(describeRun(run('ran', { lateMs: 15_000 }), 'zh'), '已加载，但晚了 15 秒——到货前曾被误报为失败')
  assert.equal(describeRun(run('waiting', { waitingFor: 'Mvu' }), 'zh'), '等待 Mvu')
  assert.equal(describeRun(run('waiting', { waitingFor: 'Mvu', waitingMs: 5_000 }), 'zh'), '仍在等待 Mvu（5 秒）')
  assert.equal(describeRun(run('refused', { member: 'toastr' }), 'zh'), '已拒绝 toastr')
  assert.equal(describeRun(run('silent'), 'zh'), '已启动但从未回报——可能仍在运行')
  assert.equal(describeRun(run('killed'), 'zh'), '随对话关闭而停止')

  assert.equal(summariseRuns([], 'zh'), '没有脚本在运行。')
  assert.equal(summariseRuns([run('ran'), run('ran'), run('threw')], 'zh'), '3 个中 1 个运行失败。对话不受影响。')
  assert.equal(summariseRuns([run('ran'), run('ran')], 'zh'), '2 个全部加载并开始监听。')

  const iface = { floor: 1, instance: 0, bytes: 369_000 }
  assert.match(describeInterface({ ...iface, phase: 'over-budget' }, 'zh'), /帧预算已用完/)
  assert.match(describeInterface({ ...iface, phase: 'over-budget' }, 'zh'), /360 KB/)
})

test('the consent question states both rulers in Chinese, with the grammar of the count', () => {
  const kB = (count: number): string => describeBytes(count)

  const oneScript = consentFigures([{ bytes: 2048, enabled: true }])
  assert.equal(
    describeConsentAsk(oneScript, kB, 'zh'),
    '这张卡运行 1 个脚本（2 kB）。它在隔离子沙箱中运行，除非你另外授予页面访问权，否则无法读取你的其他对话。',
  )

  const partial = consentFigures([
    { bytes: 1024, enabled: true },
    { bytes: 4096, enabled: false },
    { bytes: 512, enabled: false },
  ])
  const zh = describeConsentAsk(partial, kB, 'zh')
  assert.match(zh ?? '', /3 个脚本中有 1 个会立即运行（1 kB）。/)
  assert.match(zh ?? '', /包括当前关闭的 5 kB。/)
  // Agrees with the one script that would run, like the English sentence does.
  assert.match(zh ?? '', /它在隔离子沙箱中运行/)
})

test('every t("key") in the sources names a real string', async () => {
  // The keys drift at typecheck time for typed callers; this catches the
  // dynamic or stringly callers and any file the compiler does not see.
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url))
  const files = await listFiles(srcRoot)
  const used = new Set<string>()
  const use = /(?<![A-Za-z0-9_$.])t\('([A-Za-z0-9]+)'/g

  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(use)) used.add(match[1]!)
  }

  assert.ok(used.size > 100, `expected the shell's copy to be keyed, found ${String(used.size)}`)
  const unknown = [...used].filter(key => !(key in en))
  assert.deepEqual(unknown, [], 'keys used in sources but missing from the dictionary')
})

test('the components that show words subscribe to the language', async () => {
  // A component that renders copy but never subscribes would go on speaking
  // the old language until something else re-rendered it. This holds each
  // shell component that was converted to the hook.
  const app = fileURLToPath(new URL('../src/app', import.meta.url))
  const mustSubscribe = [
    'App.tsx', 'Sidebar.tsx', 'Masthead.tsx', 'ChatPane.tsx', 'Composer.tsx',
    'Message.tsx', 'VariantRail.tsx', 'Reasoning.tsx', 'ScriptButtons.tsx',
    'StatePanel.tsx', 'SettingsDrawer.tsx', 'ConnectionPanel.tsx', 'ScriptPanel.tsx',
    'HostReports.tsx', 'NoticeLog.tsx', 'PromptPanel.tsx', 'CleanupOffer.tsx',
    'ConsentAsk.tsx', 'MessageInterfaces.tsx', 'useCardScripts.tsx',
    'PresetPanel.tsx', 'RegexPanel.tsx', 'CardPopup.tsx', 'ContextMeter.tsx', 'CompactionNote.tsx',
  ]
  for (const name of mustSubscribe) {
    const text = await readFile(`${app}/${name}`, 'utf8')
    assert.match(text, /useLanguage\(/, `${name} renders words but does not subscribe`)
  }
})

test('the shell copy left English behind is gone from the components', async () => {
  // Spot checks, not an exhaustive sweep: if one of these phrases is back in a
  // component, a reader sees a mixed interface and this test says why.
  const app = fileURLToPath(new URL('../src/app', import.meta.url))
  const gone = [
    'Import a card',
    'Settings have not loaded',
    'Write your part',
    'Enter sends',
    'Save the current settings as a connection',
    'This card ships no scripts',
    'Nothing has been announced this session',
    'The host has reported nothing',
    'How the next request assembles',
  ]
  const files = (await readdir(app, { recursive: true })).filter(name => name.endsWith('.tsx'))
  for (const name of files) {
    const text = await readFile(`${app}/${name}`, 'utf8')
    for (const phrase of gone) {
      assert.ok(!text.includes(phrase), `${name} still carries English shell copy: ${phrase}`)
    }
  }
})

async function listFiles(root: string): Promise<readonly string[]> {
  const out: string[] = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const name = entry.name
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    if (entry.parentPath.includes('node_modules')) continue
    out.push(`${entry.parentPath}/${name}`)
  }
  return out
}
