# Extensions

The third-party extension system for the Iris host: what an extension is, what
it may touch, what it may not, and what the host owes it.

The constitution for everything below is `notes/EXTENSION-SYSTEM-RULING.md`
(the 总指挥 ruling of 2026-09-12, cited hereafter as Ruling §n). Where this
document paraphrases the Ruling, the Chinese sentence quoted is the ruling
itself; the English around it is this document's elaboration. A conflict is
resolved in the Ruling's favour, and overturning the Ruling is not done here —
see §8 for suggestions that go back to the 总指挥 instead.

## 1. Position and trust model

Ruling §1: 「第三方扩展 = **宿主侧 Cordis 插件**（cordis.yml 一行 + 一个 npm 包）」.

An extension is a Cordis plugin exactly like every row already in
`apps/iris/cordis.yml` — `logger`, `timer`, `llm`, `webserver`, `app`. It runs
in the host process, on the host's privileges, with the host's access. It is
not a frontend component and not an in-frame script. The `llm-openai-compat`
row (`apps/iris/cordis.yml:42`) is the first extension in this sense and the
shape to copy: swapping the model provider is a configuration row, not a code
change.

Ruling §4: 「扩展与宿主同进程、同权限（Node 进程边界内没有便宜的隔离）」. Spelled
out for the user who is about to install one:

> **An extension is privileged code on your machine.** It can read what the
> host reads and write what the host writes. Installing it is a decision with
> the same weight as installing any other Node package and running it against
> your data directory.

Two consequences the rest of this document takes as premises:

- **There is no marketplace and no auto-install** (Ruling §4). Installing means
  `pnpm add` plus one line in `cordis.yml` — the same mental load as adding a
  provider adapter. Anything that lowers that friction lowers it for hostile
  code too.
- **The value of the system is the hook contract, not sandboxing.** The
  capability face in §3 is what an extension is written against; the forbidden
  list in §4 is what it is reviewed against. Neither is a security boundary
  against code already running in the process — pretending otherwise would be
  the sandbox fantasy the Ruling names.

## 2. Anatomy of an extension

An extension is three files' worth of decisions:

### 2.1 The package

A normal npm package, `type: module`, exporting a Cordis plugin — the same
shape as `@iris/llm-openai-compat` (`name`/`inject`/`Config`/`apply`,
`packages/iris-llm-openai-compat/src/index.ts:49-52`) and the same shape the
official ecosystem proves: one package, one capability, `@deepseek-ai/dsh-llm`
and `@deepseek-ai/dsh-system-prompt` being the exemplars (Ruling §5).

Dependencies stay on the contract, not on the host: an extension package may
depend on `@deepseek-ai/cordis` and `@iris/protocol` (where the capability
types live, §3) and nothing else of Iris's. This is the same reasoning as
`docs/ARCHITECTURE.md` rule 1 (`docs/ARCHITECTURE.md:25`) — the contract is
the one thing both sides import — applied to a new trust domain.

### 2.2 The `package.json` `iris:` node

Everything declarative the host needs lives here, so that the manifest a user
audits before installing is the same manifest the host reads at runtime:

```jsonc
{
  "name": "@iris/ext-cache-trace",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@iris/protocol": "workspace:*"
  },
  "iris": {
    // The contract version this manifest speaks. The host refuses a major it
    // does not know (§5.4).
    "apiVersion": 1,
    // The persistence/claim id. Must be unique across the composition; must
    // survive the same identifier rules as any directory name on disk.
    "id": "cache-trace",
    // Optional, per Ruling §3: knobs contributed to the settings drawer.
    "contributes": {
      "settings": [
        {
          "key": "keep",
          "label": "Request bodies kept per conversation",
          "type": "number",
          "default": 8,
          "min": 0,
          "max": 64
        }
      ]
    }
  }
}
```

The `iris:` node is load-bearing at runtime, not documentation: the host reads
it from the claiming package's own `package.json` (located from the
`entryUrl` the extension passes to `claim`, §3.1) and treats it as the source
of truth for id, apiVersion and contributions. An extension cannot claim more
than its manifest declares, because the claim carries no capability data at
all — only where its manifest is.

### 2.3 The plugin entry

```ts
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export const name = 'iris-ext-cache-trace'

/** The capability face is the only sanctioned dependency. */
export const inject = ['irisExtensions']

export interface Config {
  /** Row-level defaults; the settings face (Ruling §3) outranks them. */
  keep?: number
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // One call, and everything it returns is namespaced to this extension:
  // the host read id / apiVersion / contributes from this package's own
  // package.json and will refuse a claim it cannot back with a manifest.
  const ext = ctx.irisExtensions.claim({ entryUrl: import.meta.url })

  ctx.effect(() => ext.hooks.register('generation.afterSerialize', request => {
    // …write the record into ext.storage…
  }), 'cache-trace: afterSerialize')

  ctx.effect(() => ext.events.on('stream.end', event => { /* … */ }), 'cache-trace: stream.end')
}
```

Everything the extension registers is wrapped in `ctx.effect` like any other
Cordis registration, so unloading the row takes the registrations back — the
"everything is reversible" invariant (`docs/ARCHITECTURE.md:67`) applies to
extensions without exception. A registration that outlives its plugin is a
bug, not a shortcut.

### 2.4 The `cordis.yml` row

```yaml
# Request bodies kept per conversation, for cache attribution — the
# cache-trace capability, as an extension.
- id: cache-trace
  name: '@iris/ext-cache-trace'
  config:
    keep: 8
```

That is the whole from-zero footprint, and it is the PoC's acceptance bar
(Ruling, 验收 3): one `package.json`, one row. Commenting the row out is the
uninstall (§5.2).

### 2.5 Worked example: cache-trace

The first first-class extension migrates the existing cache-trace capability
out of `@iris/app-service` (the store behind the `cacheTraceKeep` row,
`apps/iris/cordis.yml:175`, implemented in
`packages/iris-app-service/src/cache-trace.ts:558`). It is the right PoC
because it exercises three quarters of the contract at once:

- **`generation.afterSerialize`** (§3.4) — the hook that observes the canonical
  request body the host is about to send, which is the whole record;
- **`storage`** (§3.2) — its own `extensions/cache-trace/` namespace with the
  retention rules the built-in store already obeys: bounded, atomically
  written, deletable, and never able to cost a generation;
- **`contributes.settings`** (§3.5) — the retention knob moves from the app
  row's `cacheTraceKeep` to the extension's own declared `keep` setting.

The rules the built-in store already carries over without change (see the
module header, `packages/iris-app-service/src/cache-trace.ts:1`): the record
is the user's prompts on the user's own disk, so it is bounded per
conversation, confined to its own subtree, and written through
`atomicWriteFile` — and an instrument that can break the thing it measures is
not one.

## 3. Capability contract v1

Ruling §2: 「扩展能触达的能力 = 宿主通过 **ctx.provide** 显式暴露的 service 接口
子集…契约外的 inject 拒绝」.

One constitutional term is mapped to a concrete mechanism here (see §8.1):
Cordis has no literal `ctx.provide`; a provided service is a named field on
the context published by a `Service` subclass — the pattern
`IrisRpcHost` already uses (`packages/iris-rpc-host/src/index.ts:174`, named
`'irisRpc'` at `:198`). The capability face is one such service:

- **Provided by** `@iris/app-service`, as `irisExtensions` — it is the plugin
  that already owns `profilePaths` (`packages/iris-app-service/src/paths.ts:266`),
  the event fan-out (`packages/iris-app-service/src/index.ts:910`) and the
  generation pipeline, so the face needs no new dependency edge.
- **Typed in** `@iris/protocol`, in a new `src/extensions.ts` module — the
  interface blocks below are that module's content when E-2 lands. The types
  live in the contract package because an extension must not depend on
  `@iris/app-service` (L3) to be typed, and nothing may depend upward
  (`docs/ARCHITECTURE.md:50`).
- **Injected as** `['irisExtensions']`, and nothing else (§4.4).

### 3.1 The claim

```ts
/** Published on the context by @iris/app-service. */
interface IrisExtensions {
  /**
   * Claim this plugin's capability face. `entryUrl` is the calling module's
   * own `import.meta.url`; the host resolves the enclosing package.json from
   * it and reads the `iris:` node. The claim carries no capability data —
   * id, apiVersion and contributions all come from the manifest — so a
   * claim cannot exceed what the audited manifest declares.
   *
   * Refusals throw, naming the package and the reason; a refused claim fails
   * the extension's own `apply` and nothing else (§5.3).
   */
  claim(options: { entryUrl: string }): ExtensionFace
}

interface ExtensionFace {
  /** From `iris.id` in the manifest. Unique per composition; re-claimed → refusal. */
  readonly id: string
  /** From `iris.apiVersion`. */
  readonly apiVersion: number
  readonly storage: ExtensionStorage
  readonly events: ExtensionEvents
  readonly hooks: ExtensionHooks
  readonly settings: ExtensionSettings
}
```

Boot log, one line per extension, so the composition explains itself:
`extensions: cache-trace claimed (contract v1, 1 hook, 1 setting)`.

### 3.2 storage — the namespace

**Where extension data lives.** Under the profile's own root, one directory
per extension, derived by the host from the one path derivation every store
already uses (`profilePaths`, `packages/iris-app-service/src/paths.ts:266`,
growing an `extensions` entry beside `cacheTrace` at `:289`):

```
<dataDir>/<profile>/extensions/<id>/
```

An extension never receives the absolute path and cannot form one. There is
no path parameter anywhere on the face.

**The API.**

```ts
interface ExtensionStorage {
  /** Read a JSON document. Absent is `undefined`, not an error. */
  read(name: string): Promise<unknown | undefined>
  /** Replace a JSON document whole. */
  write(name: string, value: unknown): Promise<void>
  remove(name: string): Promise<void>
  /** Names under this namespace, optionally by prefix. */
  list(prefix?: string): Promise<string[]>
}
```

**The rules, each of which reuses an existing discipline rather than inventing
one:**

1. **Names are relative and contained.** A `name` is `/`-separated segments;
   each segment passes the host's identifier guard — the same
   blacklist-plus-containment discipline as `isSafeId`
   (`packages/iris-app-service/src/paths.ts:47`) — and the resolved path is
   checked to still be inside `extensions/<id>/`, the belt-and-braces
   `fileFor` performs (`packages/iris-app-service/src/paths.ts:114`). One
   guard alone is one bug away from `../../`; this face gets both, because
   the guard it reuses already learned that lesson.
2. **Writes are atomic.** The face writes through `atomicWriteFile`
   (`packages/iris-app-service/src/atomic.ts:135`): a sibling temporary, then
   a rename, so a half-written document never stands where a store's own file
   should be. Extensions cannot opt out, and must not hand-roll a second
   write path (§4.3).
3. **One writer.** The face writes from inside the process that holds
   `host.lock` (`packages/iris-app-service/src/index.ts:572`) — there is no
   second write path to race.
4. **Retention is the extension's job.** The face is deliberately low-level:
   `list` + `remove` is what a bounded store builds on, the way the built-in
   cache-trace rotates its own files. The contract does not decide every
   extension's retention policy; it decides that every byte lands inside the
   namespace, atomically, or not at all.
5. **Uninstall keeps data.** Commenting out the row removes the code, not the
   data — the same decision runtime state under the installation already
   made. `extensions/<id>/` stays until the user deletes it.

### 3.3 events — the subscription

The read-only tap on the existing event bus. The vocabulary is exactly
`IrisEvent` (`packages/iris-protocol/src/events.ts:15`): `stream.start`,
`stream.text`, `stream.reasoning`, `stream.end`, `stream.error`,
`chat.updated`, `report`, `cleanup.offer`, `chats.updated`. No new event
types are defined for extensions in v1; new event types are a protocol change
and go through `@iris/protocol` like any other.

```ts
interface ExtensionEvents {
  /**
   * Subscribe by event type. Returns a disposer. The frame is delivered
   * after the browser fan-out (`packages/iris-app-service/src/index.ts:910`)
   * and is frozen: a handler that mutates it changes nothing.
   */
  on(type: IrisEventType, handler: (event: IrisEvent) => void | Promise<void>): () => void
}
```

Semantics: delivery is best-effort and side-effect-free by construction —
the host awaits each handler, a throw is logged with the extension's id and
otherwise swallowed, and no event handler can delay a generation's stream or
change what a browser receives. An extension that needs to *change* what
happens does not subscribe; it registers a hook (§3.4). Observing and
transforming are different powers with different signatures, and v1 keeps
them apart.

### 3.4 generation hooks — the first citizens

Ruling §2: 「生成管线钩子是第一公民（模板、美化类功能的服务端形态都挂这里），
钩子签名版本化（`apiVersion`），破坏性变更走新钩子名不原地改」.

The hook contract is versioned by the manifest's `apiVersion` and the hook
names themselves are versioned by *renaming*: a breaking change to a hook's
input or output is a new hook name, and the old one is removed only when its
last known consumer has migrated. Nothing in this section is ever edited in
place.

**Registration.**

```ts
type HookHandler<I, O> = (input: I) => O | Promise<O>

interface ExtensionHooks {
  /**
   * Register this extension's handler for a hook. One handler per hook name
   * per extension: a second registration is refused, with the extension's
   * id in the log.
   */
  register(name: HookName, handler: HookHandler<never, never>): () => void
}
```

**Ordering.** Entries in `cordis.yml` start concurrently and order guarantees
nothing (`apps/iris/cordis.yml:7-8`), so registration order is not a contract.
Hooks run in **extension id, alphabetical**, order — a stable, documentable
sequence that does not depend on composition order. If two extensions fight
over the same transform, the id order decides, and that is stated here rather
than discovered.

**Error semantics, for every hook: a failure keeps the original.** The host
wraps every handler; a throw, a rejected promise, or a non-conforming return
is logged as
`extensions: <id> <hook> failed (kept original): <message>`
and the generation proceeds exactly as if the extension were not installed.
A hook that can cost a turn is a hook that will eventually cost one; the
cache-trace module's own rule is the contract's
(`packages/iris-app-service/src/cache-trace.ts:36`).

**The v1 hooks.**

| hook name | kind | use |
| --- | --- | --- |
| `generation.beforeAssembly` | inject | add a system-level preamble (style directives, template-run notices) |
| `generation.afterAssembly` | transform | rewrite the assembled message list before serialization |
| `generation.afterSerialize` | observe | record the canonical request body (cache-trace's hook) |
| `generation.afterReply` | transform | rewrite the settled reply text before it is stored (prose beautify's hook) |

Draft signatures — the content of `@iris/protocol/src/extensions.ts` when
E-2 lands:

```ts
interface ExtensionMessage {
  role: 'system' | 'user' | 'assistant'
  text: string
}

// generation.beforeAssembly — runs before buildPrompt
// (`packages/iris-app-service/src/service.ts:5166` is the real turn's call site).
interface GenerationBeforeAssemblyInput {
  apiVersion: 1
  chatId: string
  /** Upstream's vocabulary: 'normal' | 'continue' | 'impersonate' | … */
  generationType: string
  characterName: string
  userName: string
}
interface GenerationBeforeAssemblyResult {
  /** Appended after the system-prompt registry's own block. */
  systemPreamble?: string
}

// generation.afterAssembly — runs on the assembled, post-macro, post-template
// message face, before serialization.
interface GenerationAfterAssemblyInput {
  apiVersion: 1
  chatId: string
  generationType: string
  messages: readonly ExtensionMessage[]
}
interface GenerationAfterAssemblyResult {
  /** Replacement. Wrong shape → refused, original kept, extension named. */
  messages?: readonly ExtensionMessage[]
}

// generation.afterSerialize — observational; the return value is ignored
// beyond error handling. This is the hook the cache-trace PoC records with.
interface GenerationAfterSerializeInput {
  apiVersion: 1
  chatId: string
  /** What the host calls this request in its traces ('normal', 'send', …). */
  kind: string
  /** The canonical body exactly as serialized for the provider. */
  body: string
  /** The body's fingerprint, the record's join key across turns. */
  fingerprint: string
}

// generation.afterReply — runs on the settled reply, before it is persisted
// and before the `stream.end` view is broadcast
// (`packages/iris-app-service/src/service.ts:4941`). 'aborted' turns get no
// hook: an aborted reply is not a reply.
interface GenerationAfterReplyInput {
  apiVersion: 1
  chatId: string
  turn: number
  reason: 'completed'
  text: string
}
interface GenerationAfterReplyResult {
  text?: string
}
```

Two honest notes on scope:

- **Transforms on the input side spend cache money.** Anything
  `afterAssembly` changes changes the bytes a provider's prefix cache is
  computed over — the whole subject of `CACHE-PREFIX.md`. Text-shaping
  features that care about cache stability (beautify among them) belong on
  `afterReply`, where the request bytes are already gone. The contract says
  so here because the cheapest way to get a beautiful prompt is also the
  most expensive way to run a conversation.
- **The span map is not in v1.** The built-in cache-trace records a
  byte-offset → assembly-part map built from host internals
  (`packages/iris-app-service/src/cache-trace.ts:366` is the reader side).
  Whether that face belongs in the hook payload is exactly the question the
  PoC exists to answer; if it does, it arrives as a new hook
  (`generation.afterSerializeDetail` or similar), not as a field bolted onto
  this one.

### 3.5 settings — the contributed face

Ruling §3: 「扩展可向设置抽屉/阅读卡贡献**开关与简单控件**…第一版**不做**自定义
DOM/任意 React 组件贡献」.

**Declaration** (in the manifest, §2.2): each entry carries `key`, `label`,
`type`, `default`; the control types are a whitelist of exactly four, matched
one-to-one by the field components the shell already renders:

| `type` | rendered by | extras |
| --- | --- | --- |
| `toggle` | `ToggleField` (`apps/iris-web/src/app/fields.tsx:268`) | — |
| `choice` | `ChoiceField` (`apps/iris-web/src/app/fields.tsx:146`) | `choices: string[]` (required) |
| `number` | `NumberField` (`apps/iris-web/src/app/fields.tsx:42`) | `min`, `max`, `step` (optional) |
| `text` | `TextField` (`apps/iris-web/src/app/fields.tsx:111`) | — |

`token` (optional, per the Ruling's 「token 类名」) names a design-token class
from the shell's own set for the section's accent; anything outside the
shell's token set is refused, because a third-party class name is CSS injection
by another spelling. No custom DOM, no arbitrary React — a contribution that
needs those is not a setting, and this contract does not have a door for it.

**Rendering.** The host exposes the aggregated face over three RPC methods,
registered alongside the rest (`packages/iris-app-service/src/index.ts:967`
is the registration site):

- `extension.list` → the installed extensions, each with its id, apiVersion
  and settings declarations (current values included);
- `extension.settings.get` → one extension's current values;
- `extension.settings.set` → `{ id, key, value }`.

The shell renders one `CollapsibleSection` per extension that contributes
settings, at the drawer's bottom seam — the `Slot` already mounted there
(`apps/iris-web/src/app/SettingsDrawer.tsx:593`) — using the four field
components above and no others. The seam is build-time Iris code; what flows
through it is data, which is the whole point of Ruling §3.

**Persistence.** Values live in `extensions/<id>/settings.json` inside the
namespace (§3.2), written through the same atomic path, with the same
containment. The persistence key namespace belongs to the extension by
construction: the file is the extension's, the keys inside it are validated
against its declared settings, and nothing the host owns shares the file.
`extension.settings.set` validates the pair against the declaration — unknown
extension, unknown key, or a value that fails the declared type/bounds is
refused, and the refusal names the extension and the key.

**Precedence.** The settings file (the user's runtime choice) outranks the
extension's `cordis.yml` row `config`, which supplies only defaults — the
same ruling the preset selection already made
(`packages/iris-app-service/src/index.ts:875-877`: a persisted choice outranks
the composition's file, because a restart that snapped back would make the
picker a preference the host forgets). The extension reads current values
through `settings.all()` and can observe changes:

```ts
interface ExtensionSettings {
  all(): Record<string, unknown>
  onChange(handler: (values: Record<string, unknown>) => void): () => void
}
```

## 4. Forbidden list and guards

Ruling §4: 「禁区（任何扩展不得触碰，宿主在 provide 时拒绝）」. Each item of the
list, and the mechanism that guards it — with the honest note that in-process
code cannot ultimately be *stopped*, which is why the Ruling's trust model is
"install-is-host-privilege". The guards below are guards on the **contract**:
they make the right thing the only thing the face can express, and they make
every refusal loud and attributable.

### 4.1 Filesystem paths

「原始文件系统路径直读用户数据之外的位置」.

The capability face has no path parameter at all (§3.2). A storage name is a
relative, validated, contained name inside `extensions/<id>/`; there is no
API by which an extension asks for a directory, a dataDir, a
`sillyTavernDir`, or anything outside its namespace. `claim` re-checks the
manifest on every boot, and a manifest whose `iris.id` would fail the
identifier guard (`packages/iris-app-service/src/paths.ts:47`) is refused at
boot with the package named.

### 4.2 Credentials

「密钥明文读取（走 connection 服务得脱敏面）」.

There is **no credential face in v1** — the strongest form of "refuse at
provide" is absence. An extension that wants provider identity gets nothing;
when a connection face lands, it will be the sanitized wire face only —
`hasKey` and `keyTail` (`packages/iris-app-service/src/connections.ts:333`),
never the plaintext the key-protection envelope seals
(`notes/SECURITY-REMEDIATION.md` records that work as F4/§75). This document
pins the v1 absence so a later "convenient" passthrough has to argue against
a written line.

### 4.3 The second write path

「绕过 host.lock 的第二写入路径」.

The whole-file-rewrite stores inside this host are safe only because one
process holds `host.lock` (`packages/iris-app-service/src/index.ts:572`) and
every write goes through it. The extension storage face writes from inside
that process, through `atomicWriteFile`, and that is the only sanctioned
write path. An extension opening its own file handles, spawning writers, or
calling into Node `fs` directly is out of contract; for in-repo extensions
that is caught by review and by the drift test (§4.4), and for third-party
code it is exactly the trust model — which is why §1 says what it says
before anything else.

### 4.4 Contract-external inject

「契约外的 inject 拒绝」.

Cordis will resolve any provided service into any plugin's `inject` — that is
what a DI kernel is for — so "refuse" is enforced at three points that
actually hold:

1. **Claim-time validation (mechanical, always on).** Unknown `apiVersion`,
   missing `iris:` node, un-unique or unsafe id, settings contributions
   violating the §3.5 whitelist — each is a refusal that throws inside the
   extension's own `apply`, with the log line naming the package and the
   reason. The host never carries a half-claimed extension.
2. **Registration-time validation (mechanical, always on).** Unknown hook
   name, second registration of a hook, out-of-whitelist control type —
   refused with the extension id in the log, per §3.
3. **The drift test (mechanical, for in-repo extensions).** The composition
   test already parses `cordis.yml` and holds its lines
   (`apps/iris/tests/composition.test.ts:67`); the same suite pins that every
   extension package in this repo declares `inject = ['irisExtensions']` and
   that its runtime claim matches its manifest — the pattern the allowlist
   drift test uses (`apps/iris-web/tests/allowlist-drift.test.ts`).

For third-party code, point 3 does not exist and points 1-2 do not bind
`inject` itself. That gap is not an oversight; it is Ruling §4's premise, and
the reason the door stays "user runs `pnpm add` themselves" instead of
becoming a button.

### 4.5 The card-script face

Ruling §1: 「卡脚本面（TH/ST 兼容）是**已被占用的扩展点**…扩展系统不开放它」.
The capability face exposes none of the 171+ member Tavern Helper/ST compat
surface; those members stay where they are, in the compat layers
(`@iris/compat-tavernhelper` and friends), with their own compatibility
commitment. An extension asking for them is refused at claim time with the
refusal naming this section.

## 5. Lifecycle

### 5.1 Install and load

1. `pnpm add <package>` (workspace packages: add the package, then the row).
2. One row in `apps/iris/cordis.yml` (§2.4).
3. Boot: rows start concurrently (`apps/iris/cordis.yml:7-8`); the extension
   injects `irisExtensions`, which is what sequences it after the app row
   without anyone writing down an order. `claim` runs in the extension's own
   `apply`; the boot log carries one line per extension (§3.1).

### 5.2 Disable and uninstall

- **Uninstall** = comment out the row. The PoC's own acceptance bar (Ruling,
  验收 2): 「可注释掉整行即卸载」. The effect disposers take every hook,
  event and settings listener back (§2.3); the data namespace stays (§3.2
  rule 5).
- **Disable** = `disabled: true` on the row, the spelling the frontend row
  already uses (`apps/iris/cordis.yml:184-185`) — for keeping a package
  installed and configured while it is not running. Commenting out is for
  removal; `disabled` is for pause. A user who wants to keep the YAML visible
  while paused may also just comment it; the two are equivalent to the host.

### 5.3 Failure isolation

A refused claim or a throwing `apply` fails the extension's own fiber and is
reported by Cordis; the host's own rows keep running. A refused claim must
never take the host down with it — a broken extension is a row to comment
out, not a boot failure to debug. (The corollary is §4.1's: refusals happen
at claim time, before the extension holds any registration, so there is
nothing to unwind.)

### 5.4 Version upgrades

- **Contract minor evolution** (new hook names, new event types, new optional
  manifest fields): additive, announced in §7's changelog, no action needed
  from existing extensions.
- **Contract major break** (`iris.apiVersion` the host does not support):
  `claim` refuses at boot, the log names both numbers —
  `extensions: <id> declares contract v2, this host speaks v1; row ignored` —
  and the extension stays unloaded, cleanly, until its manifest is updated.
  Its data namespace is untouched. There is no half-loaded state to reason
  about, because the claim is the first thing that happens.
- **Hook breakage** follows the Ruling's own rule: a breaking change to a
  hook is a new hook name (`generation.afterAssembly` v2 would be
  `generation.afterAssemblyV2` or a better name), never an edit. Old names
  are removed only after their last known consumer has migrated, and the
  removal is a changelog line here before it is a deletion in code.

## 6. Acceptance accounting

Against the Ruling's four completion checks (`notes/EXTENSION-SYSTEM-RULING.md:47`):

1. **`docs/EXTENSIONS.md`: 契约文档** — this file: capability face (§3),
   hook signatures (§3.4), contribution syntax (§3.5), forbidden list (§4),
   lifecycle (§5).
2. **第一个一等扩展把现有某能力搬出去** — §2.5 specifies the cache-trace
   migration as the worked example and pins the three contract pieces it
   exercises (`afterSerialize`, storage namespace, settings contribution).
   Whether the built-in `cacheTraceKeep` row is retired in the same PR or
   after a soak period is the PoC PR's decision to propose; the row's schema
   default (`packages/iris-app-service/src/index.ts:422`) stays honest either
   way.
3. **从零接入 ≤ 一行 + 一个 package.json** — §2.4 is the whole footprint;
   nothing else is required of an extension author.
4. **既有纪律不回退** — the document cites only files that exist (verified
   against the tree; the checker is
   `apps/iris/tests/md-references.test.ts:114`), keeps the composition test's
   authority over `cordis.yml` (`apps/iris/tests/composition.test.ts:67`),
   builds every registration on `ctx.effect` so the reversibility invariant
   holds (`docs/ARCHITECTURE.md:67`), and adds no dependency edge that
   `docs/ARCHITECTURE.md` does not already allow (the contract types go in
   `@iris/protocol`, L0; the implementation lives in `@iris/app-service`, L3,
   which already reaches everything it needs).

## 7. Non-goals

Each with the Ruling line that closed it:

- **UI plugins / runtime frontend injection.** Ruling §1: the shell product is
  build-time, and 「运行时往页面注入第三方 JS 等于把 style-src-elem 那类边界
  全部重开」. The card frames already pay for the sandbox this makes necessary
  (`docs/SANDBOX.md`); the shell does not get a second one.
- **Settings contributions beyond the four whitelisted controls.** Ruling §3,
  same sentence: custom DOM or arbitrary React components are frontend
  pluginization through the back door.
- **Marketplace, auto-install, one-click anything.** Ruling §4: the install
  ceremony (`pnpm add` + one YAML row) **is** the consent dialog, and it is
  deliberately a ceremony.
- **Opening the card-script face to extensions.** Ruling §1: the TH/ST surface
  is a 171+ member compatibility commitment owned by the compat layers.
- **Sandboxed extension isolation.** Ruling §4: 「Node 进程边界内没有便宜的
  隔离」. The value is the contract, not a containment that would be fiction.
- **Following upstream ST's extension model.** Ruling §5: upstream's
  extensions are UI plugins — exactly what Ruling §1 excludes — so the
  precedent followed is Cordis's own plugin ecosystem instead.

## 8. Suggested amendments to the Ruling

None of these block the design; they are recorded for the 总指挥 to rule on,
per the working agreement that the Ruling is not changed here.

1. **「ctx.provide」 is a description, not an API.** Cordis exposes provided
   capabilities as named context fields published by `Service` subclasses
   (`IrisRpcHost` is the in-repo proof,
   `packages/iris-rpc-host/src/index.ts:174`). This document implements
   Ruling §2 as one such named service, `irisExtensions`. No change of intent
   is needed — only the mapping recorded here so future readers of the
   Ruling do not go looking for a method that does not exist.
2. **§4.1 could be tightened to "extensions hold no paths".** The Ruling's
   wording forbids reading locations outside user data via raw filesystem
   paths; the mechanism this document ships is stronger — the capability face
   has no path parameter at all. If the Ruling is ever revised, writing
   「扩展面不出现路径」 as the rule (a tightening, not a relaxation) would
   make the mechanism and the constitution say the same thing.
3. **Setting-declaration extras.** Ruling §3 lists 「标签、键、类型、默认值、
   token 类名」. This contract adds per-type extras (`choices` for choice,
   `min`/`max`/`step` for number) as required-or-optional fields of the same
   four whitelisted control types, not as new control types. If the 总指挥
   reads 「简单控件」 as excluding numeric bounds, dropping the extras leaves
   every other part of this document standing.

## 9. Contract changelog

| version | change |
| --- | --- |
| v1 | Initial contract: claim, storage namespace, event subscription, hooks `generation.beforeAssembly` / `generation.afterAssembly` / `generation.afterSerialize` / `generation.afterReply`, settings contribution with the four-control whitelist. |
