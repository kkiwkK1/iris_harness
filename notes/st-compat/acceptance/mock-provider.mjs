/**
 * The pilot acceptance's own provider: OpenAI-compatible SSE, scripted replies
 * so UC-2's model output carries the template the extension processes.
 * Mirrors apps/iris/tests/mock-provider.ts (the shape the host already drives).
 */
import { createServer } from 'node:http'

export async function startPilotProvider() {
  const REPLY_1 = [
    "<% setvar('好感度', getvar('好感度', { defaults: 0 }) + 10) -%>",
    '你的善意我已收到。我对你的好感度提升了。',
    "新的好感度：<%- getvar('好感度') %>",
  ].join('\n')
  const REPLY_2 = [
    "<% setvar('好感度', getvar('好感度', { defaults: 0 }) + 10) -%>",
    '我们又聊了一会儿。',
    "新的好感度：<%- getvar('好感度') %>",
  ].join('\n')
  let calls = 0
  const capture = { body: '' }
  // The acceptance driver's own record: every request body appended to a JSONL
  // file, so "what the host actually sent" is read from the provider's side of
  // the wire (PILOT_CAPTURE names the file; absent means no capture).
  const captureFile = process.env.PILOT_CAPTURE
  const note = async body => {
    if (captureFile === undefined) return
    try {
      const { appendFile, mkdir } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(captureFile), { recursive: true })
      await appendFile(captureFile, `${JSON.stringify({ ts: new Date().toISOString(), call: calls, body })}\n`, 'utf8')
    } catch { /* capture is diagnostics; a failure must not break the reply */ }
  }
  // A marker in the user's message picks the reply, so scenario scripts steer
  // the model side without a second provider. Markers are upper-case words no
  // fixture reply contains.
  const MUTEX_REPLY = [
    "<% setvar('好感度', getvar('好感度', { defaults: 0 }) + 10) -%>",
    "_.set('好感度', 99);",
    '双实现探针：这一条回复同时携带 ST 模板 setvar 与 MVU 的 _.set。',
  ].join('\n')

  const server = createServer((req, res) => {
    // ST's custom-endpoint connect fetches the model list before the first
    // completion; answer it or the connection never goes online.
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'pilot-model', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      capture.body = body
      calls += 1
      await note(body)
      const text = body.includes('UC2-MUTEX') ? MUTEX_REPLY : calls <= 1 ? REPLY_1 : REPLY_2
      const request = JSON.parse(body)
      if (request.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'pilot',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // The host streams; one content frame plus usage plus DONE is enough.
      const id = 'pilot'
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { content: text } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    capture,
    calls: () => calls,
    close: () => new Promise(resolve => { server.close(resolve) }),
  }
}
