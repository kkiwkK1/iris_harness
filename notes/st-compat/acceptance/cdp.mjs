/**
 * The C-final acceptance driver's browser half: launch Chrome, drive it over
 * the DevTools protocol, read pages and frames, take screenshots.
 *
 * The plumbing follows `apps/iris-web/tests/frame-bootstrap-live.test.ts`
 * (one-envelope-per-id bookkeeping, frame sessions collected from
 * `Target.attachedToTarget`), kept as a module so every scenario script shares
 * one implementation.
 *
 * Run shape: every scenario script imports { withBrowser } from here, drives
 * the page through `page.*`, and lets this module own the process lifetime.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

// The one temp-directory rule for everything that starts a browser.
import { chromeProfile } from '../../../qa/chrome-profile.mjs'

const here = dirname(import.meta.url)

function dirname(url) {
  return join(fileURLToPath(new URL('.', url)))
}

/** Chrome's location, from the environment or the platform's usual place. */
export function chromeBinary() {
  const named = process.env['CHROME_PATH']
  if (named !== undefined && named !== '' && existsSync(named)) return named
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  return candidates.find(path => existsSync(path))
}

/** Whether a TCP port on loopback is free, checked rather than assumed. */
async function portFree(port) {
  return new Promise(check => {
    const probe = createConnection({ host: '127.0.0.1', port })
    probe.on('connect', () => { probe.destroy(); check(false) })
    probe.on('error', () => check(true))
  })
}

/** A loopback port nothing is listening on. */
export async function freePort() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const port = 9500 + Math.floor(Math.random() * 400)
    if (await portFree(port)) return port
  }
  throw new Error('no free loopback port found for the browser debugging endpoint')
}

/**
 * Launch Chrome with a debugging endpoint and wait until it answers.
 * @returns the child process plus the debugging port.
 */
export async function launchChrome({ headless = true } = {}) {
  const binary = chromeBinary()
  if (binary === undefined) throw new Error('no Chrome binary found — set CHROME_PATH')
  const port = await freePort()
  const profile = chromeProfile('iris-cdp-')
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--lang=en-US',
    ...(headless ? ['--headless=new', '--window-size=1440,900'] : []),
    'about:blank',
  ]
  const child = profile.adopt(spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] }))
  child.stderr.on('data', () => { /* Chrome writes progress noise; not ours to relay */ })
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (version.ok) return { child, port, profile }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      await profile.dispose()
      throw new Error('Chrome did not open its debugging endpoint')
    }
    await new Promise(wake => setTimeout(wake, 200))
  }
}

/** A CDP connection, with the one-envelope-per-id bookkeeping. */
export class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()
  /** Session id → target type. */
  sessions = new Map()
  #listeners = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', event => {
      const frame = JSON.parse(String(event.data))
      if (frame.id !== undefined) {
        const waiting = this.#pending.get(frame.id)
        if (waiting === undefined) return
        this.#pending.delete(frame.id)
        if (frame.error !== undefined) waiting.reject(new Error(frame.error.message ?? 'CDP error'))
        else waiting.resolve(frame.result ?? {})
        return
      }
      if (frame.method === 'Target.attachedToTarget') {
        const id = frame.params?.sessionId
        if (id !== undefined) this.sessions.set(id, frame.params?.targetInfo?.type ?? 'unknown')
      }
      for (const listen of this.#listeners.get(frame.method) ?? []) listen(frame.params)
    })
  }

  static async open(port) {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`)
    const info = await version.json()
    const url = info.webSocketDebuggerUrl
    if (url === undefined) throw new Error('the browser debugging endpoint named no socket')
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve)
      socket.addEventListener('error', () => reject(new Error('could not open the browser debugging socket')))
    })
    return new Cdp(socket)
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve_, reject) => {
      this.#pending.set(id, { resolve: resolve_, reject })
      this.#socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
    })
  }

  on(method, listener) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set())
    this.#listeners.get(method).add(listener)
    return () => this.#listeners.get(method)?.delete(listener)
  }

  close() { this.#socket.close() }
}

/** Evaluate an expression and return its value, refusing to swallow a throw. */
export async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text ?? 'unknown'
    throw new Error(`page eval failed: ${String(detail)}`)
  }
  return result.result?.value
}

/** The page-level session id (the first page target). */
export async function pageSession(cdp) {
  for (const [sessionId, type] of cdp.sessions) {
    if (type === 'page') return sessionId
  }
  // Pages may attach lazily; force the issue.
  const targets = await cdp.send('Target.getTargets')
  const page = targets.targetInfos.find(target => target.type === 'page')
  if (page === undefined) throw new Error('no page target in the browser')
  await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  for (const [sessionId, type] of cdp.sessions) {
    if (type === 'page') return sessionId
  }
  throw new Error('the page target never attached')
}

/**
 * Poll until a condition holds, or say what was last seen.
 * @param read - returns undefined while the condition is pending.
 */
export async function until(what, read, { tries = 60, gapMs = 250 } = {}) {
  let last
  for (let attempt = 0; attempt < tries; attempt += 1) {
    last = await read()
    if (last !== undefined && last !== false) return last
    await new Promise(wake => setTimeout(wake, gapMs))
  }
  throw new Error(`${what} never happened (last reading: ${JSON.stringify(last)})`)
}

/** Where screenshots land. */
export function evidenceDir() {
  return resolve(here, 'evidence')
}

/** One screenshot, saved under the evidence directory. */
export async function screenshot(cdp, sessionId, name) {
  await cdp.send('Page.enable', {}, sessionId)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const dir = evidenceDir()
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${name}.png`)
  await writeFile(file, Buffer.from(shot.data, 'base64'))
  return file
}

/**
 * One scenario's scaffold: browser up, page session found, helpers bound,
 * teardown that always kills the child **and removes its profile** — the kill
 * was always here, the removal was not, and each scenario used to leave a
 * `iris-cdp-*` directory behind (qa/chrome-profile.mjs).
 */
export async function withBrowser(run, { url, headless = true } = {}) {
  const { child, port, profile } = await launchChrome({ headless })
  const cdp = await Cdp.open(port)
  const sessionId = await pageSession(cdp)
  const evalInPage = expression => evaluate(cdp, sessionId, expression)
  try {
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    if (url !== undefined) {
      await cdp.send('Page.navigate', { url }, sessionId)
      await until('the page loads', async () => {
        const state = await evalInPage('document.readyState')
        return state === 'complete' || state === 'interactive' ? state : undefined
      })
    }
    return await run({ cdp, sessionId, eval: evalInPage, child })
  } finally {
    cdp.close()
    await profile.dispose()
  }
}
