// Z1 reproduction: the 政经博弈 founding chain over the wire, exactly the
// calls the card's console makes (frame → shell → host), in order:
//   1. Mvu.getMvuData({message_id: current})  → script.getVariables
//   2. Mvu.replaceMvuData(data, {message_id}) → script.setVariables (replace)
//   3. createChatMessages([{role:'user',…}])  → script.createChatMessages
//   4. triggerSlash('/trigger')               → script.slash
// Between 3 and 4 (and after 4) we read the state the STATE panel shows.
//
// Usage: node qa/z1-repro.mjs [--no-gen]  (IRIS_BASE selects the host)
import { call, rpc, eventWatcher } from './rpc.mjs'

const CHARACTER = '新架空政治经济模拟器'
const NO_GEN = process.argv.includes('--no-gen')

const { view } = await call('chat.create', { characterId: CHARACTER })
const chatId = view.chatId
console.log('chat:', chatId, 'floors:', view.messages.length)

const latestVars = option => call('script.getVariables', { chatId, scope: 'message', ...option })

// --- 1. the greeting floor's table (what the console backfills from) --------
const before = await latestVars({ messageId: 0 })
console.log('floor0 stat_data keys:', Object.keys(before.variables.stat_data ?? {}))

// --- 2. the console's MVU write (replace the whole floor table) -------------
const table = before.variables
table.stat_data['政局'] ??= {}
table.stat_data['政局']['时代'] = '现代'
table.stat_data['政局']['国名'] = '测试共和国'
table.stat_data['自己'] ??= {}
table.stat_data['自己']['姓名'] = '测试者'
const written = await call('script.setVariables', {
  chatId, scope: 'message', messageId: 0, op: 'replace', variables: table,
})
console.log('after console write, 国名 =', written.variables?.stat_data?.['政局']?.['国名'])

// --- 3. the founding user floor ---------------------------------------------
const { view: view2 } = await call('script.createChatMessages', {
  chatId,
  messages: [{ name: 'User', is_user: true, mes: '<PolSimInit> 初始化指令（复现）' }],
})
console.log('after append, floors:', view2.messages.length,
  'last is_user:', view2.messages.at(-1).is_user ?? false)

// --- the STATE panel reads view.variables; the wire name is the same read ----
// (`currentVariables()` = getVariables({type:'message'}))
const panelRead = await rpc('script.getVariables', { chatId, scope: 'message' })
console.log('PANEL read (latest) ok=', panelRead.ok,
  panelRead.ok === false ? `code=${panelRead.error?.code} msg=${panelRead.error?.message}` : `keys=${Object.keys(panelRead.result?.variables?.stat_data ?? {})}`)

const latest0 = await rpc('script.getVariables', { chatId, scope: 'message', messageId: 'latest' })
console.log('LATEST read ok=', latest0.ok,
  latest0.ok === false ? `code=${latest0.error?.code} msg=${latest0.error?.message}` : `国名=${latest0.result?.variables?.stat_data?.['政局']?.['国名']}`)

// the console's own read-back (getMvuData of floor 0) must still see the write
const back = await latestVars({ messageId: 0 })
console.log('floor0 readback 国名 =', back.variables?.stat_data?.['政局']?.['国名'])

// --- 4. triggerSlash('/trigger') ---------------------------------------------
if (NO_GEN) {
  console.log('skipping generation (--no-gen)')
} else {
  const events = eventWatcher({ chatId })
  await events.ready
  const slash = await rpc('script.slash', { chatId, command: '/trigger' })
  console.log('slash /trigger ok=', slash.ok, slash.ok === false ? `${slash.error?.code} ${slash.error?.message}` : '')
  const started = await events.waitUntil(e => e.type === 'stream.start', 15000)
  console.log('stream.start:', started !== undefined)
  const textDone = await events.waitUntil(e => e.type === 'stream.end', 180_000)
  console.log('stream.end:', textDone?.type, textDone?.reason ? JSON.stringify(textDone.reason) : '')
  await new Promise(r => setTimeout(r, 1500))
  const after = await rpc('chat.open', { chatId })
  const v = after.result?.view
  console.log('after gen, floors:', v?.messages?.length,
    'view.variables 国名 =', v?.variables?.stat_data?.['政局']?.['国Name'] ?? v?.variables?.stat_data?.['政局']?.['国名'])
  events.close()
}

console.log('chatId for teardown:', chatId)
