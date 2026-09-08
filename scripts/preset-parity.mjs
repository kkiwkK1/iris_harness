#!/usr/bin/env node
/**
 * Compare SillyTavern's request with Iris's, for the same card, preset and
 * conversation.
 *
 * A shell, deliberately: everything that decides anything lives in
 * `@iris/preset`'s `parity.ts`, where it is typechecked and covered by
 * `packages/iris-preset/tests/parity.test.ts`. This file reads files, optionally
 * stands a headless host up to produce the Iris side, and prints.
 *
 * ## Cache-friendly assembly reorders the request
 *
 * Iris's cache-friendly assembly (on by default) deliberately moves
 * contributions that change between turns behind the conversation. That is a
 * **bigger** reordering than anything a fidelity audit is looking for and it
 * will bury every other finding under "moved". Capture the Iris side with
 * `IRIS_CACHE_FRIENDLY=0` — or `cacheFriendly: false` on the chat — to get
 * SillyTavern's own order. When this script assembles the Iris side itself it
 * sets that variable before the host loads and says so in the header.
 *
 * ## Usage
 *
 *   # both sides already captured (see scripts/capture-endpoint.mjs)
 *   node scripts/preset-parity.mjs --st cap/st/2026…json --iris cap/iris/2026…json
 *
 *   # ST captured, Iris assembled here from a copy of the profile
 *   node scripts/preset-parity.mjs --st cap/st/2026…json \
 *     --data apps/iris/data --chat <chatId>
 *
 *   # compare as sent, without merging system runs
 *   node scripts/preset-parity.mjs --st … --iris … --no-merge-system
 *
 * `notes/packages/iris-preset/PARITY-HOWTO.md` is the walk-through.
 *
 * @module scripts/preset-parity
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareBodies, renderReport } from '../packages/iris-preset/src/parity.ts'

/**
 * Parse `--flag value` and `--no-flag` arguments.
 * @param argv - `process.argv.slice(2)`.
 * @returns the flags.
 */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    if (name.startsWith('no-')) {
      args[name.slice(3)] = false
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) args[name] = true
    else {
      args[name] = next
      index += 1
    }
  }
  return args
}

/**
 * Assemble the Iris side here, against a **copy** of a profile.
 *
 * The host module is imported lazily so `--st/--iris` — the comparison a user
 * runs most — never pays for standing a service up, and so a broken host cannot
 * stop two captured files from being compared.
 * @param dataDir - the profile root to copy.
 * @param chatId - the chat whose newest turn to assemble.
 * @returns the request body Iris would have POSTed.
 */
async function assembleIris(dataDir, chatId) {
  // Set before the host loads: `cacheFriendlyAllowed` reads the environment at
  // assembly time, and a reordered request would bury every finding below.
  process.env['IRIS_CACHE_FRIENDLY'] = '0'
  const host = await import('./lib/cache-host.mjs')
  const scratch = await host.copyProfile(dataDir, host.DEFAULT_PROFILE, host.SCRATCH_ROOT)
  const built = await host.buildHost(scratch)
  const { options } = await built.assembleOnce(chatId)
  return host.serializeRequest(options)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args['st'] !== 'string') {
    process.stderr.write('usage: preset-parity.mjs --st <captured ST body>'
      + ' (--iris <captured Iris body> | --data <profile> --chat <chatId>)'
      + ' [--no-merge-system]\n')
    process.exit(2)
  }
  const st = JSON.parse(await readFile(args['st'], 'utf8'))
  let iris
  let source
  if (typeof args['iris'] === 'string') {
    iris = JSON.parse(await readFile(args['iris'], 'utf8'))
    source = args['iris']
  } else if (typeof args['data'] === 'string' && typeof args['chat'] === 'string') {
    iris = await assembleIris(args['data'], args['chat'])
    source = `assembled from ${args['data']} chat ${args['chat']} (IRIS_CACHE_FRIENDLY=0)`
  } else {
    process.stderr.write('need either --iris <file> or --data <profile> --chat <chatId>\n')
    process.exit(2)
  }
  process.stdout.write(`ST   ${args['st']}\nIris ${source}\n\n`)
  const report = compareBodies(st, iris, { mergeSystem: args['merge-system'] !== false })
  process.stdout.write(`${renderReport(report)}\n`)
}
