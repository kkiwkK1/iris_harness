/**
 * Real-browser fixture for the system-plugin client plane.
 *
 * It serves the production sandbox bundles, one synthetic plugin client, and
 * two srcdoc frames assembled by Iris itself. The first proves client.js runs
 * before card markup and publishes members; the second proves a card with no
 * plugin asset remains alive. This file is acceptance infrastructure only.
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSrcdoc } from '../../apps/iris-web/src/sandbox/srcdoc.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const sandboxDir = join(root, 'apps/iris-web/public/sandbox')
const manifest = JSON.parse(await readFile(join(sandboxDir, 'manifest.json'), 'utf8'))
const port = Number.parseInt(process.env['IRIS_ACCEPTANCE_PORT'] ?? '8792', 10)
const origin = `http://127.0.0.1:${String(port)}`

const pluginSource = [
  `globalThis.__iris_members__.registerPluginMembers('acceptance-demo', { acceptanceValue: 'client-loaded' });`,
  `globalThis['__iris_plugin_ready__acceptance-demo'] = true;`,
  `document.documentElement.dataset.pluginClient = 'loaded';`,
].join('\n')
const pluginRev = createHash('sha1').update(pluginSource).digest('hex').slice(0, 12)

function documentFor(withPlugin) {
  const plugins = withPlugin
    ? {
        'acceptance-demo': {
          rev: pluginRev,
          client: `/plugins/acceptance-demo/client.js?rev=${pluginRev}`,
        },
      }
    : {}
  return buildSrcdoc(withPlugin ? 'plugin-token' : 'ordinary-token', `${origin}/sandbox/${manifest.bootstrap}`, {
    networkGranted: false,
    libraries: [],
    members: `${origin}/sandbox/${manifest.members}`,
    selfOrigin: origin,
    body: withPlugin
      ? `<main id="plugin-card">plugin card alive</main><script>
          const row = globalThis['__iris_plugin_members__acceptance-demo'];
          document.documentElement.dataset.pluginMember = row?.acceptanceValue ?? 'missing';
          document.getElementById('plugin-card').textContent =
            'client.js: ' + document.documentElement.dataset.pluginClient +
            '; member: ' + document.documentElement.dataset.pluginMember;
        </script>`
      : '<main id="ordinary-card">ordinary card alive without plugin assets</main>',
    systemPlugins: {
      revision: withPlugin ? 41 : 42,
      tavernHelper: false,
      mvu: false,
      plugins,
    },
  })
}

function escapedAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

const page = `<!doctype html><html><body>
  <h1>Plugin platform browser acceptance</h1>
  <iframe id="plugin-frame" title="plugin frame" sandbox="allow-scripts" srcdoc="${escapedAttribute(documentFor(true))}"></iframe>
  <iframe id="ordinary-frame" title="ordinary frame" sandbox="allow-scripts" srcdoc="${escapedAttribute(documentFor(false))}"></iframe>
</body></html>`

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
])

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', origin)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Timing-Allow-Origin', '*')
  if (url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(page)
    return
  }
  if (url.pathname === '/plugins/acceptance-demo/client.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': url.searchParams.get('rev') === pluginRev
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    response.end(pluginSource)
    return
  }
  if (url.pathname.startsWith('/sandbox/')) {
    const name = url.pathname.slice('/sandbox/'.length)
    if (!Object.values(manifest).includes(name) && name !== 'fontawesome.min.css') {
      response.writeHead(404)
      response.end()
      return
    }
    try {
      const bytes = await readFile(join(sandboxDir, name))
      response.writeHead(200, { 'Content-Type': types.get(extname(name)) ?? 'application/octet-stream' })
      response.end(bytes)
    } catch {
      response.writeHead(404)
      response.end()
    }
    return
  }
  response.writeHead(404)
  response.end()
})

await new Promise((resolveListen, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolveListen)
})
console.log(`plugin browser fixture: ${origin}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
