/**
 * The request that writes a plugin: what the model is told, and what it is asked for.
 *
 * One 「创造」 sentence becomes one model request on a connection profile chosen
 * for exactly this (`docs/SANDBOX-PLUGINS.md` §11). This module owns the two
 * halves that are not plumbing:
 *
 * - **the document the model reads** — `docs/SANDBOX-PLUGIN-AUTHORING.md`, read
 *   from disk rather than embedded, because its length *is* the per-request cost
 *   and a constant that has drifted from the document nobody edits is worse than
 *   a file that is missing. A missing file refuses the definition by name; it
 *   does not quietly ask the model with no instructions.
 * - **the tool declaration** — one tool, five fields, whose parameter schema is
 *   built here from the same ceilings the parser enforces, so the thing the
 *   model is told about and the thing the host will accept cannot drift apart.
 *
 * @module @iris/app-service/sandbox-plugins/authoring
 */
import { readFile } from 'node:fs/promises'

import { SANDBOX_PLUGIN_LIMITS, SANDBOX_PLUGIN_QUOTAS } from '@iris/protocol'

import { SANDBOX_PLUGIN_TOOL_NAME } from './parse.ts'

/**
 * Where the author document lives, relative to this module.
 *
 * Resolved from `import.meta.url` the way `apps/iris/bin.ts` resolves its own
 * neighbours: the host runs from source, so the repository layout is the
 * runtime layout, and a path built from the working directory would depend on
 * where somebody typed the command.
 */
export const AUTHORING_DOC_URL = new URL('../../../../docs/SANDBOX-PLUGIN-AUTHORING.md', import.meta.url)

/**
 * What the model is told, before anything about this conversation.
 *
 * @returns the document's text.
 * @throws {Error} when the document cannot be read.
 */
export async function readAuthoringDocument(): Promise<string> {
  return readFile(AUTHORING_DOC_URL, 'utf8')
}

/**
 * The one tool the authoring request declares.
 *
 * Its parameter schema names the same five fields the fenced-block route cuts
 * out and carries the same ceilings — `maxLength` on the three display fields so
 * a model is told where the cut is rather than discovering it, and a plain
 * `description` for `code` because a JSON-Schema length on a 64 KiB field is a
 * number no model reads usefully.
 * @returns the schema to put in `GenerateOptions.tools`.
 */
export function sandboxPluginTool(): { name: string, description: string, parameters: Record<string, unknown> } {
  return {
    name: SANDBOX_PLUGIN_TOOL_NAME,
    description:
      'Define one sandbox plugin for this conversation. Call this exactly once, with the whole plugin.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['idPrefix', 'name', 'purpose', 'code'],
      properties: {
        idPrefix: {
          type: 'string',
          maxLength: SANDBOX_PLUGIN_QUOTAS.nameChars,
          description: 'A short lowercase slug suggesting a name. The host mints the real id from it.',
        },
        name: {
          type: 'string',
          maxLength: SANDBOX_PLUGIN_QUOTAS.nameChars,
          description: 'What to call it, in the player\'s own language.',
        },
        purpose: {
          type: 'string',
          maxLength: SANDBOX_PLUGIN_QUOTAS.purposeChars,
          description:
            'What it does, one or two sentences. This is read out to the player verbatim before they'
            + ' approve it, so describe what it really does and do not sell it.',
        },
        declares: {
          type: 'array',
          description: 'What you will register. Shown to the player; nothing is gated on it.',
          items: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['style', 'panel', 'members'] },
              names: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        code: {
          type: 'string',
          description:
            'The function body. It receives one parameter, `iris`, and returns { apply?, dispose? }.'
            + ` No import, no export, no JSX. At most ${String(SANDBOX_PLUGIN_LIMITS.codeBytes)} bytes.`,
        },
      },
    },
  }
}

/** What the request needs to know about the conversation it is writing for. */
export interface AuthoringContext {
  /** The character being played, by name. */
  readonly characterName: string
  /** The card's own scripts, by name — what already runs in this frame. */
  readonly scriptNames: readonly string[]
  /** What this conversation has already grown: name and purpose, current version. */
  readonly existing: readonly { readonly name: string, readonly purpose: string }[]
  /** The plugin being rewritten, when this is a replacement. */
  readonly replacing?: { readonly name: string, readonly purpose: string, readonly code: string }
}

/**
 * The user turn of the authoring request.
 *
 * **The player's sentence goes last and unquoted-from.** Everything above it is
 * context the host assembled; putting the sentence at the end is the ordinary
 * shape, and not paraphrasing it is what makes the `prompt` stored on the record
 * — which the panel shows back as "what you said" — the same string the model
 * was given.
 *
 * The card's interface structure is described by what the host actually holds:
 * the character's name and the names of the scripts that share the frame. The
 * design asks for a "structure summary" of the card's interface, and the host
 * has no DOM — the interface is markup inside messages, in a browser. Naming the
 * scripts is the honest subset: it tells the model what else is in the realm it
 * is about to join, which is the part a plugin can actually collide with.
 * @param context - what this conversation already is.
 * @param sentence - the player's own words.
 * @returns the user message text.
 */
export function authoringPrompt(context: AuthoringContext, sentence: string): string {
  const lines: string[] = []
  lines.push(`The player is playing a character called ${context.characterName}.`)
  lines.push(
    context.scriptNames.length === 0
      ? 'This card ships no scripts, so your plugin is the only code in the frame.'
      : `This card's own scripts share the frame with you: ${context.scriptNames.join(', ')}.`,
  )
  if (context.existing.length === 0) {
    lines.push('This conversation has not grown anything yet.')
  } else {
    lines.push('This conversation has already grown:')
    for (const plugin of context.existing) lines.push(`  - ${plugin.name}: ${plugin.purpose}`)
  }
  if (context.replacing !== undefined) {
    lines.push('')
    lines.push(
      `You are rewriting "${context.replacing.name}" (${context.replacing.purpose}).`
      + ' Its current source follows; write the whole replacement, not a patch.',
    )
    lines.push('```js')
    lines.push(context.replacing.code)
    lines.push('```')
  }
  lines.push('')
  lines.push('The player said:')
  lines.push('')
  lines.push(sentence)
  return lines.join('\n')
}
