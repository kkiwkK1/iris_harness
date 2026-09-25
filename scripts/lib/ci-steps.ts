import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The `run:` steps of `.github/workflows/ci.yml`, read from the workflow
 * itself.
 *
 * `scripts/gate.mjs` runs these, so the local gate is the CI job by
 * construction rather than a second list kept in step by hand. A hand-kept
 * list is how the old `verify` script came to run two of the six CI checks
 * with nothing noticing.
 *
 * The reader understands the subset of YAML the workflow uses, and refuses the
 * rest rather than guessing. A step is `- name:` or `- uses:` at the step
 * indent. Inside it, `run:` must be a single line, and `working-directory:`
 * and an `env:` map of scalars are read. A block scalar (`run: |`) throws,
 * because running half a multi-line script would report a pass for commands
 * that never ran. `apps/iris/tests/gate.test.ts` pins that the reader finds
 * the job's steps.
 *
 * @module scripts/lib/ci-steps
 */

/** One `run:` step. */
export interface CiStep {
  /** The step's `name:`, or its command when it has none. */
  name: string
  /** The single-line command. */
  run: string
  /** Relative to the repository root; `.` when the step names none. */
  workingDirectory: string
  /** The step's `env:` map. */
  env: Record<string, string>
}

/** Strip one layer of matching quotes from a YAML scalar. */
function scalar(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2 && (trimmed[0] === '\'' || trimmed[0] === '"') && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * The run steps in a workflow's text, in order.
 *
 * @param text - the workflow YAML.
 * @returns every step that has a `run:`; `uses:` steps are left out.
 */
export function ciStepsOf(text: string): CiStep[] {
  const lines = text.split(/\r?\n/)
  const steps: CiStep[] = []
  let current: { name?: string, run?: string, workingDirectory?: string, env: Record<string, string> } | undefined
  let stepIndent = -1
  let inEnv = false
  let envIndent = -1

  const flush = (): void => {
    if (current?.run !== undefined) {
      steps.push({
        name: current.name ?? current.run,
        run: current.run,
        workingDirectory: current.workingDirectory ?? '.',
        env: current.env,
      })
    }
    current = undefined
  }

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const start = /^(\s*)- (name|uses):\s*(.*)$/.exec(line)
    if (start !== null && (stepIndent === -1 || indent === stepIndent)) {
      flush()
      stepIndent = indent
      current = { env: {} }
      inEnv = false
      if (start[2] === 'name') current.name = scalar(start[3] ?? '')
      continue
    }
    if (current === undefined) continue
    if (indent <= stepIndent) {
      // Left the steps list.
      flush()
      continue
    }
    if (inEnv && indent > envIndent) {
      const pair = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
      if (pair === null) throw new Error(`ci.yml: an env entry this reader cannot parse: ${line.trim()}`)
      current.env[pair[1] as string] = scalar(pair[2] ?? '')
      continue
    }
    inEnv = false
    const key = /^\s*([a-z-]+):\s*(.*)$/.exec(line)
    if (key === null) continue
    const [, name, value = ''] = key
    if (name === 'name') current.name = scalar(value)
    else if (name === 'run') {
      if (/^[|>]/.test(value.trim())) {
        throw new Error(`ci.yml: step "${current.name ?? '?'}" has a multi-line run, which this reader does not run`)
      }
      current.run = scalar(value)
    } else if (name === 'working-directory') current.workingDirectory = scalar(value)
    else if (name === 'env') {
      inEnv = true
      envIndent = indent
    }
  }
  flush()
  return steps
}

/**
 * The run steps of the repository's CI workflow.
 *
 * @param root - the repository root.
 * @returns the steps, in order.
 */
export function readCiSteps(root: string): CiStep[] {
  return ciStepsOf(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'))
}
