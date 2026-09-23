/**
 * `/doctor`'s checks: each row's good shape and bad shape, from a fake client.
 *
 * Every bad shape here is one the project actually met: a page left on the old
 * bundle after a host restart, no provider in use, 「创造」 grey for want of an
 * authoring model, a card whose scripts were declined, a lock another host
 * holds, faults sitting in the buffer.
 *
 * @module iris-web/tests/doctor
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import type { HostDoctorFacts, RpcResponse } from '@iris/protocol'

import {
  bundleRow,
  consentRow,
  connectionRows,
  corpusRow,
  dataDirRow,
  doctorReport,
  faultsRow,
  pluginsRow,
  policyRow,
  runDoctor,
  sandboxRow,
  storageRow,
  type DoctorClient,
  type DoctorMethod,
  type DoctorPage,
  type DoctorRow,
} from '../src/app/doctor.ts'
import { setLanguage } from '../src/app/i18n/language.ts'

setLanguage('en')

/** A host that is healthy in every respect the doctor reads. */
function healthyFacts(patch: { [K in keyof HostDoctorFacts]?: HostDoctorFacts[K] | undefined } = {}): HostDoctorFacts {
  const facts: Record<string, unknown> = {
    irisVersion: '0.1.0',
    node: 'v24.1.0',
    pid: 4242,
    webBundle: { entry: 'index-AAAA1111.js' },
    dataDir: { path: 'D:/iris/data', writable: true, lockPid: 4242 },
    cardStorage: { bytes: 2048, limit: 10 * 1_048_576 },
    ...patch,
  }
  // A patch value of `undefined` means "the host sent no such field", which
  // on the wire is an absent key — so it is deleted, not kept as a present
  // undefined the checks would never see.
  for (const key of Object.keys(facts)) if (facts[key] === undefined) delete facts[key]
  return facts as unknown as HostDoctorFacts
}

/** A key that must never reach the report, planted in every profile the fake returns. */
const PLANTED = 'sk-PLANTED-9f3e'

/** A connection listing with one profile in use and an authoring model set. */
function healthyConnections(): RpcResponse<'connection.list'> {
  return {
    profiles: [{
      id: 'p1', label: 'DeepSeek', summary: 'deepseek · https://api.deepseek.com', provider: 'conn/p1',
      model: 'deepseek-chat', hasKey: true, keyTail: PLANTED,
    }],
    activeId: 'p1',
    authoring: { id: 'p1', model: 'deepseek-reasoner' },
  }
}

type Answers = { [M in DoctorMethod]?: RpcResponse<M> | Error }

/**
 * A client answering from a table; a missing method answers the healthy shape.
 * @param answers - per-method answers, or an Error to throw.
 * @returns the client and the log of what was called.
 */
function fakeClient(answers: Answers = {}): { client: DoctorClient, calls: string[] } {
  const calls: string[] = []
  const healthy: { [M in DoctorMethod]: RpcResponse<M> } = {
    'debug.doctor': { facts: healthyFacts() },
    'debug.reports': { reports: [], dropped: 0, oldest: 0, kinds: [] },
    'connection.list': healthyConnections(),
    'connection.test': { ok: true, latencyMs: 120, keySource: 'stored' },
    'script.list': { scripts: [], documentGranted: false, networkGranted: false },
    'plugin.list': { revision: 1, plugins: [] },
  }
  const client: DoctorClient = {
    call: async (method, params) => {
      calls.push(`${method} ${JSON.stringify(params)}`)
      await Promise.resolve()
      const answer = answers[method] ?? healthy[method]
      if (answer instanceof Error) throw answer
      return answer as never
    },
  }
  return { client, calls }
}

/** A built page on the healthy host's bundle, with a sandbox that serves. */
function page(patch: Partial<DoctorPage> = {}): DoctorPage {
  return {
    entry: 'index-AAAA1111.js',
    shellPolicy: true,
    port: '8791',
    characterId: 'aria',
    fetchText: async (path) => {
      await Promise.resolve()
      if (path === '/sandbox/manifest.json') {
        return {
          status: 200,
          body: JSON.stringify({
            bootstrap: 'bootstrap-1.js', members: 'members-1.js', preset: 'preset-1.js', 'message-preset': 'message-preset-1.js',
          }),
        }
      }
      return { status: 200, body: '' }
    },
    ...patch,
  }
}

/** The one row a list holds for a check. */
function rowOf(rows: readonly DoctorRow[], check: DoctorRow['check']): DoctorRow {
  const found = rows.filter(row => row.check === check)
  assert.equal(found.length, 1, `expected one ${check} row, saw ${String(found.length)}`)
  return found[0] as DoctorRow
}

/** A row that failed or warned says what to do; a pass does not. */
function assertRemedyMatchesVerdict(row: DoctorRow): void {
  if (row.verdict === 'ok') assert.equal(row.remedy, undefined, `${row.check} passed and still prescribes`)
  else assert.ok((row.remedy ?? '').length > 10, `${row.check} is ${row.verdict} and names no remedy`)
}

test('stale bundle: the page on one build and the host serving another is a warning that says reload', () => {
  const stale = bundleRow(healthyFacts({ webBundle: { entry: 'index-BBBB2222.js' } }), page())
  assert.equal(stale.verdict, 'warn')
  assert.match(stale.read, /index-AAAA1111\.js/)
  assert.match(stale.read, /index-BBBB2222\.js/)
  assert.match(stale.remedy ?? '', /reload/i)

  const same = bundleRow(healthyFacts(), page())
  assert.equal(same.verdict, 'ok')
  assertRemedyMatchesVerdict(same)
})

test('bundle: a dev page is read and not compared; a host with no build or an unreadable index is said', () => {
  const dev = bundleRow(healthyFacts(), page({ entry: 'main.tsx' }))
  assert.equal(dev.verdict, 'ok')
  assert.match(dev.read, /main\.tsx/)

  const none = bundleRow(healthyFacts({ webBundle: undefined }), page())
  assert.equal(none.verdict, 'warn')
  const unreadable = bundleRow(healthyFacts({ webBundle: {} }), page())
  assert.equal(unreadable.verdict, 'fail')
  for (const row of [dev, none, unreadable]) assertRemedyMatchesVerdict(row)
})

test('provider: none in use fails with the remedy, one in use passes and is probed by its id', async () => {
  const missing = fakeClient({ 'connection.list': { profiles: [] } })
  const missingRows = await connectionRows(missing.client)
  assert.equal(rowOf(missingRows, 'provider').verdict, 'fail')
  assert.match(rowOf(missingRows, 'provider').remedy ?? '', /Connections/)
  assert.equal(missingRows.some(row => row.check === 'providerTest'), false, 'probed a provider that is not in use')
  assert.equal(missing.calls.some(call => call.startsWith('connection.test')), false)

  const set = fakeClient()
  const setRows = await connectionRows(set.client)
  assert.equal(rowOf(setRows, 'provider').verdict, 'ok')
  assert.match(rowOf(setRows, 'provider').read, /DeepSeek.*deepseek-chat/)
  assert.equal(rowOf(setRows, 'providerTest').verdict, 'ok')
  // The probe asks with the profile id only: no key crosses from the page.
  assert.ok(set.calls.includes('connection.test {"profileId":"p1"}'), set.calls.join('\n'))
})

test('provider test: a refusal is a failure that quotes the host and says where to fix it', async () => {
  const { client } = fakeClient({
    'connection.test': { ok: false, latencyMs: 30, keySource: 'stored', error: { code: 'unauthorized', message: 'the endpoint refused the key' } },
  })
  const row = rowOf(await connectionRows(client), 'providerTest')
  assert.equal(row.verdict, 'fail')
  assert.match(row.read, /unauthorized: the endpoint refused the key/)
  assertRemedyMatchesVerdict(row)
})

test('authoring: unset is the grey 「Grow a feature」 warning; set passes and names the model', async () => {
  const { authoring: _set, ...withoutAuthoring } = healthyConnections()
  void _set
  const unset = fakeClient({ 'connection.list': withoutAuthoring })
  const row = rowOf(await connectionRows(unset.client), 'authoring')
  assert.equal(row.verdict, 'warn')
  assert.match(row.read, /Grow a feature/)
  assert.match(row.remedy ?? '', /Writes plugins/)

  const orphan = fakeClient({ 'connection.list': { ...healthyConnections(), authoring: { id: 'gone', model: 'm' } } })
  assert.equal(rowOf(await connectionRows(orphan.client), 'authoring').verdict, 'warn')

  const set = rowOf(await connectionRows(fakeClient().client), 'authoring')
  assert.equal(set.verdict, 'ok')
  assert.match(set.read, /deepseek-reasoner on DeepSeek/)
})

test('consent: declined and unasked warn with different remedies; allowed passes and says the network grant', async () => {
  const script = { id: 's1', name: 'MVU', source: 'card', enabledByCard: true } as never
  const declined = await consentRow(fakeClient({
    'script.list': { scripts: [script], documentGranted: false, networkGranted: false, scriptsAllowed: false },
  }).client, 'aria')
  assert.equal(declined?.verdict, 'warn')
  assert.match(declined?.read ?? '', /declined/)
  assert.match(declined?.remedy ?? '', /Scripts/)

  const unasked = await consentRow(fakeClient({
    'script.list': { scripts: [script], documentGranted: false, networkGranted: false },
  }).client, 'aria')
  assert.equal(unasked?.verdict, 'warn')
  assert.notEqual(unasked?.remedy, declined?.remedy)

  const allowed = await consentRow(fakeClient({
    'script.list': { scripts: [script], documentGranted: false, networkGranted: true, scriptsAllowed: true },
  }).client, 'aria')
  assert.equal(allowed?.verdict, 'ok')
  assert.match(allowed?.read ?? '', /network granted/)

  const none = await consentRow(fakeClient().client, 'aria')
  assert.equal(none?.verdict, 'ok')
  assert.equal(await consentRow(fakeClient().client, undefined), undefined, 'a conversation with no card has no consent row')
})

test('lock: a pid other than the host’s own fails, as does a missing lock or an unwritable directory', () => {
  const mine = dataDirRow(healthyFacts())
  assert.equal(mine.verdict, 'ok')
  assertRemedyMatchesVerdict(mine)

  const other = dataDirRow(healthyFacts({ dataDir: { path: 'D:/iris/data', writable: true, lockPid: 777 } }))
  assert.equal(other.verdict, 'fail')
  assert.match(other.read, /777/)
  assert.match(other.read, /4242/)
  assert.match(other.remedy ?? '', /another host/)

  const missing = dataDirRow(healthyFacts({ dataDir: { path: 'D:/iris/data', writable: true } }))
  assert.equal(missing.verdict, 'fail')
  assert.match(missing.read, /host\.lock is missing/)

  const readOnly = dataDirRow(healthyFacts({ dataDir: { path: 'D:/iris/data', writable: false, lockPid: 4242 } }))
  assert.equal(readOnly.verdict, 'fail')
  assert.match(readOnly.remedy ?? '', /IRIS_DATA_DIR/)
})

test('faults: held faults warn with the newest message; notes alone do not count', async () => {
  const report = (grade: 'fault' | 'note', seq: number, message: string) => ({ grade, seq, at: seq, kind: 'mvu', message })
  const held = await faultsRow(fakeClient({
    'debug.reports': {
      reports: [report('fault', 1, 'older fault'), report('note', 2, 'a note'), report('fault', 3, 'the newest fault')],
      dropped: 0, oldest: 1, kinds: ['mvu'],
    },
  }).client)
  assert.equal(held.verdict, 'warn')
  assert.match(held.read, /^2 fault/)
  assert.match(held.read, /the newest fault/)
  assert.match(held.remedy ?? '', /Host reports/)

  const notesOnly = await faultsRow(fakeClient({
    'debug.reports': { reports: [report('note', 1, 'a note')], dropped: 0, oldest: 1, kinds: ['mvu'] },
  }).client)
  assert.equal(notesOnly.verdict, 'ok')
})

test('plugins: a failed plugin fails the row with its reason; none failed passes', async () => {
  const view = { description: '', version: '1', apiVersion: 1 as const, dependencies: [], installed: true, enabled: true }
  const failed = await pluginsRow(fakeClient({
    'plugin.list': {
      revision: 2,
      plugins: [
        { ...view, id: 'mvu', name: 'MVU', status: 'error', failure: { state: 'activate-failed', reason: 'apply threw: boom' } as never },
        { ...view, id: 'th', name: 'Tavern Helper', status: 'enabled' },
      ],
    },
  }).client)
  assert.equal(failed.verdict, 'fail')
  assert.match(failed.read, /MVU \(apply threw: boom\)/)
  assert.doesNotMatch(failed.read, /Tavern Helper/)

  const fine = await pluginsRow(fakeClient({
    'plugin.list': { revision: 2, plugins: [{ ...view, id: 'th', name: 'Tavern Helper', status: 'enabled' }] },
  }).client)
  assert.equal(fine.verdict, 'ok')
  assert.match(fine.read, /^1 installed/)
})

test('sandbox: the manifest and the preset it names are fetched, the preset by HEAD; a 404 fails', async () => {
  const fetched: string[] = []
  const ok = await sandboxRow(page({
    fetchText: async (path, method) => {
      fetched.push(`${method} ${path}`)
      return page().fetchText(path, method)
    },
  }))
  assert.equal(ok.verdict, 'ok')
  assert.deepEqual(fetched, ['GET /sandbox/manifest.json', 'HEAD /sandbox/message-preset-1.js'])

  const missing = await sandboxRow(page({ fetchText: async () => ({ status: 404, body: '' }) }))
  assert.equal(missing.verdict, 'fail')
  assert.match(missing.read, /HTTP 404/)
  assertRemedyMatchesVerdict(missing)
})

test('policy, storage and corpus: each bad shape is said, each good shape passes', () => {
  assert.equal(policyRow(page()).verdict, 'ok')
  assert.equal(policyRow(page({ shellPolicy: false })).verdict, 'warn')

  assert.equal(storageRow(healthyFacts())?.verdict, 'ok')
  const full = storageRow(healthyFacts({ cardStorage: { bytes: 9.5 * 1_048_576, limit: 10 * 1_048_576 } }))
  assert.equal(full?.verdict, 'warn')
  assert.match(full?.read ?? '', /9\.5 MiB of 10\.0 MiB/)
  assert.equal(storageRow(healthyFacts({ cardStorage: undefined })), undefined)

  assert.equal(corpusRow(healthyFacts()).verdict, 'ok')
  assert.equal(corpusRow(healthyFacts({ corpusDir: { path: 'E:/st/data/default-user', readable: true } })).verdict, 'ok')
  const gone = corpusRow(healthyFacts({ corpusDir: { path: 'E:/nope', readable: false } }))
  assert.equal(gone.verdict, 'fail')
  assert.match(gone.remedy ?? '', /IRIS_ST_DIR/)
})

test('a healthy session is every row passing, as information, one line per row', async () => {
  const rows = await runDoctor(fakeClient().client, page())
  const checks = rows.map(row => row.check)
  assert.deepEqual(checks, [
    'host', 'bundle', 'provider', 'providerTest', 'authoring', 'consent', 'dataDir',
    'faults', 'sandbox', 'policy', 'plugins', 'storage', 'corpus',
  ])
  for (const row of rows) {
    assert.equal(row.verdict, 'ok', `${row.check}: ${row.read}`)
    assertRemedyMatchesVerdict(row)
  }
  const report = doctorReport(rows)
  assert.equal(report.kind, 'info')
  const lines = report.text.split('\n')
  assert.equal(lines.length, rows.length + 1, 'a count line, then one line per row')
  assert.match(lines[0] ?? '', /13 fine, 0 to look at, 0 to fix/)
  assert.ok(lines.slice(1).every(line => line.startsWith('✓ ')))
})

test('a host that does not answer debug.doctor gets a failing host row and the host-fact rows are left out', async () => {
  const { client } = fakeClient({ 'debug.doctor': new Error('no handler is registered for "debug.doctor"') })
  const rows = await runDoctor(client, page())
  const host = rowOf(rows, 'host')
  assert.equal(host.verdict, 'fail')
  assert.match(host.read, /no handler is registered/)
  for (const skipped of ['bundle', 'dataDir', 'storage', 'corpus'] as const) {
    assert.equal(rows.some(row => row.check === skipped), false, `${skipped} was guessed without host facts`)
  }
  // Every other row still read on its own.
  for (const kept of ['provider', 'authoring', 'consent', 'faults', 'sandbox', 'policy', 'plugins'] as const) {
    rowOf(rows, kept)
  }
  const report = doctorReport(rows)
  assert.equal(report.kind, 'error', 'a failing row raised the report as information')
  assert.match(report.text, /✗ Host: /)
})

test('the report carries a remedy on every non-passing line, in both languages', async () => {
  const { client } = fakeClient({
    'debug.doctor': { facts: healthyFacts({ webBundle: { entry: 'index-NEW.js' } }) },
    'connection.list': { profiles: [] },
  })
  for (const lang of ['en', 'zh'] as const) {
    setLanguage(lang)
    const text = doctorReport(await runDoctor(client, page())).text
    const lines = text.split('\n').slice(1)
    const flagged = lines.filter(line => !line.startsWith('✓ '))
    assert.ok(flagged.length >= 3, text)
    const joint = lang === 'en' ? ' — ' : ' —— '
    for (const line of flagged) assert.ok(line.includes(joint), `${lang}: no remedy on ${line}`)
  }
  setLanguage('en')
})

test('the report never carries key material, even when the listing does', async () => {
  const text = doctorReport(await runDoctor(fakeClient().client, page())).text
  assert.equal(text.includes(PLANTED), false)
})

test('the doctor modules never read a key field or name the connection store', async () => {
  // A source pin: the property is what the module *could* read, and an output
  // test passes for a module that reads the key and happens not to print it.
  for (const file of ['../src/app/doctor.ts', '../src/app/doctor-page.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const banned of ['apiKey', 'keyTail', 'hasKey', 'apiKeyHeader', 'keySource', 'connections.json']) {
      assert.equal(code.includes(banned), false, `${file} mentions ${banned} outside a comment`)
    }
  }
})

test('the report is a lasting notice: the store keeps the mark, the bar skips its timer, rows stay rows', async () => {
  const { createFakeClient } = await import('@iris/client-fake')
  const { createIrisStore } = await import('../src/client/store.ts')
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, { transport: 'fake', origin: 'doctor test' })
  try {
    store.getState().notify('info', 'Doctor: 1 fine\n✓ Host: x', { lasting: true })
    assert.equal(store.getState().notice?.lasting, true)
    // The same report again inside the dedup window merges, and stays lasting.
    store.getState().notify('info', 'Doctor: 1 fine\n✓ Host: x', { lasting: true })
    assert.equal(store.getState().notice?.count, 2)
    assert.equal(store.getState().notice?.lasting, true)
    // An ordinary notice after it is not lasting: the mark is per notice.
    store.getState().notify('info', 'Started a new conversation.')
    assert.equal(store.getState().notice?.lasting, undefined)
  } finally {
    dispose()
    client.dispose()
  }

  // The fake client has no host process, so /doctor over it says so rather
  // than inventing a healthy host.
  const fake = createFakeClient()
  try {
    await assert.rejects(fake.call('debug.doctor', {}), /no host process/)
  } finally {
    fake.dispose()
  }

  const app = await readFile(new URL('../src/app/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /notice\.lasting === true\) return/, 'the notice bar times out a lasting report')
  const css = await readFile(new URL('../src/app/panels.css', import.meta.url), 'utf8')
  const bar = /\.iris-notice \{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(bar, /white-space:\s*pre-line/, 'the notice bar runs a report’s rows into one paragraph')
})
