/**
 * The macro vocabulary.
 *
 * Names, aliases and edge-case behaviour are taken from SillyTavern — the
 * legacy `evaluateMacros` table in `public/scripts/macros.js` plus the
 * definitions under `public/scripts/macros/definitions/`, which is where the
 * modern spellings (`{{idleDuration}}`, `{{datetimeformat::FMT}}`,
 * `{{time::UTC+2}}`) live. Where the two disagree both spellings are accepted,
 * because cards in circulation were written against either.
 *
 * Three deliberate divergences, each noted again at its macro:
 *
 *  - `{{creatorNotes}}` is not implemented. Creator notes are author-to-reader
 *    text that must never enter a prompt, and a macro is the one hole through
 *    which a card could put them there.
 *  - `{{banned}}`, `{{maxPrompt}}` and the other backend-coupled macros are not
 *    here; they belong to whichever plugin owns that backend and can register
 *    themselves.
 *  - Card fields re-expand their own output. See `expand.ts`.
 *
 * @module @iris/macro/builtins
 */

import { formatDate, humanizeDuration } from './format.ts'
import {
  MacroRegistry,
  stringHash,
  type MacroInvocation,
  type MacroMessage,
  type MacroResolver,
  type VariableScope,
} from './registry.ts'

/** Combine disposers so a caller can retract a whole vocabulary at once. */
function disposeAll(disposers: readonly (() => void)[]): () => void {
  return () => {
    // Reverse order, mirroring Cordis: the last effect installed is the first
    // one taken back out.
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      disposers[index]?.()
    }
  }
}

/** Read the argument at `position`, or `undefined` when it was not supplied. */
function arg(invocation: MacroInvocation, position: number): string | undefined {
  return invocation.args[position]
}

// ---------------------------------------------------------------------------
// identity

/**
 * `{{group}}`'s value, which `{{charIfNotGroup}}` shares.
 *
 * Upstream assigns them from one expression
 * (`environment.group = environment.charIfNotGroup = getGroupValue(true)`), so
 * in a one-on-one chat both are simply the character's name.
 * @param invocation - the occurrence being resolved.
 * @returns the member list, or the character name outside a group.
 */
function groupValue(invocation: MacroInvocation): string {
  const members = invocation.context.group
  if (members === undefined || members.length === 0) return invocation.context.char
  return members.join(', ')
}

/** Register `{{char}}`, `{{user}}`, `{{persona}}`, `{{group}}`, `{{charIfNotGroup}}`, `{{notChar}}`. */
function registerIdentity(registry: MacroRegistry): (() => void)[] {
  return [
    registry.register('char', invocation => invocation.context.char),
    registry.register('user', invocation => invocation.context.user),
    // Upstream's `{{persona}}` is the persona *description*, not the name;
    // `{{user}}` is the name. Cards rely on the split.
    registry.register('persona', invocation => invocation.context.persona ?? ''),
    registry.register('group', groupValue),
    registry.register('charIfNotGroup', groupValue),
    registry.register('notChar', invocation => {
      // "Everyone in the room who is not currently speaking", user included.
      const members = invocation.context.group
      if (members === undefined || members.length === 0) return invocation.context.user
      return [...members.filter(name => name !== invocation.context.char), invocation.context.user].join(', ')
    }),
  ]
}

// ---------------------------------------------------------------------------
// character card fields

/**
 * A resolver for one card field.
 *
 * The value is re-expanded rather than spliced verbatim. That is the one place
 * Iris keeps the shipping engine's ordering behaviour instead of the parsing
 * engine's: descriptions written as "{{char}} met {{user}} in Vienna" are the
 * norm, and upstream's `Must be substituted last so that they're replaced
 * inside {{description}}` comment exists to make exactly that work.
 * @param read - pulls the field off the card.
 * @returns a resolver yielding the expanded field, or `''` when the card has none.
 */
function cardField(read: (invocation: MacroInvocation) => string | undefined): MacroResolver {
  return invocation => {
    const value = read(invocation)
    if (value === undefined || value === '') return ''
    return invocation.expand(value)
  }
}

/** Register the character-card macros and their upstream aliases. */
function registerCardFields(registry: MacroRegistry): (() => void)[] {
  const field = (
    names: readonly string[],
    read: (invocation: MacroInvocation) => string | undefined,
  ): (() => void)[] => {
    const resolver = cardField(read)
    return names.map(name => registry.register(name, resolver))
  }

  return [
    ...field(['description', 'charDescription'], i => i.context.character?.description),
    ...field(['personality', 'charPersonality'], i => i.context.character?.personality),
    ...field(['scenario', 'charScenario'], i => i.context.character?.scenario),
    // Iris has no instruct formatter yet, so `{{mesExamples}}` yields the raw
    // block — which is exactly what upstream's `{{mesExamplesRaw}}` yields, and
    // what `{{mesExamples}}` itself yields outside instruct mode.
    ...field(['mesExamples', 'mesExamplesRaw'], i => i.context.character?.mesExamples),
    ...field(['charPrompt'], i => i.context.character?.charPrompt),
    ...field(['charJailbreak', 'charInstruction'], i => i.context.character?.charJailbreak),
    ...field(['charDepthPrompt'], i => i.context.character?.charDepthPrompt),
    // Version is an opaque label; expanding it would let a card's version
    // string execute macros, which is pure downside.
    ...['charVersion', 'char_version', 'version'].map(name =>
      registry.register(name, invocation => invocation.context.character?.charVersion ?? ''),
    ),
    registry.register('original', invocation => {
      // One shot per expansion, as upstream: a card that writes {{original}}
      // twice gets the overridden block once, not twice.
      if (invocation.scratch.get('original:used') === true) return ''
      invocation.scratch.set('original:used', true)
      const value = invocation.context.original
      if (value === undefined || value === '') return ''
      return invocation.expand(value)
    }),
  ]
}

// ---------------------------------------------------------------------------
// chat

/** Index of the newest message satisfying `match`, or `undefined`. */
function lastIndexWhere(
  chat: readonly MacroMessage[],
  match: (message: MacroMessage) => boolean,
): number | undefined {
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const message = chat[index]
    if (message !== undefined && match(message)) return index
  }
  return undefined
}

/** Text of the newest message satisfying `match`, or `''`. */
function lastContent(
  chat: readonly MacroMessage[] | undefined,
  match: (message: MacroMessage) => boolean,
): string {
  if (chat === undefined) return ''
  const index = lastIndexWhere(chat, match)
  return index === undefined ? '' : (chat[index]?.content ?? '')
}

/** Register `{{lastMessage}}`, `{{lastUserMessage}}`, `{{lastCharMessage}}`, `{{lastMessageId}}`, `{{input}}`. */
function registerChat(registry: MacroRegistry): (() => void)[] {
  return [
    // Unfiltered, matching upstream's `getLastMessageId()` with no filter.
    registry.register('lastMessage', invocation => lastContent(invocation.context.chat, () => true)),
    // The filters skip system messages, so a system notice does not become
    // "the last thing the user said".
    registry.register('lastUserMessage', invocation =>
      lastContent(invocation.context.chat, message => message.role === 'user'),
    ),
    registry.register('lastCharMessage', invocation =>
      lastContent(invocation.context.chat, message => message.role === 'assistant'),
    ),
    registry.register('lastMessageId', invocation => {
      const chat = invocation.context.chat
      if (chat === undefined || chat.length === 0) return ''
      return String(chat.length - 1)
    }),
    registry.register('allChatRange', invocation => {
      const chat = invocation.context.chat
      if (chat === undefined || chat.length === 0) return ''
      return `0-${chat.length - 1}`
    }),
    registry.register('input', invocation => invocation.context.input ?? ''),
  ]
}

// ---------------------------------------------------------------------------
// time

/** `{{time::UTC+2}}` / `{{time_UTC+2}}`: an explicit zone, or the context's own. */
function timeOffset(invocation: MacroInvocation): number | undefined {
  const specifier = arg(invocation, 0)
  if (specifier === undefined || specifier === '') return invocation.context.clock.utcOffsetMinutes
  const match = /^UTC([+-]\d+)$/i.exec(specifier)
  if (match?.[1] === undefined) return invocation.context.clock.utcOffsetMinutes
  const hours = Number.parseInt(match[1], 10)
  return Number.isNaN(hours) ? invocation.context.clock.utcOffsetMinutes : hours * 60
}

/**
 * How long since the user last spoke, upstream's way.
 *
 * `getTimeSinceLastMessage` walks backwards skipping system messages, lets the
 * first non-system message it meets go by, and measures from the *next* user
 * message after that. The skip is what makes the number mean "how long the user
 * has been idle" rather than "zero, they just pressed send".
 * @param chat - the conversation.
 * @param now - the current instant.
 * @returns a humanized duration, or `'just now'` when there is nothing to measure.
 */
function idleDuration(chat: readonly MacroMessage[] | undefined, now: Date): string {
  if (chat === undefined || chat.length === 0) return 'just now'

  let skippedOne = false
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const message = chat[index]
    if (message === undefined || message.role === 'system') continue
    if (message.role === 'user' && skippedOne) {
      if (message.sendDate === undefined) return 'just now'
      return humanizeDuration(now.getTime() - message.sendDate)
    }
    skippedOne = true
  }
  return 'just now'
}

/** Register the time and date macros. */
function registerTime(registry: MacroRegistry): (() => void)[] {
  const at = (invocation: MacroInvocation, pattern: string, offset?: number): string =>
    formatDate(invocation.context.clock.now(), pattern, offset ?? invocation.context.clock.utcOffsetMinutes)

  return [
    // moment's `LT`; `{{time::UTC+2}}` and the legacy `{{time_UTC+2}}` (which
    // `expand.ts` normalizes into this form) render the same clock elsewhere.
    registry.register('time', invocation => at(invocation, 'LT', timeOffset(invocation))),
    registry.register('date', invocation => at(invocation, 'LL')),
    registry.register('weekday', invocation => at(invocation, 'dddd')),
    registry.register('isotime', invocation => at(invocation, 'HH:mm')),
    registry.register('isodate', invocation => at(invocation, 'YYYY-MM-DD')),
    registry.register('datetimeformat', invocation => {
      // Rejoined: a format string may legitimately contain `::`, and upstream's
      // legacy spelling passed everything after the macro name through.
      const pattern = invocation.args.join('::')
      if (pattern === '') return undefined
      return at(invocation, pattern)
    }),
    ...['idleDuration', 'idle_duration'].map(name =>
      registry.register(name, invocation =>
        idleDuration(invocation.context.chat, invocation.context.clock.now()),
      ),
    ),
  ]
}

// ---------------------------------------------------------------------------
// variables

/** Read a variable, treating "unset" as `''` the way upstream does. */
function readVariable(invocation: MacroInvocation, scope: VariableScope, name: string): string {
  return invocation.context.variables.get(scope, name.trim()) ?? ''
}

/**
 * `{{addvar}}`'s three-way behaviour, from `addLocalVariable`.
 *
 * The order matters: a JSON array is appended to, two numbers are summed, and
 * anything else is string concatenation. Cards use all three — the array branch
 * is how `{{addvar::inventory::rope}}` builds a list.
 * @param invocation - the occurrence being resolved.
 * @param scope - which tier to update.
 * @param name - variable name.
 * @param value - the literal to add.
 * @returns the new stored value.
 */
function addToVariable(
  invocation: MacroInvocation,
  scope: VariableScope,
  name: string,
  value: string,
): string {
  const key = name.trim()
  const current = readVariable(invocation, scope, key)

  if (current !== '') {
    try {
      const parsed: unknown = JSON.parse(current)
      if (Array.isArray(parsed)) {
        const next = JSON.stringify([...parsed, value])
        invocation.context.variables.set(scope, key, next)
        return next
      }
    } catch {
      // Not JSON, so not the array case.
    }
  }

  const base = Number(current === '' ? 0 : current)
  const delta = Number(value)
  const next = Number.isNaN(base) || Number.isNaN(delta) ? `${current}${value}` : String(base + delta)
  invocation.context.variables.set(scope, key, next)
  return next
}

/** Register `get`/`set`/`add`/`inc`/`dec`/`has`/`delete` for one scope. */
function registerVariableScope(registry: MacroRegistry, scope: VariableScope): (() => void)[] {
  const infix = scope === 'global' ? 'global' : ''
  const name = (verb: string): string => `${verb}${infix}var`

  const requireName = (invocation: MacroInvocation): string | undefined => {
    const raw = arg(invocation, 0)
    if (raw === undefined || raw.trim() === '') return undefined
    return raw.trim()
  }

  return [
    registry.register(name('get'), invocation => {
      const key = requireName(invocation)
      return key === undefined ? undefined : readVariable(invocation, scope, key)
    }),
    registry.register(name('set'), invocation => {
      const key = requireName(invocation)
      const value = arg(invocation, 1)
      if (key === undefined || value === undefined) return undefined
      invocation.context.variables.set(scope, key, value)
      // Setting is a side effect, not an expression: it renders as nothing.
      return ''
    }),
    registry.register(name('add'), invocation => {
      const key = requireName(invocation)
      const value = arg(invocation, 1)
      if (key === undefined || value === undefined) return undefined
      addToVariable(invocation, scope, key, value)
      return ''
    }),
    // Unlike `{{addvar}}`, these two *do* render — cards write
    // `Turn {{incvar::turn}}` and expect the new number back.
    registry.register(name('inc'), invocation => {
      const key = requireName(invocation)
      return key === undefined ? undefined : addToVariable(invocation, scope, key, '1')
    }),
    registry.register(name('dec'), invocation => {
      const key = requireName(invocation)
      return key === undefined ? undefined : addToVariable(invocation, scope, key, '-1')
    }),
    ...[name('has'), scope === 'global' ? 'globalvarexists' : 'varexists'].map(alias =>
      registry.register(alias, invocation => {
        const key = requireName(invocation)
        if (key === undefined) return undefined
        return invocation.context.variables.get(scope, key) === undefined ? 'false' : 'true'
      }),
    ),
    ...[name('delete'), name('flush')].map(alias =>
      registry.register(alias, invocation => {
        const key = requireName(invocation)
        if (key === undefined) return undefined
        invocation.context.variables.delete(scope, key)
        return ''
      }),
    ),
  ]
}

// ---------------------------------------------------------------------------
// random

/**
 * Split the one-argument form of `{{random}}` / `{{pick}}`.
 *
 * Reproduces `readSingleArgsRandomList`: `::` wins over `,` when both are
 * present, so `{{random:a::b::c}}` is three options rather than one. `\,`
 * escapes a comma inside an option.
 * @param listString - everything after the macro name.
 * @returns the options, trimmed.
 */
function splitOptionList(listString: string): string[] {
  if (listString.includes('::')) return listString.split('::').map(item => item.trim())

  const options: string[] = []
  let current = ''
  for (let index = 0; index < listString.length; index += 1) {
    const ch = listString[index]
    if (ch === '\\' && listString[index + 1] === ',') {
      current += ','
      index += 1
      continue
    }
    if (ch === ',') {
      options.push(current.trim())
      current = ''
      continue
    }
    current += ch ?? ''
  }
  options.push(current.trim())
  return options
}

/** The option list for a `{{random}}`/`{{pick}}` call, or `undefined` when there is none. */
function optionList(invocation: MacroInvocation): string[] | undefined {
  if (invocation.args.length === 0) return undefined
  if (invocation.args.length > 1) return [...invocation.args]
  const single = invocation.args[0] ?? ''
  if (single === '') return undefined
  return splitOptionList(single)
}

/** Register `{{random}}`, `{{pick}}` and `{{roll}}`. */
function registerRandom(registry: MacroRegistry): (() => void)[] {
  return [
    registry.register('random', invocation => {
      const list = optionList(invocation)
      if (list === undefined || list.length === 0) return undefined
      const index = Math.floor(invocation.context.random.next() * list.length)
      return list[index] ?? ''
    }),

    registry.register('pick', invocation => {
      const list = optionList(invocation)
      if (list === undefined || list.length === 0) return undefined
      // Upstream seeds on chat id, a hash of the whole text, and the macro's
      // offset within it. Chat id keeps the choice across a reload; the text
      // hash and offset keep two `{{pick}}`s in one document independent, while
      // making the same `{{pick}}` in the same place answer the same way every
      // time the prompt is rebuilt. Renaming or branching a chat must not
      // change the id, or every pick in the log rerolls.
      const seed = `${stringHash(invocation.context.chatId ?? '')}-${stringHash(invocation.source)}-${invocation.offset}`
      const random = invocation.context.random.seeded(seed)
      const index = Math.floor(random() * list.length)
      return list[index] ?? ''
    }),

    registry.register('roll', invocation => {
      const formula = invocation.args.join('::').trim()
      if (formula === '') return undefined
      // A bare number means one die of that many sides: `{{roll::20}}` = `1d20`.
      const normalized = /^\d+$/.test(formula) ? `1d${formula}` : formula
      const match = /^([1-9]\d*)?d([1-9]\d*)([+-]\d+)?$/i.exec(normalized)
      if (match === null) return ''

      const count = match[1] === undefined ? 1 : Number.parseInt(match[1], 10)
      const sides = Number.parseInt(match[2] ?? '0', 10)
      const modifier = match[3] === undefined ? 0 : Number.parseInt(match[3], 10)
      if (sides <= 0) return ''

      let total = modifier
      for (let die = 0; die < count; die += 1) {
        total += 1 + Math.floor(invocation.context.random.next() * sides)
      }
      return String(total)
    }),
  ]
}

// ---------------------------------------------------------------------------
// formatting

/** Parse an optional non-negative repeat count for `{{space}}` / `{{newline}}`. */
function repeatCount(invocation: MacroInvocation): number | undefined {
  const raw = arg(invocation, 0)
  if (raw === undefined || raw === '') return 1
  if (!/^\d+$/.test(raw)) return undefined
  return Number.parseInt(raw, 10)
}

/** Register the whitespace, comment and string-utility macros. */
function registerFormatting(registry: MacroRegistry): (() => void)[] {
  return [
    registry.register('newline', invocation => {
      const count = repeatCount(invocation)
      return count === undefined ? undefined : '\n'.repeat(count)
    }),
    registry.register('space', invocation => {
      const count = repeatCount(invocation)
      return count === undefined ? undefined : ' '.repeat(count)
    }),
    registry.register('noop', () => ''),
    // `{{trim}}` swallows the newlines *around* itself, which no single
    // substitution can express. It therefore resolves to itself and is removed,
    // together with its neighbouring newlines, by a post-pass in `expand.ts` —
    // the same trick upstream uses.
    registry.register('trim', () => '{{trim}}'),
    ...['//', 'comment'].map(name => registry.register(name, () => '')),
    registry.register('reverse', invocation => {
      const value = invocation.args.join('::')
      if (value === '') return undefined
      // Array.from, not split(''): reversing UTF-16 code units would tear
      // emoji and every non-BMP character in half.
      return Array.from(value).reverse().join('')
    }),
  ]
}

// ---------------------------------------------------------------------------

/**
 * Install the whole builtin vocabulary on a registry.
 * @param registry - the registry to populate.
 * @returns a disposer removing every registration, newest first.
 */
export function registerBuiltins(registry: MacroRegistry): () => void {
  return disposeAll([
    ...registerIdentity(registry),
    ...registerCardFields(registry),
    ...registerChat(registry),
    ...registerTime(registry),
    ...registerVariableScope(registry, 'local'),
    ...registerVariableScope(registry, 'global'),
    ...registerRandom(registry),
    ...registerFormatting(registry),
  ])
}

/**
 * A registry preloaded with the builtins.
 * @returns a fresh registry; the caller owns it and may extend or strip it.
 */
export function createMacroRegistry(): MacroRegistry {
  const registry = new MacroRegistry()
  registerBuiltins(registry)
  return registry
}

let shared: MacroRegistry | undefined

/**
 * The registry `expandMacros` uses when the caller supplies none.
 *
 * A convenience for the common case — expanding a piece of card text that only
 * uses builtins. Plugin code should own a registry instead: registrations on
 * this one are still individually reversible, but they are visible to every
 * other caller that also omitted a registry.
 * @returns the shared builtins registry, created on first use.
 */
export function defaultRegistry(): MacroRegistry {
  shared ??= createMacroRegistry()
  return shared
}
