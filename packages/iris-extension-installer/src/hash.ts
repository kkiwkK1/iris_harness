/**
 * Content hashing. The artifact hash is a deterministic tree digest: every
 * file's SHA-256, then a SHA-256 over the sorted `relativePath\0fileHash\n`
 * lines. Sort order is byte-wise on the forward-slash relative path, so the
 * same bytes always produce the same hash on any filesystem and any OS —
 * the lock record's sha256 is meaningful across machines.
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await fsp.readFile(filePath))
  return hash.digest('hex')
}

export interface TreeHash {
  sha256: string
  files: number
  bytes: number
}

/**
 * @param skip Optional predicate over forward-slash relative paths; a skipped
 * entry (e.g. the lock file inside an installed directory) contributes to
 * neither the aggregate nor the counts.
 */
export async function hashTree(root: string, skip?: (rel: string) => boolean): Promise<TreeHash> {
  const lines: { rel: string; hash: string; size: number }[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = await fsp.readdir(dir, { withFileTypes: true })
    for (const item of items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel === '' ? item.name : `${rel}/${item.name}`
      const childPath = path.join(dir, item.name)
      const st = await fsp.lstat(childPath)
      if (st.isSymbolicLink()) {
        throw new Error(`hashTree refusing a symlink/junction at ${childRel} — hashed trees are audited trees`)
      }
      if (st.isDirectory()) {
        await walk(childPath, childRel)
      } else if (st.isFile()) {
        if (skip?.(childRel)) continue
        lines.push({ rel: childRel, hash: await sha256File(childPath), size: st.size })
      }
    }
  }
  await walk(root, '')
  lines.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const aggregate = createHash('sha256')
  for (const line of lines) {
    aggregate.update(`${line.rel}\0${line.hash}\n`)
  }
  return {
    sha256: aggregate.digest('hex'),
    files: lines.length,
    bytes: lines.reduce((sum, line) => sum + line.size, 0),
  }
}
