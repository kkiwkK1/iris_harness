# System plugins

Architecture decision, 2026-09-12; re-read against the code on 2026-09-15. What
it describes is on `main` as `2eccf30` (PR #88, "Add the system plugin platform
and ST extension pilot"), so the document is written in the present tense
throughout and everything still open is gathered under "Not yet built" at the
end — a sentence here that reads as a plan is a bug in this file.

Delivery ownership: `notes/SYSTEM-PLUGINS-ACCEPTANCE.md`. Results:
`notes/PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md` (host runtime, dynamic RPC,
`/plugins` assets, member merge, stale-revision isolation) and
`notes/st-compat/PILOT-REPORT.md` (the ST extension pilot). The live interface
surface, and the authoritative list of what is missing, are
`docs/INFRASTRUCTURE-INTERFACES.md` §8 — that table is maintained per change
and this section is not, so where the two disagree it wins.

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
`notes/SYSTEM-PLUGINS-HANDOFF.md` — the move is a move, so there is exactly one
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
plugin may reach once it is active (a storage namespace under the profile, an
event tap, generation-pipeline hooks, a contributed settings face). None of
those four services exists on `main`; see "Not yet built".

The third-party extension design that named them, `docs/EXTENSIONS.md`, **is
not on `main`.** It lives only on the unmerged `origin/dev/feat-extension-system`
branch, so a reader here cannot open it and nothing in this repository's
document checks covers it. What survives the branch is the shared vocabulary,
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

A definition reaches the catalog by one of two routes, and the registry does
not assume every row is one of the two builtins:

1. **Shipped with Iris** — `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`
   (`packages/iris-app-service/src/plugins/builtins.ts`), the seed the runtime
   is constructed with. For these, install and uninstall mean attaching and
   detaching an implementation that is already on disk: they download nothing
   and remove no source file from the Iris installation, and uninstall retains
   chats, variable snapshots and preferences, so a builtin can be installed
   again from the catalog.
2. **Adopted after start** — `SystemPluginRuntime.adoptDefinition`
   (`packages/iris-app-service/src/system-plugins.ts`), which admits a
   definition the process was not constructed with. Every call site on `main`
   is the ST extension compatibility face: `buildStExtensionDefinition` shapes
   an installed SillyTavern extension into a `SystemPluginDefinition`, and from
   there it uses the same catalog, dependency graph, enable/disable and
   uninstall as a builtin — there is no second lifecycle. That route *does*
   write to disk (an installed tree under the data directory) and can fetch
   over the network, which is where the install-source question in "Trust
   model" comes from. Uninstalling one retains the installed tree and its
   settings file, because both are user data.

There is no third route: a Node system plugin is either in
`BUILTIN_SYSTEM_PLUGIN_DEFINITIONS` or it arrives as an ST extension. Package
discovery and distribution for host-side plugins — an npm name, a Git URL —
are not built; see "Not yet built".

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

The public operations are list, install, enable, disable, reload and uninstall.
Requests name a catalog id; they do not carry source code or a filesystem path.

1. Transitions are serialized. A status marked enabled means activation completed.
2. Enabling resolves dependencies in order. Unknown ids, cycles, unsupported
   contracts and activation failures produce attributable errors.
3. Disabling, reloading or uninstalling a dependency with enabled dependents is refused.
   The error identifies the dependent that must be disabled first.
4. Disabling prevents new plugin work, invalidates its old execution lifetime,
   and disposes registrations. Cleanup is still permitted during teardown.
5. Reload performs teardown and activation without restarting Iris. Repeated
   cycles must not accumulate listeners, injections or background work.
6. Uninstall retains chats, variable snapshots and plugin preferences. A bundled
   plugin can be installed again from the catalog.
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

The mechanism has no production consumer on `main`: every method a shipped
plugin answers is still a static schema in `@iris/protocol`, and `registerRpc`
is exercised only by its own tests
(`packages/iris-protocol/tests/rpc-registry.test.ts`,
`packages/iris-app-service/tests/system-plugin-rpc.test.ts`). It is a built
path, not a used one.

## Compatibility boundaries

Disabling Tavern Helper removes its optional API and stops its owned scripts.
Native chat and base message rendering remain available. Missing capabilities
must be identifiable; they must not fail later as an unexplained missing method.

Disabling MVU stops its automatic initialization, update and replay. Stored
variables remain readable as data and are not cleared. Re-enabling uses persisted
state without applying historical commands a second time.

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

**Open question — what constrains the install source of same-privilege host
code.** Undecided. Owner: the coordinator, to be settled together with the
system-plugin install path (`docs/INFRASTRUCTURE-INTERFACES.md` §8, the row
「系统插件的包外安装路径」 — an install route for a system plugin from outside
this repository). The two answers already in the tree disagree, and neither was
chosen as *the* rule for host code:

- Card code is confined by an allowlist of two remote hosts —
  `REMOTE_ALLOWLIST = ['*.jsdelivr.net', 'raw.githubusercontent.com']`
  (`apps/iris-web/src/sandbox/policy.ts`) — re-checked on the host per hop by
  `checkScriptFetch`, with the libraries a frame carries vendored into this
  repository instead of fetched at all.
- The ST installer takes an https URL and a full 40-hex commit
  (`assertPinnedCommit`, `packages/iris-extension-installer/src/source.ts`),
  fixed argv with no shell, hooks path emptied, no submodules.

`notes/PLUGIN-FEASIBILITY.md` §8 question 1 poses the choice as "same privilege
means the install source must be as constrained as card code — two CDNs,
hash-locked — rather than an arbitrary `git clone`". Read that as the proposal
it is, not as a description: what is hashed on the card path today is the
*URL*, as a cache file name (`cacheKey`,
`packages/iris-app-service/src/script-cache.ts`), not the bytes, so
"hash-locked" would be new work on either path. Deciding this is a prerequisite
for any npm or Git install route for a Node plugin, which is why that row and
this question move together.

A concrete answer is drafted in [SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md)
— **提案，待裁决**, a proposal awaiting the owner's ruling, not a description of
`main`. Until it is ruled on, the question above is what stands.

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

Read against `main` on 2026-09-15. Everything above this heading is a
description of code that exists; everything here is a description of code that
does not. `docs/INFRASTRUCTURE-INTERFACES.md` §8 is the maintained version of
this list, with completion conditions and graduated rows — this is the short
form for readers of the architecture decision.

- **Runtime services for an active plugin** — a storage namespace under the
  profile (`scope.storage`), a settings face (`scope.settings`),
  generation-pipeline hooks on `AppServiceOptions`, an open `ScriptContext`
  (`contributeContext`). None of the four exists. Tavern Helper and MVU are
  taken at fixed call sites through `capabilities.ts`, and ST settings go
  through a purpose-built `StCompatOptions` closure rather than a general
  interface.
- **Plugin-writable variables as an API.** Arbitration is host-internal and the
  settlement site names the two plugin ids in source, so a third writer cannot
  be wired in without editing it.
- **Publishable contract packages.** `@iris/plugin-api` and
  `@iris/plugin-web-api` are shaped (zero `@iris` dependencies; type-only
  Cordis and protocol) but are `private`, `0.0.0`, and export TypeScript
  sources. Shaped is not publishable.
- **An install path for a Node system plugin from outside the repository.** No
  npm name, no Git URL: the two routes under "Authority and scope" are all
  there is. Blocked on the trust-model open question above, not merely on
  plumbing.
- **A settings slot a plugin outside the shell can register.** The slot
  mechanism and its occupancy check exist and have a consumer; only
  shell-resident code can register one.
- **i18n namespace merge.** Plugin-center copy is an inline table and the ST
  panel carries its own projection; a plugin contributes no strings.
- **Acceptance for MVU hot-unload against a card-bundled copy of MVU**, as
  "Compatibility boundaries" states.
