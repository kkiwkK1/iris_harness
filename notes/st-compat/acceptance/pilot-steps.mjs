/**
 * The acceptance driver's RPC helper: call one Iris RPC and print the result.
 * Run: node notes/st-compat/acceptance/rpc.mjs <method> '<json params>'
 */
const PORT = process.env.PILOT_PORT ?? '8799'

const method = process.argv[2]
const params = process.argv[3] === undefined ? {} : JSON.parse(process.argv[3])

const response = await fetch(`http://127.0.0.1:${PORT}/iris/rpc`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: `pilot-${Date.now()}`, method, params }),
})
const frame = await response.json()
console.log(JSON.stringify(frame, null, 2))
if (!frame.ok) process.exit(1)
