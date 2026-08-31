/**
 * Proof that the interface actually renders.
 *
 * `tsc` proves the types and `vite build` proves the imports resolve; neither
 * proves that mounting the tree does not throw, or that a streaming turn puts
 * text on the page. Node cannot run `.tsx` (its type stripping erases types, it
 * does not transform JSX), so this is bundled by `tools/render-check.mjs` and
 * rendered with `react-dom/server`.
 *
 * What it is NOT: a substitute for looking at the page. Layout, colour and
 * motion are invisible to a server render. It catches the class of failure that
 * makes the page blank.
 *
 * @module iris-web/tools/render-check
 */

import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { createFakeClient } from '@iris/client-fake'

import { App } from '../src/app/App.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore, type IrisStore } from '../src/client/store.ts'
import { SlotProvider } from '../src/slots/Slot.tsx'
import { createIrisSlots, type IrisSlotName } from '../src/slots/slots.ts'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the whole tree to HTML.
 *
 * zustand's server snapshot is the store's INITIAL state, so without the
 * override below a server render would only ever show the pre-boot empty shell.
 * That is a harness concession — nothing in the app depends on it.
 * @param store - the booted store.
 * @param core - the slot registry.
 * @returns the rendered markup.
 */
function render(store: IrisStore, core: SlotCore): string {
  const api = store as unknown as { getInitialState: () => unknown }
  api.getInitialState = () => store.getState()
  return renderToString(
    <SlotProvider core={core}>
      <StoreProvider store={store}>
        <App />
      </StoreProvider>
    </SlotProvider>,
  )
}

/** Wait for the fake's next frame of a given type. */
function nextFrame(store: IrisStore, predicate: () => boolean): Promise<void> {
  return new Promise(resolve => {
    if (predicate()) {
      resolve()
      return
    }
    const off = store.subscribe(() => {
      if (!predicate()) return
      off()
      resolve()
    })
  })
}

async function main(): Promise<void> {
  const client = createFakeClient({ chunkDelayMs: 4, chunkCount: 6 })
  const slots = createIrisSlots()
  const wired = createIrisStore(client)
  await wired.store.getState().boot()

  // ---------------------------------------------------------------- settled
  const settled = render(wired.store, slots.core)
  assert.match(settled, /class="iris-shell"/, 'the shell did not render')
  assert.match(settled, /雨夜的第三次点数/, 'the open conversation title is missing')
  assert.match(settled, /MarkdownText_markdown/, 'assistant prose did not go through the Markdown renderer')
  assert.match(settled, /aria-label="2 readings of this reply"/, 'the variant rail is missing')
  assert.match(settled, /aria-label="Reading 2 of 2"/, 'the rail is missing a tick')
  assert.match(settled, /iris-composer__field/, 'the composer is missing')
  assert.match(settled, /value="openai-compat"/, 'settings fields did not populate')
  // Only the last reply offers a retry; more than one would mean discarding
  // history the protocol has no operation for.
  assert.equal(settled.match(/>Regenerate</g)?.length, 1, 'exactly one Regenerate expected')

  // -------------------------------------------------------------- streaming
  await wired.store.getState().send('那你说，我该怎么办。')
  await nextFrame(wired.store, () => (wired.store.getState().stream?.text.length ?? 0) > 0)

  const streaming = render(wired.store, slots.core)
  assert.match(streaming, /iris-caret/, 'the streaming caret is missing')
  assert.match(streaming, /那你说，我该怎么办。/, 'the sent message is not on the page')
  const buffered = wired.store.getState().stream?.text ?? ''
  assert.ok(buffered.length > 0, 'nothing was buffered')
  // The reply being written has to be visible, which is the whole point of
  // synthesizing a message for a turn the settled view does not carry yet.
  assert.ok(
    streaming.includes(buffered.slice(0, 12).replace(/[&<>"]/g, '')) || buffered.length < 12,
    'buffered text did not reach the page',
  )

  await nextFrame(wired.store, () => wired.store.getState().stream === undefined)

  // ------------------------------------------------------------- regenerate
  await wired.store.getState().regenerate()
  await nextFrame(wired.store, () => wired.store.getState().stream === undefined)
  const regenerated = render(wired.store, slots.core)
  assert.match(regenerated, /aria-label="Reading 2 of 2"/, 'regenerate did not add a reading')

  // ------------------------------------------------------------------ slots
  const registered = slots.core.register(
    { name: 'iris.message.actions' satisfies IrisSlotName, id: 'probe', registrant: 'render-check' },
    () => 'PROBE',
  )
  assert.match(render(wired.store, slots.core), /PROBE/, 'a slot contribution did not render')
  registered()
  assert.doesNotMatch(
    render(wired.store, slots.core),
    /PROBE/,
    'a disposed slot contribution still rendered — reversibility is broken',
  )

  wired.dispose()
  slots.dispose()
  console.log('render check: ok')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
