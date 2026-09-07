/**
 * `GET /version`, upstream's shape.
 *
 * MagVarUpdate's bundle opens with
 * `fetch('/version').then(e => e.json()).then(e => e.pkgVersion).catch(() => '1.0.0')`,
 * so a host without this route costs **two red reports per MVU card per chat**
 * — and worse than the noise, the `.catch` hands the card `'1.0.0'`, a version
 * older than any real SillyTavern. A card gating a feature on the version then
 * takes the oldest branch it has, which is a behaviour difference produced by
 * a missing route rather than by any decision.
 *
 * @module @iris/app-service/version
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The SillyTavern release whose behaviour this host reproduces.
 *
 * **Reported as ours deliberately, and it is not a disguise.** `pkgVersion` is
 * read by cards to ask "which behaviour set am I talking to", and the honest
 * answer to that question is the version of the behaviour set — which is this
 * one, measured against the installation at `E:/sillyTavern/SillyTavern`. Iris
 * reporting its own version number would answer a question nobody asked and
 * push every version-gated card down the `catch` branch, which is strictly
 * worse *and* less true: a card asking whether `getCharWorldbookNames` exists
 * gets a correct answer from `1.18.0` and a wrong one from `0.0.0`.
 *
 * Who this host actually is rides in {@link VersionInfo.iris}, which upstream
 * has no field for, so nothing is hidden — only answered in the vocabulary the
 * question was asked in.
 */
export const REPRODUCED_ST_VERSION = '1.18.0'

/** The version of this host, as its own field. */
export const IRIS_VERSION = '0.1.0'

/** Upstream's `getVersion()` payload (`src/util.js:136-164`), plus one field. */
export interface VersionInfo {
  /**
   * Upstream's Horde user-agent string, `SillyTavern:<version>:<maintainer>`.
   *
   * **The maintainer half is not copied.** Upstream's literal is
   * `SillyTavern:${pkgVersion}:Cohee#1207` — a specific person's handle, whose
   * purpose is identifying the client to the Horde API. Reproducing a version
   * number is saying which behaviour we implement; reproducing someone's
   * personal identifier in a string built to be sent to a third party is not
   * the same act, and nothing here talks to the Horde anyway. The prefix and
   * the shape are kept, because that is what a parser keys on.
   *
   * Measured: **0 reads** of this field across the fetched bundles, so the
   * substitution costs no observed consumer.
   */
  agent: string
  /** The reproduced SillyTavern version. See {@link REPRODUCED_ST_VERSION}. */
  pkgVersion: string
  /**
   * Upstream's git fields, `null`.
   *
   * Not invented: `null` is what upstream's own `getVersion` returns whenever
   * `git` is not on the path or the checkout has no upstream branch — the
   * `catch` at `util.js:159` leaves all three at their initial `null`. A user
   * running SillyTavern from a release zip sees exactly this, so it is an
   * upstream-reachable state rather than a stand-in for one.
   */
  gitRevision: string | null
  gitBranch: string | null
  commitDate: string | null
  /** Upstream's initial value, and what it reports when git is unavailable. */
  isLatest: boolean
  /**
   * Who is actually answering. Upstream has no such field.
   *
   * Present so that "this is Iris" is available to anything that wants to ask
   * it, without the compatibility answer above having to carry two meanings.
   */
  iris: { version: string }
}

/**
 * Build the `/version` payload.
 * @returns the payload, a fresh object each call.
 */
export function versionInfo(): VersionInfo {
  return {
    agent: `SillyTavern:${REPRODUCED_ST_VERSION}:Iris`,
    pkgVersion: REPRODUCED_ST_VERSION,
    gitRevision: null,
    gitBranch: null,
    commitDate: null,
    isLatest: true,
    iris: { version: IRIS_VERSION },
  }
}

/**
 * The whole route — match kind, path and handler — as one value.
 *
 * Assembled here rather than at the `ctx.webServer.register(…)` call site so
 * that a test can hold the same object the server is handed. A handler written
 * inline in the plugin entry would leave the payload tested, the consumer's
 * expression tested, and **the thing that answers the request** reachable by
 * nothing: `node --test` cannot load an entry module with side effects, which
 * is exactly why field-copying code accumulates there. See `notes/METHODS.md` §22.
 *
 * `exact`, not `prefix`: upstream serves one path, and a prefix would also
 * answer `/version/anything` — routes upstream does not have.
 * @returns the route descriptor to register.
 */
export function versionRoute(): {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
} {
  return {
    kind: 'exact',
    path: '/version',
    handler: (_req, res) => {
      const body = JSON.stringify(versionInfo())
      res.writeHead(200, {
        'content-type': 'application/json',
        // The bundle reads this with `.json()`, which does not consult the
        // header — but anything that does consult it gets the truth.
        'content-length': String(Buffer.byteLength(body)),
      })
      res.end(body)
    },
  }
}
