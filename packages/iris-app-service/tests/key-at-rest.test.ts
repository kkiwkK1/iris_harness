import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ConnectionStore, keyFilePathFor } from '../src/connections.ts'
import {
  DATA_KEY_BYTES,
  KEY_FILE_WARNING,
  decryptValue,
  dpapiProtector,
  encryptValue,
  fileProtector,
  protectorForKind,
  type EncryptedValue,
  type KeyProtector,
} from '../src/key-protection.ts'

/**
 * A provider key is not in the profile folder in the clear.
 *
 * The finding (audit F4): `connections.json` carried `apiKey` exactly as the
 * user typed it, which is what upstream SillyTavern still does
 * (`src/endpoints/secrets.js:150`, `:204-223`). Anything running as the user,
 * any backup and any folder-sync client therefore had the keys.
 *
 * What is asserted here is the property, not the algorithm: **the typed bytes
 * are not in the file, the store still answers with them, and every way the
 * envelope can fail ends in "no key, and here is why" rather than in a wrong
 * key or a silent one.** The protector is a fake in all but one test, because a
 * suite that spawned a PowerShell per case would be measuring Windows; the one
 * exception is gated and does exactly that on purpose.
 */

/** A deterministic stand-in for the operating system's key store. */
function fakeProtector(mask = 0x5a): KeyProtector {
  return {
    kind: 'fake',
    wrap: dataKey => Promise.resolve(Buffer.from(dataKey.map(byte => byte ^ mask)).toString('base64')),
    unwrap: wrapped => Promise.resolve(
      Uint8Array.from(Buffer.from(wrapped, 'base64').map(byte => byte ^ mask))),
  }
}

/** A protector that wraps and then cannot open its own work — the other account. */
function refusingProtector(): KeyProtector {
  return {
    kind: 'fake',
    wrap: dataKey => Promise.resolve(Buffer.from(dataKey).toString('base64')),
    unwrap: () => Promise.reject(new Error('Key not valid for use in specified state')),
  }
}

async function scratch(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-key-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  return dir
}

/** The stored rows, as the file has them. */
async function rowsOf(path: string): Promise<{ id: string, apiKey?: string, apiKeyEnc?: EncryptedValue }[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as {
    profiles: { id: string, apiKey?: string, apiKeyEnc?: EncryptedValue }[]
  }
  return parsed.profiles
}

test('a key round-trips through the store and never lands in the file', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  const key = 'sk-fixture-key-7777'

  const store = new ConnectionStore(path, undefined, { protector: fakeProtector() })
  const saved = await store.save({ provider: 'deepseek', model: 'deepseek-chat', apiKey: key })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  // 1. The bytes are not there, and neither is the field name.
  const text = await readFile(path, 'utf8')
  assert.equal(text.includes(key), false, 'the typed key is in the file')
  assert.equal(text.includes('"apiKey"'), false, 'the plaintext field name is still written')
  const [row] = await rowsOf(path)
  assert.equal(row?.apiKey, undefined)
  assert.equal(row?.apiKeyEnc?.v, 1)
  assert.ok((row?.apiKeyEnc?.ct.length ?? 0) > 0, 'the envelope carries no ciphertext')

  // 2. A second store opened on those bytes answers with the key — which is the
  //    half that makes the first half a *change* rather than a loss.
  const reopened = new ConnectionStore(path, undefined, { protector: fakeProtector() })
  assert.equal((await reopened.get(id)).apiKey, key)
  assert.equal((await reopened.list()).profiles[0]?.hasKey, true)
  assert.equal((await reopened.list()).profiles[0]?.keyTail, '7777')

  // 3. The key file names its protector and carries nothing else.
  const keyFile = JSON.parse(await readFile(keyFilePathFor(path), 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(keyFile).sort(), ['kind', 'wrapped'])
  assert.equal(keyFile['kind'], 'fake')
  assert.equal(Buffer.from(String(keyFile['wrapped']), 'base64').length, DATA_KEY_BYTES)
})

test('a nonce is fresh on every write, so two profiles with one key look different', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  const store = new ConnectionStore(path, undefined, { protector: fakeProtector() })
  await store.save({ provider: 'a', model: 'm', apiKey: 'sk-same-key-0000' })
  await store.save({ provider: 'b', model: 'm', apiKey: 'sk-same-key-0000' })

  const rows = await rowsOf(path)
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0]?.apiKeyEnc?.iv, rows[1]?.apiKeyEnc?.iv, 'one nonce served two values')
  assert.notEqual(rows[0]?.apiKeyEnc?.ct, rows[1]?.apiKeyEnc?.ct, 'one key encrypts to one ciphertext')
})

test('a ciphertext copied onto another profile’s row does not open', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  const store = new ConnectionStore(path, undefined, { protector: fakeProtector() })
  await store.save({ provider: 'rich', model: 'm', apiKey: 'sk-the-expensive-one' })
  await store.save({ provider: 'poor', model: 'm' })

  // The file edit this binding exists for: take the row with the key and paste
  // its envelope onto the row without one.
  const file = JSON.parse(await readFile(path, 'utf8')) as {
    profiles: { id: string, apiKeyEnc?: EncryptedValue }[]
  }
  const donor = file.profiles[0]
  const thief = file.profiles[1]
  assert.ok(donor?.apiKeyEnc !== undefined && thief !== undefined)
  thief.apiKeyEnc = donor.apiKeyEnc
  await writeFile(path, JSON.stringify(file, null, 2), 'utf8')

  const said: string[] = []
  const reopened = new ConnectionStore(path, message => { said.push(message) }, { protector: fakeProtector() })
  const listed = await reopened.list()
  assert.equal(listed.profiles[0]?.hasKey, true, 'the donor row stopped working')
  assert.equal(listed.profiles[1]?.hasKey, undefined, 'a stolen envelope opened on another row')
  assert.equal(said.length, 1, `one report expected, got ${String(said.length)}`)
  assert.ok(said[0]?.includes(thief.id), 'the report does not name the profile')
  assert.ok(said[0]?.includes('could not be decrypted'), said[0])
})

for (const field of ['ct', 'tag'] as const) {
  test(`a flipped byte in ${field} reads as no key, and says which profile`, async (t) => {
    const dir = await scratch(t)
    const path = join(dir, 'connections.json')
    const store = new ConnectionStore(path, undefined, { protector: fakeProtector() })
    await store.save({ provider: 'deepseek', model: 'm', apiKey: 'sk-tampered-with-1234' })

    const file = JSON.parse(await readFile(path, 'utf8')) as {
      profiles: { id: string, apiKeyEnc: EncryptedValue }[]
    }
    const row = file.profiles[0]
    assert.ok(row !== undefined)
    const bytes = Buffer.from(row.apiKeyEnc[field], 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    row.apiKeyEnc[field] = bytes.toString('base64')
    await writeFile(path, JSON.stringify(file, null, 2), 'utf8')

    const said: string[] = []
    const reopened = new ConnectionStore(path, message => { said.push(message) }, { protector: fakeProtector() })
    const listed = await reopened.list()
    assert.equal(listed.profiles[0]?.hasKey, undefined, `a flipped ${field} byte still opened`)
    assert.equal(listed.profiles[0]?.keyTail, undefined)
    assert.equal(said.length, 1)
    assert.ok(said[0]?.includes(row.id), 'the report does not name the profile')

    // And the tampered bytes are kept, not tidied away by the next write.
    await reopened.save({ id: row.id, provider: 'deepseek', model: 'other' })
    assert.equal((await rowsOf(path))[0]?.apiKeyEnc?.[field], row.apiKeyEnc[field],
      'a save dropped the ciphertext it could not read')
  })
}

test('a file from before the change is migrated on load, once, and says so', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  // Exactly the shape this package wrote until 2026-09-11.
  await writeFile(path, `${JSON.stringify({
    profiles: [
      { id: 'one', provider: 'deepseek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-old-plaintext-1111' },
      { id: 'two', provider: 'openrouter', model: 'gemini', apiKey: 'sk-old-plaintext-2222' },
      { id: 'three', provider: 'local', model: 'qwen3' },
    ],
    activeId: 'one',
  }, null, 2)}\n`, 'utf8')

  const said: string[] = []
  const notes: string[] = []
  const store = new ConnectionStore(path, message => { said.push(message) }, {
    protector: fakeProtector(),
    onNote: message => { notes.push(message) },
  })
  const listed = await store.list()

  // 1. Nothing was lost: both keys still answer, the third row still has none.
  assert.equal(listed.profiles.length, 3)
  assert.equal((await store.get('one')).apiKey, 'sk-old-plaintext-1111')
  assert.equal((await store.get('two')).apiKey, 'sk-old-plaintext-2222')
  assert.equal((await store.get('three')).apiKey, undefined)
  assert.equal(listed.activeId, 'one', 'the migration lost which profile was in use')

  // 2. The plaintext is gone from the disk **now**, not at the next save.
  const text = await readFile(path, 'utf8')
  assert.equal(text.includes('sk-old-plaintext-1111'), false, 'the first plaintext key is still on disk')
  assert.equal(text.includes('sk-old-plaintext-2222'), false, 'the second plaintext key is still on disk')
  assert.equal(text.includes('apiKey"'), false, 'the plaintext field name survived the migration')

  // 3. One note, naming the count and the file, and no fault.
  assert.equal(said.length, 0, `the migration reported a problem: ${said.join(' / ')}`)
  assert.equal(notes.length, 1, `one note expected, got ${String(notes.length)}`)
  assert.ok(notes[0]?.includes('2 connection key(s) were encrypted at rest'), notes[0])
  assert.ok(notes[0]?.includes(path), 'the note does not name the file')

  // 4. And it is one-way: a second boot finds nothing to migrate and is silent.
  const again: string[] = []
  const second = new ConnectionStore(path, undefined, {
    protector: fakeProtector(),
    onNote: message => { again.push(message) },
  })
  assert.equal((await second.get('one')).apiKey, 'sk-old-plaintext-1111')
  assert.deepEqual(again, [])
})

test('a row carrying both keys keeps the encrypted one and drops the plaintext', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  const dataKey = Uint8Array.from(Buffer.alloc(DATA_KEY_BYTES, 7))
  const wrapped = await fakeProtector().wrap(dataKey)
  await writeFile(keyFilePathFor(path), `${JSON.stringify({ kind: 'fake', wrapped })}\n`, 'utf8')
  await writeFile(path, `${JSON.stringify({
    profiles: [{
      id: 'both',
      provider: 'deepseek',
      model: 'm',
      apiKey: 'sk-the-plaintext-one',
      apiKeyEnc: encryptValue(dataKey, 'both', 'sk-the-encrypted-one'),
    }],
  }, null, 2)}\n`, 'utf8')

  const said: string[] = []
  const store = new ConnectionStore(path, message => { said.push(message) }, { protector: fakeProtector() })
  assert.equal((await store.get('both')).apiKey, 'sk-the-encrypted-one', 'the plaintext won')

  const text = await readFile(path, 'utf8')
  assert.equal(text.includes('sk-the-plaintext-one'), false, 'the dropped plaintext is still on disk')
  assert.equal(said.length, 1, `one report expected, got ${String(said.length)}`)
  assert.ok(said[0]?.includes('plaintext key beside its encrypted one'), said[0])
})

test('a plaintext beside a ciphertext this host cannot open is dropped, not adopted', async (t) => {
  // The case that gives the `delete` in the both-fields branch its teeth: with
  // the data key unreadable there is no decrypt to overwrite the plaintext, so
  // a store that left it standing would adopt it as the key and seal it on the
  // next save — a downgrade smuggled in through the one path that refuses them.
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  const dataKey = Uint8Array.from(Buffer.alloc(DATA_KEY_BYTES, 11))
  await writeFile(keyFilePathFor(path),
    `${JSON.stringify({ kind: 'fake', wrapped: await fakeProtector().wrap(dataKey) })}\n`, 'utf8')
  await writeFile(path, `${JSON.stringify({
    profiles: [{
      id: 'both',
      provider: 'deepseek',
      model: 'm',
      apiKey: 'sk-the-plaintext-one',
      apiKeyEnc: encryptValue(dataKey, 'both', 'sk-the-encrypted-one'),
    }],
  }, null, 2)}\n`, 'utf8')

  const said: string[] = []
  const store = new ConnectionStore(path, message => { said.push(message) }, { protector: refusingProtector() })
  assert.equal((await store.list()).profiles[0]?.hasKey, undefined, 'the plaintext was adopted as the key')
  assert.equal((await store.get('both')).apiKey, undefined)

  await store.save({ id: 'both', provider: 'deepseek', model: 'another' })
  const text = await readFile(path, 'utf8')
  assert.equal(text.includes('sk-the-plaintext-one'), false, 'the plaintext survived on disk')
  // And what the row *does* hold is still the key it was stored with — opened
  // here with the data key this test minted, which is the one thing the store
  // could not do.
  const sealed = (await rowsOf(path))[0]?.apiKeyEnc
  assert.ok(sealed !== undefined)
  assert.equal(decryptValue(dataKey, 'both', sealed), 'sk-the-encrypted-one',
    'the row no longer holds the key it was stored with')
})

test('a data key that will not open leaves every key absent and every byte where it was', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')

  const store = new ConnectionStore(path, undefined, { protector: fakeProtector() })
  const saved = await store.save({ provider: 'deepseek', model: 'm', apiKey: 'sk-unreachable-9999' })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  const sealedBefore = (await rowsOf(path))[0]?.apiKeyEnc
  const keyFileBefore = await readFile(keyFilePathFor(path))

  // The other Windows account, the other machine, the tampered wrapped key:
  // one condition as far as this store is concerned.
  const said: string[] = []
  const reopened = new ConnectionStore(path, message => { said.push(message) }, { protector: refusingProtector() })
  const listed = await reopened.list()
  assert.equal(listed.profiles.length, 1, 'the profile itself was lost')
  assert.equal(listed.profiles[0]?.hasKey, undefined, 'a key was reported for an unopenable store')
  assert.equal(listed.profiles[0]?.baseURL, undefined)
  assert.equal((await reopened.get(id)).apiKey, undefined)
  assert.equal(said.length, 1, `one report expected, got ${String(said.length)}`)
  assert.ok(said[0]?.includes(keyFilePathFor(path)), 'the report does not name the key file')
  assert.ok(said[0]?.includes('Key not valid for use in specified state'), said[0])

  // And a save in that state — the ordinary next thing a user does — keeps both
  // the wrapped key and the ciphertext it could not read, byte for byte.
  await reopened.save({ id, provider: 'deepseek', model: 'another-model' })
  assert.deepEqual((await rowsOf(path))[0]?.apiKeyEnc, sealedBefore, 'a save destroyed a ciphertext it could not read')
  assert.deepEqual(await readFile(keyFilePathFor(path)), keyFileBefore, 'a save rewrote the wrapped key')
  assert.equal(said.length, 1, 'the store reported the same failure twice')
})

test('a key file that is gone while the ciphertexts are not is said out loud', async (t) => {
  // The half-restored backup, and the sync client that carries `*.json`. Not
  // the same state as a first run, which has no ciphertexts and reports nothing
  // — the two were one branch in the first draft of this and a test said so.
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  const store = new ConnectionStore(path, undefined, { protector: fakeProtector() })
  await store.save({ provider: 'a', model: 'm', apiKey: 'sk-orphaned-0001' })
  await store.save({ provider: 'b', model: 'm', apiKey: 'sk-orphaned-0002' })
  await rm(keyFilePathFor(path))

  const said: string[] = []
  const reopened = new ConnectionStore(path, message => { said.push(message) }, { protector: fakeProtector() })
  const listed = await reopened.list()
  assert.equal(listed.profiles.filter(profile => profile.hasKey === true).length, 0, 'a key opened with no data key')
  assert.equal(said.length, 1, `two orphaned rows should say it once, got ${String(said.length)}`)
  assert.ok(said[0]?.includes(keyFilePathFor(path)), said[0])
  assert.ok(said[0]?.includes('is missing'), said[0])
})

test('typing a key again after that failure works, and the old wrapped key is kept', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  const store = new ConnectionStore(path, undefined, { protector: fakeProtector() })
  const saved = await store.save({ provider: 'deepseek', model: 'm', apiKey: 'sk-lost-forever-1111' })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  const orphaned = (await rowsOf(path))[0]?.apiKeyEnc
  const keyFileBefore = await readFile(keyFilePathFor(path), 'utf8')

  const said: string[] = []
  const reopened = new ConnectionStore(path, message => { said.push(message) }, { protector: refusingProtector() })
  await reopened.list()
  // The panel asked, and the user answered — on a **second** profile, so the
  // first one's unreadable envelope has to survive the write beside it.
  await reopened.save({ provider: 'openrouter', model: 'gemini', apiKey: 'sk-typed-again-2222' })

  const rows = await rowsOf(path)
  assert.deepEqual(rows[0]?.apiKeyEnc, orphaned, 'the unreadable row was rewritten')
  assert.ok(rows[1]?.apiKeyEnc !== undefined, 'the new key was not stored')
  const text = await readFile(path, 'utf8')
  assert.equal(text.includes('sk-typed-again-2222'), false, 'the new key landed in plaintext')

  // The old wrapped key is not deleted and not overwritten: it is set aside,
  // exactly as a file that would not parse is (§68).
  const kept = (await readdir(dir)).filter(name => name.includes('.unreadable-'))
  assert.equal(kept.length, 1, `the old wrapped key was not kept aside: ${(await readdir(dir)).join(', ')}`)
  assert.equal(await readFile(join(dir, kept[0] ?? ''), 'utf8'), keyFileBefore)
  assert.ok(said.some(line => line.includes('a new connection data key was created')), said.join(' / '))
})

test('with no key store to wrap it, the data key is a 0600 file and the boot says so', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  const said: string[] = []
  // No protector injected: this is the real choice, made for a platform with no
  // DPAPI. `wrapNewDataKey` therefore takes the fallback branch itself.
  const store = new ConnectionStore(path, message => { said.push(message) }, { platform: 'linux' })
  await store.save({ provider: 'deepseek', model: 'm', apiKey: 'sk-unwrapped-3333' })

  const keyFile = JSON.parse(await readFile(keyFilePathFor(path), 'utf8')) as { kind: string, wrapped: string }
  assert.equal(keyFile.kind, 'file')
  assert.equal(Buffer.from(keyFile.wrapped, 'base64').length, DATA_KEY_BYTES)
  assert.equal(said.length, 1, `one warning expected, got: ${said.join(' / ')}`)
  assert.equal(said[0], KEY_FILE_WARNING)
  assert.ok(said[0].includes('§75'), 'the warning does not point at the ledger')

  // The mode is a POSIX statement. On Windows the bits are not enforced and the
  // call is a no-op, so asserting them there would pin the platform's answer
  // rather than this code's — but the file must exist and open either way, and
  // that half is asserted on every platform.
  if (process.platform !== 'win32') {
    assert.equal((await stat(keyFilePathFor(path))).mode & 0o777, 0o600, 'the data key is readable by others')
  }
  const reopened = new ConnectionStore(path, undefined, { platform: 'linux' })
  assert.equal((await reopened.list()).profiles[0]?.hasKey, true)
})

test('the wrapped data key is asked for with 0600, on every platform', async () => {
  // A source pin, and it earns its oddness. The *effect* of the mode is a POSIX
  // fact: on Windows the bits are not enforced, so the assertion above runs
  // nowhere on this developer's machine and a mutation that drops the mode
  // stays green here while going red on CI. What can be asserted everywhere is
  // that the write **asks** for it — which is the thing a refactor would drop.
  const source = await readFile(new URL('../src/key-protection.ts', import.meta.url), 'utf8')
  assert.match(source, /atomicWriteFile\(path, [^\n]+, \{ mode: 0o600 \}\)/u,
    'writeKeyFile no longer asks for 0600; on POSIX the data key became world-readable')
})

test('the protector a key file names is the only one that may open it', () => {
  // The downgrade that must never happen automatically: a `dpapi` key file on a
  // machine that cannot reach DPAPI is a refusal, not a re-wrap.
  assert.equal(protectorForKind('dpapi').kind, 'dpapi')
  assert.equal(protectorForKind('file').kind, 'file')
  assert.throws(() => protectorForKind('kdbx'), /does not have/u)
})

test('the envelope binds to the row it was sealed for', () => {
  const dataKey = Uint8Array.from(Buffer.alloc(DATA_KEY_BYTES, 3))
  const sealed = encryptValue(dataKey, 'profile-a', 'sk-bound-to-a')
  assert.equal(decryptValue(dataKey, 'profile-a', sealed), 'sk-bound-to-a')
  assert.throws(() => decryptValue(dataKey, 'profile-b', sealed), /auth/iu)
  assert.throws(() => decryptValue(Uint8Array.from(Buffer.alloc(DATA_KEY_BYTES, 4)), 'profile-a', sealed), /auth/iu)
})

test('the file protector refuses a wrapped value that is not a data key', async () => {
  await assert.rejects(fileProtector().unwrap(Buffer.from('short').toString('base64')), /not 32/u)
})

/**
 * The one test that really talks to Windows.
 *
 * Gated on `IRIS_DPAPI=1` **and** the platform, because it spawns a PowerShell
 * and costs about half a second; the gate is the flag rather than a capability
 * check, for the reason `scripts/check-corpus-skips.mjs` gives — a number that
 * is a property of the machine cannot be pinned.
 *
 * The key it protects is made up. The assertion that matters as much as the
 * round trip is the second one: the bytes go in on **stdin**, so no argument
 * this spawn is given contains them, and a process listing on this machine
 * cannot read a credential out of the command line.
 */
test('DPAPI protects and unprotects a key without putting it on a command line', {
  skip: process.platform === 'win32' && process.env['IRIS_DPAPI'] === '1'
    ? false
    : 'needs Windows and IRIS_DPAPI=1',
}, async () => {
  const calls: { executable: string, args: readonly string[] }[] = []
  const recording: typeof spawn = ((executable: string, args: readonly string[], options: object) => {
    calls.push({ executable, args })
    return spawn(executable, args as string[], options)
  }) as typeof spawn

  const dataKey = Uint8Array.from(Buffer.from('this-is-not-a-real-key-0123456789'.slice(0, DATA_KEY_BYTES)))
  const protector = dpapiProtector(recording)
  const wrapped = await protector.wrap(dataKey)
  const back = await protector.unwrap(wrapped)

  assert.deepEqual(Buffer.from(back), Buffer.from(dataKey), 'DPAPI did not return the key it was given')
  assert.ok(Buffer.from(wrapped, 'base64').length > DATA_KEY_BYTES, 'the wrapped key is not a DPAPI blob')

  assert.equal(calls.length, 2, 'one spawn per call, no more')
  const material = [Buffer.from(dataKey).toString('base64'), wrapped]
  for (const call of calls) {
    assert.match(call.executable, /powershell\.exe|pwsh/u)
    assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
    for (const argument of call.args) {
      for (const secret of material) {
        assert.equal(argument.includes(secret), false, 'a key was passed on the command line')
      }
    }
  }
})
