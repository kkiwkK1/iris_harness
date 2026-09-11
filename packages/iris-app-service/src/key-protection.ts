/**
 * Encryption at rest for the one secret this host stores: a provider API key.
 *
 * **What was here before.** `connections.json` carried `apiKey` as the user
 * typed it. Upstream SillyTavern does the same — `src/endpoints/secrets.js:150`
 * writes `JSON.stringify(secrets, null, 4)` and `:204-223` puts the value into
 * it verbatim — so the plaintext was compatible behaviour, and it is still the
 * behaviour of every SillyTavern install. It is also a file that any process
 * running as the user, any backup, any folder-sync client and anyone who
 * borrows the machine can read with `type`. A key is the one thing in a profile
 * whose loss costs money rather than time, so it is the one thing worth paying
 * for.
 *
 * **Envelope, not a passphrase.** A random 32-byte *data key* encrypts every
 * stored value with AES-256-GCM, and the data key itself is wrapped by the
 * operating system and kept beside the profiles. The alternative — deriving a
 * key from something the user types — buys protection from the user's own
 * account, which is not the threat, at the cost of a prompt on every start of a
 * host whose entire design is that it starts without one.
 *
 * **Two protectors, and the choice is measured rather than declared.** On
 * Windows, `ProtectedData.Protect` under `CurrentUser` — DPAPI — is the
 * keystore every other local tool on that platform uses, and it binds the
 * wrapped key to the logged-in account, so a copy of the profile folder on
 * another machine or under another account decrypts nothing. Node has no
 * binding for it, so it is reached through one PowerShell spawn (measured on
 * this machine 2026-09-11: 289 ms to protect, 255 ms to unprotect, `pwsh` about
 * 380 ms; a 32-byte key wraps to 262 bytes). The host pays that once per boot
 * and once per key creation, never per request. Everywhere else — and on a
 * Windows machine where neither `powershell.exe` nor `pwsh` can be spawned —
 * the data key is stored unwrapped in a `0o600` file, which is **weaker than a
 * keystore and says so out loud at boot**: it stops the casual read of
 * `connections.json` and a sync client that only carries `*.json`, and it stops
 * nothing else. An honest fallback beats a silent one, and beats refusing to
 * start.
 *
 * **The direction that is never automatic.** `dpapi` → `file` may happen when
 * the data key is *created*, because there the alternative is a host that
 * cannot store a key at all. It must never happen at *unwrap*: a wrapped key
 * this machine cannot open is a signal (another account, another machine, a
 * tampered file), and answering it by writing a weaker one would turn a
 * detected problem into a silent downgrade.
 *
 * @module @iris/app-service/key-protection
 */

import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, readFile } from 'node:fs/promises'

import { atomicWriteFile } from './atomic.ts'

/** Bytes of the data key every stored value is encrypted with. AES-256. */
export const DATA_KEY_BYTES = 32
/** Bytes of the per-value nonce. 96 bits is GCM's own recommendation. */
const IV_BYTES = 12

/**
 * A stored value, as the file carries it.
 *
 * Base64 rather than hex for the same reason the wrapped key is base64: this
 * lands in JSON a human occasionally reads, and a third fewer characters is a
 * third less of a file that should not invite reading. `v` is the envelope's
 * version, present from the first write so a second shape never has to be told
 * apart from the first by guessing at its fields.
 */
export interface EncryptedValue {
  /** The envelope version. `1` is AES-256-GCM with a 12-byte IV and the row id as AAD. */
  v: 1
  /** The nonce, base64. Fresh for every write of every value. */
  iv: string
  /** GCM's 16-byte authentication tag, base64. */
  tag: string
  /** The ciphertext, base64. */
  ct: string
}

/**
 * Whether a parsed value is an envelope this build can open.
 *
 * A shape check rather than a cast, because this is read from a file a user can
 * edit and a build from the future can write. A row whose envelope is not
 * understood is left alone and read as "no key" — never dropped.
 * @param value - anything the file's `apiKeyEnc` field held.
 * @returns true when every field is present and the version is this one.
 */
export function isEncryptedValue(value: unknown): value is EncryptedValue {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return row['v'] === 1
    && typeof row['iv'] === 'string'
    && typeof row['tag'] === 'string'
    && typeof row['ct'] === 'string'
}

/**
 * Encrypt one value under the data key, bound to the row it belongs to.
 *
 * `aad` is the profile's id, and the binding it buys is the one a file editor
 * reaches for first: copying another row's `apiKeyEnc` onto their own profile,
 * which without it would decrypt happily and generate with someone else's
 * credential. With it, GCM refuses, because the id the ciphertext was sealed
 * against is not the id it is being opened under.
 * @param dataKey - the 32 bytes from {@link KeyProtector}.
 * @param aad - the profile id this value belongs to.
 * @param plaintext - the key as the user typed it.
 * @returns the envelope to store.
 */
export function encryptValue(dataKey: Uint8Array, aad: string, plaintext: string): EncryptedValue {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

/**
 * Open one stored value, or refuse.
 *
 * Throws on a flipped ciphertext byte, a flipped tag, a value moved to another
 * profile's row, and a data key that is not the one it was sealed with — all
 * four are the same GCM verdict, and all four are cases where the honest answer
 * is "this is not readable" rather than a string.
 * @param dataKey - the 32 bytes from {@link KeyProtector}.
 * @param aad - the profile id the value is stored under.
 * @param value - the envelope from the file.
 * @returns the plaintext key.
 * @throws {Error} when the tag does not verify or the envelope is malformed.
 */
export function decryptValue(dataKey: Uint8Array, aad: string, value: EncryptedValue): string {
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(value.iv, 'base64'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  const out = Buffer.concat([decipher.update(Buffer.from(value.ct, 'base64')), decipher.final()])
  return out.toString('utf8')
}

/**
 * Something that can put the data key somewhere this machine can get it back
 * from and another machine cannot.
 *
 * An interface rather than a function pair so the **kind travels with the
 * implementation**: what wrapped a key decides what may unwrap it, and reading
 * `kind` back out of the file is how the store refuses to open a DPAPI blob
 * with the file protector.
 */
export interface KeyProtector {
  /** What lands in the key file's `kind`, and what a later boot looks up by. */
  readonly kind: string
  /**
   * Wrap the data key.
   * @param dataKey - the raw bytes.
   * @returns base64 of whatever the protector stores.
   */
  wrap(dataKey: Uint8Array): Promise<string>
  /**
   * Open a wrapped data key.
   * @param wrapped - the base64 from the key file.
   * @returns the raw bytes.
   * @throws {Error} when this machine, this account or these bytes cannot.
   */
  unwrap(wrapped: string): Promise<Uint8Array>
}

/**
 * The optional entropy DPAPI mixes in, so a blob of ours is not opened by an
 * unrelated program running as the same user that happens to call `Unprotect`.
 *
 * Fixed and in the source on purpose: it is not a secret and cannot be one — it
 * ships with the program. It is a namespace, and its only job is to make the
 * ciphertext specific to this application.
 */
const DPAPI_ENTROPY = 'iris:connections:v1'

/** The interpreters tried, in order. `powershell.exe` is on every Windows; `pwsh` is the 7.x install. */
const POWERSHELL_EXECUTABLES = ['powershell.exe', 'pwsh'] as const

/**
 * The script one spawn runs.
 *
 * **Bytes never touch the command line.** The base64 goes in on stdin and comes
 * back on stdout, because a command line is readable by every process on the
 * machine (`Get-CimInstance Win32_Process` needs no privilege for one's own
 * user) and is what a shell history and a process-monitor log keep. The script
 * itself is on the command line — it is not secret — and it contains no double
 * quote, so no layer of Windows argument quoting can change what it means.
 *
 * `Add-Type` is attempted and its failure swallowed: Windows PowerShell 5.1
 * needs it to see `System.Security`, PowerShell 7 already has the type and
 * answers the request with an error. Wanting the type present is the whole
 * requirement; which of the two provided it is not.
 * @param verb - `Protect` or `Unprotect`.
 * @returns the one-liner to hand `-Command`.
 */
function dpapiScript(verb: 'Protect' | 'Unprotect'): string {
  return [
    'try {',
    '$ErrorActionPreference = \'Stop\';',
    'try { Add-Type -AssemblyName System.Security } catch {};',
    '$text = [Console]::In.ReadToEnd();',
    '$bytes = [Convert]::FromBase64String($text.Trim());',
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}');`,
    `$out = [Security.Cryptography.ProtectedData]::${verb}`
    + '($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Console]::Out.Write([Convert]::ToBase64String($out));',
    'exit 0',
    '} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }',
  ].join(' ')
}

/** What a spawn answered, kept apart from "there is no such interpreter". */
interface SpawnOutcome {
  /** Base64 on stdout, when the script exited 0. */
  output?: string
  /** Why not, in one line, when it did not. */
  failure?: string
  /** True when the executable itself is not on this machine — the one case a caller may retry. */
  missing?: boolean
}

/**
 * Run one PowerShell, handing it bytes on stdin.
 *
 * Never rejects: the two failures a caller has to tell apart — "no such
 * interpreter" and "the interpreter said no" — are a rejection and a rejection,
 * and collapsing them is how a missing `powershell.exe` would be reported as a
 * corrupt key file.
 * @param executable - `powershell.exe` or `pwsh`.
 * @param verb - `Protect` or `Unprotect`.
 * @param input - base64 to write to stdin.
 * @param spawnFn - the spawn, injectable so a test can assert the arguments.
 * @returns what happened.
 */
async function runPowerShell(
  executable: string,
  verb: 'Protect' | 'Unprotect',
  input: string,
  spawnFn: typeof spawn,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    let child
    try {
      child = spawnFn(
        executable,
        ['-NoProfile', '-NonInteractive', '-Command', dpapiScript(verb)],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
    } catch (error: unknown) {
      resolve({ failure: error instanceof Error ? error.message : String(error) })
      return
    }
    let output = ''
    let errors = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { output += chunk })
    child.stderr?.on('data', (chunk: string) => { errors += chunk })
    child.on('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'ENOENT'
        ? { missing: true, failure: `${executable} is not on this machine` }
        : { failure: error.message })
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ output: output.trim() })
      // The message is the .NET exception's, which names the condition
      // ("Key not valid for use in specified state" is the other account) far
      // better than an exit code would. It never contains the bytes: the script
      // writes only `$_.Exception.Message`.
      else resolve({ failure: `${executable} exited ${String(code ?? -1)}: ${errors.replace(/\s+/gu, ' ').trim()}` })
    })
    child.stdin?.end(input)
  })
}

/**
 * The Windows keystore, reached through one spawn per call.
 * @param spawnFn - the spawn, injectable so a test can assert the arguments.
 * @returns a protector whose `kind` is `dpapi`.
 */
export function dpapiProtector(spawnFn: typeof spawn = spawn): KeyProtector {
  const call = async (verb: 'Protect' | 'Unprotect', input: string): Promise<string> => {
    const failures: string[] = []
    for (const executable of POWERSHELL_EXECUTABLES) {
      const outcome = await runPowerShell(executable, verb, input, spawnFn)
      if (outcome.output !== undefined) return outcome.output
      failures.push(outcome.failure ?? 'no output')
      // Only a *missing* interpreter is worth trying the next one for. A
      // PowerShell that ran and refused has given the answer; asking a second
      // one would replace a real diagnosis ("this blob belongs to another
      // account") with "pwsh is not installed".
      if (outcome.missing !== true) break
    }
    throw new Error(failures.join('; '))
  }
  return {
    kind: 'dpapi',
    async wrap(dataKey: Uint8Array): Promise<string> {
      return call('Protect', Buffer.from(dataKey).toString('base64'))
    },
    async unwrap(wrapped: string): Promise<Uint8Array> {
      return Buffer.from(await call('Unprotect', wrapped), 'base64')
    },
  }
}

/**
 * The fallback: the data key as it is, in a file only its owner may read.
 *
 * Not a protector in the cryptographic sense and the name would be a lie if the
 * boot did not say so; {@link KEY_FILE_WARNING} is the sentence that pays for
 * it. What it does buy is real and small: the key is no longer in the file a
 * person opens to look at their providers, and the mode keeps it out of the
 * other accounts on a shared POSIX machine.
 * @returns a protector whose `kind` is `file`.
 */
export function fileProtector(): KeyProtector {
  return {
    kind: 'file',
    // `async` on both because the interface is DPAPI's shape; there is nothing
    // here to await, and a synchronous variant of the interface would make the
    // one protector that spawns the odd one out.
    async wrap(dataKey: Uint8Array): Promise<string> {
      return Promise.resolve(Buffer.from(dataKey).toString('base64'))
    },
    async unwrap(wrapped: string): Promise<Uint8Array> {
      const bytes = Buffer.from(wrapped, 'base64')
      if (bytes.length !== DATA_KEY_BYTES) {
        throw new Error(`the stored data key is ${String(bytes.length)} bytes, not ${String(DATA_KEY_BYTES)}`)
      }
      return Promise.resolve(bytes)
    },
  }
}

/** What a boot that fell back to {@link fileProtector} tells the user, once. */
export const KEY_FILE_WARNING
  = 'the connection data key is stored unwrapped beside the profiles, which is weaker than an OS keystore:'
    + ' anything that can read the file can read the keys.'
    + ' See notes/packages/iris-app-service/DEVIATIONS.md §75'

/** The key file's shape. */
export interface KeyFile {
  /** Which protector wrapped {@link wrapped}; the only thing allowed to unwrap it. */
  kind: string
  /** The wrapped data key, base64. */
  wrapped: string
}

/**
 * Whether this machine can be asked for the Windows keystore at all.
 *
 * Answered by *doing the work* rather than by a capability probe: the first
 * wrap either succeeds or reports a missing interpreter, and a separate
 * "is PowerShell there" spawn would be a second spawn measuring a different
 * moment than the one that matters.
 * @param platform - `process.platform` in the product.
 * @returns true when DPAPI is worth attempting.
 */
export function dpapiPossible(platform: string): boolean {
  return platform === 'win32'
}

/**
 * Wrap a freshly minted data key, falling back out loud.
 *
 * **One spawn**, and the wrap the caller needs is that spawn — a capability
 * probe before it would double the cost of every key creation to learn what the
 * work itself is about to say. The fallback lives here and only here: a Windows
 * host with no PowerShell that refused to store a key would be a host that
 * cannot save a provider, which is a worse answer than a weaker file with a
 * warning on it. Nothing about the *unwrap* path may reason this way.
 * @param dataKey - the raw bytes to wrap.
 * @param options - the platform, the spawn and where a warning goes.
 * @returns the key file to write.
 */
export async function wrapNewDataKey(dataKey: Uint8Array, options: {
  platform?: string
  spawnFn?: typeof spawn
  onWarn?: (message: string) => void
} = {}): Promise<KeyFile> {
  if (dpapiPossible(options.platform ?? process.platform)) {
    try {
      const dpapi = dpapiProtector(options.spawnFn ?? spawn)
      return { kind: dpapi.kind, wrapped: await dpapi.wrap(dataKey) }
    } catch (error: unknown) {
      options.onWarn?.(`the Windows key store could not be reached (${
        error instanceof Error ? error.message : String(error)}); ${KEY_FILE_WARNING}`)
    }
  } else {
    options.onWarn?.(KEY_FILE_WARNING)
  }
  const plain = fileProtector()
  return { kind: plain.kind, wrapped: await plain.wrap(dataKey) }
}

/**
 * The protector a stored key file names — and nothing else.
 *
 * A file saying `dpapi` is opened by DPAPI or not at all. The refusal to
 * substitute is the whole point: see the module note on downgrades.
 * @param kind - the key file's `kind`.
 * @param spawnFn - the spawn, injectable so a test can assert the arguments.
 * @returns the protector.
 * @throws {Error} when no protector answers to that name.
 */
export function protectorForKind(kind: string, spawnFn: typeof spawn = spawn): KeyProtector {
  if (kind === 'dpapi') return dpapiProtector(spawnFn)
  if (kind === 'file') return fileProtector()
  throw new Error(`the key file names a protector this build does not have ("${kind}")`)
}

/**
 * Write the key file, with the bits on the inode from its first byte.
 *
 * `0o600` is a POSIX statement and Windows ACLs are not it — the mode is passed
 * anyway, where it is a no-op, rather than branching on the platform to say the
 * same thing. What protects the file on Windows is DPAPI: the bytes there are
 * wrapped, so their readability is not the question.
 * @param path - the key file.
 * @param file - what to write.
 */
export async function writeKeyFile(path: string, file: KeyFile): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  // Again after the rename, because the mode above applies to the temporary at
  // creation and a `rename` over an *existing* target keeps the target's inode
  // on no filesystem this runs on — but a umask that cleared a bit, or a
  // previous file created before this call existed, would leave it wrong. One
  // syscall to be sure beats a comment claiming it cannot happen.
  await chmod(path, 0o600).catch(() => {})
}

/**
 * Read the key file back, or say there is none.
 * @param path - the key file.
 * @returns its contents, or `undefined` when the file is absent.
 * @throws {Error} when the file is there and is not a key file.
 */
export async function readKeyFile(path: string): Promise<KeyFile | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the key file is not an object')
  const row = parsed as Record<string, unknown>
  if (typeof row['kind'] !== 'string' || typeof row['wrapped'] !== 'string') {
    throw new Error('the key file carries no kind and wrapped pair')
  }
  return { kind: row['kind'], wrapped: row['wrapped'] }
}
