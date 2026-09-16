# System plugins

> 状态：现状文档。描述 `main` `e356771` 的现状，核对于 2026-09-16。数字与路径以该提交为证据；行号会漂移，符号名不会。

## 本文与其他文档的关系

本文是系统插件的**架构裁决记录**，只拥有三件事：生命周期契约、所有权划分、信任模型。
其余的事各有归属，本文引用而不复述：

| 要找什么 | 去哪 |
| --- | --- |
| 可调用的接口目录，以及**唯一维护的缺口清单** | [INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md)（§8 是那份清单；本文不另立第二份） |
| 插件包安装路径的设计与落地记录 | [SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) |
| 作者视角的制作与操作步骤 | [PLUGIN-AUTHORING-RUNBOOK](PLUGIN-AUTHORING-RUNBOOK.md) |
| 契约包的发布形（tarball、版本策略） | [PLUGIN-CONTRACT-PACKAGING](PLUGIN-CONTRACT-PACKAGING.md) |
| ST 扩展兼容面的设计与施工合同 | [ST-EXTENSION-DESIGN-AND-RUNBOOK](ST-EXTENSION-DESIGN-AND-RUNBOOK.md) |
| 生成钩子（设计已裁决，实现未开始） | [GENERATION-HOOKS](GENERATION-HOOKS.md) |

Architecture decision, first written 2026-09-12; re-read against the code at
`e356771` on 2026-09-16. Everything below describes code that exists, so the
document is written in the present tense throughout — a sentence here that reads
as a plan is a bug in this file.

Delivery ownership: `notes/SYSTEM-PLUGINS-ACCEPTANCE.md`. Results:
`notes/PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md` (host runtime, dynamic RPC,
`/plugins` assets, member merge, stale-revision isolation),
`notes/st-compat/PILOT-REPORT.md` (the ST extension pilot) and
`notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md` (the package install path driven
in a real browser).

## Purpose

Iris owns a system-level plugin lifecycle. Tavern Helper and MVU are its first
bundled plugins. Their existing compatibility packages remain the implementation
of their algorithms and public APIs; the host supplies replaceable capabilities
and lifetime boundaries instead of calling them unconditionally.

A card script is content executed within the existing sandbox. A system plugin
owns a capability that such content may need. Installing or enabling a system
plugin does not grant a card permission to execute scripts or access the network.

## The contract packages

What a plugin is, and what a frame is born with, are published contracts, not
host internals. They moved out of the transition sites named in
`notes/SYSTEM-PLUGINS-HANDOFF.md` (superseded by #88 and kept as a historical
draft; its 「必须保持的行为合同」 section still stands) — the move is a move, so there is exactly one
`SystemPluginDefinition` in the repository.

- **`@iris/plugin-api`** — the host-side contract: `SystemPluginDefinition`
  (`apiVersion`-gated, dependency-declaring), the `SystemPluginActivationScope`
  a definition's `activate` receives (provide and getDependency over namespaced
  capabilities on a Cordis child fiber), the `SystemPluginLease` a unit of
  admitted work holds across drain, and the runtime construction options. It
  has no `@iris` dependencies — a plugin package can be typed against the
  contract and the framework alone — and its sources may import nothing at
  runtime.
- **`@iris/plugin-web-api`** — the browser-side face: the
  `SandboxPluginRuntime` capability snapshot a sandbox frame is born with, the
  meta name it travels under, and the codec the shell (srcdoc writer) and the
  frame bootstrap (reader) must use identically. Its only Iris dependency is
  `@iris/protocol`, as types only, so importing it drags nothing into the
  browser.

Dependency direction: `app-service → plugin-api`, `iris-web → plugin-web-api`.
The wire projection (`SystemPluginSnapshot`, `SystemPluginView`) stays in
`@iris/protocol`; the runtime implementation — catalog, dependency ordering,
serialized transitions, persistence, Cordis fibers, drain — stays in
`@iris/app-service`.

This document and `@iris/plugin-api` describe *what a plugin is and how it
activates* — one layer earlier in the paper stack than the runtime services a
plugin may reach once it is active. Two of those services now exist on `main`
(`scope.storage`, a private key–value store under the profile; and
`scope.variables.registerWriter`, the settlement's writer registry); a settings
face, generation-pipeline hooks and an open `ScriptContext` do not. Which is
which is maintained in one place only — `docs/INFRASTRUCTURE-INTERFACES.md` §8 —
and this file does not keep a second copy.

The third-party extension design that named them, `docs/EXTENSIONS.md`, was
never on `main`; it lived on the `dev/feat-extension-system` branch, which was
retired on 2026-09-16, and the document is kept as a record at
[notes/archive/EXTENSIONS.md](../notes/archive/EXTENSIONS.md) together with its
ruling, [notes/archive/EXTENSION-SYSTEM-RULING.md](../notes/archive/EXTENSION-SYSTEM-RULING.md).
It is history, not a contract: the plugin platform (#88) superseded it. What survives the branch is the shared vocabulary,
which is kept here rather than cited: one control plane, whether the
implementation shipped with Iris or arrived from outside; and one versioning
device, the `apiVersion` on a `SystemPluginDefinition`, which a breaking change
replaces with a new version rather than editing in place. There is one
registry — a dynamic extension contributes through this contract's
install/activate paths, not beside them, and the ST extension pilot is the
worked case: an installed ST extension becomes a `SystemPluginDefinition` and
goes through the same catalog (`docs/INFRASTRUCTURE-INTERFACES.md` §7).

## Authority and scope

The user requested runtime management and extraction of Tavern Helper and MVU.
This supersedes the static-only lifecycle proposed on the unmerged
`dev/feat-extension-system` design branch. There is one plugin control plane;
future extension hooks must attach to it, not create a second registry.

A definition reaches the catalog by one of three routes, and the registry does
not assume every row is one of the two builtins:

1. **Shipped with Iris** — `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`
   (`packages/iris-app-service/src/plugins/builtins.ts`), the seed the runtime
   is constructed with. For these, install and uninstall mean attaching and
   detaching an implementation that is already on disk: they download nothing
   and remove no source file from the Iris installation, and uninstall retains
   chats, variable snapshots and preferences, so a builtin can be installed
   again from the catalog.
2. **Adopted after start, as an ST extension** — `SystemPluginRuntime.adoptDefinition`
   (`packages/iris-app-service/src/system-plugins.ts`), which admits a
   definition the process was not constructed with.
   `buildStExtensionDefinition` shapes an installed SillyTavern extension into a
   `SystemPluginDefinition`, and from there it uses the same catalog, dependency
   graph, enable/disable and uninstall as a builtin — there is no second
   lifecycle. That route *does* write to disk (an installed tree under the data
   directory) and can fetch over the network. Uninstalling one retains the
   installed tree and its settings file, because both are user data.
3. **Installed as an out-of-repository package** — the install path landed in
   PRs 1–3 of [SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §10 and finished
   by the second batch (U1's `plugin.update`, U5's copy bundles, U6's installer
   hardening). A directory whose `package.json` carries an `iris.plugin` block
   is staged from an https git remote pinned to a full commit, or loaded in
   place from a local `dev` directory, previewed, consented to, and promoted
   into `<profile>/system-plugins/installed/<id>/`. It then uses the same
   catalog and lifecycle as the other two. Unlike route 2, uninstalling a `git`
   row **deletes the tree** — a plugin tree is a reproducible read-only artifact,
   not user data — while a `dev` row's directory is never touched.

There is no fourth route. An npm name and an arbitrary tarball URL are refused
by design ([SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §11), not missing.

The shell renders plugin metadata and management controls using its own
components. Card-authored JavaScript continues to execute in the existing
sandbox. This refactor does not promote that code into the Node host.

## Ownership

| Owner | Responsibility |
| --- | --- |
| Plugin runtime | Catalog, dependency graph, serialized transitions, persistence, actual activation/disposal, status and errors |
| Tavern Helper plugin | Compatibility facade and its owned script lifetimes, registrations and listeners |
| MVU plugin | Initialization, variable-command interpretation, update and replay capability |
| Chat persistence | Existing chat and variable data, independent of plugin installation |
| Plugin center | Projection of host state and explicit user commands |

Both bundled plugins are installed and enabled when an existing profile has no
plugin preferences. Existing script-consent decisions still apply. MVU depends
on Tavern Helper for its card-facing integration; the dependency is visible.

## Lifecycle contract

The six catalog operations are list, install, enable, disable, reload and
uninstall. Their requests name a catalog id; they do not carry source code or a
filesystem path. The four install-path methods (`previewInstall`,
`confirmInstall`, `cancelInstall`, `update`) are the one place a request does
carry a source, and they are a separate contract with its own consent step —
see [SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §5 and, for the wire
shapes, `docs/INFRASTRUCTURE-INTERFACES.md` §3.

1. Transitions are serialized. A status marked enabled means activation completed.
2. Enabling resolves dependencies in order. Unknown ids, cycles, unsupported
   contracts and activation failures produce attributable errors.
3. Disabling, reloading or uninstalling a dependency with enabled dependents is refused.
   The error identifies the dependent that must be disabled first.
4. Disabling prevents new plugin work, invalidates its old execution lifetime,
   and disposes registrations. Cleanup is still permitted during teardown.
5. Reload performs teardown and activation without restarting Iris. Repeated
   cycles must not accumulate listeners, injections or background work.
6. Uninstall retains chats, variable snapshots and the plugin's own private
   storage under `<profile>/plugin-data/<id>/`. A bundled plugin keeps its
   preference row and can be installed again from the catalog; an ST extension
   keeps its installed tree and settings file. A row installed as a package is
   the one exception the install path decided on deliberately: the whole row is
   removed and, for a `git` source, its tree is deleted — the reasoning is in
   [SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §6, and the runtime tells
   the two apart by `removable`.
7. Failed activation must not retain half-registered capabilities. Failed
   transitions must not persist a successful state that did not occur.

The host publishes versioned snapshots. The browser reconciles from the host,
including on reconnect; it must not confuse a new host process with an older
snapshot of the previous process. An iframe from an earlier plugin lifetime must
not be able to commit a delayed write after a disable/re-enable cycle.

The runtime uses real Cordis child fibers and owned effects. The installed
Cordis 4.0.2 exposes `ctx.provide`, `ctx.plugin`, `fiber.dispose` and
`fiber.restart`; the earlier extension draft's claim that `ctx.provide` was
unavailable does not apply to this dependency. Capability registrations are
owned by the providing incarnation, so a delayed old disposer cannot withdraw
its replacement.

The activation scope also carries `registerRpc` (landed 2026-09-13, on `main`
in #88): a plugin contributes a wire method without touching the static
protocol. The request
schema goes into `@iris/protocol`'s runtime registry and the handler onto the
transport — paired, so a method is never half-registered — and both halves are
effects of the activation's own fiber, so disposal takes them whether or not
the plugin kept the returned handle. Every call is admitted through the
plugin's lease: a disabled plugin's method answers `unsupported`, a stale
`pluginRevision` is refused, and a disable drains in-flight calls before the
registration goes. A method name is a composition-level fact: colliding with a
built-in or another registration throws inside the arriving plugin's
`activate`, failing that plugin and nothing else. The static vocabulary stays
the host's own claim — `Handlers` remains total — and a capability moving out
to a plugin takes its schemas to the registry, shrinking `RpcMethod` by the
same keys.

The mechanism still has no production consumer at `e356771`: every method a
shipped plugin answers is a static schema in `@iris/protocol`, and the only
caller of `scope.registerRpc` anywhere in the tree is
`packages/iris-app-service/tests/system-plugin-rpc.test.ts` (the protocol half,
`registerRequestSchema`, is separately exercised by
`packages/iris-protocol/tests/rpc-registry.test.ts`). It is a built path, not a
used one.
（口径：`grep -rn "\.registerRpc(" --include=*.ts packages/*/src apps/*/src` 为空。）

## Compatibility boundaries

Disabling Tavern Helper removes its optional API and stops its owned scripts.
Native chat and base message rendering remain available. Missing capabilities
must be identifiable; they must not fail later as an unexplained missing method.

Disabling MVU stops its automatic initialization, update and replay — and,
since the variable-writer registry (U2), the mechanism is stronger than a flag
check: disabling disposes the activation's fiber, the fiber disposal removes
MVU's registered writer, and a disabled plugin is thus *absent from the
settlement participant set*, not merely silent inside it. Stored variables
remain readable as data and are not cleared. Re-enabling uses persisted state
without applying historical commands a second time.

Cards may bundle remote MVU code, and a disable is accounted for separately
from it. What a disable revokes is named: the host-side capability, so
initialization, command interpretation and replay stop, and the frame's MVU
global surface, which disappears independently of Tavern Helper's — both
exercised by the sandbox cases in
`notes/PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md`. What it does not revoke is a
copy of MVU a card fetched and published itself; stopping the host algorithm
does not stop a still-running bundled script, and a filename guess is not an
execution boundary. No acceptance case on `main` puts a card carrying its own
MVU bundle through a disable, so **full MVU hot-unload is not claimed** — the
claim would need that case, and it is listed under "Not yet built".

## Trust model (信任模型)

Written down 2026-09-15. This is not a new decision: it is the one practice has
settled into over the platform's landing, recorded because until now it existed
only as behaviour. Two privilege lines share one control plane.

**A system plugin is same-privilege Node code.** Its `activate` runs in the
host process on a Cordis child fiber with the host's own reach — filesystem,
network, the service graph — and nothing sandboxes it. What limits the risk is
therefore not a sandbox but *where the code came from*, and today there are
exactly two origins: `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`, which is this
repository's own source, and an installed ST-extension tree adopted through
`adoptDefinition`, which the ST installer put on disk.

**ST extension code is sandboxed.** It runs in the shell's hidden iframe under
`sandbox="allow-scripts allow-downloads"`
(`apps/iris-web/src/st-extensions/plane.tsx`), against facades rather than
SillyTavern's own modules, and a card frame cannot reach it directly. The only
path from a card is the generated member proxy
(`packages/iris-compat-st-extension/src/host/member-bundle.ts`): one member,
`EjsTemplate`, whose every method posts a `member-call` envelope through the
tokened channel for the extension frame to answer. No upstream code runs in the
card frame and no card code runs in the extension frame. Note what this means
for the host half of an ST extension: the *definition* wrapping it is
same-privilege by the paragraph above, while the extension's own JavaScript is
not — the sandbox is around the code, not around the catalog row.

**What constrains the install source of same-privilege host code — settled
2026-09-15, landed.** The question this section used to leave open (owner: the
coordinator) was answered by the five rulings in
[SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §12 and is now code. The
answer in one paragraph, with that document as the authority for every detail:

- **No host allowlist for `git` sources.** Card code is confined by an allowlist
  of two remote hosts — `REMOTE_ALLOWLIST = ['*.jsdelivr.net',
  'raw.githubusercontent.com']` (`apps/iris-web/src/sandbox/policy.ts`),
  re-checked on the host per hop by `checkScriptFetch` — because a card is
  *content*: opening one is not a decision to run somebody's code. Installing a
  system plugin is that decision, so the compensating control is the consent
  step, not a list.
- **What replaces the list is the bytes.** An install takes an https remote and
  a full 40-hex commit (`assertPinnedCommit`,
  `packages/iris-extension-installer/src/source.ts`), fixed argv with no shell,
  hooks path emptied, no submodules; the promoted tree is hashed (`hashTree`)
  and that hash is re-computed at every boot, a mismatch parking the row as
  `tampered` without importing anything.
- **`dev` is the one exception and is marked as one**, in three places (the
  preference file, the catalog row, the consent page), because it is the single
  source whose bytes are never re-verified.

This closes `notes/PLUGIN-FEASIBILITY.md` §8 question 1, which posed the choice
as "two CDNs, hash-locked, rather than an arbitrary `git clone`". Note what was
*not* adopted from it: "hash-locked" on the card path still is not true — what
is hashed there is the *URL*, as a cache file name (`cacheKey`,
`packages/iris-app-service/src/script-cache.ts`), not the bytes. The plugin path
hashes bytes; the card path was deliberately left alone.

## Acceptance requirements

Verified for the platform as it landed: see
`notes/PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md`, which passes all seven
behaviour groups with per-row evidence, and `notes/st-compat/PILOT-REPORT.md`.
The list is kept as the standing criteria a change to the control plane is
re-checked against, not as work outstanding.

- Plain chat works with both optional plugins disabled.
- Existing compatible cards behave as before with both enabled.
- Enable, disable, enable and reload cycles leave one live registration set.
- An enabled dependent prevents removal of its dependency.
- State survives restart; fresh and migrated profiles retain existing defaults.
- Uninstall and reinstall preserve chat and variable data.
- Failure during activation is isolated and reported accurately.
- Delayed requests from a previous lifetime cannot write after re-enable.
- Current and reconnecting browsers converge on the host's plugin state.
- The plugin center provides English and Chinese labels, keyboard-accessible
  actions, dependencies, pending states and actionable errors.
- Root and web typechecks, web build, render checks, full tests and the
  no-corpus gate pass on the integrated tree.

## Not yet built (尚未实现)

**This section is a pointer, on purpose.** It used to carry its own list, and
the list went stale: between 2026-09-15 and 2026-09-16 four of its seven bullets
landed while the bullets stayed. The maintained list — with per-row completion
conditions, graduated rows and their landing evidence — is
`docs/INFRASTRUCTURE-INTERFACES.md` §8, and it is the only one. If you are
reading this file to find out what is missing, go there.

Two consequences of that list belong to *this* document's own claims, so they
are stated here rather than only implied:

- **Full MVU hot-unload is not claimed**, for the reason in "Compatibility
  boundaries": no acceptance case puts a card carrying its own MVU bundle
  through a disable.
- **A settings face and generation hooks do not exist on the activation scope**,
  so the "Lifecycle contract" above is the whole of what a plugin can rely on
  beyond `provide` / `getDependency` / `registerRpc` / `variables` / `storage`.
  The hooks design is decided but unimplemented: [GENERATION-HOOKS](GENERATION-HOOKS.md).
