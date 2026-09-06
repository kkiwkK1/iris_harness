import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readFileSync } from 'node:fs'

import { FA_SENTINEL, buildSrcdoc, framePolicy, unblockFontStylesheets } from '../src/sandbox/srcdoc.ts'

/** Iris's own origin, as the runner supplies it. */
const SELF = 'http://127.0.0.1:5173'

test('the frame policy allows eval and pins where code comes from', () => {
  // The distinction SANDBOX.md now draws: CSP cannot forbid `eval` here, because
  // the card blobs are webpack output that evals per module. Restricting the
  // ORIGIN of code is a separate capability and it is fully available.
  const policy = framePolicy(false, SELF)

  assert.match(policy, /script-src[^;]*'unsafe-eval'/, 'the webpack blobs would not run')
  assert.match(policy, /script-src[^;]*https:\/\/\*\.jsdelivr\.net/)
  assert.match(policy, /script-src[^;]*https:\/\/raw\.githubusercontent\.com/)
  assert.doesNotMatch(policy, /script-src[^;]*https:(?!\/\/)/, 'script-src must not admit all of https')
})

test('blob: scripts are allowed, because the injection layer arrives that way', () => {
  // Measured in a live network trace: Tavern Helper delivers `predefine`,
  // `adjust_iframe_height` and `adjust_viewport` as blob URLs, not inline text.
  // Without this the injection layer is blocked before any card code exists, and
  // the symptom looks like a broken card rather than a wrong policy.
  const policy = framePolicy(false, SELF)
  assert.match(policy, /script-src[^;]*blob:/, 'the injected layer would be blocked')
})

test('the frame cannot open a nested context or post a form', () => {
  // Both are routes out of a frame whose entire purpose is not having one.
  const policy = framePolicy(false, SELF)
  assert.match(policy, /frame-src 'none'/)
  assert.match(policy, /form-action 'none'/)
  assert.match(policy, /default-src 'none'/)
})

test('the bootstrap is inlined, not fetched', () => {
  // An opaque-origin frame has no useful same-origin path, and a stable public
  // URL would be one more answer that could be substituted.
  const doc = buildSrcdoc('tok', 'console.log(1)', { networkGranted: false, libraries: [], selfOrigin: SELF })

  assert.match(doc, /<script>console\.log\(1\)<\/script>/)
  assert.doesNotMatch(doc, /<script[^>]+src=/, 'the frame should load nothing')
})

test('the run token reaches the bootstrap through the markup', () => {
  const doc = buildSrcdoc('abc123', '', { networkGranted: false, libraries: [], selfOrigin: SELF })
  assert.match(doc, /<meta name="iris-token" content="abc123">/)
})

test('a token containing markup cannot escape its attribute', () => {
  const doc = buildSrcdoc('a"><script>bad()</script>', '', { networkGranted: false, libraries: [], selfOrigin: SELF })

  assert.doesNotMatch(doc, /content="a"><script>bad/)
  assert.match(doc, /&quot;&gt;&lt;script&gt;/)
})

test('a bootstrap containing a closing script tag cannot break out', () => {
  // The one sequence that ends a script element early. Split rather than
  // HTML-escaped: the payload is JavaScript, and escaping inside it would change
  // the program.
  //
  // Asserted with a constructed string rather than a regex — in a test about
  // escaping, a literal backslash in the pattern is one more layer to reason
  // about than the thing under test.
  const BACKSLASH = String.fromCharCode(92)
  const doc = buildSrcdoc('tok', `const s = "</script><img onerror=bad()>"`, { networkGranted: false, libraries: [], selfOrigin: SELF })

  assert.equal(doc.includes('</script><img'), false, 'the payload broke out of its element')
  assert.equal(doc.includes(`<${BACKSLASH}/script`), true, 'the sequence was not neutralised')
  // Exactly one real script element: the one we opened.
  assert.equal(doc.match(/<[/]script>/g)?.length, 1)
})

test('the policy travels in the document, not as an attribute the host must set', () => {
  // The frame is built from `srcdoc`, so there is no response whose headers could
  // carry this. A meta element is the only place it can live.
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: [], selfOrigin: SELF })
  assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="[^"]+">/)
})

test('the default network scope is closed, because an open one is an exit', () => {
  /*
   * An image request is an exfiltration channel wearing a costume: a card allowed
   * to load `https://anywhere/x.png?d=<conversation>` sends the conversation out
   * one pixel at a time. `connect-src` is the same capability without the
   * pretence. So both are closed by default even though closing them costs real
   * cards their appearance — that cost is what the per-card grant is for.
   */
  const policy = framePolicy(false, SELF)

  assert.match(policy, /connect-src 'none'/, 'fetch must be closed by default')
  assert.match(policy, /img-src data: blob:/, 'images must not reach arbitrary origins by default')
  assert.doesNotMatch(policy, /img-src[^;]*https:/, 'the default must not admit https images')
})

test('fonts are the one default widening, and they execute nothing', () => {
  // High coverage across real cards, and a stylesheet or a font file runs no
  // code. Both hosts or neither: googleapis serves the CSS, gstatic the faces.
  const policy = framePolicy(false, SELF)

  assert.match(policy, /style-src[^;]*https:\/\/fonts\.googleapis\.com/)
  assert.match(policy, /font-src[^;]*https:\/\/fonts\.gstatic\.com/)
})

test('a network grant widens fetch, images and styles — and nothing else', () => {
  const granted = framePolicy(true, SELF)

  assert.match(granted, /connect-src https:/)
  assert.match(granted, /img-src https:/)
  assert.match(granted, /style-src[^;]*https:/)

  // Not script origins. Letting a card fetch its author's images is a different
  // decision from letting it execute its author's code, and only the first is
  // what the grant is for.
  const scriptSrc = /script-src ([^;]*)/.exec(granted)?.[1] ?? ''
  assert.equal(scriptSrc, /script-src ([^;]*)/.exec(framePolicy(false, SELF))?.[1])
})

test('the only cleartext origin permitted is Iris own', () => {
  /*
   * This assertion used to be "no `http://` anywhere, granted or not", and it
   * caught a real collision the moment Iris's own origin joined the policy: in
   * development that origin IS `http://127.0.0.1`.
   *
   * The rule it was reaching for survives, restated precisely. A grant is the user
   * accepting that a card may talk to its author's server; it is not them
   * accepting that their conversation crosses a network they do not control in
   * clear text. Iris's own origin is not such a network — it is where the page
   * already is, so admitting it adds nothing the card did not already have.
   *
   * **Restated a second time, and the same way it went wrong before.** This read
   * `deepEqual(cleartext, [SELF])`, which asserts our origin appears exactly
   * *once* — never the rule, just how many directives happened to need it. The
   * moment `style-src` needed it too, for the FontAwesome sentinel, a correct
   * change failed a passing test. What matters is that every cleartext origin in
   * the policy is ours, however many times it is named.
   */
  for (const granted of [false, true]) {
    const policy = framePolicy(granted, SELF)
    const cleartext = [...policy.matchAll(/http:\/\/[^\s;]*/g)].map(match => match[0])
    assert.ok(cleartext.length > 0, 'our own origin should be in there somewhere')
    assert.deepEqual(
      [...new Set(cleartext)],
      [SELF],
      'a cleartext origin other than Iris own reached the policy',
    )
  }
})

test('the bootstrap is emitted before the libraries it must be able to report on', () => {
  // Order is the whole point. The bootstrap has to capture its channel and install
  // its error handling first, or a library that fails to load is a silent gap that
  // only surfaces later as `Vue is not defined` — a message naming the symptom and
  // hiding the cause.
  const doc = buildSrcdoc('tok', 'BOOTSTRAP', {
    networkGranted: false,
    libraries: ['https://cdn.example/vue.js', 'https://cdn.example/vue-router.js'],
    selfOrigin: SELF,
  })

  const bootstrapAt = doc.indexOf('BOOTSTRAP')
  const firstLibAt = doc.indexOf('vue.js')
  assert.ok(bootstrapAt !== -1 && firstLibAt !== -1)
  assert.ok(bootstrapAt < firstLibAt, 'the bootstrap must be able to watch the libraries load')
})

test('libraries keep their given order', () => {
  // `vue-router` expects `Vue` to already be a global.
  const doc = buildSrcdoc('tok', '', {
    networkGranted: false,
    libraries: ['https://cdn.example/vue.js', 'https://cdn.example/vue-router.js'],
    selfOrigin: SELF,
  })
  assert.ok(doc.indexOf('vue.js') < doc.indexOf('vue-router.js'))
})

test('library tags are marked so the bootstrap can find them', () => {
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: ['https://cdn.example/a.js'], selfOrigin: SELF })
  assert.ok(doc.includes('data-iris-lib'), 'the bootstrap watches for load failures by this marker')
})

test('a frame with no libraries emits no library tags', () => {
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: [], selfOrigin: SELF })
  assert.equal(doc.includes('data-iris-lib'), false)
})

test('the policy admits Iris own origin, named exactly and not as a wildcard', () => {
  // The card-library bundle is served from it. Without this the bundle is refused
  // by this very policy, and the symptom is `_ is not defined` — a message
  // pointing at a missing library rather than at the rule that blocked it.
  const policy = framePolicy(false, SELF)

  assert.match(policy, new RegExp(`script-src[^;]*${SELF.replace(/[.]/g, '[.]')}`))
  // One origin Iris controls end to end is a different thing from a wildcard.
  assert.doesNotMatch(policy, /script-src[^;]*\*:/)
})

test('a network grant does not quietly widen script origins', () => {
  // Fetching an author's images and executing an author's code are different
  // decisions, and only the first is what the grant is for.
  const ungranted = /script-src ([^;]*)/.exec(framePolicy(false, SELF))?.[1]
  const granted = /script-src ([^;]*)/.exec(framePolicy(true, SELF))?.[1]
  assert.equal(granted, ungranted)
})

test('a library tag requests CORS, so its errors arrive with names', () => {
  /*
   * Half of a pair. The other half — that the host actually answers with
   * `Access-Control-Allow-Origin` — is asserted in
   * `apps/iris/tests/sandbox-cors.test.ts`, because no test inside this package
   * can see the host, and this attribute without that header does not degrade
   * gracefully: the browser refuses to run the script at all.
   *
   * That is not a hypothetical. This assertion previously read the other way
   * round, pinning the *absence* of the attribute, because adding it without the
   * header had blocked the entire preset — no globals, no error, nine libraries
   * reported missing when the truth was one blocked request. Both states have
   * now been correct at different times, which is precisely why the pairing is
   * asserted somewhere that can see both sides rather than trusted to a comment.
   */
  const doc = buildSrcdoc('tok', '', {
    networkGranted: false,
    libraries: [`${SELF}/sandbox/preset.js`],
    selfOrigin: SELF,
  })

  assert.ok(doc.includes('/sandbox/preset.js'), 'the library tag should still be emitted')
  assert.ok(
    doc.includes('crossorigin="anonymous"'),
    'without this the preset\u2019s exceptions are redacted to "Script error." and the throw that' +
      ' stops a card\u2019s publish chain arrives carrying nothing',
  )
})

test('a message frame carries its markup in the document, after the libraries', () => {
  /*
   * Order is load-bearing in both directions. The bootstrap first, so anything
   * the markup throws is something the frame can *say*. The libraries before the
   * markup, because a card's inline script calls `$()` on its first line and an
   * external `<script src>` without `defer` blocks parsing until it has run.
   */
  const doc = buildSrcdoc('tok', 'BOOTSTRAP', {
    networkGranted: false,
    libraries: [`${SELF}/sandbox/message-preset-abc.js`],
    selfOrigin: SELF,
    body: '<body><h1 id="bridge">console</h1></body>',
  })

  assert.ok(doc.includes('id="bridge"'), 'the card markup must be in the document')
  assert.ok(
    doc.indexOf('BOOTSTRAP') < doc.indexOf('message-preset-abc.js'),
    'the bootstrap installs the channel before anything can fail',
  )
  assert.ok(
    doc.indexOf('message-preset-abc.js') < doc.indexOf('id="bridge"'),
    'a card calls $() on its first line, so the libraries must have run',
  )
})

test('a message frame cannot scroll itself, which is why height sync is existence', () => {
  const doc = buildSrcdoc('tok', '', {
    networkGranted: false,
    libraries: [],
    selfOrigin: SELF,
    body: '<div>x</div>',
  })

  // Upstream's reset (`render/iframe.ts:88-89`). Without it a card that sized
  // itself expecting no inner scrollbar lays out differently.
  assert.ok(doc.includes('overflow:hidden!important'))
  assert.ok(doc.includes('box-sizing:border-box'))
})

test('a script frame keeps the minimal reset and gets no markup', () => {
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: [], selfOrigin: SELF })

  // Script bodies arrive as `run` messages, so there is nothing to place — and
  // `overflow:hidden` would be a rule about a document nobody looks at.
  assert.ok(!doc.includes('overflow:hidden'))
  assert.ok(doc.includes('color-scheme:inherit'))
})

test('the inlined snapshot is a string literal, so card data cannot become code', () => {
  /*
   * A card's variables are author-written and model-influenced text, and this
   * puts them into a document as source. Embedded as an object literal, a value
   * containing `</script>` — or anything that parses — would end the element or
   * run. As a JSON string literal parsed once at run time, no character in the
   * data is ever read as syntax.
   */
  const hostile = {
    variables: { note: '</script><img src=x onerror=alert(1)>' },
    nested: { deep: 'also "quoted" and \ escaped' },
  }
  const doc = buildSrcdoc('tok', '', {
    networkGranted: false,
    libraries: [],
    selfOrigin: SELF,
    body: '<div>x</div>',
    context: hostile,
  })

  assert.ok(doc.includes('__iris_context__'), 'the seed must be present')
  assert.ok(doc.includes('JSON.parse('), 'the value must be parsed, not evaluated')
  // The dangerous sequence must not appear able to close the seed's script.
  const seedAt = doc.indexOf('__iris_context__')
  const seedEnd = doc.indexOf('</script>', seedAt)
  const seed = doc.slice(seedAt, seedEnd)
  /*
   * Two properties, and the first draft of this test asserted the wrong one.
   *
   * It required that `onerror=` not appear at all — but the payload is a card's
   * *variable*, and it is supposed to survive verbatim. Had it been absent, the
   * card's data would have been silently corrupted, which is a worse bug than
   * the one being guarded against. **Data preserved, syntax neutralised** is
   * the property: the text is there, and the sequence that could end the
   * element is not.
   */
  assert.ok(
    !seed.includes('</script'),
    'the payload could close its own script element, so it would escape into markup',
  )
  assert.ok(
    seed.includes('onerror='),
    'the payload was altered — a card variable must arrive as the card wrote it',
  )
})

test('a frame with no inlined snapshot has no seed at all', () => {
  // A script frame's snapshot arrives over the channel, and an empty seed global
  // would give the frame a second, always-stale source for it.
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: [], selfOrigin: SELF })
  assert.ok(!doc.includes('__iris_context__'))
})
test('the inlined snapshot precedes the bootstrap, positionally', () => {
  /*
   * **The order is the timing contract.** The bootstrap's `installSandbox`
   * reads the seed synchronously (`env.seededContext()`), so the seed has to be
   * in place before the bootstrap's first line runs. A seed emitted after the
   * bootstrap script is present, parseable, and read by nobody — which is the
   * exact shape that shipped: a message frame's inline card script called
   * `getAllVariables()` at parse time, the snapshot was still `undefined`, and
   * the member refused by name (新·架空政治经济模拟器's status bar).
   *
   * Asserted by **position**, not by presence — presence is the test above, and
   * a dead seed passes it. The markup still comes last, so the assertion pins
   * the whole parse-time order the invariant rests on: seed → bootstrap →
   * markup.
   */
  const doc = buildSrcdoc('tok', 'BOOTSTRAP_MARKER', {
    networkGranted: false,
    libraries: [],
    selfOrigin: SELF,
    body: '<div id="x"></div>',
    context: { variables: { hp: 5 } },
  })

  const seed = doc.indexOf('__iris_context__')
  const bootstrap = doc.indexOf('BOOTSTRAP_MARKER')
  const markup = doc.indexOf('<div id="x"></div>')
  assert.ok(seed !== -1, 'the seed was not emitted')
  assert.ok(
    seed < bootstrap,
    `the seed (at ${String(seed)}) runs after the bootstrap (at ${String(bootstrap)}) —`
      + ' installSandbox reads it during the bootstrap, so a later seed is never read',
  )
  assert.ok(bootstrap < markup, 'the card markup must parse last')
})
test('the member table loads before the bootstrap, and blocking', () => {
  /*
   * **The ordering is the whole contract of the split.** A classic
   * `<script src>` with no `async`/`defer` finishes before the next script
   * element begins, so the bootstrap can check a marker rather than wait for
   * one — and an interface frame's inline markup, which parses after both, sees
   * a complete surface.
   *
   * Asserted by **position**, not by presence: a table emitted after the
   * bootstrap would still be in the document, still load, and still set its
   * marker — one tick too late, in every frame, every time. That failure has no
   * error in it; the frame simply refuses to run cards and blames a fetch.
   */
  const doc = buildSrcdoc('tok', 'BOOTSTRAP_MARKER', {
    networkGranted: false,
    libraries: ['https://example.test/preset.js'],
    selfOrigin: SELF,
    members: `${SELF}/sandbox/members-abc.js`,
  })

  const members = doc.indexOf('data-iris-members')
  const bootstrap = doc.indexOf('BOOTSTRAP_MARKER')
  const library = doc.indexOf('data-iris-lib')
  assert.ok(members !== -1, 'the member table was not emitted')
  assert.ok(members < bootstrap, 'the table must load before the bootstrap reads it')
  assert.ok(bootstrap < library, 'the bootstrap still comes before the card libraries')

  // Not deferred, or the ordering above is a claim about the document rather
  // than about when anything runs.
  const tag = doc.slice(doc.lastIndexOf('<script', members), doc.indexOf('>', members) + 1)
  assert.doesNotMatch(tag, /\basync\b/, tag)
  assert.doesNotMatch(tag, /\bdefer\b/, tag)
  // And carrying the attribute that keeps its exceptions readable, like the
  // libraries do — an opaque origin redacts a cross-origin throw without it.
  assert.match(tag, /crossorigin="anonymous"/, tag)
})

test('no member URL emits no tag at all, rather than an empty one', () => {
  // `<script src="">` re-requests the frame's own document, and the failure that
  // produces is nothing like the one it would be standing in for.
  const doc = buildSrcdoc('tok', 'x', { networkGranted: false, libraries: [], selfOrigin: SELF })
  assert.doesNotMatch(doc, /data-iris-members/)
  assert.doesNotMatch(doc, /<script src=""/)
})
test('the head links a stylesheet whose filename a card can recognise', () => {
  /*
   * **The substring is the assertion, because the substring is the mechanism.**
   *
   * A card cannot cheaply ask whether the icon rules are present, so upstream's
   * cards ask whether a stylesheet whose href contains `fontawesome` or
   * `font-awesome` has loaded, and inject a CDN link when none has. That
   * injection is refused here, so the card spends its recovery path on a wall
   * while the rules have been inlined since before it ran.
   *
   * Asserted on the href rather than on the constant so a rename that keeps the
   * path valid but drops the word — `sentinel.css`, say — fails here. The
   * filename participates in behaviour, and nothing else in the tree says so.
   */
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: [], selfOrigin: SELF })
  const link = /<link rel="stylesheet" href="([^"]+)">/.exec(doc)
  assert.ok(link, `no sentinel stylesheet in the head: ${doc.slice(0, 400)}`)
  assert.match(link[1] ?? '', /fontawesome|font-awesome/)
  assert.ok((link[1] ?? '').startsWith(SELF), 'the sentinel must come from our own origin')
})

test('a message frame gets the sentinel too, since its cards run the same guard', () => {
  const doc = buildSrcdoc('tok', '', {
    networkGranted: false,
    libraries: [],
    selfOrigin: SELF,
    body: '<body><i class="fa-solid fa-gear"></i></body>',
  })
  assert.match(doc, /<link rel="stylesheet" href="[^"]*fontawesome[^"]*">/)
})

test('the policy admits the sentinel, or linking it would be theatre', () => {
  /*
   * The pair that has to hold together: a `<link>` in the head and a
   * `style-src` that refuses it would produce the refusal report this whole
   * mechanism exists to prevent — and it would name *us* as the blocked host,
   * which reads as a bug in Iris rather than as a missing directive.
   */
  const policy = framePolicy(false, SELF)
  const styleSrc = policy.split('; ').find(part => part.startsWith('style-src '))
  assert.ok(styleSrc, policy)
  assert.ok(styleSrc.includes(SELF), `style-src must admit ${SELF}: ${styleSrc}`)

  // And under a network grant, where `https:` would cover a deployed origin but
  // not a dev one on http.
  const granted = framePolicy(true, SELF).split('; ').find(part => part.startsWith('style-src '))
  assert.ok(granted?.includes(SELF), granted)
})
test('the sentinel the head links is the one the build writes', () => {
  /*
   * **A cross-file pin, because the pair can only break silently.**
   *
   * `srcdoc.ts` links a literal path and `hash-sandbox-assets.mjs` writes a
   * literal filename; nothing in the type system connects them. Rename either
   * and every test here still passes — the head has a `<link>`, its href still
   * contains `fontawesome` — while the request 404s. A 404 is invisible to the
   * half of card guards that use `querySelector('link[href*=…]')` (the element
   * is there) and fatal to the half that read `document.styleSheets` (a sheet
   * that never loaded is not in there), so the symptom would be *some* cards
   * recovering onto a blocked CDN and others not, which is the hardest possible
   * shape to trace back to a filename.
   *
   * Read from source rather than from `public/sandbox/`: that directory is a
   * build output and git-ignored, so asserting on the file there would pass or
   * fail depending on whether someone had run the build, which is exactly the
   * kind of test that gets deleted for flapping.
   */
  const written = /const SENTINEL = '([^']+)'/.exec(
    readFileSync(new URL('../tools/hash-sandbox-assets.mjs', import.meta.url), 'utf8'),
  )
  assert.ok(written, 'the build no longer writes a named sentinel')
  assert.ok(
    FA_SENTINEL.endsWith(`/${written[1] ?? ''}`),
    `srcdoc links ${FA_SENTINEL} but the build writes ${String(written[1])}`,
  )
  // And the name still carries what a card's guard looks for. Both halves have
  // to hold: agreeing on a name with no `fontawesome` in it agrees on nothing.
  assert.match(FA_SENTINEL, /fontawesome|font-awesome/)
})
test('both frame kinds give a nested-frame stand-in an iframe’s default size', () => {
  /*
   * A `<div>` stand-in has no intrinsic size where an `<iframe>` has 300×150.
   * Measured in a laid-out page: the stand-in came out **600×0** — full
   * container width, zero height — so a card that sizes its frame only from a
   * stylesheet, or not at all, had nothing to look at.
   *
   * **A rule, not inline styles**, because inline would beat the card's own
   * sheet and break every card that does size its frame. Also measured: with
   * this rule first and a card's sheet after, a card's `#id` rule wins outright
   * and its `.class` rule wins on order.
   *
   * Both frame kinds, because a card can build a nested frame from either an
   * interface body or a script — and the two resets are separate strings, which
   * is exactly how one of them would come to lack it.
   */
  for (const body of [undefined, '<body>an interface</body>']) {
    const doc = buildSrcdoc('tok', '', {
      networkGranted: false,
      libraries: [],
      selfOrigin: SELF,
      ...(body === undefined ? {} : { body }),
    })
    assert.match(
      doc,
      /\[data-iris-nested-frame\]\{display:block;width:300px;height:150px\}/,
      `the ${body === undefined ? 'script' : 'interface'} frame's reset has no stand-in size`,
    )
  }
})

test('a card’s font stylesheet loads without blocking anything', () => {
  /*
   * A pending stylesheet blocks the execution of every classic script parsed
   * after it and holds the `load` event. The one origin this frame admits by
   * default is fonts.googleapis.com — admitted *because* it executes nothing —
   * and the measured card defeated that premise with it: its title screen
   * linked Google Fonts, and on a network where the fetch hung, the interface
   * rendered, the button drew, and clicking it did nothing, because the
   * `<script>` defining the button's handler was still waiting for a font.
   *
   * The swap is upstream's own load pattern: `media="print"` downloads the
   * sheet without matching the screen (joining neither the render-blocking nor
   * the script-blocking set), and `onload` applies it on arrival. The download
   * and the rendering still happen — only the waiting is gone.
   */
  const body =
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Orbitron&display=swap" rel="stylesheet">'
    + '<button onclick="go()">SYSTEM_START</button><script>function go() {}</script>'
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: [], selfOrigin: SELF, body })

  const link = /<link[^>]*Orbitron[^>]*>/.exec(doc)?.[0]
  assert.ok(link, 'the font link was dropped outright')
  assert.match(link ?? '', /media="print"/, 'the font stylesheet still blocks the frame')
  assert.match(link ?? '', /onload="this\.media='all'"/, 'the font stylesheet would never apply')
  // The preconnect links name a font host too, but connect nothing: leave them.
  assert.doesNotMatch(doc, /preconnect[^>]*media=/, 'the transform reached a link it must not')
})

test('a font stylesheet the author already scoped is left as written', () => {
  // `media` present means the author already decided when it applies; adding a
  // second opinion would be exactly the quieter, second decision this file
  // exists to prevent.
  const body = '<link href="https://fonts.googleapis.com/css2?family=Noto" rel="stylesheet" media="screen and (min-width: 400px)">'
  assert.equal(unblockFontStylesheets(body), body)
})

test('a stylesheet that is not the default-admitted font origin is untouched', () => {
  /*
   * The scope is the CSP's own premise. A stylesheet the policy refuses fails
   * fast and blocks nothing; one a network grant admitted is the user's
   * decision and keeps upstream's semantics; the same-origin sentinel is
   * deterministic. Only the origin admitted *because it executes nothing*
   * gets the non-blocking load.
   */
  const body =
    `<link rel="stylesheet" href="${SELF}/sandbox/fontawesome.min.css">`
    + '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css">'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">'
  const out = unblockFontStylesheets(body)

  assert.ok(out.includes(`${SELF}/sandbox/fontawesome.min.css">`), 'the sentinel was rewritten')
  assert.ok(out.includes('remixicon.css">'), 'a refused stylesheet was rewritten')
  assert.match(out, /Inter[^>]*media="print"/, 'the font origin was not unblocked')
})

test('the unblocking is applied where the markup enters the document', () => {
  // Asserted through `buildSrcdoc`, so the transform cannot drift away from the
  // assembly the way a helper nobody calls would.
  const doc = buildSrcdoc('tok', '', {
    networkGranted: false,
    libraries: [],
    selfOrigin: SELF,
    body: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
  })
  assert.match(doc, /Inter[^>]*media="print"/)
})
