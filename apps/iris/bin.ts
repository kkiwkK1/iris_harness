#!/usr/bin/env node
/**
 * The Iris host process.
 *
 * Boots the composition in `cordis.yml` and holds it open. Every capability is
 * a plugin row in that file, so this bin owns nothing but startup, shutdown,
 * and reading the local `.env` — which exists so configuring an endpoint never
 * depends on the shell's environment-variable syntax. PowerShell has no
 * `VAR=value cmd` prefix form, and telling Windows users to fight that is a
 * worse answer than reading a file.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { boot, loadEnv } from '@deepseek-ai/dsh-app-boot'
// Imported for its `Context.webServer` declaration: the bin reads the bound
// port so it can print a URL that is true even when the configured one was taken.
import type {} from '@deepseek-ai/dsh-host-webserver'

import { describePortDrift, describePortInUse } from './banner.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

// Inherited environment wins over the file, so a one-off override still works.
loadEnv('iris', here)

// Where the built interface lives. The bin resolves it because the dist path is
// workspace knowledge — a `!!js` expression in the composition would have to
// guess at the working directory. Left unset when there is no build, which
// disables the static row instead of failing the boot: the host is useful on
// its own (the transport tests drive it headless), and telling someone to run a
// build before they can start the process at all is a worse first experience
// than telling them the interface is not built yet.
const distIndex = fileURLToPath(new URL('../iris-web/dist/index.html', import.meta.url))
if (process.env.IRIS_WEB_DIST === undefined && existsSync(distIndex)) {
  process.env.IRIS_WEB_DIST = distIndex
}

// A boot that dies because something already holds the port reaches the person
// as a Cordis plugin-tree stack trace naming a package they never configured.
// One sentence instead — and anything else still gets the trace, because a
// swallowed unknown failure is worse than an ugly one.
//
// The other refusal this host can make at startup — a data directory another
// host already has open — prints its own sentence from inside the app service
// and arrives here as an ordinary failed boot.
const bootOrExplain = async (): Promise<Awaited<ReturnType<typeof boot>>> => {
  try {
    return await boot('iris', fileURLToPath(new URL('./cordis.yml', import.meta.url)))
  } catch (error: unknown) {
    const taken = describePortInUse(error)
    if (taken === undefined) throw error
    console.error(taken)
    process.exit(1)
  }
}
const ctx = await bootOrExplain()

const shutdown = async (): Promise<void> => {
  await ctx.fiber.dispose()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

const endpoint = process.env.IRIS_BASE_URL ?? 'http://127.0.0.1:11434/v1 (default)'
const model = process.env.IRIS_MODEL ?? 'local-model (default)'
// The bound port, not the configured one: `port: 0` and an already-taken port
// both make the two differ, and printing the config would send the user nowhere.
const url = `http://${ctx.webServer.host}:${String(ctx.webServer.port)}`
const interfaceLine = process.env.IRIS_WEB_DIST === undefined
  ? '  interface: not built — run `pnpm build:web`, then restart'
  : `  interface: ${url}`
// Only when `IRIS_PORT` names one: the composition's default is written in
// `cordis.yml` and restating `8787` here would be a second copy of a constant.
const configuredPort = process.env.IRIS_PORT === undefined ? undefined : Number(process.env.IRIS_PORT)
const driftLine = describePortDrift(configuredPort, ctx.webServer.port)
console.log([
  'iris: host composition active.',
  `  listening: ${url}`,
  ...driftLine === undefined ? [] : [driftLine],
  interfaceLine,
  `  endpoint:  ${endpoint}`,
  `  model:     ${model}`,
  'Ctrl+C to stop.',
].join('\n'))
