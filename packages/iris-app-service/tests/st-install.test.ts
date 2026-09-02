import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { refuseOverlappingInstall, StInstall, stFileName } from '../src/st-install.ts'
import { toId } from '../src/paths.ts'

/**
 * Reading a book out of the user's own SillyTavern installation.
 *
 * A card can name a world book that did not travel with it; the book usually
 * exists in the user's install. Finding it means asking the question their
 * filesystem answers, which is **their** filename rule, not ours.
 *
 * SillyTavern writes ``sanitize(`${name}.json`)`` through `sanitize-filename`
 * (`worldinfo.js:24,151`): the nine illegal characters and C0/C1 controls are
 * **deleted** rather than replaced, Windows device names are eaten whole,
 * trailing dots and spaces go, and the result is truncated to 255 **bytes**.
 * Unicode and case survive, so CJK names land on disk unchanged.
 */

test('this host’s own id rule must not be used to find someone else’s files', () => {
  // Measured against the 18 books in the reference install: `toId` reproduces
  // the filename for 5 and changes it for 13. The dangerous ones are not the
  // misses but the near-misses — `toId` strips a trailing extension, so a
  // dotted version number is read as one and a *different* book is named.
  assert.equal(toId('创世回廊1.3'), '创世回廊1')
  assert.equal(stFileName('创世回廊1.3'), '创世回廊1.3.json')

  assert.equal(toId('命定之诗与黄昏之歌v3.0.4'), '命定之诗与黄昏之歌v3.0')
  assert.equal(stFileName('命定之诗与黄昏之歌v3.0.4'), '命定之诗与黄昏之歌v3.0.4.json')

  // `toId` is right for our own files, where it is the only writer. It is wrong
  // as a reader of a directory written by a different rule.
  assert.notEqual(toId('尸变纪元 v0.5（NSFW）'), '尸变纪元 v0.5（NSFW）')
  assert.equal(stFileName('尸变纪元 v0.5（NSFW）'), '尸变纪元 v0.5（NSFW）.json')
})

test('the nine illegal characters are deleted, not replaced', () => {
  // Deleted is the whole point: a replacement scheme would produce a filename
  // that exists in neither install.
  for (const character of ['/', '?', '<', '>', '\\', ':', '*', '|', '"']) {
    assert.equal(
      stFileName(`a${character}b`),
      'ab.json',
      `${character} was not deleted`,
    )
  }
})

test('a Windows device name is eaten whole, extension and all', () => {
  // `sanitize-filename` matches the reserved name *with* its extension, so
  // `con.json` becomes the empty string rather than `con`. A lookup must treat
  // that as "no such file" instead of matching something else.
  for (const reserved of ['con', 'PRN', 'aux', 'nul', 'com1', 'lpt9']) {
    assert.equal(stFileName(reserved), '', `${reserved} survived`)
  }
  // But a name that merely starts with one is ordinary.
  assert.equal(stFileName('console'), 'console.json')
  assert.equal(stFileName('lpt10'), 'lpt10.json')
})

test('the trailing-dot rule cannot fire here, because .json is appended first', () => {
  /*
   * `sanitize-filename` strips trailing dots and spaces from the *whole*
   * string, and SillyTavern hands it ``${name}.json`` — which never ends in a
   * dot or a space. So a name ending in a space keeps that space **inside** the
   * filename, and the rule that looks like it would tidy that up is unreachable
   * on this path.
   *
   * Asserted as the behaviour rather than the intention: this test first
   * claimed `book. ` becomes `book.json`, which is what the rule would do if it
   * ran on the name alone. Matching their pipeline means matching the order
   * they apply it in, not just the transforms.
   */
  assert.equal(stFileName('book. '), 'book. .json')
  assert.equal(stFileName('爱衣妹妹v1.1'), '爱衣妹妹v1.1.json')
  assert.equal(stFileName('【Sgw】『普通』'), '【Sgw】『普通』.json')
})

test('the 255 limit is bytes, not characters', () => {
  // These names are largely CJK, where one character is three bytes — a
  // character-counted limit would let a name through that the filesystem then
  // refuses, and the failure would land at write time on someone else's disk.
  const long = '本'.repeat(100)
  const produced = stFileName(long)
  assert.ok(Buffer.byteLength(produced, 'utf8') <= 255, 'the limit was applied to characters')
  assert.ok(produced.length < long.length, 'a name over the byte limit was not truncated')
})

/** A fake install: the point is the rule, not the user's real files. */
async function install(t: TestContext): Promise<{ dir: string, st: StInstall }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-st-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(
    join(dir, 'worlds', '爱衣妹妹v1.1.json'),
    JSON.stringify({ entries: { '0': { uid: 0, key: ['k'], content: 'real', comment: 'c' } } }),
    'utf8',
  )
  return { dir, st: new StInstall(dir) }
}

test('a book is found by the name a card spells', async (t) => {
  const { st } = await install(t)
  const found = await st.book('爱衣妹妹v1.1')

  assert.equal(found.found, true)
  assert.equal(typeof (found as { book: unknown }).book, 'object')
})

test('the three kinds of "not there" are told apart', async (t) => {
  const { st } = await install(t)

  // Only one of these has an action for the user, and one of them may succeed
  // on the next open — collapsing them would send someone looking for a book
  // they actually have.
  assert.deepEqual(await new StInstall().book('anything'), { found: false, why: 'not-configured' })
  assert.deepEqual(await st.book('no such book'), { found: false, why: 'absent' })
  assert.deepEqual(await st.book('con'), { found: false, why: 'absent' })
})

test('a file that will not parse is unreadable, not absent', async (t) => {
  const { dir, st } = await install(t)
  await writeFile(join(dir, 'worlds', 'half-written.json'), '{"entries": {', 'utf8')

  // SillyTavern may be writing while we read. "Absent" would be a lie about a
  // book the user has, and the next open may well succeed.
  assert.deepEqual(await st.book('half-written'), { found: false, why: 'unreadable' })
})

test('nothing in this reader writes to the install', async (t) => {
  const { dir, st } = await install(t)
  const before = (await readdir(join(dir, 'worlds'))).sort()

  await st.book('爱衣妹妹v1.1')
  await st.book('no such book')
  await st.globalSelect()

  // The premise of the whole feature, asserted rather than trusted to review.
  assert.deepEqual((await readdir(join(dir, 'worlds'))).sort(), before)
  assert.equal(existsSync(join(dir, 'settings.json')), false, 'a read created a settings file')
})

test('a missing globalSelect key is undefined, never an empty selection', async (t) => {
  const { dir, st } = await install(t)

  // The nesting is `world_info_settings.world_info.globalSelect`. A top-level
  // `world_info` key does not exist, and reading it with a `?? []` fallback
  // yields a clean empty array — a missing key wearing the face of "the user
  // selected nothing". Those are different facts, so this reports undefined.
  assert.equal(await st.globalSelect(), undefined, 'no settings file should be undefined, not []')

  await writeFile(join(dir, 'settings.json'), JSON.stringify({ world_info: { globalSelect: ['wrong'] } }), 'utf8')
  assert.equal(await st.globalSelect(), undefined, 'the shallow path was read')

  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({ world_info_settings: { world_info: { globalSelect: ['right'] } } }),
    'utf8',
  )
  assert.deepEqual(await st.globalSelect(), ['right'])
})

test('an install path overlapping our own data directory is refused', () => {
  // Checked at startup, because the way "we never write to their install"
  // breaks is the two directories being one — after which our ordinary writes
  // land in their library, and finding that out later is not recoverable.
  assert.notEqual(refuseOverlappingInstall('/data/user', '/data/user'), undefined)
  assert.notEqual(refuseOverlappingInstall('/data/user/worlds', '/data/user'), undefined)
  assert.notEqual(refuseOverlappingInstall('/data', '/data/user'), undefined)
  assert.equal(refuseOverlappingInstall('/elsewhere/st', '/data/user'), undefined)
})
