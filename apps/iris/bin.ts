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

const ctx = await boot('iris', fileURLToPath(new URL('./cordis.yml', import.meta.url)))

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
console.log([
  'iris: host composition active.',
  `  listening: ${url}`,
  interfaceLine,
  `  endpoint:  ${endpoint}`,
  `  model:     ${model}`,
  'Ctrl+C to stop.',
].join('\n'))
