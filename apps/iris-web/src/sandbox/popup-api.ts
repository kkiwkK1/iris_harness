/**
 * SillyTavern's popup API as a card holds it — the runtime half.
 *
 * `sandbox/popup.ts` holds the arithmetic (which button carries which
 * `POPUP_RESULT`, what `show()` resolves to). This holds the parts that are not
 * pure: the promise, the id, the round trip to the shell, and the `Popup` class
 * a card can construct.
 *
 * **It lives in the fetched member table, not in the inlined bootstrap**, and
 * that placement is the one decision in this file worth arguing. The bootstrap
 * is inlined into every frame's `srcdoc`, so every byte here would be paid once
 * per interface on screen — `FRAME_OVERHEAD_BYTES` is that cost, and the
 * reading window's count gate is derived from it (`app/frame-budget.ts`). This
 * API is about 7 KiB of bootstrap if it goes there, which is a seventh of the
 * artifact for a dialog most frames never raise. The member table is fetched
 * once per frame from a content-hashed URL the browser caches, which is exactly
 * the mechanism a previous round used to answer the same growth — the note on
 * `FRAME_COUNT_LIMIT` records it as "splitting the member table out answered
 * it". Measured: the split keeps the bootstrap under the ceiling and the gate at
 * 20 live frames instead of forcing it to 17.
 *
 * What stays in the bootstrap is the wiring: five property reads on the
 * `SillyTavern` proxy, one `popup:answer` arm, and the plan's validation in
 * `protocol.ts` (which has to be there, because it is what decides whether an
 * arriving message is believed at all).
 *
 * @module iris-web/sandbox/popup-api
 */

import {
  POPUP_RESULT,
  POPUP_TYPE,
  buildTextWithHeader,
  inputHelperValue,
  planPopup,
  popupValue,
  type PopupAnswer,
  type PopupOptions,
  type PopupPlan,
} from './popup.ts'

/** What a card holds after `new Popup(...)`. */
interface PopupHandle {
  id: string
  type: number
  result: number | null | undefined
  value: unknown
}

/** One popup the frame is waiting on. */
interface WaitingPopup {
  plan: PopupPlan
  /** Resolve the card's `show()` promise with upstream's value for a result. */
  settle: (result: number | null, input: string) => void
  /** The card's own `customButtons[].action` callbacks, by declaration index. */
  actions: Map<number, (popup: unknown) => unknown>
  /** The card's `onClose`, run once the dialog is gone. */
  onClose: ((popup: unknown) => unknown) | undefined
  /** The instance, when a card built one rather than calling the function. */
  instance: PopupHandle | undefined
}

/** What this API needs from the frame it is installed in. */
export interface PopupIo {
  /** Ask the shell to draw one popup. */
  ask: (id: string, plan: PopupPlan) => void
  /**
   * Tell the shell to take one down unanswered — the card closed it itself.
   *
   * Its own channel because the card's promise is already resolved by then:
   * without it the shell holds a modal nobody is waiting for, and for a modal
   * that means the reader is stuck.
   */
  withdraw: (id: string) => void
  /** Say something on the card's durable report channel. */
  report: (message: string) => void
  /**
   * What `Popup.util.getTopmostModalLayer()` answers.
   *
   * Upstream returns the topmost open `<dialog>` or `document.body`. There is no
   * dialog element in a card frame — the popup is the shell's — so this is the
   * frame's own container, which is what `parent.document.body` answers here and
   * where a card appending to "the topmost layer" would want its node to land.
   */
  topmostLayer: () => unknown
}

/** The five names, plus the frame's way of delivering an answer. */
export interface PopupApi {
  POPUP_TYPE: typeof POPUP_TYPE
  POPUP_RESULT: typeof POPUP_RESULT
  callGenericPopup: (
    content: unknown, type: unknown, inputValue?: unknown, popupOptions?: PopupOptions,
  ) => Promise<string | number | boolean | null>
  callPopup: (
    text: unknown, type: unknown, inputValue?: unknown, options?: PopupOptions,
  ) => Promise<string | boolean>
  Popup: unknown
  /** Deliver what the reader did. Called from the frame's `popup:answer` arm. */
  answer: (id: string, answer: PopupAnswer) => void
}

/**
 * Build the popup API for one frame.
 *
 * **The measured failure it closes.** MagVarUpdate's bundle opens its one-time
 * variable cleanup with `SillyTavern.callGenericPopup(text,
 * SillyTavern.POPUP_TYPE.CONFIRM, …)` (`cleanup/legacy_chat.ts:16-25`), on every
 * chat past 25 messages. The surface carried none of these five names, so
 * `SillyTavern.POPUP_TYPE` read `undefined` and `.CONFIRM` threw `TypeError:
 * Cannot read properties of undefined` — inside a `jQuery(async …)`, as an
 * unhandled rejection, on a real 26-message chat (reported 2026-09-08).
 *
 * **Why the dialog is the shell's and not the frame's.** A message frame is
 * clipped to its message's height and a script frame's surface is the reading
 * column; a modal drawn inside either is one the reader cannot see. So the plan
 * crosses to the shell, which draws it over the whole viewport, and the answer
 * comes back.
 *
 * **Not `window.alert`.** The bridged `alert`/`confirm`/`prompt` answer *for*
 * the card, because upstream answers those synchronously and a message boundary
 * cannot. `callGenericPopup` is asynchronous upstream too, so this one carries
 * the reader's real answer.
 * @param io - the frame's channels.
 * @returns the API to hang on the `SillyTavern` surface.
 */
export function createPopupApi(io: PopupIo): PopupApi {
  let nextPopup = 0
  const pending = new Map<string, WaitingPopup>()
  /** Upstream's `Popup.util.popups`: every popup built, until it closes. */
  const openPopups: PopupHandle[] = []
  /** Upstream's `Popup.util.lastResult` ([ST] `popup.js:864`). */
  let lastResult: { value: unknown, result: number | null, inputResults: null } | null = null

  const removeOpen = (popup: PopupHandle): void => {
    const at = openPopups.indexOf(popup)
    if (at >= 0) openPopups.splice(at, 1)
  }

  /** A card's callback option, if it really is one. */
  const asHandler = (value: unknown): ((popup: unknown) => unknown) | undefined =>
    typeof value === 'function' ? (value as (popup: unknown) => unknown) : undefined

  /**
   * The `action` callbacks a card hung on its custom buttons, by index.
   *
   * Kept frame-side because a function cannot cross a `postMessage`; the plan
   * carries each custom button's declaration index so a press can find its
   * action again after the render order moved it.
   * @param options - the options the card passed.
   * @returns the actions, by `customButtons` index.
   */
  const buttonActions = (
    options: PopupOptions | undefined,
  ): Map<number, (popup: unknown) => unknown> => {
    const actions = new Map<number, (popup: unknown) => unknown>()
    const list = options?.['customButtons']
    if (!Array.isArray(list)) return actions
    list.forEach((entry: unknown, index) => {
      if (typeof entry !== 'object' || entry === null) return
      const action = asHandler((entry as Record<string, unknown>)['action'])
      if (action !== undefined) actions.set(index, action)
    })
    return actions
  }

  /** Upstream's `onClose`, run after the dialog is gone. */
  const runClose = async (entry: WaitingPopup, instance: unknown): Promise<void> => {
    if (entry.onClose === undefined) return
    try {
      await entry.onClose(instance)
    } catch {
      // The card's handler. Upstream awaits it inside its own animation
      // callback, where a throw goes nowhere either.
    }
  }

  /**
   * Raise one popup and wait for the reader.
   *
   * Resolves with **upstream's value**, not with the result: an INPUT popup
   * resolves with the text and every other kind with the result number, which is
   * `popupValue`'s single rule rather than three call sites'.
   * @param plan - what the shell should draw.
   * @param extras - the callbacks that cannot cross the boundary.
   * @returns the value `show()` resolves with.
   */
  const raise = (
    plan: PopupPlan,
    extras: {
      actions: Map<number, (popup: unknown) => unknown>
      onOpen: ((popup: unknown) => unknown) | undefined
      onClose: ((popup: unknown) => unknown) | undefined
      instance: PopupHandle | undefined
    },
  ): Promise<string | number | boolean | null> => {
    const id = `p${(nextPopup += 1)}`
    // The instance's id is upstream's `uuidv4()` — a handle a card may read
    // back. Minted here rather than in the constructor so it is the same string
    // the shell was addressed with, instead of a guess that drifts when a card
    // builds two popups and shows them out of order.
    if (extras.instance !== undefined) extras.instance.id = id
    /*
     * Said once per popup, and only when the card actually passed something
     * this surface drops. A dialog that behaves differently from upstream's with
     * nothing on the record is the failure the whole sandbox keeps choosing
     * against — and the reader can see this popup, so the note is for the card
     * author reading the report list, not for them.
     */
    if (plan.ignored.length > 0) {
      io.report(
        `a card opened a SillyTavern popup with options Iris does not honour (${plan.ignored.join(', ')})`
        + ' — the popup is drawn and answered, those options are ignored',
      )
    }

    return new Promise<string | number | boolean | null>(resolve => {
      pending.set(id, {
        plan,
        actions: extras.actions,
        onClose: extras.onClose,
        instance: extras.instance,
        settle: (result, input) => {
          const value = popupValue(plan.kind, result, input)
          if (extras.instance !== undefined) {
            extras.instance.result = result
            extras.instance.value = value
          }
          lastResult = { value, result, inputResults: null }
          resolve(value)
        },
      })
      io.ask(id, plan)
      /*
       * `onOpen` fires after the request is away, which is as close as this can
       * come to upstream's "after `showModal()`". Not awaited: upstream does not
       * await it either (`popup.js:688-691` calls it inside a
       * `runAfterAnimation` callback), and a card whose `onOpen` throws must not
       * take its own popup down with it.
       */
      if (extras.onOpen !== undefined) {
        try {
          void extras.onOpen(extras.instance)
        } catch {
          // The card's handler, the card's problem — upstream swallows it too.
        }
      }
    })
  }

  /**
   * The `Popup` class, as a card gets it off `getContext()`.
   *
   * `popups`/`isPopupOpen` are upstream's own bookkeeping and cards do read
   * them; everything this class decides it asks `popup.ts` for.
   */
  class Popup implements PopupHandle {
    id: string
    type: number
    result: number | null | undefined = undefined
    value: unknown = undefined
    #plan: PopupPlan
    #extras: {
      actions: Map<number, (popup: unknown) => unknown>
      onOpen: ((popup: unknown) => unknown) | undefined
      onClose: ((popup: unknown) => unknown) | undefined
    }

    #promise: Promise<string | number | boolean | null> | undefined = undefined

    constructor(content: unknown, type: unknown, inputValue?: unknown, options?: PopupOptions) {
      this.#plan = planPopup(content, type, inputValue, options)
      this.type = this.#plan.kind
      // Replaced with the real one when `show()` addresses the shell; a popup
      // that is built and never shown keeps this placeholder, as upstream's
      // keeps a uuid for a dialog it never opened.
      this.id = ''
      this.#extras = {
        actions: buttonActions(options),
        onOpen: asHandler(options?.['onOpen']),
        onClose: asHandler(options?.['onClose']),
      }
      openPopups.push(this)
    }

    show(): Promise<string | number | boolean | null> {
      /*
       * Idempotent, like upstream's: its `show()` returns the same `#promise`
       * for a second call rather than opening a second dialog.
       */
      if (this.#promise !== undefined) return this.#promise
      this.#promise = raise(this.#plan, { ...this.#extras, instance: this })
      return this.#promise
    }

    async complete(result: unknown): Promise<unknown> {
      const value = typeof result === 'number' || result === null ? result : null
      const waiting = [...pending].find(([, entry]) => entry.instance === this)
      if (waiting === undefined) return undefined
      const [id, entry] = waiting
      pending.delete(id)
      removeOpen(this)
      /*
       * The input box's starting text, because there is no live box on this side
       * to read. Upstream reads `this.mainInput.value`, so a card that
       * programmatically completes an INPUT popup the reader has typed into gets
       * the initial value here rather than the typed one. Recorded rather than
       * papered over: the alternative is a round trip to fetch a value the card
       * is closing anyway.
       */
      entry.settle(value, this.#plan.inputValue)
      io.withdraw(id)
      await runClose(entry, this)
      return this.value
    }

    async completeAffirmative(): Promise<unknown> {
      return this.complete(POPUP_RESULT.AFFIRMATIVE)
    }

    async completeNegative(): Promise<unknown> {
      return this.complete(POPUP_RESULT.NEGATIVE)
    }

    async completeCancelled(): Promise<unknown> {
      return this.complete(POPUP_RESULT.CANCELLED)
    }

    static show = {
      input: async (
        header: unknown,
        text?: unknown,
        defaultValue?: unknown,
        options?: PopupOptions,
      ): Promise<string | null> => {
        const popup = new Popup(
          buildTextWithHeader(header, text),
          POPUP_TYPE.INPUT,
          typeof defaultValue === 'string' ? defaultValue : '',
          options,
        )
        return inputHelperValue(await popup.show())
      },
      confirm: async (
        header: unknown, text?: unknown, options?: PopupOptions,
      ): Promise<number | null> => {
        const popup = new Popup(buildTextWithHeader(header, text), POPUP_TYPE.CONFIRM, null, options)
        const result = await popup.show()
        // Upstream throws here rather than returning a surprise type, and the
        // throw is the contract: a CONFIRM that resolved with a string means the
        // value rule broke, which a card cannot be asked to notice.
        if (typeof result === 'string' || typeof result === 'boolean') {
          throw new Error(
            `Invalid popup result. CONFIRM popups only support numbers, or null. Result: ${String(result)}`,
          )
        }
        return result
      },
      text: async (
        header: unknown, text?: unknown, options?: PopupOptions,
      ): Promise<number | null> => {
        const popup = new Popup(buildTextWithHeader(header, text), POPUP_TYPE.TEXT, null, options)
        const result = await popup.show()
        if (typeof result === 'string' || typeof result === 'boolean') {
          throw new Error(
            `Invalid popup result. TEXT popups only support numbers, or null. Result: ${String(result)}`,
          )
        }
        return result
      },
    }

    static util = {
      popups: openPopups,
      get lastResult(): unknown {
        return lastResult
      },
      isPopupOpen(): boolean {
        return pending.size > 0
      },
      getTopmostModalLayer(): unknown {
        return io.topmostLayer()
      },
    }
  }

  return {
    POPUP_TYPE,
    POPUP_RESULT,
    Popup,

    /**
     * `callGenericPopup` ([ST] `popup.js:909-917`) — one popup, awaited.
     *
     * Upstream's is two lines over the class, and so is this: the class holds
     * the behaviour, and a card that reaches for the function rather than the
     * constructor must get the same dialog.
     */
    callGenericPopup: (content, type, inputValue, popupOptions) =>
      new Popup(content, type, inputValue ?? '', popupOptions).show(),

    /**
     * `callPopup` — upstream's deprecated one ([ST] `public/script.js:9007`).
     *
     * A different contract, not an alias, and the difference is what a card
     * relying on it reads: the type is a **string** (`'confirm'`, `'input'`,
     * `'text'`, …), and it resolves with `true`/`false` rather than a
     * `POPUP_RESULT` — the input box's text when the type was `'input'`
     * (`script.js:11312-11341`). Mapping it onto `callGenericPopup` would hand a
     * card `1` where it tests `=== true`; that passes a truthiness check and
     * fails an equality one, which is the kind of near-miss that survives
     * review.
     *
     * The type strings that only exist upstream (`char_not_selected`,
     * `delete_extension`, `new_chat`) differ from `'confirm'` in nothing this
     * surface can see: they choose a *caption* from upstream's own list, and
     * captions come from the shell's dictionary here.
     */
    callPopup: async (text, type, inputValue, options) => {
      const kind = type === 'input'
        ? POPUP_TYPE.INPUT
        : type === 'text' ? POPUP_TYPE.TEXT : POPUP_TYPE.CONFIRM
      const value = await new Popup(text, kind, inputValue ?? '', options).show()
      if (kind === POPUP_TYPE.INPUT) return typeof value === 'string' ? value : false
      return value === POPUP_RESULT.AFFIRMATIVE
    },

    answer: (id, answer) => {
      const waiting = pending.get(id)
      if (waiting === undefined) return
      const input = answer.input ?? waiting.plan.inputValue
      /*
       * The button's own `action`, before anything else — upstream binds it as
       * a plain `click` listener on the element (`popup.js:317-319`), so it runs
       * whether or not the button also closes the popup, and it runs before the
       * completion path.
       */
      const pressed = answer.button === undefined ? undefined : waiting.plan.buttons[answer.button]
      const action = pressed?.custom === undefined ? undefined : waiting.actions.get(pressed.custom)
      if (action !== undefined) {
        try {
          void action(waiting.instance)
        } catch {
          // The card's own handler; upstream's listener swallows a throw too.
        }
      }
      /*
       * A button with no `result` does not close the popup ([ST]
       * `popup.js:69`). Its action has just run, the dialog stays up, so nothing
       * is resolved and the entry is kept.
       */
      if (!answer.closed) return
      pending.delete(id)
      if (waiting.instance !== undefined) removeOpen(waiting.instance)
      waiting.settle(answer.result, input)
      void runClose(waiting, waiting.instance)
    },
  }
}
