import assert from 'node:assert/strict'
import { test } from 'node:test'

import { requestSchemas } from '../src/index.ts'

/**
 * The `sandboxPlugin.*` family, held to its properties rather than to its size.
 *
 * `rpc.ts` used to say "three methods" in the comment over this family.
 * `sandboxPlugin.source` made it four (`docs/SANDBOX-PLUGINS.md` §15, PR-D),
 * and the fix is not a different number — it is not having one. A count written
 * in prose beside the table it describes is a reading that goes stale in
 * silence, which `method-names.test.ts` is the standing record of: a survey
 * counted this same table with a pattern that dropped the deeper names, and the
 * total it published read as complete.
 *
 * So: the size is **reported at run time** in a diagnostic, and what is asserted
 * is what a reader actually depends on.
 *
 * - **The family is in the static table.** That is the claim the comment makes —
 *   none of these arrives through `scope.registerRpc` — and the only way to
 *   check it here is that the family is non-empty in `requestSchemas`, which
 *   also stops every loop below from passing by never running.
 * - **Every one of them is scoped to a conversation.** A sandbox plugin belongs
 *   to a chat the way its messages do, and a plugin id is minted per
 *   conversation, so a method in this family that did not take a required
 *   `chatId` would be one that answers about a plugin without knowing whose it
 *   is. That is the shape of the id-scoping failure `sandboxPlugin.source` is
 *   tested against on the host, and this is the half of it the protocol can
 *   hold.
 */

/** A zod object with its per-field schemas reachable. */
interface ShapedSchema {
  shape?: Record<string, { safeParse: (value: unknown) => { success: boolean } } | undefined>
}

test('every sandbox-plugin method is in the static table and scoped to one conversation', t => {
  const names = Object.keys(requestSchemas).filter(name => name.startsWith('sandboxPlugin.'))

  /*
   * A floor, not the number. Without it, an empty family passes the loop below
   * by never entering it — the failure this repo has met before, where a check
   * skipped its own sample and stayed green.
   */
  assert.ok(names.length > 0, 'no `sandboxPlugin.*` method is in the static request table at all')

  // Evidence about this commit, reported rather than asserted: it moves every
  // time the family gains a method, and a test that fails on a correct change
  // gets its number bumped without being read.
  t.diagnostic(`${String(names.length)} static sandboxPlugin methods: ${names.join(', ')}`)

  for (const name of names) {
    const shape = (requestSchemas[name as keyof typeof requestSchemas] as unknown as ShapedSchema).shape
    assert.ok(shape !== undefined, `${name}'s schema is not an object schema`)
    const chatId = shape['chatId']
    assert.ok(chatId !== undefined, `${name} takes no chatId, so it cannot know which conversation it is about`)
    /*
     * Required, not merely present. An optional `chatId` would let a caller
     * omit it and leave the handler to pick a conversation, which is the
     * scoping failure written as a default rather than as a missing field.
     */
    assert.equal(
      chatId.safeParse(undefined).success,
      false,
      `${name}'s chatId is optional, so a call can be made without naming the conversation`,
    )
  }
})
