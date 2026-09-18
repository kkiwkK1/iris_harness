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
