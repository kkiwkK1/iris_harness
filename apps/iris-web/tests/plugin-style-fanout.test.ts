/**
 * A plugin's stylesheet crossing from the card-script frame to the message
 * frames, and the four things that crossing must not become.
 *
 * The fan-out is short — a store, a fold, a rebuild — and every one of its
 * failures is silent from outside: a sheet that was quietly cut in half still
 * paints, a sheet that outlives its plugin still paints, a plugin's tag written
 * onto the shell's own page still paints, and a `</style>` inside model-written
 * CSS ends an element without anyone's console saying so. So the assertions here
 * are about **bytes and populations**, not about screenshots.
 *
 * @module iris-web/tests/plugin-style-fanout
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SANDBOX_PLUGIN_LIMITS, SANDBOX_PLUGIN_STYLE_ATTRIBUTE } from '@iris/protocol'

import { frameWeight } from '../src/app/frame-budget.ts'
import {
  forgetChatPluginStyles,
  pluginStyleChars,
  pluginStyleRevision,
  pluginStyleSheets,
  publishPluginStyle,
  retractPluginStyles,
} from '../src/app/plugin-style-fanout.ts'
import { buildSrcdoc, MESSAGE_CSS_MARK, withMessageCss, withPluginCss } from '../src/sandbox/srcdoc.ts'
import { claimMessageSurfaces } from '../src/sandbox/frontend-blocks.ts'
import { runMessageInterfaces, type MessageFramesEnv } from '../src/sandbox/message-frames.ts'

const TICKS = String.fromCharCode(96, 96, 96)
const NL = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)

test('a plugin sheet at the ceiling is taken and one byte over is refused by name', () => {
  const chatId = 'cap-chat'
  forgetChatPluginStyles(chatId)
  /*
   * The ceiling itself first, so the refusal below is about **the extra
   * character** and not about the test having misjudged the limit — the
   * positive control the negative one needs.
   */
  const exact = 'x'.repeat(SANDBOX_PLUGIN_LIMITS.cssChars)
  const atLimit = publishPluginStyle(chatId, 'p', exact)
  assert.equal(atLimit.accepted, true)
  assert.equal(pluginStyleChars(chatId), SANDBOX_PLUGIN_LIMITS.cssChars)

  /*
   * And one more character, as a **second** sheet, because the ceiling is per
   * plugin rather than per call: `insert` may be called any number of times, and
   * a cap that only looked at one call would be no cap at all.
   */
  const over = publishPluginStyle(chatId, 'p', 'y')
  assert.equal(over.accepted, false)
  if (over.accepted) return
  assert.equal(over.chars, SANDBOX_PLUGIN_LIMITS.cssChars + 1, 'the report carries the measured size')
  assert.equal(over.limit, SANDBOX_PLUGIN_LIMITS.cssChars, 'and the ceiling it went over')

  /*
   * **Refused, not truncated.** The held text is byte-for-byte the sheet that
   * was accepted, with nothing appended and nothing cut — a store that had kept
   * a trimmed version would still report a refusal and still paint something
   * nobody wrote.
   */
  const held = pluginStyleSheets(chatId)
  assert.equal(held.length, 1)
  assert.equal(held[0]?.css, exact)
  forgetChatPluginStyles(chatId)
})

test('one plugin going away does not take another plugin’s sheets with it', () => {
  const chatId = 'two-plugins'
  forgetChatPluginStyles(chatId)
  publishPluginStyle(chatId, '1-a', '.a{color:red}')
  publishPluginStyle(chatId, '2-b', '.b{color:blue}')

  assert.equal(retractPluginStyles(chatId, '2-b'), true)
  /*
   * The assertion that matters is the **survivor**, not the departure: a store
   * keyed by chat alone would answer this test's "was B's sheet dropped" with a
   * cheerful yes and take A's with it, and from a reader's side that is the
   * wrong plugin having been removed.
   */
  assert.deepEqual(pluginStyleSheets(chatId), [{ pluginId: '1-a', css: '.a{color:red}' }])
  assert.equal(retractPluginStyles(chatId, '2-b'), false, 'and forgetting twice is not an event')
  forgetChatPluginStyles(chatId)
})

test('sheets come out in plugin id order, and the revision moves only when they do', () => {
  const chatId = 'order-chat'
  forgetChatPluginStyles(chatId)
  const before = pluginStyleRevision(chatId)
  // Published out of order on purpose: the cascade order is a property of the
  // ids (§9), not of who happened to call first.
  publishPluginStyle(chatId, '9-late', '.late{}')
  publishPluginStyle(chatId, '1-early', '.early{}')
  assert.deepEqual(
    pluginStyleSheets(chatId).map(sheet => sheet.pluginId),
    ['1-early', '9-late'],
  )
  assert.notEqual(pluginStyleRevision(chatId), before)

  const settled = pluginStyleRevision(chatId)
  retractPluginStyles(chatId, 'nobody')
  assert.equal(
    pluginStyleRevision(chatId),
    settled,
    'a retraction that found nothing must not rebuild every message frame in the view',
  )
  forgetChatPluginStyles(chatId)
})

test('the shell’s fan-out store never reaches for a document', () => {
  /*
   * A source scan, and it is here because the tooth this guards has no other
   * home a unit test can reach: §16.3 asks that the **shell's own page** carry
   * zero plugin style tags after a mount, which the acceptance script asserts
   * against a live page. This is the half that can fail in CI — a module with no
   * DOM in it cannot put a tag on the shell's page, so the property is kept by
   * keeping the module free of one rather than by watching the page.
   *
   * It reads the file rather than the module's behaviour deliberately: a
   * behavioural test would pass in Node for the trivial reason that `document`
   * is undefined there, which is a fact about the test environment and not
   * about the code.
   */
  const source = readFileSync(
    fileURLToPath(new URL('../src/app/plugin-style-fanout.ts', import.meta.url)),
    'utf8',
  )
  const code = source
    // Comments are prose, and this file's prose talks about documents at length.
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[ \t]*\/\/.*$/gmu, '')
  for (const forbidden of ['document', 'window', 'createElement', 'appendChild']) {
    assert.equal(
      code.includes(forbidden),
      false,
      `the fan-out store must not reach for ${forbidden}: it is what keeps the shell's own page free of plugin style tags`,
    )
  }
})

test('a plugin’s CSS cannot end the element it is folded into', () => {
  const folded = withPluginCss('<div>x</div>', [
    { pluginId: 'p', css: 'a{content:"</style><img onerror=bad()>"}' },
    { pluginId: 'q', css: 'b{content:"</script>alert(1)"}' },
  ])
  /*
   * Neither literal closer survives. `</style` is the live hole — a stylesheet
   * lives inside a `<style>` element, and a literal closer there would end it
   * and make everything after it document content. `</script` is defence in
   * depth: it ends nothing inside a `<style>`, and it is neutralised because the
   * only thing keeping that true is a claim about every future call site.
   */
  assert.equal(folded.includes('</style><img'), false)
  assert.equal(folded.includes('</script>alert'), false)
  assert.equal(folded.includes(`<${BACKSLASH}/style>`), true)
  assert.equal(folded.includes(`<${BACKSLASH}/script>`), true)
  // The markup itself is untouched, and each sheet is its own element tagged
  // with its owner — which is what makes a census in a message frame ask the
  // same question a census in the card's own frame asks.
  assert.equal(folded.endsWith('<div>x</div>'), true)
  assert.equal(folded.includes(`${SANDBOX_PLUGIN_STYLE_ATTRIBUTE}="p"`), true)
  assert.equal(folded.includes(`${SANDBOX_PLUGIN_STYLE_ATTRIBUTE}="q"`), true)
})

test('folding nothing changes nothing, byte for byte', () => {
  /*
   * The compatibility floor, and the assertion is on the **whole string**: a
   * conversation with no sandbox plugin has to produce the markup it produced
   * before this feature existed, and "I searched for a marker I thought of" only
   * answers the breakage I thought of.
   */
  const markup = withMessageCss('<div>x</div>', '.m{color:red}')
  assert.equal(withPluginCss(markup, []), markup)
  assert.equal(
    withPluginCss(markup, [{ pluginId: 'p', css: '   ' }]),
    markup,
    'a plugin that inserted whitespace has inserted nothing, and nothing is what the frame must carry',
  )
})

test('a mounted-then-removed plugin leaves the srcdoc byte-identical to before it', () => {
  const chatId = 'fold-then-remove'
  forgetChatPluginStyles(chatId)
  // The same composition `runMessageInterfaces` uses, in the same order: both
  // helpers prefix, so the message sheet goes on the outside to end up first.
  const frame = (): string =>
    buildSrcdoc('tok', '/b.js', {
      networkGranted: false,
      libraries: [],
      selfOrigin: 'https://iris.invalid',
      body: withMessageCss(
        withPluginCss('<div id="bar">x</div>', pluginStyleSheets(chatId)),
        '.bar{color:red}',
      ),
    })

  const before = frame()
  publishPluginStyle(chatId, '1-dark', '#bar{background:#101418}')
  const mounted = frame()
  assert.notEqual(mounted, before, 'the positive control: the fold did reach the document')
  assert.equal(
    mounted.includes(`${SANDBOX_PLUGIN_STYLE_ATTRIBUTE}="1-dark"`),
    true,
  )

  retractPluginStyles(chatId, '1-dark')
  /*
   * And back to the **same bytes**, not merely to a document without that tag.
   * The lift that moves these sheets into the head reads a run of elements now
   * rather than one, and an off-by-one there would leave the reset, the message
   * sheet or the body one position out — a difference no tag-counting assertion
   * would see.
   */
  assert.equal(frame(), before)
  forgetChatPluginStyles(chatId)
})

test('a plugin’s sheets land in the head, after the message’s own and before the body', () => {
  const chatId = 'head-order'
  forgetChatPluginStyles(chatId)
  publishPluginStyle(chatId, '1-a', '.first{}')
  publishPluginStyle(chatId, '2-b', '.second{}')
  const html = buildSrcdoc('tok', '/b.js', {
    networkGranted: false,
    libraries: [],
    selfOrigin: 'https://iris.invalid',
    body: withMessageCss(withPluginCss('<div>x</div>', pluginStyleSheets(chatId)), '.message{}'),
  })

  const head = html.indexOf('</head>')
  const messageSheet = html.indexOf(`<style ${MESSAGE_CSS_MARK}>`)
  const first = html.indexOf(`${SANDBOX_PLUGIN_STYLE_ATTRIBUTE}="1-a"`)
  const second = html.indexOf(`${SANDBOX_PLUGIN_STYLE_ATTRIBUTE}="2-b"`)
  const bodyText = html.indexOf('<div>x</div>')

  assert.ok(messageSheet !== -1 && first !== -1 && second !== -1 && bodyText !== -1)
  /*
   * Positional, not "is it present". Document order is CSS's tie-breaker, so
   * these four indexes **are** the cascade: a plugin beats the message's own
   * sheet, the later plugin in id order beats the earlier, and both are in the
   * head rather than left in the body — where a `<style>` would shift
   * `body.children[0]` and add one to the count the blank-body detector reads.
   */
  assert.ok(messageSheet < first, "the message's own sheet comes first, so a plugin can override it")
  assert.ok(first < second, 'and the later plugin in id order wins a tie against the earlier')
  assert.ok(second < head, 'both are in the head')
  assert.ok(head < bodyText, 'and the body is past it')
})

test('the frame budget charges what the fold inlines', () => {
  const candidate = { floor: 0, instance: 0, body: '<div>x</div>' }
  const bare = frameWeight(candidate)
  /*
   * Charged, unlike the message's own sheet — a departure from that precedent
   * with its reason written on the field. The quantity here is not bounded by
   * anything a floor contains: sixteen plugins at the 32 KiB ceiling is half a
   * megabyte in **each** frame, which a budget refusing to look at it would rate
   * as zero.
   */
  assert.equal(frameWeight({ ...candidate, pluginCssBytes: 1_000 }), bare + 1_000)
})

test('the plugin sheets reach every region frame, fenced ones included', () => {
  const started: { markup: string }[] = []
  const env: MessageFramesEnv = {
    start: input => {
      started.push({ markup: input.markup })
      return {
        element: { isConnected: true } as unknown as HTMLIFrameElement,
        refreshContext: () => undefined,
        emit: () => undefined,
        // Required by the interface since the network-grant switch: a missing
        // member here would be a frame the grant could never reach.
        applyNetworkGrant: () => undefined,
        dispose: () => undefined,
      }
    },
    attach: () => undefined,
    onState: () => undefined,
  }
  const text = [
    '<div id="bar">bare</div>',
    '',
    TICKS + 'html',
    '<body><h1>fenced</h1></body>',
    TICKS,
  ].join(NL)
  const { blocks } = claimMessageSurfaces(text)
  assert.deepEqual(
    blocks.map(block => block.kind),
    ['bare-html', 'fenced'],
    'the fixture has one of each kind — without that the two populations below cannot be told apart',
  )
  runMessageInterfaces(blocks, 0, env, '.message{}', [{ pluginId: '1-dark', css: '#bar{}' }])

  const withPlugin = started.filter(one => one.markup.includes(SANDBOX_PLUGIN_STYLE_ATTRIBUTE))
  /*
   * **Both** frames, and this is the assertion the first acceptance run turned
   * into a defect. The message's own sheet stops at the bare-HTML regions, and
   * copying that population for the plugin sheets looked reasonable and reached
   * **zero** of 爱衣's frames: its status bar is a fenced interface, which is the
   * exact shape the design's acceptance scenario names.
   */
  assert.equal(withPlugin.length, 2, 'every region frame carries the sheet, fenced included')
  assert.equal(
    started.filter(one => one.markup.includes(`<style ${MESSAGE_CSS_MARK}>`)).length,
    1,
    "and the message's own sheet still stops at the bare region, as upstream's does",
  )

  /*
   * And in the right order, asserted **on the string the controller actually
   * composed** rather than on a composition the test wrote for itself.
   *
   * Both helpers prefix, so swapping the nesting silently inverts the cascade:
   * the card's own message CSS would beat the plugin the reader just asked for.
   * Every other assertion in this file stayed green through exactly that
   * mutation, because each one built its own markup — the producer and the
   * consumer both tested, the composition between them tested by nobody.
   */
  const markup = started.find(one => one.markup.includes('bare'))?.markup ?? ''
  const messageSheet = markup.indexOf(`<style ${MESSAGE_CSS_MARK}>`)
  const pluginSheet = markup.indexOf(SANDBOX_PLUGIN_STYLE_ATTRIBUTE)
  assert.ok(messageSheet !== -1 && pluginSheet !== -1)
  assert.ok(
    messageSheet < pluginSheet,
    "the message's own sheet must come first, so a plugin's rule wins the tie against it",
  )
})
