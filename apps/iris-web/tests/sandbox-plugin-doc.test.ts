import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { test } from 'node:test'

/**
 * The document the model reads, held against the surface it describes.
 *
 * `docs/SANDBOX-PLUGIN-AUTHORING.md` is not prose about the facade — it is the
 * **input to every 「create」 request**, and a model writes against whatever it
 * says. So two properties matter and neither is rhetorical:
 *
 * - **it is the same signature.** The seam this closes is the one this project
 *   has paid for before: two documents each correct on its own and inconsistent
 *   together. Here the cost is direct — a facade described with a parameter that
 *   does not exist produces code that compiles and throws on the first call, and
 *   the player sees `mount-failed` for a fault in a document.
 * - **its length is a price.** It rides out on every request, so 8 KiB is a
 *   ceiling and not a style note.
 *
 * The comparison strips comments deliberately: the doc explains the three
 * capabilities in prose around the block, and repeating the source's JSDoc
 * inside a fenced block would make the document longer for the model with
 * nothing added. What must match is the **declaration**.
 */

const DOC = new URL('../../../docs/SANDBOX-PLUGIN-AUTHORING.md', import.meta.url)
const TREE = new URL('../src/sandbox/plugin-tree.ts', import.meta.url)

/** How many bytes the document may cost per request (`docs/SANDBOX-PLUGINS.md` §11.2). */
const DOC_CEILING = 8 * 1024

/**
 * A declaration with its comments and blank lines taken out.
 *
 * Whitespace inside a line is kept, so indentation is part of the comparison —
 * a reader of either file sees the same shape, and a doc block that had been
 * reflowed would be reporting a signature nobody wrote.
 * @param text - the declaration's source.
 * @returns the stripped lines, joined.
 */
function declarationOnly(text: string): string {
  const lines: string[] = []
  let inBlock = false
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/\s+$/u, '')
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.endsWith('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//')) continue
    if (trimmed === '') continue
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Cut one brace-balanced declaration out of a file.
 * @param source - the file's text.
 * @param opener - the line the declaration starts with.
 * @returns the declaration, from `opener` to its closing brace.
 */
function declaration(source: string, opener: string): string {
  const at = source.indexOf(opener)
  assert.notEqual(at, -1, `"${opener}" is not in the file any more`)
  let depth = 0
  for (let index = at; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, index + 1)
    }
  }
  assert.fail(`"${opener}" is not brace-balanced`)
}

test('the author document describes the facade the frame actually hands over', async () => {
  const doc = await readFile(DOC, 'utf8')
  const tree = await readFile(TREE, 'utf8')

  const fromCode = declarationOnly(declaration(tree, 'export interface SandboxPluginFacade {'))
    // The doc is written for a reader who is not inside this package, so it
    // drops the keyword that only means something to one — and nothing else.
    .replace(/^export /u, '')

  const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/gu)].map(match => match[1] ?? '')
  const inDoc = blocks.map(block => declarationOnly(block))
    .find(block => block.startsWith('interface SandboxPluginFacade {'))
  assert.ok(inDoc !== undefined, 'the document carries no `interface SandboxPluginFacade` block')

  /*
   * Line for line. The tooth is to change one parameter name in the document —
   * `insert: (css: string)` to `insert: (sheet: string)` — which fails here and
   * nowhere else, because nothing at runtime reads the document.
   */
  assert.equal(inDoc, fromCode)
})

/**
 * One directive's value in a generated policy.
 * @param policy - the policy string.
 * @param name - the directive.
 * @returns its value, or undefined when the policy does not carry it.
 */
function directiveValue(policy: string, name: string): string | undefined {
  for (const part of policy.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name} `)) return trimmed.slice(name.length + 1)
  }
  return undefined
}

test('the author document states both network branches, as framePolicy builds them', async () => {
  /*
   * **The model is told what the frame will actually do, in both branches.**
   * The sentence this replaced said the network was "never open", and it was
   * false for every card the player had allowed online: the grant widens the
   * card frame's policy, and sandbox plugins mount in that frame (owner ruling
   * 2, 2026-09-25 — the grant reaches them, deliberately).
   *
   * Bound to the generated policy rather than restating it, in the same way
   * `GRANT_WIDENED_DIRECTIVES` is bound in `sandbox-policy.test.ts`: every row
   * of the document's table is looked up in `framePolicy(false)` and
   * `framePolicy(true)` and must say exactly what they say. The tooth is to
   * write `'none'` in the "allowed online" column of `connect-src` — the old
   * sentence's claim — which fails here and nowhere else, since nothing at
   * runtime reads the document.
   */
  const doc = await readFile(DOC, 'utf8')
  const { framePolicy } = await import('../src/sandbox/srcdoc.ts')
  const { GRANT_WIDENED_DIRECTIVES } = await import('../src/sandbox/policy.ts')
  const origin = 'http://127.0.0.1:8796'
  const off = framePolicy(false, origin)
  const on = framePolicy(true, origin)

  const rows = [...doc.matchAll(/^\s*\| `([a-z-]+)` \| `([^`]*)` \| `([^`]*)` \|\s*$/gmu)]
  const compared: string[] = []
  for (const [, name = '', offline, online] of rows) {
    assert.equal(offline, directiveValue(off, name), `the document's offline ${name} is not the policy's`)
    assert.equal(online, directiveValue(on, name), `the document's online ${name} is not the policy's`)
    // A row whose two columns agree is not describing a grant at all, and a
    // directive the grant does not widen has no business in this table.
    assert.ok(GRANT_WIDENED_DIRECTIVES.includes(name), `${name} is in the table but the grant does not widen it`)
    compared.push(name)
  }
  /*
   * The two directives that are the network — requests and image loads — are
   * the floor. `style-src` is widened too but carries Iris's own origin, which
   * differs per install and is not something the model can act on; the prose
   * does not claim it is closed, which is the property that matters.
   */
  assert.ok(compared.includes('connect-src'), 'the table no longer states what connect-src does')
  assert.ok(compared.includes('img-src'), 'the table no longer states what img-src does')
  assert.ok(compared.length >= 2, `compared ${String(compared.length)} rows, fewer than the two that are the network`)
  assert.doesNotMatch(doc, /never open/u, 'the document still claims the network was never open')
})

test('the author document stays inside the budget it is sent on', async () => {
  const bytes = (await stat(DOC)).size
  assert.ok(
    bytes <= DOC_CEILING,
    `the author document is ${String(bytes)} bytes, over the ${String(DOC_CEILING)} it may cost per request`,
  )
  // And it is not empty, which a broken path would also produce — the ceiling
  // alone passes on a file that says nothing.
  assert.ok(bytes > 1024, `the author document is ${String(bytes)} bytes, which is too short to be it`)
})
