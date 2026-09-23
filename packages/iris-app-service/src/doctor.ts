/**
 * The host half of the composer's `/doctor`: facts no other method exposes.
 *
 * **Read-only, and read at call time.** Every field is a fresh reading — the
 * lock file, the built index, the directories' permissions — because the case
 * this exists for is a fact that *changed* while something kept an older copy:
 * a host restarted onto a new build under a page still running the old one, a
 * lock taken over by a second host. A value captured at boot would be the one
 * reading guaranteed not to see either.
 *
 * **Nothing is written.** "Is the data directory writable" is answered by
 * `access(W_OK)` rather than by writing a probe file: a doctor that leaves a
 * file behind in the directory it is diagnosing has changed the thing it was
 * asked to look at. On Windows `W_OK` only reads the read-only attribute, so a
 * directory refused by an ACL still reads as writable here; the lock row and a
 * failed save's own report are what catch that case, and the row's text says
 * "reported writable" rather than "tested by writing".
 *
 * **No secrets.** Nothing here opens the profile's connection store or reads a
 * key; the only file contents read are `host.lock` (a pid, a port, a host name
 * and a start time) and the built `index.html`.
 *
 * @module @iris/app-service/doctor
 */

import { constants } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { HostDoctorFacts } from '@iris/protocol'

import { HOST_LOCK_FILE, readLockRecord } from './host-lock.ts'
import { IRIS_VERSION } from './version.ts'

/**
 * The module script a built index loads, as a file name.
 *
 * The first `<script type="module" … src="…">` — Vite writes exactly one for
 * the entry, and it is the one whose content hash moves when the bundle does.
 * The name alone, because the page compares it with its own entry's name and
 * the two spell the directory differently (`./assets/` in the file, an absolute
 * URL in the page).
 * @param html - the index as served.
 * @returns the entry's file name, or undefined when the index names none.
 */
export function entryScriptName(html: string): string | undefined {
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const text = tag[0]
    if (!/\btype\s*=\s*["']?module["']?/i.test(text)) continue
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(text)?.[1]
    if (src === undefined) continue
    const name = basename(src.split(/[?#]/)[0] ?? src)
    if (name !== '') return name
  }
  return undefined
}

/** What {@link readHostDoctorFacts} reads from. */
export interface DoctorSources {
  /** The resolved data directory. */
  dataDir: string
  /** The built index the static seat serves, when there is one. */
  webDistIndex?: string
  /** `IRIS_ST_DIR`, when configured. */
  sillyTavernDir?: string
  /** The card storage's current size and its cap, when the store is composed. */
  cardStorage?: { size: () => Promise<number>, limit: number }
  /** The process id. Defaults to `process.pid`. */
  pid?: number
  /** The Node version. Defaults to `process.version`. */
  node?: string
}

/**
 * Whether a path answers an access check, without throwing.
 * @param path - the path.
 * @param mode - the `fs.constants` mode.
 * @returns true when the check passed.
 */
async function answers(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

/**
 * Read every host fact `/doctor` needs, now.
 *
 * Each reading fails into its own absent-or-false field rather than failing the
 * call: a doctor that could not say anything because one file was unreadable
 * would be silent about exactly the host most in need of it.
 * @param sources - where to read.
 * @returns the facts.
 */
export async function readHostDoctorFacts(sources: DoctorSources): Promise<HostDoctorFacts> {
  let lockPid: number | undefined
  try {
    lockPid = readLockRecord(await readFile(join(sources.dataDir, HOST_LOCK_FILE), 'utf8'))?.pid
  } catch {
    lockPid = undefined
  }

  let webBundle: HostDoctorFacts['webBundle']
  if (sources.webDistIndex !== undefined && sources.webDistIndex !== '') {
    try {
      const entry = entryScriptName(await readFile(sources.webDistIndex, 'utf8'))
      webBundle = entry === undefined ? {} : { entry }
    } catch {
      webBundle = {}
    }
  }

  let corpusDir: HostDoctorFacts['corpusDir']
  if (sources.sillyTavernDir !== undefined && sources.sillyTavernDir !== '') {
    let readable = false
    try {
      await readdir(sources.sillyTavernDir)
      readable = true
    } catch {
      readable = false
    }
    corpusDir = { path: sources.sillyTavernDir, readable }
  }

  let cardStorage: HostDoctorFacts['cardStorage']
  if (sources.cardStorage !== undefined) {
    try {
      cardStorage = { bytes: await sources.cardStorage.size(), limit: sources.cardStorage.limit }
    } catch {
      cardStorage = undefined
    }
  }

  return {
    irisVersion: IRIS_VERSION,
    node: sources.node ?? process.version,
    pid: sources.pid ?? process.pid,
    ...webBundle === undefined ? {} : { webBundle },
    dataDir: {
      path: sources.dataDir,
      writable: await answers(sources.dataDir, constants.W_OK),
      ...lockPid === undefined ? {} : { lockPid },
    },
    ...corpusDir === undefined ? {} : { corpusDir },
    ...cardStorage === undefined ? {} : { cardStorage },
  }
}
