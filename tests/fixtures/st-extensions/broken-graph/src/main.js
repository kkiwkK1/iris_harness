// Three refusal arms: an own import whose target is absent from the tree, a
// host-shaped import that resolves to an unregistered path with no unique
// registered tail-match, and a near-miss whose tail does match one registered
// path — that one must read 'unknown', not 'missing'.
import { gone } from './absent.js'
import { made } from '../../../../made-up.js'
import { wi } from '../../../../../extensions/world-info.js'

export { gone, made, wi }
