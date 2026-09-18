/**
 * Turning what a model answered into a plugin record — two routes, one validator.
 *
 * A model asked to write a sandbox plugin can answer in two shapes, and the
 * design takes both (`docs/SANDBOX-PLUGINS.md` §3.2 Q3):
 *
 * 1. **a tool call.** The request declares `iris_define_sandbox_plugin`, and the
 *    arguments arrive as one accumulated JSON string. The appeal is not elegance
 *    — it is that the code is *a field*, so nothing has to be cut out of prose.
 * 2. **fenced blocks.** One ` ```json ` block of metadata and one ` ```js ` block
 *    of code; everything outside them is thrown away. Iris connects to "any
 *    OpenAI-compatible endpoint", and an endpoint with no tool support is the
 *    ordinary case rather than the exotic one, so a tools-only reader would hand
 *    half the users a road that does not go anywhere.
 *
 * **The two routes differ only in how the fields are cut out.** What happens
 * afterwards — the lengths, the shapes, the refusals — is
 * {@link validateSandboxPluginFields}, called by both, and a test drives the
 * same content down both roads and compares the records byte for byte. Sharing
 * the *cutter* is impossible; sharing everything after it is the point.
 *
 * Nothing here compiles anything. The syntax precheck is
 * `precheckSandboxPluginSyntax` in `@iris/protocol`, which the caller runs
 * afterwards so that "it did not parse" and "it parsed and does not compile" are
 * two states with two different sentences (§6.1, §6.2).
 *
 * @module @iris/app-service/sandbox-plugins/parse
 */
import {
  SANDBOX_PLUGIN_LIMITS,
  SANDBOX_PLUGIN_QUOTAS,
  type SandboxPluginDeclaration,
} from '@iris/protocol'

/**
 * The fields a definition is made of, after cutting and before storing.
 *
 * Not a `SandboxPluginVersion`: the host still has to mint the id, compute the
 * hash, stamp the authoring route and decide the version number, and none of
 * those are things the model said. Keeping the model's half in its own type is
 * what stops a field it invented being mistaken for one the host derived.
 */
export interface SandboxPluginCandidate {
  /** What the model proposes to call it. **A prefix, not an id** (§3.2 Q1). */
  readonly idPrefix: string
  readonly name: string
  readonly purpose: string
  readonly declares: readonly SandboxPluginDeclaration[]
  readonly code: string
}

/** What a parse produced, or why it produced nothing. */
export type SandboxPluginParse =
  | { readonly ok: true, readonly candidate: SandboxPluginCandidate }
  | {
    readonly ok: false
    /** One of the seven (§6). Only these two are reachable from here. */
    readonly state: 'unparseable' | 'too-large'
    /** What is wrong, in words a player can act on. */
    readonly detail: string
  }

/**
 * The tool the authoring request declares.
 *
 * Exported because three places have to spell it the same way: the request that
 * declares it, the reader that matches the answer against it, and the author
 * documentation that tells the model about it.
 */
export const SANDBOX_PLUGIN_TOOL_NAME = 'iris_define_sandbox_plugin'

/**
 * How much of a model's reply a refusal report carries.
 *
 * The design asks for it by name (§6.2): a report that says only "could not
 * parse" leaves whoever reads it next with a verdict and no evidence, and the
 * evidence is not reproducible — the reply is gone.
 */
export const SANDBOX_PLUGIN_REPLY_EXCERPT = 500

/**
 * The opening of a reply, for a refusal's report.
 * @param text - the model's completion.
 * @returns a bounded excerpt, with the cut marked when there was one.
 */
export function replyExcerpt(text: string): string {
  const head = text.slice(0, SANDBOX_PLUGIN_REPLY_EXCERPT)
  return text.length > head.length ? `${head}…` : head
}

/**
 * Cut a string field to its ceiling.
 *
 * **Truncation is right here and wrong for `code`**, and the asymmetry is the
 * design's (§3.2 Q2): a cut name is a shorter name, while a cut function body is
 * a syntax error — and the error would then point at the model's code for a
 * fault the ceiling introduced. So the three display fields are cut and the
 * source is refused.
 * @param value - the field.
 * @param chars - its ceiling.
 * @returns the field, at most `chars` long.
 */
function cut(value: string, chars: number): string {
  return value.length > chars ? value.slice(0, chars) : value
}

/**
 * Read the `declares` field, keeping what is well formed.
 *
 * **A malformed entry costs a line on the confirmation card, not the plugin.**
 * The field is the model's own account of what it will register and the host
 * gates nothing on it (§7, §14.7); refusing a whole definition because a
 * display-only array had a typo in it would trade the thing the player asked
 * for against a caption.
 *
 * Both routes go through this one reader, so a tool call and a fenced block
 * carrying the same array produce the same array.
 * @param value - whatever was in the field.
 * @returns the declarations that were well formed, in the order given.
 */
function readDeclares(value: unknown): SandboxPluginDeclaration[] {
  if (!Array.isArray(value)) return []
  const out: SandboxPluginDeclaration[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const kind = (entry as { kind?: unknown }).kind
    if (kind === 'style' || kind === 'panel') {
      out.push({ kind })
      continue
    }
    if (kind !== 'members') continue
    const names = (entry as { names?: unknown }).names
    out.push({
      kind: 'members',
      names: Array.isArray(names)
        ? names.filter((name): name is string => typeof name === 'string' && name.length > 0)
          .map(name => cut(name, SANDBOX_PLUGIN_QUOTAS.nameChars))
        : [],
    })
  }
  return out
}

/**
 * The one validator both routes end in.
 *
 * Given the raw object a route cut out, answer a candidate or a named refusal.
 * Everything a route decides on its own is *which bytes go in here*; every rule
 * about what those bytes have to be is in this function, so that a rule can only
 * be changed for both routes at once.
 * @param raw - the object a route produced: the five fields, unvalidated.
 * @param where - how the fields were cut out, for the refusal's sentence.
 * @returns the candidate, or why there is none.
 */
export function validateSandboxPluginFields(raw: unknown, where: string): SandboxPluginParse {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, state: 'unparseable', detail: `${where}: the definition was not an object` }
  }
  const record = raw as Record<string, unknown>

  const code = record['code']
  if (typeof code !== 'string' || code.trim().length === 0) {
    return { ok: false, state: 'unparseable', detail: `${where}: no code field, or it was empty` }
  }
  /*
   * **Bytes, not characters.** A plugin written in a language whose characters
   * are three bytes each would otherwise get three times the ceiling, and the
   * ceiling exists against a byte budget — the frame's 2 MiB (`frame-budget.ts`).
   */
  const bytes = Buffer.byteLength(code, 'utf8')
  if (bytes > SANDBOX_PLUGIN_LIMITS.codeBytes) {
    return {
      ok: false,
      state: 'too-large',
      detail:
        `the model wrote ${String(bytes)} bytes of code, over the`
        + ` ${String(SANDBOX_PLUGIN_LIMITS.codeBytes)} one plugin may hold`,
    }
  }

  const name = record['name']
  const purpose = record['purpose']
  const idPrefix = record['idPrefix']
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, state: 'unparseable', detail: `${where}: no name field, or it was empty` }
  }
  if (typeof purpose !== 'string' || purpose.trim().length === 0) {
    return { ok: false, state: 'unparseable', detail: `${where}: no purpose field, or it was empty` }
  }
  if (typeof idPrefix !== 'string' || idPrefix.trim().length === 0) {
    return { ok: false, state: 'unparseable', detail: `${where}: no idPrefix field, or it was empty` }
  }

  return {
    ok: true,
    candidate: {
      idPrefix: cut(idPrefix.trim(), SANDBOX_PLUGIN_QUOTAS.nameChars),
      name: cut(name.trim(), SANDBOX_PLUGIN_QUOTAS.nameChars),
      purpose: cut(purpose.trim(), SANDBOX_PLUGIN_QUOTAS.purposeChars),
      declares: readDeclares(record['declares']),
      code,
    },
  }
}

/**
 * Route 1: the arguments of a `iris_define_sandbox_plugin` tool call.
 *
 * The arguments arrive as one accumulated JSON string — that is what
 * `@iris/llm-openai-compat`'s `translate` builds out of the streamed fragments —
 * so this route is `JSON.parse` and then the shared validator.
 * @param argumentsJson - the tool call's accumulated arguments.
 * @returns the candidate, or why there is none.
 */
export function parseSandboxPluginToolCall(argumentsJson: string): SandboxPluginParse {
  let raw: unknown
  try {
    raw = JSON.parse(argumentsJson)
  } catch (error: unknown) {
    return {
      ok: false,
      state: 'unparseable',
      detail:
        `the tool call's arguments were not JSON (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  return validateSandboxPluginFields(raw, 'the tool call')
}

/**
 * Find the body of the first fenced block carrying an exact info string.
 *
 * **Exact, and deliberately not forgiving.** The author documentation names one
 * marker for each block and this accepts that one: a reader that also took
 * `javascript`, `JS` and `typescript` would be encoding a guess about what a
 * model might do into the one place that is supposed to say what it must do, and
 * the next spelling would be somebody else's guess. The teeth table has a
 * mutation whose whole job is to keep this honest — renaming the marker must go
 * red rather than quietly still passing.
 * @param text - the completion.
 * @param marker - the info string, exactly.
 * @returns the block's body, or undefined when there is no such block.
 */
function fencedBlock(text: string, marker: string): string | undefined {
  const lines = text.split(/\r?\n/u)
  let open = false
  const body: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!open) {
      // The info string is what follows the fence on the opening line, trimmed.
      if (trimmed.startsWith('```') && trimmed.slice(3).trim() === marker) open = true
      continue
    }
    if (trimmed.startsWith('```')) return body.join('\n')
    body.push(line)
  }
  // An unterminated block is not a block: the model was cut off, and treating
  // whatever arrived as complete code is how a truncated body becomes a syntax
  // error attributed to the model's writing rather than to the cut.
  return undefined
}

/**
 * Route 2: a completion carrying a ` ```json ` block and a ` ```js ` block.
 *
 * Prose outside the blocks is thrown away — which is the whole reason this is
 * the fallback and not the only route: a model that writes "note: you will need
 * to…" beside its code leaves a fence reader with two wrong answers to choose
 * between, and a tool call has no such seam.
 * @param text - the completion.
 * @returns the candidate, or why there is none.
 */
export function parseSandboxPluginFences(text: string): SandboxPluginParse {
  const meta = fencedBlock(text, 'json')
  const code = fencedBlock(text, 'js')
  if (meta === undefined && code === undefined) {
    return {
      ok: false,
      state: 'unparseable',
      detail: 'the reply carried neither a ```json block nor a ```js block',
    }
  }
  if (meta === undefined) {
    return { ok: false, state: 'unparseable', detail: 'the reply carried code but no ```json block of metadata' }
  }
  if (code === undefined) {
    return { ok: false, state: 'unparseable', detail: 'the reply carried metadata but no ```js block of code' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(meta)
  } catch (error: unknown) {
    return {
      ok: false,
      state: 'unparseable',
      detail: 'the metadata block was not JSON ('
        + (error instanceof Error ? error.message : String(error)) + ')',
    }
  }
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, state: 'unparseable', detail: 'the ```json block was not an object' }
  }
  /*
   * The code is spliced in as the `code` field so the two routes hand the
   * validator **the same shape**. Doing it the other way — a validator that
   * takes the code separately — would give the fenced route a rule the tool
   * route does not have, which is exactly the seam the equivalence test exists
   * to close.
   */
  return validateSandboxPluginFields({ ...raw as Record<string, unknown>, code }, 'the fenced blocks')
}
