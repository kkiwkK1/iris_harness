/**
 * Per-profile persistence for an installed ST extension's own settings blob
 * (`extension_settings.EjsTemplate` upstream). One JSON file per extension,
 * written atomically (tmp + rename), keyed by the safe extension id the
 * installer validated.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { settingsKeyFor } from './settings.ts'

export class StExtensionSettingsStore {
  readonly #dir: string
  readonly #onProblem: ((message: string) => void) | undefined

  constructor(dir: string, onProblem?: (message: string) => void) {
    this.#dir = dir
    this.#onProblem = onProblem
  }

  /** The stored blob, or undefined when this extension has none yet. */
  async read(extensionId: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(this.#file(extensionId), 'utf8')) as unknown
    } catch (cause: unknown) {
      const code = (cause as { code?: string }).code
      if (code === 'ENOENT') return undefined
      this.#onProblem?.(`the settings file for "${extensionId}" could not be read (${String(cause)})`)
      return undefined
    }
  }

  async write(extensionId: string, blob: unknown): Promise<void> {
    const file = this.#file(extensionId)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(blob, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  #file(extensionId: string): string {
    return join(this.#dir, `${settingsKeyFor(extensionId)}.json`)
  }
}
