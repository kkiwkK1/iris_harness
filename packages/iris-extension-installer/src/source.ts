/**
 * Extension sources and their materialization into a staging directory.
 *
 * Scope fences (runbook §3, §5): three source kinds only — a local archive,
 * a local directory, and a Git repository pinned to a full commit SHA. There
 * is no plain-HTTP artifact fetch in this slice and no ref/branch resolution:
 * a moving ref would make the lock record a lie, so only a full 40-hex commit
 * is accepted. Git never runs hooks (`core.hooksPath` is emptied on every
 * command) and never recurses into submodules; the only child process ever
 * spawned is `git` itself with a fixed argv and no shell.
 */

import { spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export type ExtensionSource =
  | { kind: 'local-archive'; archivePath: string }
  | { kind: 'local-directory'; directoryPath: string }
  | { kind: 'git'; repository: string; commit: string }

export interface SourceOptions {
  /** Off by default. Only tests materialize `file://` Git URLs; production accepts https://. */
  allowLocalGit?: boolean
  /** Hard ceiling on copied archive bytes; the copy aborts once exceeded. */
  maxArchiveBytes?: number
  signal?: AbortSignal
}

export class SourceError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export interface MaterializeOutcome {
  resolvedCommit?: string
  /** Set for local-archive: the archive bytes copied into staging, pending unpack. */
  stagedArchive?: string
}

const GIT_COMMIT_RE = /^[0-9a-f]{40}$/

/**
 * Userinfo in a repository URL is refused on every path, not just the https
 * one: the URL is recorded verbatim in the lock, in the caller's catalog and
 * on every consent surface, so a credential pasted into a remote becomes a
 * credential in four files, three of which the user never looks at.
 *
 * SillyTavern's own installer accepts such URLs; Iris deliberately does not —
 * a recorded divergence, argued once in the app-service ledger (§85) rather
 * than re-argued at each call site. A string that does not parse as a URL is
 * left for the scheme branch below, which refuses it with a message that
 * names the actual defect.
 */
function refuseCredentialedRemote(repository: string): void {
  let url: URL
  try {
    url = new URL(repository)
  } catch {
    // A `file://` authority carrying userinfo is unparseable as a WHATWG URL
    // at all — file hosts have no userinfo slot — so this is not the
    // not-a-URL case the scheme branch refuses better: under
    // `allowLocalGit` the scheme branch would admit it, @ and all. The
    // textual check reads the same authority the parser would have.
    if (userinfoInAuthority(repository)) {
      throw new SourceError(
        'the remote URL carries credentials in its userinfo — refused before the fetch, because the URL is recorded'
        + ' in the lock, in the catalog and on the consent page, and a secret written there is a secret in four files',
        'bad-repository',
      )
    }
    return
  }
  if (url.username !== '' || url.password !== '') {
    throw new SourceError(
      'the remote URL carries credentials in its userinfo — refused before the fetch, because the URL is recorded'
      + ' in the lock, in the catalog and on the consent page, and a secret written there is a secret in four files',
      'bad-repository',
    )
  }
}

/** An `@` in the authority — after `://`, before the first `/`. */
function userinfoInAuthority(repository: string): boolean {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(repository)
  if (scheme === null) return false
  const authority = repository.slice(scheme[0].length)
  const at = authority.indexOf('@')
  if (at < 0) return false
  const slash = authority.indexOf('/')
  return slash < 0 || at < slash
}

export function validateExtensionSource(source: ExtensionSource, options: SourceOptions = {}): void {
  switch (source.kind) {
    case 'local-archive':
    case 'local-directory': {
      const p = source.kind === 'local-archive' ? source.archivePath : source.directoryPath
      if (typeof p !== 'string' || p.length === 0) {
        throw new SourceError(`${source.kind} source requires a non-empty path`, 'bad-path')
      }
      return
    }
    case 'git': {
      if (typeof source.repository !== 'string' || source.repository.length === 0) {
        throw new SourceError('git source requires a repository URL', 'bad-repository')
      }
      if (/[\s"']/u.test(source.repository)) {
        throw new SourceError('git repository URL contains whitespace or quotes: refused', 'bad-repository')
      }
      // Credentials before the pin: a URL that both carries userinfo and lacks
      // a pin must be refused for the userinfo — the secret is the thing to
      // remove first, and the scheme and pin refusals would read as a fix
      // somewhere else.
      refuseCredentialedRemote(source.repository)
      assertPinnedCommit(source.commit)
      if (source.repository.startsWith('https://')) return
      if (options.allowLocalGit && source.repository.startsWith('file://')) return
      throw new SourceError(
        'git repository must be an https:// URL — refused non-https URL (no git://, no ssh:, no bare paths)',
        'bad-repository',
      )
    }
  }
}

export function assertPinnedCommit(commit: string): string {
  if (!GIT_COMMIT_RE.test(commit)) {
    throw new SourceError(
      `git source requires a full 40-hex commit SHA pinned at analysis time, got ${JSON.stringify(commit)} — a moving ref would make the lock record a lie`,
      'unpinned-commit',
    )
  }
  return commit
}

/**
 * Materializes `source` into `dest` (an existing directory inside staging).
 * For archives this is the byte copy only; unpacking is a separate phase
 * (archive.ts). For directories and Git, `dest` ends up holding the full
 * materialized tree. Nothing is ever materialized outside `dest`.
 */
export async function materializeSource(
  source: ExtensionSource,
  dest: string,
  options: SourceOptions = {},
): Promise<MaterializeOutcome> {
  validateExtensionSource(source, options)
  await fsp.mkdir(dest, { recursive: true })
  switch (source.kind) {
    case 'local-archive': {
      const stagedArchive = await copyArchiveIntoStaging(source.archivePath, dest, options)
      return { stagedArchive }
    }
    case 'local-directory': {
      const { copyTreeGuarded } = await import('./archive.ts')
      await copyTreeGuarded(source.directoryPath, dest)
      return {}
    }
    case 'git': {
      const resolvedCommit = await materializeGit(source, dest, options)
      return { resolvedCommit }
    }
  }
}

async function copyArchiveIntoStaging(
  archivePath: string,
  dest: string,
  options: SourceOptions,
): Promise<string> {
  let stat: fs.Stats
  try {
    stat = await fsp.lstat(archivePath)
  } catch {
    throw new SourceError(`archive does not exist: ${archivePath}`, 'missing-archive')
  }
  if (stat.isSymbolicLink()) {
    throw new SourceError('archive path is a symlink/junction: refused', 'symlink')
  }
  if (!stat.isFile()) {
    throw new SourceError(`archive path is not a regular file: ${archivePath}`, 'not-a-file')
  }
  const max = options.maxArchiveBytes ?? 512 * 1024 * 1024
  if (stat.size > max) {
    throw new SourceError(`archive is ${stat.size} bytes, over the ${max}-byte limit`, 'too-large')
  }
  const staged = path.join(dest, 'archive.download')
  const out = createWriteStream(staged, { flags: 'wx' })
  try {
    await pipeline(createReadStream(archivePath), out, { signal: options.signal })
  } catch (err) {
    out.destroy()
    await fsp.rm(staged, { force: true })
    if (options.signal?.aborted) throw new SourceError('download interrupted by abort', 'aborted')
    throw err
  }
  const copied = (await fsp.stat(staged)).size
  if (copied !== stat.size) {
    await fsp.rm(staged, { force: true })
    throw new SourceError(`copied ${copied} of ${stat.size} bytes — interrupted copy refused`, 'truncated')
  }
  return staged
}

/**
 * Git materialization: fetch exactly the pinned commit into `dest`, detach
 * HEAD onto it, then prove HEAD equals the pin. Every git invocation empties
 * core.hooksPath so nothing from the fetched tree can execute during fetch or
 * checkout, and submodule recursion is off.
 */
async function materializeGit(
  source: Extract<ExtensionSource, { kind: 'git' }>,
  dest: string,
  options: SourceOptions,
): Promise<string> {
  const commit = assertPinnedCommit(source.commit)
  const hookless = ['-c', 'core.hooksPath=', '-c', 'protocol.version=2']
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  if (options.signal?.aborted) throw new SourceError('download interrupted by abort', 'aborted')
  const run = (args: string[]): void => {
    const r = spawnSync('git', [...hookless, ...args], { env })
    if (r.status !== 0) {
      throw new SourceError(`git ${args[0]} failed (exit ${r.status}): ${String(r.stderr).trim()}`, 'git-failed')
    }
  }
  run(['init', '-q', dest])
  run(['-C', dest, 'remote', 'add', 'origin', source.repository])
  run(['-C', dest, 'fetch', '--depth', '1', '--no-recurse-submodules', '--no-tags', 'origin', commit])
  if (options.signal?.aborted) throw new SourceError('download interrupted by abort', 'aborted')
  run(['-C', dest, 'checkout', '-q', '--detach', 'FETCH_HEAD'])
  const head = spawnSync('git', [...hookless, '-C', dest, 'rev-parse', 'HEAD'], { env })
  const resolved = String(head.stdout).trim()
  if (head.status !== 0 || !GIT_COMMIT_RE.test(resolved)) {
    throw new SourceError(`could not read fetched HEAD: ${String(head.stderr).trim()}`, 'git-failed')
  }
  if (resolved !== commit) {
    throw new SourceError(
      `git HEAD ${resolved} does not match pinned commit ${commit} — refusing to install something other than what was analyzed`,
      'head-mismatch',
    )
  }
  return resolved
}
