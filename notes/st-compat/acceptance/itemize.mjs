const PORT = process.env.PILOT_PORT ?? '8799'
const chatId = process.argv[2]
const turn = process.argv[3] === undefined ? undefined : Number(process.argv[3])
const response = await fetch(`http://127.0.0.1:${PORT}/iris/rpc`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'p3', method: 'prompt.itemize', params: { chatId, ...(turn === undefined ? {} : { turn }) } }),
})
const frame = await response.json()
if (!frame.ok) { console.log(JSON.stringify(frame.error)); process.exit(1) }
const it = frame.result.itemization
for (const entry of it.entries) {
  console.log('==', entry.kind, entry.label ?? entry.id)
  if (entry.members !== undefined) {
    for (const member of entry.members) console.log('   ', JSON.stringify(member.text?.slice(0, 240)))
  } else if (entry.text !== undefined) {
    console.log('   ', JSON.stringify(entry.text?.slice(0, 240)))
  }
}
