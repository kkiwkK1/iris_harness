/**
 * How a sandbox artifact's content hash is spelled — in one place.
 *
 * Two tools need it and for opposite purposes: `hash-sandbox-assets.mjs` **makes**
 * the name, and `check-bootstrap.mjs` **verifies** it, asserting that the file
 * the manifest points at still hashes to the hash in its own filename. A
 * verifier that computed the hash its own way would be checking one convention
 * against another, and the two would agree right up until someone changed the
 * length here — at which point the check would go red for a legitimate change
 * and the fix would look like "make the check agree with the build", which is the
 * shape that gets a check deleted.
 *
 * @module iris-web/tools/asset-fingerprint
 */
import { createHash } from 'node:crypto'

/**
 * Sixteen hex characters of SHA-256.
 *
 * Long enough that a collision is not a thing anyone needs to reason about,
 * short enough to read in a network panel and compare by eye — which is what
 * someone does when they are trying to work out whether the browser has the
 * build they just made.
 * @param {Buffer | string} bytes - the file contents.
 * @returns {string} the hash fragment for the name.
 */
export function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/**
 * The name a given artifact's bytes must carry.
 * @param {string} artifact - the build's own name for it, e.g. `bootstrap`.
 * @param {Buffer | string} bytes - the file contents.
 * @returns {string} the content-addressed filename.
 */
export function hashedName(artifact, bytes) {
  return `${artifact}-${fingerprint(bytes)}.js`
}
