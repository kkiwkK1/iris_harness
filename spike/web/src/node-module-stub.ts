/**
 * Browser stand-in for `node:module`.
 *
 * The vendored Cordis Loader imports `createRequire` to probe Node's internal
 * module loader. In the browser that slot is filled by the client module system
 * instead, so the probe must resolve to something inert rather than fail to
 * resolve at all. Paired with the `process.versions.node = "0.0.0"` define,
 * which makes the probe take neither Node branch and leave the slot empty.
 */

/** Inert `createRequire`: nothing in the browser may reach Node's resolver. */
export function createRequire(_specifier: string | URL): (id: string) => never {
  return (id: string) => {
    throw new Error(`node:module is unavailable in the browser (require("${id}"))`)
  }
}

export default { createRequire }
