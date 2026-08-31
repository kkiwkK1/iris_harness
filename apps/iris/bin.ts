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

import { fileURLToPath } from 'node:url'
import { boot, loadEnv } from '@deepseek-ai/dsh-app-boot'

const here = fileURLToPath(new URL('.', import.meta.url))

// Inherited environment wins over the file, so a one-off override still works.
loadEnv('iris', here)

const ctx = await boot('iris', fileURLToPath(new URL('./cordis.yml', import.meta.url)))

const shutdown = async (): Promise<void> => {
  await ctx.fiber.dispose()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

const endpoint = process.env.IRIS_BASE_URL ?? 'http://127.0.0.1:11434/v1 (default)'
const model = process.env.IRIS_MODEL ?? 'local-model (default)'
console.log(`iris: host composition active.\n  endpoint: ${endpoint}\n  model:    ${model}\nCtrl+C to stop.`)
