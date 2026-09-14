/**
 * The third-party member merge, as the bootstrap's collector sees it.
 *
 * Pure on purpose: the tag order (members → bootstrap → plugins → cards)
 * forces the collection to be **lazy** — no eager read could see a
 * registration — and laziness plus a document dependency is exactly the
 * combination a test cannot reach. So the rules live here, over a host-like
 * lookup, and `frame-entry` wires the globals around them: it publishes the
 * admitted rows before the first plugin tag runs, and hands this collector to
 * the sandbox as a thunk the run path calls once, after every tag has run or
 * definitively not run.
 *
 * The refusal is **per plugin, not per frame**: the core table's absence
 * refuses the whole run (its reason is recorded at the core read), but one
 * plugin's missing ready marker — its script was blocked, failed to parse, or
 * threw before its last statement — rejects only that plugin's members, and
 * the report names the plugin and the cause. Cards using other plugins'
 * members, or none, still run; a card probing a refused namespace gets the
 * named report rather than a bare `undefined`, which is the same attribution
 * rule the core table's marker bought
 * (`notes/PLUGIN-CONTRACT-LANDING-SITES.md` §3, 拒跑语义重定).
 *
 * @module iris-web/sandbox/plugin-members
 */

import { pluginMembersGlobal, pluginReadyMarker } from './members-contract.ts'

/** What the merge collected: each admitted plugin's members, or why they are absent. */
export interface PluginMembersCollect {
  members: Record<string, Record<string, unknown>>
  reports: Record<string, string>
}

/**
 * The host lookups the collector needs — `globalThis` in a frame, a plain
 * object in a test.
 */
export type PluginMemberHost = Record<string, unknown>

/**
 * Collect one frame's third-party members from the host's registration
 * globals.
 *
 * @param admitted - the rows the frame's snapshot carries, keyed by plugin id.
 *   Only these ids are collected; anything else on the host was never
 *   admitted and is invisible to this merge.
 * @param host - the realm the registrations live in.
 * @returns the members per plugin and the named reports for the rest. The
 *   result is memoized by the caller (the frame's answer cannot change after
 *   the tags have run — collection is a verdict, not a poll).
 */
export function collectPluginMembers(admitted: Record<string, unknown>, host: PluginMemberHost): PluginMembersCollect {
  const members: Record<string, Record<string, unknown>> = {}
  const reports: Record<string, string> = {}
  for (const pluginId of Object.keys(admitted)) {
    const ready = host[pluginReadyMarker(pluginId)] === true
    const registered = host[pluginMembersGlobal(pluginId)] as Record<string, unknown> | undefined
    if (!ready && registered === undefined) {
      reports[pluginId] = `plugin "${pluginId}" did not run to completion — its script was blocked, failed to parse, or threw before its ready marker; its members are not available in this frame`
      continue
    }
    if (!ready || registered === undefined) {
      reports[pluginId] = `plugin "${pluginId}" is in a half-registered state (${ready ? 'ready marker without members' : 'members without a ready marker'}) — its script violated the merge protocol; its members are not available in this frame`
      continue
    }
    members[pluginId] = registered
  }
  return { members, reports }
}
