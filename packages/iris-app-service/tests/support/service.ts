import { join } from 'node:path'
import type { TestContext } from 'node:test'

import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../../src/chats.ts'
import { CharacterLibrary } from '../../src/library.ts'
import { IrisAppService, type AppServiceOptions, type Handlers } from '../../src/service.ts'
import { SettingsStore } from '../../src/settings.ts'
import { tempDir } from './temp-dir.ts'

/**
 * One way for a test to get an `IrisAppService`.
 *
 * Why it exists: on 2026-09-25, 74 test files (104 call sites) built the
 * service by hand, each choosing its own subset of the 44-field
 * `AppServiceOptions` bag. Splitting `service.ts`, or changing that bag, then
 * means editing 74 files, and a test that goes red because a constructor moved
 * looks the same as one that goes red because a behaviour changed. With one
 * builder, a change to the composition is one edit here.
 *
 * `packages/iris-app-service/tests/service-construction.test.ts` holds the
 * rule: a test file that still writes the constructor itself must be on a
 * named allowance list, and that list can only shrink.
 *
 * ## What the builder fills in, and what it does not
 *
 * It fills in only the five **required** options, and only with values that
 * carry no meaning for an assertion:
 *
 * | option     | default                                                    |
 * | ---------- | ---------------------------------------------------------- |
 * | `library`  | `<dir>/characters`, avatar base `/iris/avatar`             |
 * | `chats`    | `<dir>/chats` over that library, no other collaborators    |
 * | `settings` | `<dir>/settings.json`, defaults `{ provider: 'test', model: 'test-model' }` |
 * | `stream`   | finishes at once with `stop`, having said nothing          |
 * | `broadcast`| appends to the returned `events` array                     |
 *
 * Everything optional stays absent unless the test passes it, `userName`
 * included. A test that asserts on a value passes that value itself (the
 * CONTRIBUTING rule that different scenarios use different fixtures), so a
 * default here can never be what makes a test pass. The one value tests read
 * back, the settings model, has a name no production path uses.
 *
 * ## Overrides
 *
 * Either a plain `Partial<AppServiceOptions>`, or a function of the base that
 * returns one. The function form exists because most stores need a path, and
 * the path is only known once the directory exists: it receives `dir` plus the
 * default `library` and `settings`, so a test that needs a `ChatStore` wired to
 * a `WorldbookStore` can build it over the same library. Write fixture files
 * inside the function, since it runs after the directory exists and before the
 * service is built.
 *
 * Cleanup: the directory is registered for removal on `t.after` by `tempDir`.
 * The service holds no process-wide resources of its own.
 *
 * @module @iris/app-service/tests/support/service
 */

/** What an override function is handed. */
export interface TestServiceBase {
  /** The test's own temporary directory, removed after the test. */
  dir: string
  /** The default library at `<dir>/characters`. */
  library: CharacterLibrary
  /** The default settings at `<dir>/settings.json`. */
  settings: SettingsStore
}

/** Either the options to set, or a function of the base that returns them. */
export type TestServiceOverrides =
  | Partial<AppServiceOptions>
  | ((base: TestServiceBase) => Partial<AppServiceOptions> | Promise<Partial<AppServiceOptions>>)

/** What the builder returns. */
export interface TestService {
  service: IrisAppService
  handlers: Handlers
  /** The options the service was built with, defaults and overrides merged. */
  options: AppServiceOptions
  dir: string
  /** Every event the service broadcast, when `broadcast` was not overridden. */
  events: IrisEvent[]
}

/**
 * A stream that ends the reply at once, having said nothing.
 *
 * For tests that never generate, or that only need a generation to finish.
 */
export const silentStream: StreamFn = async function* () {
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Build a service over a fresh temporary directory.
 *
 * @param t - the test context; the directory is removed on its `t.after`.
 * @param overrides - options to set, or a function of the base returning them.
 * @param prefix - the temporary directory's name prefix, for finding a leak.
 * @returns the service, its handlers, the options it was built with, the
 *   directory, and the broadcast events.
 */
export async function createTestService(
  t: TestContext,
  overrides: TestServiceOverrides = {},
  prefix = 'iris-svc-',
): Promise<TestService> {
  const dir = await tempDir(t, prefix)
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const chosen = typeof overrides === 'function' ? await overrides({ dir, library, settings }) : overrides

  const events: IrisEvent[] = []
  const chosenLibrary = chosen.library ?? library
  const options: AppServiceOptions = {
    stream: silentStream,
    library: chosenLibrary,
    settings,
    broadcast: event => { events.push(event) },
    ...chosen,
    // After the spread, so that an override naming its own library gets a
    // chat store over that library rather than over the default one.
    chats: chosen.chats ?? new ChatStore(join(dir, 'chats'), chosenLibrary),
  }
  const service = new IrisAppService(options)
  return { service, handlers: service.handlers(), options, dir, events }
}
