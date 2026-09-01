/**
 * SillyTavern's `getStringHash` (cyrb53), reproduced bit for bit.
 *
 * Here rather than in either package that uses it, for the same reason
 * `parseRegexFromString` moved: two callers must produce the **same number**,
 * and two copies of a hash are two things that can drift apart while both keep
 * working on their own.
 *
 * What depends on it:
 *
 * - `@iris/macro` — `{{pick}}` seeds off this, so a chat imported from
 *   SillyTavern keeps the picks its log was written with. A "better" hash would
 *   silently reroll every pick in every imported chat.
 * - `@iris/lorebook` — an entry's identity for timed effects, so editing an
 *   entry drops its sticky and cooldown windows.
 * - Script buttons — the event name is `${scriptId}_${hash(name)}`, and a
 *   listener registered under a hash that differs **by one bit** never fires
 *   and never says why.
 *
 * **Two lines here are load-bearing and neither of them looks it.**
 *
 * `Math.imul` is 32-bit multiplication; `h1 * 2654435761` is not the same
 * number and the difference only shows above 2^32. And `charCodeAt` walks
 * **UTF-16 code units**, not code points — measured, an emoji hashes
 * differently under `for…of` than under this loop, so a button named with one
 * would register under a name nothing listens to. Both rewrites produce working
 * code that returns wrong numbers.
 *
 * @module @iris/compat-tavernhelper-core/hash
 */

export function stringHash(value: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let index = 0; index < value.length; index += 1) {
    const ch = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
