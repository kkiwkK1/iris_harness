/**
 * Reading a reply that may be written in either MVU dialect.
 *
 * There are two, and both are live: the `_.verb();` calls `commands.ts` scans
 * for, and the `<JSONPatch>` blocks newer distributions ask for. A card's
 * prompt asks for exactly one — the instruction lives in its own world book —
 * so a caller cannot know in advance which it will get, and reading only one is
 * how the second dialect went unnoticed while every test stayed green.
 *
 * @module @iris/mvu/dialects
 */

import { extractCommands, type CommandInfo } from './commands.ts'
import { scanJsonPatch } from './json-patch.ts'

/** What a reply turned out to contain. */
export interface DialectScan {
  /** Every command, whichever dialect wrote it. */
  commands: CommandInfo[]
  /** How many `<JSONPatch>` blocks the reply carried. */
  jsonPatchBlocks: number
  /** How many commands came from the legacy `_.verb();` dialect. */
  legacyCommands: number
  /**
   * Anything the reply asked for and this could not read.
   *
   * The channel exists because its absence is what made the JSON Patch dialect
   * invisible: models emitted blocks for a whole release, nothing understood
   * them, and there was nowhere to say so. A reply carrying a block that yields
   * no commands is now a reportable event rather than a silence.
   */
  rejected: string[]
}

/**
 * Read a reply in whichever dialect it used.
 *
 * The two are concatenated rather than interleaved — legacy first, then JSON
 * Patch. No card in the corpus asks for both, so there is no real ordering to
 * reproduce; a reply that used both would be a new situation, and
 * {@link DialectScan} reports enough to notice it rather than having it settled
 * silently by an ordering nobody measured.
 * @param text - the whole message.
 * @returns the commands and what was seen along the way.
 */
export function scanDialects(text: string): DialectScan {
  const legacy = extractCommands(text)
  const patch = scanJsonPatch(text)
  return {
    commands: [...legacy, ...patch.commands],
    jsonPatchBlocks: patch.blocks,
    legacyCommands: legacy.length,
    rejected: patch.rejected,
  }
}

/**
 * Every update command in a reply, in either dialect.
 * @param text - the whole message.
 * @returns the commands.
 */
export function extractUpdateCommands(text: string): CommandInfo[] {
  return scanDialects(text).commands
}
