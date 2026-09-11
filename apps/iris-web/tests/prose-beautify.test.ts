/**
 * The prose beautify: the switch, the dialogue classifier, and the borders it
 * must not cross.
 *
 * Three kinds of pin, because the feature has three kinds of promise:
 *
 * - **behaviour pins** — the store's default, its tolerance of a hostile
 *   store, the dialogue heuristic's rulings, and the tagger's minimal DOM
 *   contract (held with stubs, because the contract really is two methods);
 * - **decoupling pins read off the sources** — the beautify sits *outside*
 *   the claim pipeline: `prose-beautify.ts` imports nothing from the sandbox,
 *   and `MessageInterfaces.tsx` (the claim seam) imports nothing from the
 *   beautify. Either direction welding shut is the regression that would put
 *   display code back inside the offset math, which is exactly where this
 *   feature promised it would never live;
 * - **discipline pins read off the stylesheet** — every beautify rule gates
 *   on the root attribute, scopes to assistant rows, and paints with
 *   `--iris-*` tokens defined in `tokens.css`; no hex, no rgb, no second
 *   palette.
 *
 * @module iris-web/tests/prose-beautify
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  DIALOGUE_ATTR,
  getProseBeautify,
  isDialogueParagraph,
  loadProseBeautify,
  PROSE_BEAUTIFY_ATTR,
  setProseBeautify,
  subscribeProseBeautify,
  tagDialogueParagraphs,
  untagDialogueParagraphs,
} from '../src/app/prose-beautify.ts'
import { en, zh } from '../src/app/i18n/strings.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** The store module's source, for the decoupling pins. */
const BEAUTIFY_TS = readFileSync(join(here, '..', 'src', 'app', 'prose-beautify.ts'), 'utf8')
/** The claim seam's source, for the decoupling pins from the other side. */
const INTERFACES_TSX = readFileSync(join(here, '..', 'src', 'app', 'MessageInterfaces.tsx'), 'utf8')
/** The row's source, where the tagger is wired. */
const MESSAGE_TSX = readFileSync(join(here, '..', 'src', 'app', 'Message.tsx'), 'utf8')
const READING_CSS = readFileSync(join(here, '..', 'src', 'app', 'reading.css'), 'utf8')
const TOKENS_CSS = readFileSync(join(here, '..', 'src', 'theme', 'tokens.css'), 'utf8')
const DRAWER_TSX = readFileSync(join(here, '..', 'src', 'app', 'SettingsDrawer.tsx'), 'utf8')

/** Install a private in-memory `localStorage` as `window.localStorage`. */
function withStorage(run: () => void): void {
  const backing = new Map<string, string>()
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value)
      },
    },
  }
  try {
    run()
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
}

/* ------------------------------------------------------------------ store */

test('the beautify is on until a reader turns it off — the documented default', () => {
  withStorage(() => {
    assert.equal(loadProseBeautify(), true)
    assert.equal(getProseBeautify(), true)
  })
})

test('a stored choice survives the reload, and a foreign value reads as the default', () => {
  withStorage(() => {
    setProseBeautify(false)
    // The reload half: a fresh read of the same store.
    assert.equal(loadProseBeautify(), false)
    setProseBeautify(true)
    assert.equal(loadProseBeautify(), true)

    // Anything this module never wrote — an older build, a typo, another
    // app's key — is "no opinion", and the default answers.
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    store.setItem('iris.proseBeautify', 'yes')
    assert.equal(loadProseBeautify(), true)
    store.setItem('iris.proseBeautify', '0')
    assert.equal(loadProseBeautify(), true)
  })
})

test('a store that throws on access is an absent value, not a fault', () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('private mode')
      },
    },
  }
  try {
    assert.equal(loadProseBeautify(), true)
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
})

test('setting the switch notifies subscribers, persists, and paints the root attribute', () => {
  withStorage(() => {
    const painted: string[] = []
    ;(globalThis as unknown as { document: unknown }).document = {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          painted.push(`${name}=${value}`)
        },
      },
    }
    try {
      let told = 0
      const dispose = subscribeProseBeautify(() => {
        told += 1
      })

      assert.equal(getProseBeautify(), true)
      setProseBeautify(false)
      assert.equal(getProseBeautify(), false)
      assert.equal(told, 1)
      assert.equal(loadProseBeautify(), false)
      assert.deepEqual(painted, [`${PROSE_BEAUTIFY_ATTR}=off`])

      setProseBeautify(false)
      assert.equal(told, 1, 'a no-op switch tells nobody and writes nothing')

      setProseBeautify(true)
      assert.deepEqual(painted, [`${PROSE_BEAUTIFY_ATTR}=off`, `${PROSE_BEAUTIFY_ATTR}=on`])
      dispose()
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document
    }
  })
})

/* -------------------------------------------------------------- dialogue */

test('a paragraph opening on a quote is dialogue — the CJK and curly families', () => {
  assert.equal(isDialogueParagraph('「你来了。」她没有回头。'), true)
  assert.equal(isDialogueParagraph('『……』'), true)
  assert.equal(isDialogueParagraph('“Stay back,” she said.'), true)
  assert.equal(isDialogueParagraph('"Stay back," he said.'), true)
})

test('a short speaker lead-in ending in a colon is dialogue', () => {
  assert.equal(isDialogueParagraph('艾拉：「茶好了。」'), true)
  assert.equal(isDialogueParagraph('艾拉: "tea is ready."'), true)
  // Twelve characters before the colon — a narrated speech, still a speech.
  assert.equal(isDialogueParagraph('她沉默了很久，才终于开口：「……」'), true)
})

test('exactly at the lead-in cap it is dialogue; one past the cap it is narration', () => {
  const sixteen = '一二三四五六七八九十一二三四五六'
  assert.equal(sixteen.length, 16)
  assert.equal(isDialogueParagraph(`${sixteen}：「茶。」`), true)
  assert.equal(isDialogueParagraph(`一${sixteen}：「茶。」`), false)
})

test('a quotation mark inside the paragraph names no speaker', () => {
  assert.equal(isDialogueParagraph('他想起了「旧日」的约定。'), false)
  assert.equal(isDialogueParagraph('她推开门，走了进去。'), false)
})

test('emptiness is not dialogue, and a list-lead paragraph is left unclassified', () => {
  assert.equal(isDialogueParagraph(''), false)
  assert.equal(isDialogueParagraph('   '), false)
  // Known v1 limitation, pinned: a list item whose text opens on a quote is
  // not tagged. The heuristic reads the paragraph's head, and a bullet is a
  // different kind of head.
  assert.equal(isDialogueParagraph('- 「第一件事。」'), false)
})

test('a blockquote paragraph\u2019s markdown marker is stripped before the ruling', () => {
  assert.equal(isDialogueParagraph('> 「引文行。」'), true)
})

/* ------------------------------------------------------- tagging (stubs) */

/** A paragraph stub: text in, attribute calls out — the tagger's whole contract. */
class FakeParagraph {
  readonly calls: string[] = []
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
  setAttribute(name: string, value: string): void {
    this.calls.push(`set ${name}=${value}`)
  }
  removeAttribute(name: string): void {
    this.calls.push(`remove ${name}`)
  }
  get textContent(): string {
    return this.text
  }
  querySelectorAll(): FakeParagraph[] {
    return []
  }
}

test('the tagger marks dialogue paragraphs and clears the rest, in one pass', () => {
  const dialogue = new FakeParagraph('「你来了。」她没有回头。')
  const narration = new FakeParagraph('她推开门，走了进去。')
  const shell = {
    querySelectorAll: (selector: string) => (selector === 'p' ? [dialogue, narration] : []),
  }
  const container = {
    querySelectorAll: (selector: string) =>
      selector.startsWith(':scope') ? [shell] : [],
  }
  tagDialogueParagraphs(container as unknown as Element)
  assert.deepEqual(dialogue.calls, [`set ${DIALOGUE_ATTR}=on`])
  assert.deepEqual(narration.calls, [`remove ${DIALOGUE_ATTR}`])
})

test('untagging removes the attribute everywhere the tagger could have put it', () => {
  const dialogue = new FakeParagraph('艾拉：「茶好了。」')
  const shell = { querySelectorAll: (selector: string) => (selector === 'p' ? [dialogue] : []) }
  const container = { querySelectorAll: (selector: string) => (selector.startsWith(':scope') ? [shell] : []) }
  untagDialogueParagraphs(container as unknown as Element)
  assert.deepEqual(dialogue.calls, [`remove ${DIALOGUE_ATTR}`])
})

/* ------------------------------------------------- decoupling (sources) */

test('the beautify module imports nothing from the sandbox or the claim pipeline', () => {
  // The code, not the prose — the module's header comment is allowed to name
  // the pipeline it stays out of; its imports are not.
  const code = BEAUTIFY_TS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!code.includes("from '../sandbox/"), 'the beautify must not import the sandbox')
  assert.ok(!code.includes('claimMessageSurfaces'), 'the beautify must not name the claim')
  assert.ok(!code.includes('frontend-blocks'), 'the beautify must not reach the block pipeline')
})

test('the claim seam never imports the beautify — the dependency points one way', () => {
  assert.ok(
    !INTERFACES_TSX.includes('prose-beautify'),
    'MessageInterfaces renders prose; the tagger attaches in Message, after the splice',
  )
})

test('the row wires the tagger and both of its directions', () => {
  assert.ok(MESSAGE_TSX.includes("from './prose-beautify.ts'"))
  assert.ok(MESSAGE_TSX.includes('tagDialogueParagraphs('), 'the on path exists')
  assert.ok(MESSAGE_TSX.includes('untagDialogueParagraphs('), 'the off path exists')
  assert.ok(MESSAGE_TSX.includes("message.role !== 'assistant'"), 'the row scope is named where it is decided')
})

/* --------------------------------------------------- discipline (styles) */

/**
 * Every rule in `reading.css` that belongs to the beautify, as selector +
 * body pairs. Found by the gate attribute — the one word every rule starts
 * from, and the thing that makes the switch a switch.
 */
function beautifyRules(): { selector: string, body: string }[] {
  const rules: { selector: string, body: string }[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of READING_CSS.matchAll(pattern)) {
    const selector = match[1]
    const body = match[2]
    if (selector === undefined || body === undefined) continue
    if (selector.includes(`[${PROSE_BEAUTIFY_ATTR}`)) {
      rules.push({ selector, body })
    }
  }
  return rules
}

test('every beautify rule gates on the root attribute and scopes to assistant rows', () => {
  const rules = beautifyRules()
  assert.ok(rules.length >= 2, 'the indent rule and the dialogue rule are both here')
  for (const rule of rules) {
    assert.ok(rule.selector.includes('.iris-msg--assistant'), rule.selector)
    assert.ok(rule.selector.includes('.iris-msg__text'), rule.selector)
    assert.ok(rule.selector.includes(":not([class*='iris-'])"), `the shell rule, in: ${rule.selector}`)
  }
})

test('the beautify paints with tokens only — no hex, no rgb, and every token defined', () => {
  for (const rule of beautifyRules()) {
    const body = rule.body
    assert.ok(!body.includes('#'), `no hex in: ${body}`)
    assert.ok(!body.toLowerCase().includes('rgb'), `no rgb in: ${body}`)
    for (const token of body.matchAll(/var\((--iris-[a-z-]+)/g)) {
      const name = token[1]
      assert.ok(name !== undefined, 'the token capture group is part of this test\u2019s own pattern')
      assert.ok(TOKENS_CSS.includes(`${name}:`), `${name} must be defined in tokens.css`)
    }
  }
})

test('the beautify\u2019s two rhythm tokens live in the theme-independent typography block', () => {
  const firstThemeBlock = TOKENS_CSS.indexOf('[data-iris-theme')
  assert.ok(firstThemeBlock > 0, 'tokens.css carries theme blocks after the typography root')
  for (const name of ['--iris-prose-indent', '--iris-prose-para']) {
    const at = TOKENS_CSS.indexOf(`${name}:`)
    assert.ok(at > 0, `${name} exists`)
    assert.ok(at < firstThemeBlock, `${name} is theme-independent structure, not palette`)
  }
})

/* ------------------------------------------------------- switch surface */

test('the reading card offers the switch, and both dictionaries carry its words', () => {
  assert.ok(DRAWER_TSX.includes("t('proseBeautify')"))
  assert.ok(DRAWER_TSX.includes("t('proseBeautifyNote')"))
  assert.equal(typeof en.proseBeautify, 'string')
  assert.equal(typeof zh.proseBeautify, 'string')
  assert.ok(en.proseBeautify.length > 0 && zh.proseBeautify.length > 0)
})
