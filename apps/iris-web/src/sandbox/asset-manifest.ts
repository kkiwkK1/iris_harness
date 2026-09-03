/**
 * Which sandbox artifacts this build actually produced.
 *
 * The bootstrap and the preset now carry content hashes in their names, so
 * nothing may hardcode a path to them. One fixed path remains — this manifest —
 * and it is deliberately the smallest, most cacheless thing in the system: a few
 * dozen bytes naming two files.
 *
 * The indirection buys the property that matters. A hashed name is immutable, so
 * a cached copy is correct by definition and a superseded name is a **404**
 * rather than silently-old code. Before this, a browser holding yesterday's
 * `bootstrap.js` reported faults that had been fixed hours earlier, and the only
 * known cure was a hard refresh before every verification round — a ritual that
 * taxed every reading anyone took.
 *
 * Validated rather than trusted, for the same reason `bootstrap-source.ts` exists:
 * a dev server answers an unknown path with its index page **at status 200**, so
 * `response.ok` proves nothing. A manifest that silently parsed as garbage would
 * send the shell to fetch `undefined`, and the error would surface three steps
 * later as a frame that never started.
 *
 * @module iris-web/sandbox/asset-manifest
 */

/** Where the manifest lives. The only fixed sandbox path left. */
export const SANDBOX_MANIFEST_PATH = '/sandbox/manifest.json'

/** The artifacts a build produces, as URLs. */
export interface SandboxAssets {
  bootstrap: string
  /**
   * The card-facing member table.
   *
   * Split out of the bootstrap so it is fetched once per page instead of inlined
   * into every frame — that alone took the per-frame cost from 65 KiB to 41 KiB.
   * It is **required** rather than optional here: a build that emitted no table
   * would produce frames that come up and refuse to run anything, and the
   * manifest is the earliest place that can be said.
   */
  members: string
  preset: string
  /**
   * The message frame's library bundle.
   *
   * A separate artifact because the two frame kinds need different libraries —
   * upstream injects two into a script frame and eight into a message frame — and
   * a script frame carrying Tailwind and jQuery UI would be bytes spent on
   * nothing.
   */
  messagePreset: string
}

/**
 * Read a manifest body into asset URLs.
 *
 * Separated from fetching so the validation is testable without a server, which
 * is where every interesting case lives — an index page, a truncated body, a
 * name that is not a string.
 *
 * @param body - the response text.
 * @returns the assets, or a sentence saying what is wrong with the body.
 */
export function parseSandboxManifest(body: string): SandboxAssets | string {
  if (body.trim() === '') return 'the sandbox manifest is empty'

  // First, because a dev server's SPA fallback answers 200 with the index page
  // and JSON.parse would then report a syntax error that names a character
  // offset rather than the actual problem.
  if (/^\s*<!doctype html|^\s*<html/i.test(body)) {
    return 'the sandbox manifest path returned an HTML page — the build has not run, or the path is wrong'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return 'the sandbox manifest is not valid JSON'
  }

  if (typeof parsed !== 'object' || parsed === null) return 'the sandbox manifest is not an object'
  const record = parsed as Record<string, unknown>

  const names: Record<string, string> = {}
  for (const key of ['bootstrap', 'members', 'preset', 'message-preset']) {
    const value = record[key]
    if (typeof value !== 'string' || value === '') {
      return `the sandbox manifest does not name a ${key} artifact`
    }
    /*
     * A name, not a path. The manifest is data from the build, and the one thing
     * that must never happen is a value from it being pasted into a URL that
     * leaves this origin. Rejecting anything with a slash or a scheme keeps this
     * an index into our own directory rather than a redirect someone could aim.
     */
    if (value.includes('/') || value.includes(':')) {
      return `the sandbox manifest's ${key} entry is a path, and only a bare filename is allowed`
    }
    names[key] = value
  }

  return {
    bootstrap: `/sandbox/${names['bootstrap'] ?? ''}`,
    members: `/sandbox/${names['members'] ?? ''}`,
    preset: `/sandbox/${names['preset'] ?? ''}`,
    messagePreset: `/sandbox/${names['message-preset'] ?? ''}`,
  }
}
