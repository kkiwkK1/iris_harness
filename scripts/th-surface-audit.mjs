/**
 * 逐成员审计酒馆助手（TavernHelper/JS-Slash-Runner）声明面：上游声明、Iris 现状、语料用量。
 *
 *   node scripts/th-surface-audit.mjs
 *   node scripts/th-surface-audit.mjs --member getPreset,Mvu   （只看部分成员的证据）
 *   node scripts/th-surface-audit.mjs --evidence               （打印每个命中成员的证据行）
 *
 * `th-member-census.mjs` 回答「哪些成员要优先补」；本脚本为审计报告
 * `notes/apps/iris-web/TH-SURFACE-AUDIT.md` 供数：171 个声明成员逐个给出
 * 上游 file:line、Iris 现状（机械提取 + 显式裁定表）、四个语料群体的逐卡用量，
 * 并把「动态拼名」（字符串形式的成员名）与「泛名」（通用词命中需人工核对）分开。
 *
 * 与 census 相同的纪律：语料缺席时跳过，恒 exit 0——这是一把卡尺，不是测试。
 * 成员清单与实现面都从**我们自己的源码**按声明文本提取（失败会打印计数为 0，
 * 不许自己看起来还活着）。
 *
 * @module scripts/th-surface-audit
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { decodeCardPng, normalizeCard } from '../packages/iris-character/src/index.ts'
import { extractScripts } from '../packages/iris-script/src/index.ts'
import { parseChatFile } from '../packages/iris-persistence/src/index.ts'
import { PLACEMENT, applyRegexScripts, orderScripts } from '../packages/iris-regex/src/index.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TH = process.env.TH_HOME ?? 'E:/sillyTavern/SillyTavern/data/default-user/extensions/JS-Slash-Runner'
const ST_INSTALL = process.env.IRIS_CORPUS ?? 'E:/sillyTavern/SillyTavern/data/default-user'
const IRIS_DATA = `${ROOT}apps/iris/data/default-user`
const SAMPLE = 'D:/workspace/小项目/iris_分支/测试用卡'

const onlyMembers = argMemberList()
const showEvidence = process.argv.includes('--evidence')

// ── 1. 成员清单：我们自己的 upstream-surface.ts（171）────────────────────────
const surfaceSource = readFileSync(`${ROOT}apps/iris-web/src/sandbox/upstream-surface.ts`, 'utf8')
const MEMBERS = [...surfaceSource
  .slice(surfaceSource.indexOf('UPSTREAM_MEMBERS'))
  .matchAll(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map(m => m[1])
if (MEMBERS.length !== 171) {
  console.log(`## 成员清单提取异常：期望 171，得到 ${MEMBERS.length} —— 以下数字不可引用`)
}

// ── 2. 上游声明位置：@types/**/*.d.ts ────────────────────────────────────────
// 先抓 function/index.d.ts 里 window.TavernHelper 的 `// 域` 分组（命名空间面），
// 再对每个成员找第一个 `declare function/const/namespace NAME` 或 `readonly NAME:`。
const indexSource = existsSync(`${TH}/@types/function/index.d.ts`)
  ? readFileSync(`${TH}/@types/function/index.d.ts`, 'utf8')
  : ''
const NS_DOMAIN = new Map()
if (indexSource) {
  let domain = '未分组'
  for (const line of indexSource.split('\n')) {
    const domainHit = line.match(/^\s*\/\/\s*(\S+)/)
    if (domainHit) domain = domainHit[1]
    const memberHit = line.match(/readonly ([A-Za-z_$][A-Za-z0-9_$]*):/)
    if (memberHit) NS_DOMAIN.set(memberHit[1], domain)
  }
}
const UP_DOMAIN_CN = {
  audio: '音频', builtin: '内置', character: '角色卡', chat_message: '聊天消息',
  displayed_message: '楼层消息', extension: '扩展管理', generate: '生成',
  global: '跨 iframe 全局', import_raw: '原始导入', inject: '提示词注入',
  lorebook: '世界书（旧 lorebook 族）', lorebook_entry: '世界书条目（旧族）',
  macrolike: '宏', preset: '预设', persona: '个人名片', raw_character: '角色原始数据',
  script: '脚本', slash: '斜杠命令', tavern_regex: '正则', util: '工具',
  variables: '变量', version: '版本', worldbook: '世界书',
}
const FILE_DOMAIN_CN = [
  // lorebook_entry 必须排在 lorebook 之前：前者路径包含后者。
  [/function\/lorebook_entry/, '世界书条目（旧族）'],
  [/function\/worldbook/, '世界书'], [/function\/lorebook/, '世界书（旧 lorebook 族）'],
  [/function\/preset/, '预设'],
  [/function\/audio/, '音频'], [/function\/builtin/, '内置'], [/function\/character/, '角色卡'],
  [/function\/chat_message/, '聊天消息'], [/function\/displayed_message/, '楼层消息'],
  [/function\/extension/, '扩展管理'], [/function\/generate/, '生成'],
  [/function\/global/, '跨 iframe 全局'], [/function\/import_raw/, '原始导入'],
  [/function\/inject/, '提示词注入'], [/function\/macro_like/, '宏'],
  [/function\/persona/, '个人名片'], [/function\/raw_character/, '角色原始数据'],
  [/function\/script/, '脚本'], [/function\/slash/, '斜杠命令'], [/function\/tavern_regex/, '正则'],
  [/function\/util/, '工具'], [/function\/variables/, '变量'], [/function\/version/, '版本'],
  [/iframe\/event/, '事件'], [/iframe\/script/, '脚本'], [/iframe\/variables/, '变量'],
  [/iframe\/util/, '工具'], [/exported\.mvu/, '库全局（MVU）'],
  [/exported\.sillytavern/, '库全局（SillyTavern）'], [/exported\.ejstemplate/, '库全局（EJS）'],
  [/exported\.tavernhelper/, '库全局（TavernHelper）'],
]

/** @type {Map<string, {file: string, line: number, domain: string, namespace: boolean, deprecated: boolean, signature: string, declare?: boolean}>} */
const upstream = new Map()
if (existsSync(`${TH}/@types`)) {
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.d.ts')) files.push(path)
    }
  }
  walk(`${TH}/@types`)
  for (const file of files) {
    const rel = file.slice(TH.length + 1).replaceAll('\\', '/')
    const source = readFileSync(file, 'utf8')
    const lines = source.split('\n')
    lines.forEach((text, at) => {
      const decl = text.match(/declare (?:function|const|namespace) ([A-Za-z_$][A-Za-z0-9_$]*)/)
      const readonly = text.match(/readonly ([A-Za-z_$][A-Za-z0-9_$]*):/)
      const name = decl?.[1] ?? readonly?.[1]
      if (!name || !MEMBERS.includes(name)) return
      // `declare` 声明（带文档注释）优先于命名空间里的 `readonly` 转发。
      const have = upstream.get(name)
      if (have && !decl) return
      if (have && decl && have.declare) return
      const nsDomain = NS_DOMAIN.get(name)
      const fileDomain = FILE_DOMAIN_CN.find(([re]) => re.test(rel))?.[1]
      const domain = nsDomain ? (UP_DOMAIN_CN[nsDomain] ?? nsDomain) : (fileDomain ?? '未分组')
      // 前 6 行里的 @deprecated 视为弃用声明
      const above = lines.slice(Math.max(0, at - 6), at).join('\n')
      const deprecated = /@deprecated/.test(above)
      const signature = text.trim().replace(/\s*\{\s*$/, '').slice(0, 110)
      upstream.set(name, {
        file: rel, line: at + 1, domain, namespace: Boolean(readonly), deprecated, signature,
        declare: Boolean(decl),
      })
    })
  }
}

// ── 3. Iris 现状：机械提取 + 显式裁定 ────────────────────────────────────────
// 3a. createFrameTavernHelper 的 api 字面量键（tavern-helper.ts）
const helperSource = readFileSync(`${ROOT}apps/iris-web/src/sandbox/tavern-helper.ts`, 'utf8')
const apiStart = helperSource.indexOf('const api: Record<string, unknown> = {')
const apiEnd = helperSource.indexOf('\n  }', apiStart)
const API_KEYS = helperSource.slice(apiStart, apiEnd).matchAll(/^\s{4}([A-Za-z_$][A-Za-z0-9_$]*)(?::|\s*\()/gm)
const BUILT_API = new Set([...API_KEYS].map(m => m[1]))
BUILT_API.add('TavernHelper') // 返回前挂上的自命名空间（tavern-helper.ts:2950 附近）

// 3b. frame 侧：core 名单 + coordination 对 + 接口帧的 Mvu
const frameSource = readFileSync(`${ROOT}apps/iris-web/src/sandbox/frame.ts`, 'utf8')
const FRAME_CORE = new Set(['SillyTavern', 'EjsTemplate', 'triggerSlash', 'getScriptId'])
const identitySource = readFileSync(`${ROOT}apps/iris-web/src/sandbox/identity.ts`, 'utf8')
const kindsBlock = identitySource.slice(
  identitySource.indexOf('MEMBER_KINDS'),
  identitySource.indexOf('export function identityMembers'),
)
const KINDS = new Map([...kindsBlock.matchAll(/^\s*'?([A-Za-z_$][A-Za-z0-9_$]*)'?\s*:\s*'(identity|shared)'/gm)]
  .map(m => [m[1], m[2]]))

/**
 * 3c. 裁定表：机械提取给不出的「部分/拒绝」判断，逐条带证据。
 * 「已实现」= 机械集里有且无裁定；「部分」= 有同名面但语义覆盖不完；「拒绝」= 明确不答。
 */
const PARTIAL = new Map([
  ['Mvu', '接口帧发布显示面（frame.ts:2692 附近：events + getMvuData/replaceMvuData 薄改名），模式机与 schema 更新机制留在脚本帧的 MVU bundle 里'],
  ['SillyTavern', '代理按量供面（frame.ts:620 起）：getContext/extensionSettings/saveSettings 对/eventSource/event_types/popup 五名/characterId（数组下标翻译）等，非 st-context.js 145 键全量；未知成员报 gap 返 undefined'],
  ['EjsTemplate', 'core 供名（frame.ts core 列表 + ejsTemplate 值）；面向 evalTemplate 等桥接能力，非 ST-Prompt-Template 全量'],
])
const REFUSED = new Map([
  // 目前 171 内没有「同名但按名拒绝」的成员；占位以保持口径完整。
])

function irisStatus(name) {
  if (REFUSED.has(name)) return '拒绝'
  if (PARTIAL.has(name)) return '部分'
  if (BUILT_API.has(name) || FRAME_CORE.has(name)) return '已实现'
  if (name === 'initializeGlobal' || name === 'waitGlobalInitialized') return '已实现'
  return '未提供'
}
function irisWhere(name) {
  if (REFUSED.has(name)) return REFUSED.get(name)
  if (PARTIAL.has(name)) return PARTIAL.get(name)
  if (name === 'initializeGlobal' || name === 'waitGlobalInitialized') {
    return 'frame.ts coordination（约 :2023-2096）：identityMembers 绑定 + 接口帧也发布'
  }
  if (FRAME_CORE.has(name)) return 'frame.ts core 名单（:2237-2289）'
  if (BUILT_API.has(name)) return `tavern-helper.ts api 字面量（:1495-${apiEnd + 1}），行号见报告`
  return '—'
}

// ── 4. 语料群体 ──────────────────────────────────────────────────────────────
const sources = [] // {population, card, origin, code}

function addCardScripts(population, file, card) {
  for (const script of extractScripts(card).scripts) {
    sources.push({ population, card: file, origin: `script:${script.name}`, code: script.content })
  }
}

function scanCharactersDir(population, dir) {
  if (!existsSync(dir)) return
  for (const file of readdirSync(dir).filter(f => /\.(png|jpg)$/i.test(f))) {
    try {
      const card = normalizeCard(decodeCardPng(readFileSync(join(dir, file))))
      addCardScripts(population, file, card)
    } catch { /* 不是卡或解码失败：跳过 */ }
  }
}

/** 渲染界面：卡的正则脚本在聊天正文上展开后的 <script> 块，按卡去重。 */
function scanRenderedInterfaces(population, chatsDir, charactersDir, layout) {
  if (!existsSync(chatsDir) || !existsSync(charactersDir)) return
  const cardCache = new Map()
  const cardFor = name => {
    if (cardCache.has(name)) return cardCache.get(name)
    let resolved
    for (const candidate of [name, name.replace(/\d+$/, '')]) {
      for (const ext of ['.png', '.PNG']) {
        const path = join(charactersDir, candidate + ext)
        if (existsSync(path)) {
          try { resolved = { file: candidate + ext, card: normalizeCard(decodeCardPng(readFileSync(path))) } } catch { }
        }
        if (resolved) break
      }
      if (resolved) break
    }
    cardCache.set(name, resolved)
    return resolved
  }
  const seen = new Set()
  const chatFiles = layout === 'st'
    ? readdirSync(chatsDir, { withFileTypes: true }).flatMap(d => d.isDirectory()
        ? readdirSync(join(chatsDir, d.name)).filter(f => f.endsWith('.jsonl')).map(f => join(chatsDir, d.name, f))
        : [])
    : readdirSync(chatsDir).filter(f => f.endsWith('.jsonl')).map(f => join(chatsDir, f))
  for (const path of chatFiles) {
    let chat
    try { chat = parseChatFile(readFileSync(path, 'utf8')) } catch { continue }
    const name = chat.characterName ?? chat.character_name ?? path.split(/[\\/]/).at(-1).split(/-\d{8}-/)[0]
    const resolved = cardFor(name)
    if (!resolved) continue
    const scripts = orderScripts((resolved.card.data?.extensions?.regex_scripts ?? [])
      .map(script => ({ script, type: 'character' })))
    if (scripts.length === 0) continue
    chat.messages.forEach((message, index) => {
      const depth = chat.messages.length - 1 - index
      const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0
      const raw = Array.isArray(message.swipes) && message.swipes.length > 0
        ? String(message.swipes[swipeId] ?? message.mes ?? '')
        : String(message.mes ?? '')
      const rendered = applyRegexScripts(raw, message.is_user ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT,
        scripts, { isMarkdown: true, depth })
      for (const match of rendered.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        const code = match[1] ?? ''
        if (code.trim().length === 0) continue
        const key = `${resolved.file}\u0000${code}`
        if (seen.has(key)) continue
        seen.add(key)
        sources.push({ population, card: resolved.file, origin: 'rendered-interface', code })
      }
    })
  }
}

// 群体 A：Iris 数据目录的 12 张卡 + 它们的聊天
scanCharactersDir('iris-卡', `${IRIS_DATA}/characters`)
scanRenderedInterfaces('iris-界面', `${IRIS_DATA}/chats`, `${IRIS_DATA}/characters`, 'iris')
// 群体 B：测试用卡目录（卡脚本 + 正则界面块）
if (existsSync(SAMPLE)) {
  for (const file of readdirSync(SAMPLE).filter(f => /\.(png|jpg)$/i.test(f))) {
    try {
      const card = normalizeCard(decodeCardPng(readFileSync(join(SAMPLE, file))))
      addCardScripts('测试用卡', file, card)
      for (const [i, script] of (card.data?.extensions?.regex_scripts ?? []).entries()) {
        const text = String(script?.replaceString ?? '')
        for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
          if ((match[1] ?? '').trim().length === 0) continue
          sources.push({ population: '测试用卡', card: file, origin: `regex[${i}]`, code: match[1] ?? '' })
        }
      }
    } catch { }
  }
}
// 群体 C：ST 安装语料（既有 census 的口径，保持账目连续）
scanCharactersDir('st-卡', `${ST_INSTALL}/characters`)
scanRenderedInterfaces('st-界面', `${ST_INSTALL}/chats`, `${ST_INSTALL}/characters`, 'st')

// ── 5. 探针：与 census 同型，附字符串命中（动态拼名）──────────────────────────
const WINDOW_CHAIN = '((?:window|parent|top|self|globalThis)\\s*(?:\\?\\s*)?\\.\\s*)*'
const NAMESPACE = '(TavernHelper\\s*(?:\\?\\s*)?\\.\\s*)?'

function reachesFor(code, name) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$.])${WINDOW_CHAIN}${NAMESPACE}${name}\\s*(\\?\\s*)?[(.]`, 'g')
  return [...code.matchAll(pattern)].length
}
function stringHits(code, name) {
  // 名字出现在字符串里：TavernHelper['getPreset']、表驱动的 dispatch、拼名。
  const pattern = new RegExp(`['"\`]${name}['"\`]`, 'g')
  return [...code.matchAll(pattern)].length
}

/** 通用名：词边界命中可能不是这个 API（census 的 GENERIC 集 + toastr）。 */
const GENERIC = new Set(['builtin', 'Mvu', 'SillyTavern', 'TavernHelper', 'EjsTemplate', 'errorCatched'])

/** @type {Map<string, {cards: Map<string, {pop: Set<string>, origins: Set<string>, calls: number, str: number, sample: string}>}>} */
const usage = new Map(MEMBERS.map(name => [name, new Map()]))
for (const source of sources) {
  for (const name of MEMBERS) {
    const calls = reachesFor(source.code, name)
    const str = stringHits(source.code, name)
    if (calls === 0 && str === 0) continue
    const perCard = usage.get(name)
    const entry = perCard.get(source.card) ?? { pop: new Set(), origins: new Set(), calls: 0, str: 0, sample: '' }
    entry.pop.add(source.population)
    entry.origins.add(source.origin.split(':')[0])
    entry.calls += calls
    entry.str += str
    if (!entry.sample && calls > 0) entry.sample = evidenceLine(source.code, name)
    perCard.set(source.card, entry)
  }
}

function evidenceLine(code, name) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$.])${WINDOW_CHAIN}${NAMESPACE}${name}\\s*(\\?\\s*)?[(.]`, 'g')
  const match = pattern.exec(code)
  if (!match) return ''
  const start = Math.max(0, match.index)
  return code.slice(start, start + 130).replaceAll(/\s+/g, ' ').trim()
}

// ── 6. 报表 ──────────────────────────────────────────────────────────────────
const stat = name => {
  const perCard = usage.get(name)
  let calls = 0, str = 0
  const pops = new Set()
  for (const entry of perCard.values()) {
    calls += entry.calls
    str += entry.str
    for (const p of entry.pop) pops.add(p)
  }
  return { cards: perCard.size, calls, str, pops: [...pops] }
}

console.log('## 上游声明位置缺失（@types 里没找到声明）:', MEMBERS.filter(n => !upstream.has(n)).join(', ') || '无')
console.log(`## 语料群体：${[...new Set(sources.map(s => s.population))].map(p => `${p} ${sources.filter(s => s.population === p).length}`).join('、')}（合计 ${sources.length} 段代码）`)
console.log(`## Iris 机械面：api 字面量 ${BUILT_API.size - 1} 键 + TavernHelper；core 名单 ${FRAME_CORE.size} 名；identity/shared 分类 ${KINDS.size} 条`)
const statusOf = n => irisStatus(n)
console.log(`## 171 成员的 Iris 现状：已实现 ${MEMBERS.filter(n => statusOf(n) === '已实现').length}、部分 ${MEMBERS.filter(n => statusOf(n) === '部分').length}、未提供 ${MEMBERS.filter(n => statusOf(n) === '未提供').length}`)
console.log('')

console.log('## 逐域统计（域 → 声明数 / 已实现+部分 / 语料用过）')
const domains = new Map()
for (const name of MEMBERS) {
  const u = upstream.get(name)
  const domain = u?.domain ?? '未定位'
  const d = domains.get(domain) ?? { declared: 0, built: 0, used: 0 }
  d.declared++
  if (['已实现', '部分'].includes(irisStatus(name))) d.built++
  if (stat(name).cards > 0) d.used++
  domains.set(domain, d)
}
for (const [domain, d] of [...domains].sort((a, b) => b[1].declared - a[1].declared)) {
  console.log(`  ${domain.padEnd(20)} 声明 ${String(d.declared).padStart(3)}  已建 ${String(d.built).padStart(3)}  用过 ${String(d.used).padStart(3)}`)
}
console.log('')

console.log('## 语料用量全表（cards>0，按卡数降序；str=字符串命中≈动态拼名线索）')
const usedMembers = MEMBERS.filter(n => stat(n).cards > 0)
  .sort((a, b) => stat(b).cards - stat(a).cards || stat(b).calls - stat(a).calls)
for (const name of usedMembers) {
  const s = stat(name)
  const u = upstream.get(name)
  console.log(`  ${name.padEnd(30)} 卡 ${String(s.cards).padStart(2)}  调 ${String(s.calls).padStart(3)}  串 ${String(s.str).padStart(3)}`
    + `  现状 ${irisStatus(name).padEnd(4)}  域 ${u?.domain ?? '?'}  群体 [${s.pops.join(',')}]${GENERIC.has(name) ? '  [泛名-需核对]' : ''}${s.str > 0 && s.calls === 0 ? '  [仅字符串命中]' : ''}`)
}
console.log(`\n## 用过但未提供/部分：${usedMembers.filter(n => irisStatus(n) !== '已实现').join(', ') || '无'}`)
console.log(`## 用过且已实现：${usedMembers.filter(n => irisStatus(n) === '已实现').length} 个`)
console.log(`## 未用过且未提供：${MEMBERS.filter(n => irisStatus(n) === '未提供' && stat(n).cards === 0).length} 个`)
console.log(`## 未用过但已建：${MEMBERS.filter(n => irisStatus(n) === '已实现' && stat(n).cards === 0).join(', ')}`)

// 字符串命中但静态命中为 0 的成员：动态拼名的候选
const dynamicCandidates = MEMBERS.filter(n => stat(n).str > 0)
console.log(`\n## 有字符串命中的成员（动态拼名候选，需逐条看）: ${dynamicCandidates.join(', ') || '无'}`)

if (showEvidence || onlyMembers.size > 0 || process.argv.includes('--locations')) {
  if (process.argv.includes('--locations')) {
    for (const name of MEMBERS) {
      const u = upstream.get(name)
      console.log(`${name.padEnd(32)} ${(u ? `${u.file}:${u.line}` : '未定位').padEnd(38)} ${irisStatus(name).padEnd(4)} ${u?.deprecated ? 'deprecated' : ''}`)
    }
  }
  const targets = onlyMembers.size > 0 ? MEMBERS.filter(n => onlyMembers.has(n)) : usedMembers
  for (const name of targets) {
    const perCard = usage.get(name)
    if (perCard.size === 0) { console.log(`\n### ${name}: 语料无命中`); continue }
    console.log(`\n### ${name}（现状 ${irisStatus(name)}；上游 ${upstream.get(name)?.file}:${upstream.get(name)?.line}）`)
    for (const [card, entry] of perCard) {
      console.log(`  ${card}  [${[...entry.pop].join(',')}]  ${[...entry.origins].join(',')}  调 ${entry.calls} 串 ${entry.str}`)
      if (entry.sample) console.log(`    > ${entry.sample}`)
    }
  }
}

function argMemberList() {
  const at = process.argv.indexOf('--member')
  if (at === -1) return new Set()
  return new Set((process.argv[at + 1] ?? '').split(',').filter(Boolean))
}
