import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SHELL_CSP_DIRECTIVES } from '../../../packages/iris-app-service/src/shell-csp.ts'

/**
 * The plugin-asset plane, asserted from the one place that can see all its
 * halves at once.
 *
 * Three pairings, each of which can be quietly broken by a change on one side
 * whose own tests stay green — the reason this file reads sources rather than
 * trusting any single package's own view (the same ground
 * `sandbox-cors.test.ts` stands on, stated there at length):
 *
 * 1. **The route is mounted, and it goes through the one guard.** dsh's own
 *    `client-modules` service would serve `/plugins` from its constructor
 *    without `irisRpc.guard`, and the landing-site survey rejected exactly
 *    that shape: a hostile same-origin page reads plugin bytes as easily as
 *    the RPC endpoint, and "every route Iris owns goes through this one
 *    function" is a written rule, not a habit. So the check here is not "the
 *    plugins route is guarded" but "**every** route in the composition file
 *    is", with the plugins route as the newest member.
 *
 * 2. **The shell policy does not restrict what the plugin plane loads.** The
 *    shell's CSP deliberately carries no fetch directives, because a `srcdoc`
 *    frame inherits it and every directive would intersect with the frame's
 *    own permissive policy (`shell-csp.ts` carries the browser measurement).
 *    For the plugin plane this has a specific consequence worth pinning: a
 *    same-origin `/plugins/<id>/client.js` is not narrowed by anything here.
 *
 * 3. **The frame policy admits the host's own origin for script.** The frame's
 *    `script-src` names `selfOrigin` exactly (never a wildcard), which is what
 *    lets a same-origin plugin bundle execute inside the card frame with no
 *    CSP change — the property the asset plane exists on. Only a **remote**
 *    plugin source would need the remote allow-list, and that is a different
 *    decision this file does not grant.
 *
 * @module apps/iris/tests/plugin-assets-plane
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The composition file, where every route Iris owns is registered. */
async function serviceSource(): Promise<string> {
  return readFile(join(ROOT, 'packages', 'iris-app-service', 'src', 'index.ts'), 'utf8')
}

/** The frame's markup builder, as source: apps/iris cannot import it. */
async function srcdocSource(): Promise<string> {
  return readFile(join(ROOT, 'apps', 'iris-web', 'src', 'sandbox', 'srcdoc.ts'), 'utf8')
}

/**
 * Whether a source emits something, ignoring what its comments discuss.
 *
 * Both files explain their behaviour at length and name the tokens while doing
 * so; a search that counted the essays would stay green on a file that had
 * removed the behaviour and kept the prose. Built with `String.fromCharCode`
 * rather than written as escapes, for the reason `sandbox-cors.test.ts`
 * records: escapes in transit have been eaten before.
 */
function code(source: string): string {
  const OPEN = String.fromCharCode(47, 42)
  const CLOSE = String.fromCharCode(42, 47)
  const LINE = String.fromCharCode(47, 47)
  const NEWLINE = String.fromCharCode(10)

  let stripped = source
  for (;;) {
    const at = stripped.indexOf(OPEN)
    if (at === -1) break
    const to = stripped.indexOf(CLOSE, at + OPEN.length)
    if (to === -1) break
    stripped = stripped.slice(0, at) + stripped.slice(to + CLOSE.length)
  }
  return stripped
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith(LINE))
    .join(NEWLINE)
}

test('every route the composition registers goes through the one guard', async () => {
  const service = code(await serviceSource())

  // Each `webServer.register` site, as the text that follows it up to the next
  // one. A guard wrap always sits inside that window — the handler is part of
  // the register object — and `irisRpc.guard` appears nowhere else in this
  // file, so a window that contains it contains it as its own route's wrap.
  const sites = service.split('webServer.register').slice(1)
  assert.ok(sites.length >= 5, `expected the route registrations, found ${String(sites.length)}`)
  for (const [index, site] of sites.entries()) {
    const window = site.slice(0, site.indexOf('webServer.register') === -1 ? site.length : site.indexOf('webServer.register'))
    assert.ok(
      window.includes('irisRpc.guard'),
      `route registration #${String(index)} is not wrapped in ctx.irisRpc.guard — the rule is every route,` +
        ' not the ones that remember',
    )
  }
})

test('the plugin-asset route is one of them, mounted at the contract prefix', async () => {
  const service = code(await serviceSource())

  // A **call**, not an import: the store must be constructed and served, and
  // the path must be the contract constant rather than a local literal — the
  // frame's plugin tags and this route must spell one URL, and a second
  // spelling here is how they stop.
  assert.ok(service.includes('new PluginAssetStore('), 'the plugin-asset store is never constructed')
  assert.ok(
    service.includes('pluginAssets.serve('),
    'nothing serves through the plugin-asset store, so the frontend fallback answers /plugins instead',
  )
  assert.ok(
    service.includes('path: PLUGIN_ASSET_PREFIX'),
    'the route prefix is not the contract constant, so the frame and the host can spell two URLs',
  )
  assert.ok(
    service.includes("from '@iris/plugin-web-api'"),
    'the prefix no longer comes from the contract package — the two halves have no shared spelling left',
  )
})

test('the shell policy leaves the plugin plane unrestricted, on purpose', async () => {
  /*
   * The shell fetches `/plugins/manifest.json` and may load plugin scripts
   * itself; either would be refused the day someone "strengthens" the shell
   * policy with a `connect-src` or `script-src` — and the refusal would cite a
   * directive that exists only in the shell, with the plugin plane's own tests
   * all green. `shell-csp.test.ts` pins the same absences for the frames'
   * sake; this pins them for the plugin plane's, which is a different reader
   * of the same list and ages on a different schedule.
   */
  const directives = SHELL_CSP_DIRECTIVES.map(row => row.split(' ')[0])
  assert.ok(
    !directives.includes('script-src'),
    "the shell policy grew a script-src, so same-origin '/plugins/*.js' loads are narrowed by it",
  )
  assert.ok(
    !directives.includes('connect-src'),
    'the shell policy grew a connect-src, so the manifest fetch is narrowed by it',
  )
})

test('the frame policy admits the host origin for script, named exactly', async () => {
  const srcdoc = code(await srcdocSource())

  // The template literal as written: `${selfOrigin}` inside the script-src
  // directive, not a wildcard and not only a docblock's promise. Named
  // exactly, the srcdoc's own comment says, because admitting *executing
  // code* from one origin Iris controls end to end is a different thing from
  // admitting a host on the public internet — the exact ground a same-origin
  // plugin bundle stands on.
  assert.match(
    srcdoc,
    /script-src[^\n]*\$\{selfOrigin\}/,
    'the frame script-src no longer names the self origin, so a same-origin plugin bundle is refused' +
      ' inside the frame with no CSP change able to say so',
  )
})
