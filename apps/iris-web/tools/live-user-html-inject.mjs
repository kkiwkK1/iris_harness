/**
 * Live-verification driver for dev/fix-user-html: create a polsim chat and
 * inject the console's 建国档案 floor as a **user** message, through the same
 * RPC the card console uses (`script.createChatMessages` with `is_user: true`).
 *
 * Run: node tools/live-user-html-inject.mjs [port]
 * @module iris-web/tools/live-user-html-inject
 */

const port = process.argv[2] ?? '8827'
const base = `http://127.0.0.1:${port}`

/**
 * One RPC call.
 * @param {string} method - the protocol method.
 * @param {unknown} params - the method's params.
 * @returns {Promise<unknown>} the result, throwing on an error frame.
 */
async function call(method, params) {
  const response = await fetch(`${base}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: String(Math.random()), method, params }),
  })
  const frame = await response.json()
  if (frame.ok !== true) throw new Error(`${method}: ${JSON.stringify(frame.error)}`)
  return frame.result
}

/**
 * The console floor the bug report describes: line-initial bare `<div
 * style="width: 85%…">`, a `<details class="polsim-terminal">` 建国档案
 * terminal, and a nested 👾 variable-update panel. Closed `<details>` on
 * arrival, so the live test has something to open.
 */
const consoleFloor = [
  '<div style="width: 85%; margin: 0 auto; font-family: Consolas, monospace;">',
  '<style>',
  '.polsim-terminal{background:#101418;color:#c8e3c8;border:1px solid #2f4030;border-radius:6px;padding:12px 14px;font-size:14px;line-height:1.5}',
  '.polsim-terminal summary{cursor:pointer;color:#8fd18f;font-weight:600}',
  '.polsim-terminal .polsim-line{margin:2px 0}',
  '.polsim-vars{margin-top:10px;border-top:1px dashed #2f4030;padding-top:8px;color:#e3d18f}',
  '</style>',
  '<details class="polsim-terminal">',
  '<summary>建国档案已提交</summary>',
  '<div class="polsim-line">> 国号：新栎</div>',
  '<div class="polsim-line">> 政体：执政团</div>',
  '<div class="polsim-line">> 初始局势写入完毕，变量层已落账。</div>',
  '<div class="polsim-vars">👾变量更新： stability=52 · treasury=310 · legitimacy=41</div>',
  '</details>',
  '</div>',
].join('\n')

const characterId = '新架空政治经济模拟器'

const created = await call('chat.create', { characterId })
const chatId = created.view.chatId
console.log('created chat:', JSON.stringify(chatId))

await call('script.createChatMessages', {
  chatId,
  messages: [{ name: 'User', is_user: true, mes: consoleFloor }],
})
await call('script.saveChat', { chatId })
console.log('injected user HTML floor, saved')

const opened = await call('chat.open', { chatId })
const floors = opened.view.messages.map(m => ({ id: m.id, role: m.role, len: m.text.length }))
console.log('floors:', JSON.stringify(floors))
console.log('chatId for browser step:', JSON.stringify(chatId))
