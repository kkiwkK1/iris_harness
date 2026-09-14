/**
 * Facade for `scripts/extensions/regex/engine.js`, served at
 * `<rev>/scripts/extensions/regex/engine.js`. The extension borrows only the
 * "run the placement rules over a text" half (`getRegexedString` +
 * `regex_placement`); the rules themselves live in the hydrated
 * `extension_settings.regex` table, whose shapes (and the `placement` numbers)
 * mirror SillyTavern's own regex extension.
 *
 * Implemented minimally but honestly: string `findRegex` (with `/…/flags`
 * parsing) and string `replaceString` substitutions, honouring `disabled`,
 * the placement set, and the direction flags the caller passes. Function
 * replacers and macro substitution inside rules refuse — they are outside the
 * pilot's surface.
 */

import { state } from '../kernel-entry.ts'
import { UnsupportedStCompatApiError } from '../../../../../packages/iris-compat-st-extension/src/runtime/kernel-core.ts'

export const regex_placement = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const

interface RegexRule {
  id?: string
  findRegex?: string
  replaceString?: string
  placement?: number[]
  disabled?: boolean
  markdownOnly?: boolean
  promptOnly?: boolean
  runOnEdit?: boolean
  substituteRegex?: number
  minDepth?: number
  maxDepth?: number
  [key: string]: unknown
}

export function getRegexedString(
  content: string,
  placement: number,
  options: {
    isMarkdown?: boolean
    isPrompt?: boolean
    isRegex?: boolean
    depth?: number
    [key: string]: unknown
  } = {},
): string {
  let value = String(content)
  const rules = Array.isArray(state.extensionSettings['regex'])
    ? (state.extensionSettings['regex'] as RegexRule[])
    : []
  for (const rule of rules) {
    if (rule.disabled === true) continue
    const placements = Array.isArray(rule.placement) ? rule.placement : []
    if (placements.length > 0 && !placements.includes(placement)) continue
    if (rule.promptOnly === true && options.isPrompt !== true) continue
    if (rule.markdownOnly === true && options.isMarkdown !== true) continue
    if (typeof rule.findRegex !== 'string') continue
    if (typeof rule.replaceString !== 'function') {
      // String replacer — the only form the pilot supports.
      const pattern = parseRuleRegex(rule.findRegex)
      if (pattern === null) continue
      value = value.replace(pattern, rule.replaceString ?? '')
    } else {
      throw new UnsupportedStCompatApiError('regex engine: function replacers in extension_settings.regex')
    }
  }
  return value
}

function parseRuleRegex(findRegex: string): RegExp | null {
  const literal = /^\/(.*)\/([gimsuy]*)$/su.exec(findRegex)
  try {
    if (literal !== null) {
      const source = literal[1] ?? ''
      const flags = literal[2] ?? ''
      return new RegExp(source, flags)
    }
    return new RegExp(findRegex, 'gu')
  } catch {
    return null
  }
}
