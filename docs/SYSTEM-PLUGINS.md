# System plugins

Architecture decision, 2026-09-12. Implementation and acceptance are tracked in
`notes/SYSTEM-PLUGINS-ACCEPTANCE.md`.

## Purpose

Iris owns a system-level plugin lifecycle. Tavern Helper and MVU are its first
bundled plugins. Their existing compatibility packages remain the implementation
of their algorithms and public APIs; the host supplies replaceable capabilities
and lifetime boundaries instead of calling them unconditionally.

A card script is content executed within the existing sandbox. A system plugin
owns a capability that such content may need. Installing or enabling a system
plugin does not grant a card permission to execute scripts or access the network.

## Authority and scope

The user requested runtime management and extraction of Tavern Helper and MVU.
This supersedes the static-only lifecycle proposed on the unmerged
`dev/feat-extension-system` design branch. There is one plugin control plane;
future extension hooks must attach to it, not create a second registry.

The initial install catalog consists of plugins shipped with Iris. Install and
uninstall mean attaching and detaching those available implementations from this
profile. They do not download packages or remove source files from the Iris
installation. Third-party package discovery and distribution are separate work;
the registry must not assume every future plugin is one of these two builtins.

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

## Compatibility boundaries

Disabling Tavern Helper removes its optional API and stops its owned scripts.
Native chat and base message rendering remain available. Missing capabilities
must be identifiable; they must not fail later as an unexplained missing method.

Disabling MVU stops its automatic initialization, update and replay. Stored
variables remain readable as data and are not cleared. Re-enabling uses persisted
state without applying historical commands a second time.

Cards may bundle remote MVU code. The implementation must account for this
separately from host-side MVU processing: stopping only the host algorithm does
not stop a still-running bundled script. A filename guess is not an execution
boundary. The acceptance record must state which runtime capability is revoked
and any remaining limitations before claiming full MVU hot-unload.

## Acceptance requirements

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
