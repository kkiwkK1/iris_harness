/**
 * The child process's entry point.
 *
 * Separate from `child.ts` so that importing the evaluator in a test does not
 * attach message handlers to the test runner's own process.
 *
 * @module @iris/compat-prompt-template/child-entry
 */

import { main } from './child.ts'

main()
