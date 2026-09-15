import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  dropPluginCopy,
  getPluginCopy,
  pluginRuntimeKey,
  setPluginCopy,
  subscribePluginCopy,
  syncPluginCopy,
  translatePlugin,
} from '../src/app/i18n/plugin-copy.ts'
import { getLanguage, setLanguage } from '../src/app/i18n/language.ts'
import { en, translate } from '../src/app/i18n/strings.ts'

/**
 * The runtime overlay of plugins' bundled copy. The two teeth the task sheet
 * names are the first two tests: the overlay must not leak into the shell's
 * static namespace (T5), and a language switch must move the plugin copy
 * (T6). The rest pin the lifetime rules — drop on manifest absence, rev
 * dedup, all-or-nothing per plugin — because "copy goes away" is the half of
 * this feature an implementation quietly forgets.
 */

test('a plugin copy cannot reach the shell dictionary, and the shell cannot be reached by one (U5 T5)', () => {
  // A plugin declares `send` — a real shell key — under its own tables. The
  // static lookup must keep answering with the shell's sentence; the same
  // key must stay reachable under the runtime namespace.
  setPluginCopy('demo', {
    en: { send: 'Hijacked' },
    zh: { send: '劫持' },
  })
  try {
    assert.equal(translate('en', 'send'), en.send)
    assert.notEqual(en.send, 'Hijacked')
    assert.equal(translatePlugin('en', 'demo', 'send'), 'Hijacked', 'the same key is reachable namespaced')
  } finally {
    dropPluginCopy('demo')
  }
})

test('a language switch moves the plugin copy, and the runtime key reads through translate (U5 T6)', () => {
  setPluginCopy('demo', {
    en: { panelTitle: 'Panel {name}' },
    zh: { panelTitle: '面板 {name}' },
  })
  try {
    assert.equal(translatePlugin('en', 'demo', 'panelTitle', { name: 'X' }), 'Panel X')
    setLanguage('zh')
    assert.equal(translatePlugin(getLanguage(), 'demo', 'panelTitle', { name: 'X' }), '面板 X')
    assert.equal(translate('zh', pluginRuntimeKey('demo', 'panelTitle'), { name: 'X' }), '面板 X')
  } finally {
    setLanguage('en')
    dropPluginCopy('demo')
  }
})

test('the fallback chain is zh column, en column, then the key itself', () => {
  setPluginCopy('demo', { en: { only: 'English only' }, zh: { hello: '你好' } })
  try {
    assert.equal(translatePlugin('zh', 'demo', 'hello'), '你好', 'the requested language wins')
    assert.equal(translatePlugin('zh', 'demo', 'only'), 'English only', 'the en column backs the zh one up')
    assert.equal(translatePlugin('zh', 'demo', 'gone'), 'plugin:demo:gone', 'absent copy shows the key, never blank')
  } finally {
    dropPluginCopy('demo')
  }
})

test('set and drop notify subscribers, and drop really removes', () => {
  let notified = 0
  const dispose = subscribePluginCopy(() => {
    notified += 1
  })
  setPluginCopy('demo', { en: { a: 'a' }, zh: { a: '甲' } })
  assert.equal(getPluginCopy('demo')?.en.a, 'a')
  dropPluginCopy('demo')
  assert.equal(getPluginCopy('demo'), undefined, 'after a drop the plugin contributes nothing')
  assert.equal(notified, 2, 'both writes told every subscriber')
  dispose()
})

test('syncPluginCopy loads rows, dedups by rev, and drops ids the manifest stopped carrying', async () => {
  const realFetch = globalThis.fetch
  const realWarn = console.warn
  const fetched: string[] = []
  const table = (lang: string): string => JSON.stringify({ panelTitle: lang === 'en' ? 'Panel' : '面板' })
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url))
    const lang = String(url).includes('/en.') ? 'en' : 'zh'
    return { ok: true, text: async () => table(lang) }
  }) as typeof fetch

  try {
    const manifest = {
      plugins: {
        demo: {
          rev: 'a'.repeat(12),
          client: '/plugins/demo/client.js?rev=' + 'a'.repeat(12),
          i18n: {
            en: '/plugins/demo/i18n/en.json?rev=' + 'b'.repeat(12),
            zh: '/plugins/demo/i18n/zh.json?rev=' + 'c'.repeat(12),
          },
        },
      },
    }
    await syncPluginCopy(manifest)
    assert.equal(getPluginCopy('demo')?.zh.panelTitle, '面板')

    const afterFirst = fetched.length
    await syncPluginCopy(manifest)
    assert.equal(fetched.length, afterFirst, 'an unchanged rev is never re-fetched')

    // A manifest that stops carrying the id removes the copy — disabling is
    // the same shape, since a disabled plugin has no row at all.
    await syncPluginCopy({ plugins: {} })
    assert.equal(getPluginCopy('demo'), undefined)

    // Re-appearing fetches again (the drop forgets the rev with the table).
    await syncPluginCopy(manifest)
    assert.ok(fetched.length > afterFirst)
  } finally {
    globalThis.fetch = realFetch
    console.warn = realWarn
    dropPluginCopy('demo')
  }
})

test('a broken copy table drops the whole plugin, and the rest of the overlay stands', async () => {
  const realFetch = globalThis.fetch
  const realWarn = console.warn
  const warnings: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlText = String(url)
    if (urlText.includes('/bad/')) {
      return { ok: false, status: 500, text: async () => '' }
    }
    return { ok: true, text: async () => JSON.stringify({ panelTitle: 'Panel' }) }
  }) as typeof fetch
  console.warn = (message?: unknown) => {
    warnings.push(String(message))
  }

  try {
    setPluginCopy('keeper', { en: { a: 'a' }, zh: { a: '甲' } })
    await syncPluginCopy({
      plugins: {
        keeper: { rev: 'a'.repeat(12), i18n: { en: '/plugins/keeper/i18n/en.json?rev=' + 'b'.repeat(12), zh: '/plugins/keeper/i18n/zh.json?rev=' + 'c'.repeat(12) } },
        bad: { rev: 'd'.repeat(12), i18n: { en: '/plugins/bad/i18n/en.json?rev=' + 'e'.repeat(12), zh: '/plugins/bad/i18n/zh.json?rev=' + 'f'.repeat(12) } },
      },
    })
    assert.equal(getPluginCopy('keeper')?.en.panelTitle, 'Panel', 'one plugin’s broken copy does not disturb the others')
    assert.equal(getPluginCopy('bad'), undefined, 'a half-fetched plugin is dropped whole')
    assert.ok(warnings.some(message => message.includes('bad/en')), 'the console names the plugin and language')
  } finally {
    globalThis.fetch = realFetch
    console.warn = realWarn
    dropPluginCopy('keeper')
    dropPluginCopy('bad')
  }
})
