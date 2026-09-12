// A small self-authored artifact exercising every analyzer arm from one
// entry: mapped host imports at true depths, own-file edges (static, re-export
// and literal dynamic), an expression dynamic import, import.meta, a Worker
// with a baked absolute URL, and (via siblings) a bare specifier and css
// resource references. Never executed; only parsed.
import { getContext } from '../../../../../script.js'
import { helper } from './util.js'
export * from './re-export.js'

const lazy = () => import('./lazy.js')
const byName = name => import(name)
const here = import.meta.url
const worker = new Worker('/scripts/extensions/third-party/minimal-ok/src/worker.js')

export { helper, lazy, byName, here, worker }
