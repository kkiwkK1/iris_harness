import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRealm, evaluate } from '../src/child.ts'
import { buildEnvironment, createState } from '../src/index.ts'
import type { Snapshot } from '../src/index.ts'

/**
 * Evaluation, in the realm templates actually run in.
 *
 * The template fixtures are **transcribed from the corpus**, verbatim, with the
 * card and entry they came from named beside each. `extract.test.ts` records what
 * happens when a fixture is invented from a summary instead: the test passes
 * against the guess.
 *
 * The realm is exercised in-process here. `host.test.ts` covers the process
 * boundary; this file covers what the boundary contains.
 */

/** Variables shaped like the corpus's, since every fixture reads `stat_data`. */
function snapshot(): Snapshot {
  return {
    variables: {
      global: {},
      initial: {},
      local: {},
      message: {
        stat_data: {
          未央: { 现实侵占进度: 63 },
          App系统状态: { 以太能量浓度: 45, 人格维持轮数: 6, 运行人格路线: '傲娇学妹' },
          主角: { 个人信息: {} },
        },
        n: 2,
        当前层级: '第一层',
      },
    },
    chatMetadata: { yinqi_story_flags: { 宋赵复合: true } },
    worldInfo: [
      { world: 'book', uid: '1', comment: 'TakamatsuTomori_Wary', content: '灯还在戒备。' },
    ],
    lorebooks: { character: 'book' },
    scalars: { charName: '未央', userName: 'user' },
    traceId: 1,
  }
}

/** Render one template in a fresh realm over that snapshot. */
async function render(text: string, locals?: Record<string, never>): Promise<string> {
  const snap = snapshot()
  const state = createState(snap)
  const realm = createRealm()
  const environment = buildEnvironment({
    snapshot: snap,
    locals,
    evaluateNested: (nestedText, origin, nestedLocals) => evaluate(realm, nestedText, origin, nestedLocals),
  }, state)
  return await evaluate(realm, text, 'test', environment.locals)
}

test('text with no tag comes back byte-identical', () => {
  // The short-circuit again, but from the outside: the field is never compiled,
  // so nothing normalises its whitespace or line endings.
  const prose = '未央靠在窗边，没有说话。\r\n\r\n  缩进保留。  '
  return render(prose).then(text => assert.equal(text, prose))
})

test('a plain interpolation renders the variable', () => {
  // 可攻略女主拒绝被攻略.png wi[12] "[mvu_update]变量更新规则"
  return render("<%= getvar('stat_data.未央.现实侵占进度') %>").then(text => assert.equal(text, '63'))
})

test('a comment tag renders nothing but keeps the surrounding text', () => {
  // 性斗学园超级重制版.png wi[7] "EJS幸运阶段控制器"
  return render('<%# 根据幸运值输出对应阶段内容 %>剩下的正文').then(text => assert.equal(text, '剩下的正文'))
})

test('the slurping scriptlet leaves no blank line behind it', () => {
  // 87% of the corpus's 3364 tags are `<%_ … _%>`, and this is why: a card wraps
  // prose in conditionals and the conditionals cost nothing in the prompt. `<%_`
  // eats the indentation before it and `_%>` eats the newline after it, so a
  // scriptlet on its own line disappears entirely rather than leaving a gap.
  // Shape from 创世回廊1.3.png wi[93] "地图加载".
  const template = "A\n<%_ if (getvar('当前层级') === '第一层') { _%>\nB\n<%_ } _%>\nC"
  return render(template).then(text => assert.equal(text, 'A\nB\nC'))
})

test('a plain scriptlet does leave its blank line, which is why cards use <%_', () => {
  // The contrast that makes the previous test meaningful: `<% %>` keeps the
  // whitespace around it, so the same card written with plain tags would inject
  // blank lines into the prompt.
  const template = "A\n<% if (getvar('当前层级') === '第一层') { %>\nB\n<% } %>\nC"
  return render(template).then(text => assert.equal(text, 'A\n\nB\n\nC'))
})

test('a false condition removes the block', () => {
  const template = "A<%_ if (getvar('当前层级') === '第九层') { _%>B<%_ } _%>C"
  return render(template).then(text => assert.equal(text, 'AC'))
})

test('<%= does not escape, so a card can emit XML into the prompt', () => {
  // The identity `escape` is upstream's, and 289 corpus sites depend on it. If
  // EJS's HTML escaping were restored this would render `&lt;Status…`.
  return render("<%= '<StatusPlaceHolderImpl/>' %>").then((text) => {
    assert.equal(text, '<StatusPlaceHolderImpl/>')
  })
})

test('<%- renders the same as <%= in this dialect', () => {
  return Promise.all([
    render("<%= '<a & b>' %>"),
    render("<%- '<a & b>' %>"),
  ]).then(([escaped, raw]) => {
    assert.equal(escaped, '<a & b>')
    assert.equal(escaped, raw)
  })
})

test('lodash is available in the realm', () => {
  // 魔法少女是不会败北恶堕的吧！.png wi[4] "[描述] 善良AI人格" — and `_.get` is
  // 176 of the corpus's 207 lodash calls.
  const template = "<%= _.get(getvar('stat_data'), '主角.个人信息.使魔伙伴性格', '温柔') %>"
  return render(template).then(text => assert.equal(text, '温柔'))
})

test('a template can declare locals, loop, and catch', () => {
  // The corpus's tags are programs: 1749 `if`, 205 `function`, 139 `try`, 118
  // `for`. A template engine that only interpolated would run none of them.
  const template = [
    '<%_ var total = 0; _%>',
    '<%_ for (var i = 1; i <= 3; i++) { total += i } _%>',
    '<%_ try { null.x } catch (e) { total += 10 } _%>',
    '<%= total %>',
  ].join('')
  return render(template).then(text => assert.equal(text, '16'))
})

test('await getwi fetches another entry and evaluates it', () => {
  // 【Sgw】又看一集.png wi[28] "[Controller]高松灯_Persona". All 63 `await`s in
  // the corpus are this call, which is the only reason the engine needs to be
  // async at all.
  const template = "<%- await getwi(null, 'TakamatsuTomori_Wary') %>"
  return render(template, { world_info: { world: 'book' } } as never).then((text) => {
    assert.equal(text, '灯还在戒备。')
  })
})

test('a chat-metadata read works, as the corpus uses it', () => {
  // 银麒赎世.png wi[50] "地点_大学城步行街", reduced to the read.
  const template = "<%_ var f = (SillyTavern.chatMetadata || {}).yinqi_story_flags || {}; if (f['宋赵复合']) { _%>复合<%_ } _%>"
  return render(template).then(text => assert.equal(text, '复合'))
})

test('a template that throws surfaces the error rather than the text', () => {
  // The host turns this into a failed item and keeps the original text, which
  // is upstream's behaviour. What matters here is that it throws at all.
  return assert.rejects(() => render('<%= nope.missing %>'), /nope is not defined/)
})

test('an unbalanced brace is a compile failure naming the origin', () => {
  // `<% if (true) { %>` is a well-formed *tag*; what breaks is the JavaScript it
  // generates. So the error comes from the function constructor, and EJS labels
  // it with the `filename` we passed — which is why every item carries an
  // `origin`.
  return assert.rejects(() => render('<% if (true) { %>'), /in test while compiling ejs/)
})

// --- the boundary the realm provides ----------------------------------------

/**
 * These four are the security properties of the design, and every one of them
 * was a measurement before it was a test.
 *
 * The `import()` case is the one that matters most: it is the only reach that
 * survives deleting every global, because it is syntax rather than a global, and
 * Node's permission model does not gate the network — there is no `--allow-net`.
 * A context with no `importModuleDynamically` callback is what closes it.
 */
test('a template cannot reach the module system', () => {
  return Promise.all([
    render('<%= typeof require %>'),
    render('<%= typeof process %>'),
    render('<%= typeof fetch %>'),
    render('<%= typeof globalThis.process %>'),
  ]).then((results) => {
    assert.deepEqual(results, ['undefined', 'undefined', 'undefined', 'undefined'])
  })
})

test('dynamic import is refused inside the realm', () => {
  const template = '<%= await (async () => { try { await import("node:net"); return "REACHED" } catch (e) { return e.constructor.name } })() %>'
  return render(template).then((text) => {
    // Node reports a missing dynamic-import callback as a TypeError.
    assert.equal(text, 'TypeError')
  })
})

test('dynamic import is refused through a constructed function too', () => {
  // `new Function` is still reachable — it has to be, EJS compiles with it —
  // but the function it builds belongs to the same context and inherits the
  // same refusal.
  const template = '<%= await (async () => { try { await new Function("return import(\'node:net\')")(); return "REACHED" } catch (e) { return e.constructor.name } })() %>'
  return render(template).then(text => assert.equal(text, 'TypeError'))
})

test('two realms do not share globals', () => {
  // One realm per batch. A template that stashes something on the global object
  // must not be able to leave it for the next batch's templates.
  return render('<%_ globalThis.leaked = "yes" _%><%= String(globalThis.leaked) %>')
    .then((first) => {
      assert.equal(first, 'yes')
      return render('<%= String(globalThis.leaked) %>')
    })
    .then(second => assert.equal(second, 'undefined'))
})
