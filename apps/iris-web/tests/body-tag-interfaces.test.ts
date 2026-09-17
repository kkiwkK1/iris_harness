/**
 * The body tag and the interface claim, at the seam where they used to fight.
 *
 * `notes/apps/iris-web/DEVIATIONS.md` §110. The row derived
 * `bodyText = leak.body ?? display` and handed *that* to the claim, so the
 * body tag — a preset's convention about which part of a reply is prose —
 * silently decided which blocks were allowed to be interfaces. A card that
 * obeys its preset writes its panels outside `<content>`, so the more obedient
 * the card, the more certainly its interfaces were folded away: 12 of the 14
 * corpus cards measured on 2026-09-17 rendered **zero** frames on every reply,
 * and the head and tail they were folded into did not even reach the
 * `.iris-bodyleak` fold — the panel simply left the screen with nothing said.
 *
 * The fixtures below are the regression record's variants in miniature: M6
 * (three blocks, no wrapper) and M7 (the same three blocks plus a `<content>`
 * prose region) are the pair whose browser readings were 3 frames and 0, and
 * A/C/D are the single- and double-block controls. They are written against
 * `layOutMessageBody` — the row's own assembly — rather than against a copy of
 * its four lines, because a copy is exactly what could stay green while the row
 * regressed.
 *
 * @module iris-web/tests/body-tag-interfaces
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { BODY_TAG_DEFAULT, locateBodyTag, splitBodyTag } from '../src/app/body-tag.ts'
import { claimMessageSurfaces } from '../src/sandbox/frontend-blocks.ts'
import { layOutMessageBody } from '../src/app/message-body.ts'

/** A fence, built from code points so no escape has to survive being written. */
const TICKS = String.fromCharCode(96, 96, 96)
const NL = String.fromCharCode(10)

/** Assemble a fenced block. */
function fenced(info: string, body: string): string {
  return [TICKS + info, body, TICKS].join(NL)
}

/** The first fenced document — variant A's block, in miniature. */
const DOC_ONE = fenced('html', ['<html>', '<body><h1>状态栏</h1></body>', '</html>'].join(NL))

/** The bare HTML region between them — the shape `INLINE-HTML.md` measured. */
const REGION = ['<div class="de24-panel">', '<span>好感度 72</span>', '</div>'].join(NL)

/** The last fenced document — variant C's block. */
const DOC_TWO = fenced('text', ['<head><title>手机UI</title></head>', '<body>信息</body>'].join(NL))

/** The model's director notes: scaffolding, before the wrapper. */
const HEAD = '【开始思考】场景：废墟室内。检查：感官锚点就位。【结束思考】'

/** The self-check the preset asks for after the wrapper. */
const TAIL = '【自检】人称一致，未越界。'

/** The prose the preset teaches the model to wrap. */
const PROSE = '她把枪插回枪套，没有回头。'

/** M6: three blocks, no wrapper anywhere — the record's 3-frame reading. */
const M6 = [HEAD, '', DOC_ONE, '', REGION, '', DOC_TWO, '', TAIL].join(NL)

/** M7: the same three blocks, plus a `<content>` prose region between them. */
const M7 = [
  HEAD,
  '',
  DOC_ONE,
  '',
  REGION,
  '',
  `<content>${NL}${PROSE}${NL}</content>`,
  '',
  DOC_TWO,
  '',
  TAIL,
].join(NL)

/** How many interfaces one message lays out, through the row's own assembly. */
function interfacesOf(text: string, tag: string = BODY_TAG_DEFAULT): number {
  const { blocks, styles } = claimMessageSurfaces(text)
  return layOutMessageBody(text, tag, blocks, styles).filter(s => s.kind === 'interface').length
}

test('the M6/M7 pair claims the same three blocks — the wrapper is not a membership test', () => {
  /*
   * The whole defect in two numbers. The browser read 3 frames for M6 and 0 for
   * M7; the only difference between the two texts is a prose region the preset
   * asked the model to write.
   */
  assert.equal(claimMessageSurfaces(M6).blocks.length, 3, 'M6 must carry three claimable blocks or the pair proves nothing')
  assert.equal(
    claimMessageSurfaces(M7).blocks.length,
    claimMessageSurfaces(M6).blocks.length,
    'adding a <content> prose region must not change which blocks are interfaces',
  )
  assert.equal(interfacesOf(M7), 3, 'and all three reach the row as interfaces')

  /*
   * The control that gives the two numbers above their teeth: the *nearest
   * wrong implementation* — claiming over the wrapper's body, which is what the
   * row did — disagrees. Without this line a claim that ignored the body tag
   * for some unrelated reason would pass the same assertions.
   */
  const body = splitBodyTag(M7, BODY_TAG_DEFAULT).body
  assert.ok(body !== null, 'the M7 fixture must really carry the wrapper')
  assert.equal(
    claimMessageSurfaces(body).blocks.length,
    0,
    'the fixture must reproduce the defect when claimed the old way, or it discriminates nothing',
  )
})

test('prose inside the wrapper, an interface outside it: both keep their kind', () => {
  const text = [DOC_ONE, '', `<content>${NL}${PROSE}${NL}</content>`].join(NL)
  const { blocks, styles } = claimMessageSurfaces(text)
  const segments = layOutMessageBody(text, BODY_TAG_DEFAULT, blocks, styles)

  assert.deepEqual(
    segments.map(segment => segment.kind),
    ['interface', 'text'],
    'the document outside the wrapper is an interface; the wrapped prose is prose',
  )
  const prose = segments.find(segment => segment.kind === 'text')
  assert.ok(prose?.kind === 'text' && prose.text.includes(PROSE), 'the body is still the body')
  // And the wrapper's own characters never reach the renderer, which disables
  // raw HTML and would print `<content>` at the reader.
  assert.equal(
    segments.every(segment => segment.kind === 'interface' || !segment.text.includes('<content>')),
    true,
    'the wrapper markup is dropped, like a <style> span',
  )
})

test('head and tail scaffolding folds — it is never dropped on the floor', () => {
  /*
   * The second half of §110. A message whose blocks were all outside the
   * wrapper claimed nothing, fell through the row's no-interface fast path, and
   * returned the prose alone: the scaffolding was not folded, it was *gone*,
   * which is why 「卡片的界面消失了」 left no clue on screen.
   */
  const { blocks, styles } = claimMessageSurfaces(M7)
  const segments = layOutMessageBody(M7, BODY_TAG_DEFAULT, blocks, styles)

  const scaffold = segments.filter(segment => segment.kind === 'scaffold')
  assert.ok(scaffold.length >= 2, `head and tail must both survive, got ${String(scaffold.length)} folded pieces`)
  const folded = scaffold.map(segment => (segment.kind === 'scaffold' ? segment.text : '')).join(NL)
  assert.ok(folded.includes(HEAD), 'the director notes must be reachable in the fold')
  assert.ok(folded.includes(TAIL), 'and so must the self-check after the wrapper')
  assert.deepEqual(
    scaffold.map(segment => (segment.kind === 'scaffold' ? segment.edge : '')),
    ['head', 'tail'],
    'each piece knows which side of the prose it was written on',
  )

  // Nothing in the message is lost: every character is either a claimed block,
  // the wrapper's own markup, prose, folded scaffolding, or whitespace.
  const accounted = segments
    // The claimed span, not `block.body`: a fenced block's body excludes its
    // own fences, and this is an accounting of the message's characters.
    .map(segment => (segment.kind === 'interface' ? M7.slice(segment.block.start, segment.block.end) : segment.text))
    .join('')
    .replace(/\s+/g, '')
  const whole = M7.replace(/<\/?content>/g, '').replace(/\s+/g, '')
  assert.equal(accounted.length, whole.length, 'a character of the message went missing between claim and render')
})

test('the causal switch: a non-matching tag name and the default lay out the same interfaces', () => {
  /*
   * The regression record's own instrument. Setting `iris.bodyTag` to a name
   * the message does not carry made the same text build 3 frames again, and
   * setting it back made them vanish — which is what proved the body tag was
   * the cause rather than the frame layer. After the fix the switch must be
   * inert for membership: the same three interfaces either way.
   */
  assert.equal(locateBodyTag(M7, 'zzznotatag').tagged, false, 'the control name must really not match')
  assert.equal(locateBodyTag(M7, BODY_TAG_DEFAULT).tagged, true, 'and the default must really match')
  assert.equal(
    interfacesOf(M7, 'zzznotatag'),
    interfacesOf(M7, BODY_TAG_DEFAULT),
    'the body tag preference must not change how many interfaces a message has',
  )
  // It still decides layout, which is the half of the ruling that stays true:
  // with no wrapper matched there is nothing to fold, so the notes are prose.
  assert.equal(
    layOutMessageBody(M7, 'zzznotatag', ...surfacesOf(M7)).some(segment => segment.kind === 'scaffold'),
    false,
    'an unmatched tag folds nothing — the compatibility zero',
  )
  assert.equal(
    layOutMessageBody(M7, BODY_TAG_DEFAULT, ...surfacesOf(M7)).some(segment => segment.kind === 'scaffold'),
    true,
    'and the matching tag still folds the scaffolding',
  )
})

test('the single- and double-block variants are unchanged — A, C and D were never broken', () => {
  // The record's healthy readings. They pass before the fix too, and that is
  // the point: the fix must not move them.
  assert.equal(interfacesOf(DOC_ONE), 1, 'variant A')
  assert.equal(interfacesOf(DOC_TWO), 1, 'variant C')
  assert.equal(interfacesOf([DOC_ONE, '', DOC_TWO].join(NL)), 2, 'variant D')
  assert.equal(interfacesOf(M6), 3, 'variant M6')
})

test('an untagged message lays out byte-for-byte as it did before the mechanism', () => {
  const text = ['她抬头看了一眼。', '', REGION, '', '然后低头继续。'].join(NL)
  const { blocks, styles } = claimMessageSurfaces(text)
  const segments = layOutMessageBody(text, BODY_TAG_DEFAULT, blocks, styles)

  assert.deepEqual(segments.map(segment => segment.kind), ['text', 'interface', 'text'])
  assert.equal(segments.some(segment => segment.kind === 'scaffold'), false, 'nothing to fold, nothing folded')
})

/**
 * The claim's two lists for one message, positionally, for the spread above.
 * @param text - the message.
 * @returns its blocks and its style spans.
 */
function surfacesOf(text: string): [ReturnType<typeof claimMessageSurfaces>['blocks'], ReturnType<typeof claimMessageSurfaces>['styles']] {
  const { blocks, styles } = claimMessageSurfaces(text)
  return [blocks, styles]
}
