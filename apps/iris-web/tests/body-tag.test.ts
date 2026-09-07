import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { BODY_TAG_DEFAULT, getBodyTag, splitBodyTag, setBodyTag } from '../src/app/body-tag.ts'

const NL = String.fromCharCode(10)

test('a message without the wrapper splits to itself — the compatibility zero', () => {
  const text = `她把枪插回枪套。${NL}${NL}<StatusPlaceHolderImpl/>`
  const split = splitBodyTag(text, BODY_TAG_DEFAULT)
  assert.deepEqual(split, { tagged: false, body: null, head: '', tail: '' })
  // And the caller's fallback — render `body ?? text` — is the same string.
  assert.equal(split.body ?? text, text)
})

test('a closed wrapper: prose inside, scaffolding folded to head and tail', () => {
  const text = `【开始思考】场景：废墟室内。检查：感官锚点就位。【结束思考】${NL}<content>这是正文。她没有回头。</content>${NL}（补一句标签外的闲笔）`
  const split = splitBodyTag(text, 'content')
  assert.equal(split.tagged, true)
  assert.equal(split.head, '【开始思考】场景：废墟室内。检查：感官锚点就位。【结束思考】' + NL)
  assert.equal(split.body, '这是正文。她没有回头。')
  assert.equal(split.tail, NL + '（补一句标签外的闲笔）')
})

test('an unclosed wrapper reads body-to-end: streaming is the normal case, a settled slip the same ruling', () => {
  const streaming = `【开始思考】${NL}<content>正文还在路上，一个字一个字来`
  const split = splitBodyTag(streaming, 'content')
  assert.equal(split.tagged, true)
  assert.equal(split.head, '【开始思考】' + NL)
  assert.equal(split.body, '正文还在路上，一个字一个字来')
  assert.equal(split.tail, '')

  // Settled but never closed: the model opened the wrapper, so the rest was
  // meant as prose — repairStrayFences' ruling, one level up.
  const split2 = splitBodyTag(streaming, 'content')
  assert.equal(split2.body, '正文还在路上，一个字一个字来')
})

test('repeated wrappers: the first pair is the reply, the rest is scaffolding by construction', () => {
  const text = '<content>第一段正文。</content>中间的泄漏<content>第二段</content>'
  const split = splitBodyTag(text, 'content')
  assert.equal(split.body, '第一段正文。')
  assert.equal(split.tail, '中间的泄漏<content>第二段</content>')
})

test('an empty wrapper still counts: the scaffolding must not be promoted to prose', () => {
  const split = splitBodyTag('<content></content>全都是泄漏', 'content')
  assert.equal(split.tagged, true)
  assert.equal(split.body, '')
  assert.equal(split.tail, '全都是泄漏')
})

test('the tag name matches at element boundaries only — a longer tag sharing the prefix is untagged', () => {
  assert.deepEqual(splitBodyTag('<content_notes>不是正文标签</content_notes>', 'content'), {
    tagged: false,
    body: null,
    head: '',
    tail: '',
  })
  // A real tag with an attribute still opens.
  const split = splitBodyTag('<content lang="zh">正文</content>', 'content')
  assert.equal(split.tagged, true)
  assert.equal(split.body, '正文')
})

test('an invalid tag name is untagged rather than a broken match', () => {
  for (const bad of ['', '<content', 'content>', 'a b', '正.文', '..']) {
    const split = splitBodyTag(`<${bad}>x</${bad}>`, bad)
    assert.equal(split.tagged, false, `tag name ${JSON.stringify(bad)} must refuse`)
  }
})

test('the preference validates on write and falls back to the default on a corrupt store', () => {
  assert.equal(BODY_TAG_DEFAULT, 'content', 'the ecosystem default the preset teaches')
  assert.equal(setBodyTag('body'), true)
  assert.equal(getBodyTag(), 'body')
  assert.equal(setBodyTag('正 文'), false, 'an invalid name is refused, not coerced')
  assert.equal(getBodyTag(), 'body', 'and the previous choice survives the refusal')
  assert.equal(setBodyTag('content'), true)
})

test('the row renders the split at the one seam everything already reads', () => {
  /*
   * Asserted at the source, like the other cross-file agreements: the split
   * must sit exactly between the repair and every downstream read, or the
   * claim's offsets and the row's splice diverge — the fault the stray-fence
   * merge spent its whole test pinning against, one transform earlier. The
   * identity line (`body ?? display`) is the compatibility contract: an
   * untagged card renders byte-for-byte what it rendered before this existed.
   */
  const row = readFileSync(fileURLToPath(new URL('../src/app/MessageInterfaces.tsx', import.meta.url)), 'utf8')
  assert.match(row, /const bodyTag = useSyncExternalStore\(subscribeBodyTag, getBodyTag\)/, 'the tag name is a live preference, not a constant frozen at boot')
  assert.match(row, /const leak = splitBodyTag\(display, bodyTag\)/, 'the split reads the repaired text, after the fence ruling')
  assert.match(row, /const bodyText = leak\.body \?\? display/, 'an untagged message is the identity — the compatibility zero')
  assert.match(row, /leak\.tagged && leak\.head\.trim\(\) !== '' && <BodyLeak text=\{leak\.head\}/, 'the head scaffolding renders folded, and only when there is any')
  assert.match(row, /leak\.tagged && leak\.tail\.trim\(\) !== '' && <BodyLeak text=\{leak\.tail\}/, 'the tail scaffolding renders folded at the far edge')
})
