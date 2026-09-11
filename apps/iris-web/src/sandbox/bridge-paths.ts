/**
 * Which of Iris's own paths a card's frame may reach through the fetch bridge.
 *
 * `same-origin.ts` answers *whether a request is ours*; this answers *whether it
 * is one of ours a card may have*. The two are deliberately separate functions
 * in separate modules because they fail in opposite directions: widening the
 * first breaks cards that reach a CDN, and widening this one hands a card the
 * shell's credentials for a route nobody meant it to read.
 *
 * ## What the bridge is, and what it therefore costs
 *
 * A srcdoc frame resolves a relative URL against the shell page's base, so a
 * card's `fetch('/version')` — frequent upstream, where card scripts share
 * SillyTavern's origin — aims at Iris's own host. `connect-src` does not list
 * that origin, so the browser refuses it; the bridge exists so the shell fetches
 * it instead, **with the shell's own credentials**, and hands the body back.
 *
 * That is a credentialed GET against any path the host serves, asked for by the
 * least trusted code in the product. POST writes are already stopped a layer
 * further in — the RPC endpoint refuses anything that is not
 * `application/json`, and the bridge sends no body and no headers — but a read
 * is a read: the network audit's M-3/F11 pair named `/iris/avatar/<another
 * card>`, which is the whole card file of a character the conversation is not
 * about, PNG payload and embedded data together.
 *
 * ## The list, and why each entry is on it
 *
 * - `/version` — the one upstream-shaped call measured in the corpus.
 *   MagVarUpdate's bundle, which every MVU card imports, opens with it.
 * - `/sandbox/` — this build's own frame artifacts (`asset-manifest.ts` fetches
 *   `/sandbox/manifest.json`). A frame asking for its own bootstrap is the
 *   bridge working.
 * - `/iris/script-bundle` — the host's remote-dependency proxy. A card's import
 *   of an allowlisted CDN is rewritten onto it (`bundle-proxy.ts`), so refusing
 *   it here would refuse the very rewrite Iris performs.
 * - `/iris/avatar/<the card's own id>` — and **only** the card's own. A card
 *   putting an avatar in `url(...)` is unaffected either way: images are
 *   `img-src`, not the bridge.
 *
 * Everything else is refused, `/iris/rpc` included. Upstream has no equivalent
 * of any of this: on SillyTavern a card's code runs on the page itself, so every
 * same-origin path is already its to read and there is no bridge to put a list
 * on. This list is therefore a divergence in Iris's favour, not a compatibility
 * gap — see `notes/apps/iris-web/DEVIATIONS.md` §94.
 *
 * ## Two sides, one function
 *
 * Consulted frame-side (`frame.ts`, before a request rides) and shell-side
 * (`runner.ts`, before the shell honours one), for the reason the origin check
 * already is: the frame is the untrusted side, and "the frame already filtered"
 * is not a check. The repo rule is that a refusal names the layer that relayed
 * it, so both sides say the same shape in their own voice rather than one of
 * them staying silent.
 *
 * @module iris-web/sandbox/bridge-paths
 */

/** Paths a card may fetch, matched whole. */
export const BRIDGE_EXACT_PATHS: readonly string[] = ['/version']

/**
 * Paths a card may fetch, matched by prefix.
 *
 * `/iris/script-bundle` carries no trailing slash because the host serves it
 * with the URL in a query string (`?url=…`), so the pathname *is* the prefix;
 * `/sandbox/` carries one so that a hypothetical `/sandboxed-secrets` is not
 * quietly admitted by a prefix meant for a directory.
 */
export const BRIDGE_PATH_PREFIXES: readonly string[] = ['/sandbox/', '/iris/script-bundle']

/** Where card avatars are served. Only the current card's own is allowed. */
export const AVATAR_PREFIX = '/iris/avatar/'

/** What the classification decided, and what a report should call it. */
export interface BridgeVerdict {
  /** Whether the request may ride the bridge. */
  allowed: boolean
  /**
   * A stable label for this request, for deduplicating reports.
   *
   * The pathname, with an avatar id folded to `<id>` so a card sweeping the
   * library produces one report rather than one per card. The query string is
   * dropped: `/iris/script-bundle?url=…` is one shape, not one per dependency.
   */
  shape: string
}

/**
 * Whether a same-origin target is one the bridge carries.
 *
 * @param target - the resolved absolute URL, as `sameOriginTarget` returns it.
 *   Already known to be same-origin; this function does not re-check that, and
 *   a caller that skipped the origin check would be asking the wrong question.
 * @param ownCharacterId - the card this frame is running for, when the caller
 *   knows it. `undefined` refuses every avatar rather than allowing one: a
 *   frame that cannot say whose it is has not earned the exception, and the
 *   failure is a refused picture rather than a leaked card file.
 * @returns the verdict and the shape to report it under.
 */
export function bridgeVerdict(target: string, ownCharacterId: string | undefined): BridgeVerdict {
  let path: string
  try {
    path = new URL(target).pathname
  } catch {
    // Unparseable here means the caller handed over something that did not come
    // from `sameOriginTarget`. Refused, and named as what it is.
    return { allowed: false, shape: '(an unparseable URL)' }
  }

  if (path.startsWith(AVATAR_PREFIX)) {
    const rest = path.slice(AVATAR_PREFIX.length)
    let id: string
    try {
      id = decodeURIComponent(rest)
    } catch {
      // The host answers 400 for this; refusing it here costs nothing real and
      // keeps a malformed escape from reaching the credentialed fetch at all.
      return { allowed: false, shape: `${AVATAR_PREFIX}<id>` }
    }
    /*
     * Compared exactly, not case-folded.
     *
     * Ids here are filename-shaped, and the library folds case when it asks
     * whether one is *taken* — two cards whose ids differ only in case cannot
     * both exist on a case-folding filesystem. Folding here would be the other
     * direction: on a case-sensitive host it would admit a genuinely different
     * card's file. A card never has to type this id, either — it comes back
     * from `getCharAvatarPath()` exactly as the host spells it — so strictness
     * costs nothing a card can trip over.
     */
    return { allowed: id !== '' && id === ownCharacterId, shape: `${AVATAR_PREFIX}<id>` }
  }

  if (BRIDGE_EXACT_PATHS.includes(path)) return { allowed: true, shape: path }
  if (BRIDGE_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return { allowed: true, shape: path }
  }
  return { allowed: false, shape: path }
}

/**
 * The sentence a refusal is reported with.
 *
 * One function so the frame and the shell say the same thing about the same
 * shape, differing only in which of them is speaking — a reader comparing the
 * panel's line with a host report should be able to see that they are the same
 * refusal rather than guess it.
 * @param shape - the label from {@link bridgeVerdict}.
 * @param side - which layer refused.
 * @returns the report text.
 */
export function describeBridgeRefusal(shape: string, side: 'frame' | 'shell'): string {
  const who = side === 'frame'
    ? 'this frame did not carry it to the page'
    : 'the page refused to fetch it for this frame'
  return (
    `a card asked Iris for ${shape} through the same-origin fetch bridge, and ${who}:`
    + ' the bridge carries /version, this build\'s /sandbox/ artifacts, the'
    + ' /iris/script-bundle proxy and this card\'s own avatar, and nothing else —'
    + ' upstream has no bridge here because a card there runs on the page itself'
  )
}
