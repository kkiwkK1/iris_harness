// Acceptance checker: variables + itemization for the current pilot chat.
const PORT = '8799'
const chatId = process.argv[2]
async function rpc(method, params) {
  const r = await fetch(`http://127.0.0.1:${PORT}/iris/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'c', method, params }),
  })
  return r.json()
}
const vars = await rpc('script.getVariables', { chatId, scope: 'chat' })
console.log('CHAT_VARS:', JSON.stringify(vars.result))
const item = await rpc('prompt.itemize', { chatId })
if (item.ok) {
  const it = item.result.itemization
  const wi = it.entries.filter(e => e.kind === 'worldInfoAfter' || e.kind === 'worldInfoBefore')
  console.log('WI_ENTRIES:', JSON.stringify(wi.map(e => ({ kind: e.kind, tokens: e.tokens }))))
  console.log('TOTAL_TOKENS:', it.tokens)
}
