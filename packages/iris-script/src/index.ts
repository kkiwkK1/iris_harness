/**
 * Card script extraction and the remote-source policy.
 *
 * Deliberately free of any runtime: this package answers what a card contains
 * and where it may fetch from, and nothing here can run a script. The runner
 * lives in the browser, where the frame boundary is, and keeping the two apart
 * means the host can list and vet a card's scripts without a page open.
 *
 * @module @iris/script
 */

export {
  extractScripts,
  runnableScripts,
} from './extract.ts'

export {
  allowedScriptSources,
  ALLOWED,
  checkScriptFetch,
  type FetchVerdict,
} from './remote.ts'

export type {
  CardScript,
  CardScriptBundle,
  ScriptButton,
  ScriptType,
} from './types.ts'
