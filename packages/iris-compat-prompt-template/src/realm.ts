/**
 * The realm templates run in, and the one-way bridge into it.
 *
 * A `vm` context with no `process` and no working dynamic import is only half a
 * boundary. The other half is that **nothing inside it may hold a reference to
 * an object of this realm**, because every object carries its realm's prototype
 * chain and every prototype chain ends at a `constructor`:
 *
 * ```ejs
 * <%= escapeFn.constructor("return process")() %>
 * ```
 *
 * `escapeFn` used to be this module's neighbour's own function, passed straight
 * into the template as EJS's third argument. `escapeFn.constructor` is then the
 * **child main realm's** `Function`, the function it builds runs in the child
 * main realm, and from there `globalThis.fetch`, `process` and `process.send`
 * are all in scope — measured 2026-09-11 against the code this file replaces:
 * `escapeFn.constructor('return process.pid')()` answered with the child's real
 * pid and `'return typeof fetch'` answered `function`. The same reach was open
 * through `include`, `rethrow`, `getvar`, `setvar`, the `SillyTavern` proxy, and
 * through any **value** those functions returned: `getvar('obj').constructor` is
 * the host realm's `Object` just as surely.
 *
 * So the rule this module implements is structural rather than a list of patched
 * names:
 *
 * - **Every callable that crosses is a trampoline built inside the context.**
 *   {@link Realm.fn} compiles its factory with `vm.runInContext` in strict mode,
 *   so the returned function's `constructor` is the *context's* `Function`, the
 *   host closure it calls lives only in a closure variable, and `caller` /
 *   `arguments.callee` are unavailable. The trampoline is frozen.
 * - **Every value that crosses is re-created inside the context.**
 *   {@link Realm.adopt} rebuilds it through the context's own `JSON.parse`, so
 *   its prototype chain is the context's. Primitives cross unchanged: a number
 *   or a string carries no realm, and `(5).constructor` resolves through
 *   whichever realm evaluates it.
 * - **Errors and promises are values too.** A host refusal reaches template code
 *   as a context `Error` with the same `name` and `message`, and a host promise
 *   as a context `Promise` — otherwise `try { … } catch (e) { e.constructor }`
 *   and `getwi(…).constructor` are the same escape wearing a different hat.
 * - **Libraries are instantiated in the context**, not passed across: lodash's
 *   source is evaluated here, so `_` and everything it builds are context
 *   objects. {@link Realm.lodash} is that instance, and the environment uses it
 *   for every read and write — `_.set` on a context object must not create its
 *   intermediate objects in this realm.
 *
 * The one thing that deliberately does **not** cross back is a conversion of the
 * `ops`: they leave the child through `process.send`, which structured-clones
 * them into the host process, so the host never holds a context object anyway.
 * {@link Realm.release} exists for tests, which run both realms in one process.
 *
 * @module @iris/compat-prompt-template/realm
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

/**
 * lodash's source, to be evaluated **inside** each context.
 *
 * In-context rather than passed across, and for two reasons now. The realm one:
 * a host lodash handed to a template is `_.constructor` → host `Function`. The
 * correctness one, which is older and quieter: lodash's `isPlainObject` compares
 * against *its own* realm's `Object.prototype`, so a host lodash asked about a
 * template's object literal answers `false` — which is the overload test in
 * `getwi` and the merge test in `setvar`. Measured at 24 ms per context.
 */
const lodashSource = readFileSync(require.resolve('lodash'), 'utf8')

/**
 * The bridge's own helpers, compiled inside the context.
 *
 * Everything here has to be context-realm code, because everything here builds
 * an object a template will touch. `body` and `refuse` are host closures held in
 * closure variables of context functions: reachable to the call, unreachable
 * from the template, which is the whole trick.
 *
 * Strict mode is load-bearing twice over: `wrapped.caller` and
 * `wrapped.arguments` are poisoned accessors on a strict function, and
 * `arguments.callee` is a `TypeError`. Both are how a template would otherwise
 * walk back up to the host frame that called it.
 */
const BRIDGE_SOURCE = `'use strict';
(function (lodash) {
  var freeze = Object.freeze
  var defineProperty = Object.defineProperty
  return freeze({
    lodash: lodash,
    parse: JSON.parse,
    create: function () { return {} },
    assign: function (parts) { return Object.assign.apply(Object, [{}].concat(parts)) },
    owns: function (value) { return value instanceof Object },
    isThenable: function (value) { return typeof value.then === 'function' },
    fn: function (name, body) {
      var wrapped = function (...args) { return body(this, args) }
      defineProperty(wrapped, 'name', { value: name, configurable: true })
      return freeze(wrapped)
    },
    define: function (target, key, value) {
      defineProperty(target, key, { value: value, enumerable: true, configurable: true, writable: true })
    },
    defineGetter: function (target, key, get) {
      defineProperty(target, key, { get: get, enumerable: true, configurable: true })
    },
    guard: function (target, allowed, refuse) {
      return new Proxy(target, {
        get: function (object, property, receiver) {
          if (typeof property === 'symbol') return Reflect.get(object, property, receiver)
          if (allowed.indexOf(property) !== -1) return Reflect.get(object, property, receiver)
          throw refuse(String(property))
        },
      })
    },
    error: function (name, message) {
      var error = new Error(message)
      error.name = name
      // The frames behind a refusal are this package's own file paths, which are
      // the one thing in an error a card has no business reading. The message is
      // the whole story a card author needs.
      error.stack = name + ': ' + message
      return error
    },
    adoptPromise: function (thenable, onValue, onError) {
      return new Promise(function (resolve, reject) {
        thenable.then(
          function (value) { resolve(onValue(value)) },
          function (cause) { reject(onError(cause)) },
        )
      })
    },
  })
})(_)`

/** The helper table {@link BRIDGE_SOURCE} evaluates to. */
interface Bridge {
  lodash: RealmLodash
  parse: (text: string) => unknown
  create: () => object
  assign: (parts: readonly unknown[]) => object
  owns: (value: object) => boolean
  isThenable: (value: object) => boolean
  fn: (name: string, body: (self: unknown, args: unknown[]) => unknown) => unknown
  define: (target: object, key: string, value: unknown) => void
  defineGetter: (target: object, key: string, get: unknown) => void
  guard: (target: object, allowed: readonly string[], refuse: (member: string) => unknown) => object
  error: (name: string, message: string) => unknown
  adoptPromise: (
    thenable: PromiseLike<unknown>,
    onValue: (value: unknown) => unknown,
    onError: (cause: unknown) => unknown,
  ) => unknown
}

/**
 * The members of lodash the environment uses, as the **context** instantiated
 * them.
 *
 * Typed structurally rather than imported from `@types/lodash`, because the
 * point of this object is that it is not the `lodash` this file could import.
 */
export interface RealmLodash {
  get: (object: unknown, path: unknown, defaults?: unknown) => unknown
  set: (object: unknown, path: unknown, value: unknown) => unknown
  unset: (object: unknown, path: unknown) => boolean
  has: (object: unknown, path: unknown) => boolean
  cloneDeep: <T>(value: T) => T
  concat: (array: unknown[], values: unknown) => unknown[]
  mergeWith: (
    object: unknown,
    source: unknown,
    customizer: (destination: unknown, source: unknown) => unknown,
  ) => unknown
  isArray: (value: unknown) => boolean
  isPlainObject: (value: unknown) => boolean
}

/** A guarded object's members, before they are built inside the context. */
export interface GuardedSpec {
  /** Members read afresh on every access. */
  reads: Record<string, () => unknown>
  /** Members the template calls. */
  calls: Record<string, (...args: never[]) => unknown>
  /** What reaching for anything else raises. Host error; bridged on the way out. */
  refuse: (member: string) => Error
}

/** One realm, plus everything that is allowed to cross into it. */
export interface Realm {
  /** The `vm` context itself. Template source is compiled into this. */
  context: vm.Context
  /** lodash, as this context built it. */
  lodash: RealmLodash
  /** Compile and run source in the context. */
  run: (source: string, filename: string) => unknown
  /** A fresh, empty context object. */
  create: () => object
  /** `Object.assign({}, …parts)`, performed in the context. */
  assign: (...parts: readonly unknown[]) => object
  /** Parse JSON inside the context, so the result's prototypes are its own. */
  parse: (text: string) => unknown
  /**
   * A context-realm counterpart of a host value.
   *
   * Primitives pass through, values the context already owns pass through,
   * functions become trampolines, thenables become context promises, and
   * everything else is rebuilt through the context's `JSON.parse`.
   */
  adopt: <T>(value: T) => T
  /** A frozen context function that calls `body` and bridges what it produces. */
  fn: (name: string, body: (self: unknown, args: unknown[]) => unknown) => unknown
  /** Install a data member on a context object. */
  define: (target: object, key: string, value: unknown) => void
  /** Install a getter, itself a trampoline, on a context object. */
  defineGetter: (target: object, key: string, read: () => unknown) => void
  /** A context object with a closed member list and a named refusal for the rest. */
  guarded: (name: string, spec: GuardedSpec) => object
  /** Whether a value already belongs to this context. */
  owns: (value: unknown) => boolean
  /** A host-realm plain copy of a context value. For tests, which span both. */
  release: <T>(value: T) => T
}

/**
 * Make the realm templates run in.
 *
 * `vm.createContext({})` starts from a bare global: no `process`, no `require`,
 * no `fetch`. lodash is evaluated into it because templates reach for `_`; the
 * bridge is evaluated into it because everything else that crosses has to be
 * built by code that lives here.
 * @returns a fresh realm.
 */
export function createRealm(): Realm {
  const context = vm.createContext({})
  vm.runInContext(lodashSource, context, { filename: 'lodash.js' })
  const bridge = vm.runInContext(BRIDGE_SOURCE, context, { filename: 'realm-bridge.js' }) as Bridge

  const owns = (value: unknown): boolean =>
    value !== null && (typeof value === 'object' || typeof value === 'function') && bridge.owns(value as object)

  /**
   * A context error for whatever a host closure threw.
   *
   * A value the context already owns is rethrown as it is: an error raised
   * *inside* a template and passed back out through `rethrow` must keep its own
   * class, or a card's `catch (e) { e instanceof TypeError }` stops working.
   */
  const toContextError = (cause: unknown): unknown => {
    if (owns(cause)) return cause
    if (cause instanceof Error) return bridge.error(cause.name, cause.message)
    return adopt(cause)
  }

  const fn = (name: string, body: (self: unknown, args: unknown[]) => unknown): unknown =>
    bridge.fn(name, (self, args) => {
      let result: unknown
      try {
        result = body(self, args)
      } catch (cause) {
        throw toContextError(cause)
      }
      return adopt(result)
    })

  function adopt<T>(value: T): T {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
    if (bridge.owns(value as object)) return value
    if (typeof value === 'function') {
      const callable = value as unknown as (...args: unknown[]) => unknown
      return fn(callable.name, (self, args) => Reflect.apply(callable, self, args)) as T
    }
    if (bridge.isThenable(value as object)) {
      return bridge.adoptPromise(value as unknown as PromiseLike<unknown>, adopt, toContextError) as T
    }
    // `?? 'null'` is unreachable for the shapes that cross here — every one is
    // plain JSON — and is written out rather than asserted because a `undefined`
    // from `JSON.stringify` would otherwise reach `parse` as the string
    // "undefined" and throw somewhere with no trace of the cause.
    return bridge.parse(JSON.stringify(value) ?? 'null') as T
  }

  return {
    context,
    lodash: bridge.lodash,
    run: (source, filename) => vm.runInContext(source, context, { filename }),
    create: () => bridge.create(),
    assign: (...parts) => bridge.assign(parts),
    parse: text => bridge.parse(text),
    adopt,
    fn,
    define: (target, key, value) => { bridge.define(target, key, value) },
    defineGetter: (target, key, read) => { bridge.defineGetter(target, key, fn(key, () => read())) },
    guarded: (name, spec) => {
      const target = bridge.create()
      for (const [member, read] of Object.entries(spec.reads)) {
        bridge.defineGetter(target, member, fn(`${name}.${member}`, () => read()))
      }
      for (const [member, call] of Object.entries(spec.calls)) {
        bridge.define(target, member, fn(`${name}.${member}`, (_self, args) => call(...args as never[])))
      }
      const allowed = [...Object.keys(spec.reads), ...Object.keys(spec.calls)]
      return bridge.guard(target, allowed, member => toContextError(spec.refuse(member)))
    },
    owns,
    release: value => (value === null || typeof value !== 'object'
      ? value
      : JSON.parse(JSON.stringify(value)) as typeof value),
  }
}
