/**
 * The three SillyTavern element ids a card reaches for, as working stand-ins.
 *
 * **Replacements that drive the real pipeline, not mirrors.** 3c read every
 * operation the corpus performs on these ids and none of them is a read of a
 * size: cards write `#send_textarea`'s value and click `#send_but` to send a
 * message, and they poll `#mes_stop`'s visibility to know whether a generation
 * is running. A stand-in that answered plausibly and did nothing would make
 * those cards *appear* to work — the worst of the three available outcomes,
 * because the card's own success path runs and the message never goes.
 *
 * They live in the frame's own realm and forward to the shell, because the real
 * composer is in the shell's document and this frame is cross-origin from it.
 * So each member below is either answered from state the frame is told, or
 * forwarded as a request.
 *
 * **Why these three and no others** [3c, 44]: the corpus's whole body-level
 * dependency is `body`, `#chat`, `#send_textarea`, `#send_but` and `#mes_stop`.
 * `#send_form` and `#sheld` are **zero hits**. `#chat` is not here because its
 * only measured consumption is a `MutationObserver` on `childList` — it is a
 * signal, not an object a card operates, so it belongs to the reading view
 * rather than to this table.
 *
 * Anything else a card looks up by an ST id gets `null` **and one report**. That
 * is the shape the corpus fails in today: 不要被神隐's script died on
 * `Cannot read properties of null (reading 'querySelector')`, which is a silent
 * `null` one line earlier.
 *
 * @module iris-web/sandbox/st-anchors
 */

/** What the anchors need from the shell. */
export interface AnchorHost {
  /**
   * The composer's current text.
   *
   * Read live rather than pushed, because a card writes the value and reads it
   * back in the same tick — one of the two measured variants does exactly that
   * before dispatching anything.
   */
  draft: () => string
  /** Ask the shell to put this text in the composer. */
  setDraft: (text: string) => void
  /**
   * Ask the shell to send what the composer holds.
   *
   * Deliberately takes no text: the two measured variants disagree about
   * whether they dispatch an `input` event after writing the value, so the
   * value in the DOM is the only thing both of them agree on. The shell reads
   * that, not its own React state.
   */
  send: () => void
  /** Whether a generation is running, for `disabled` and `#mes_stop`. */
  generating: () => boolean
  /** Say something on the frame's report channel. */
  report: (message: string, failed: boolean) => void
}

/**
 * A token list with the members a card actually calls.
 *
 * `classList` on these anchors is read for one thing — whether the send button
 * carries `disabled` — so the live class comes from the host rather than from a
 * stored set. A card adding its own class is remembered, because a card that
 * marks the button and later checks its own mark should find it.
 * @param live - classes the host decides, recomputed on each read.
 * @returns the stand-in.
 */
function tokenList(live: () => readonly string[]): object {
  const own = new Set<string>()
  const all = (): Set<string> => new Set([...live(), ...own])
  return {
    add: (...names: string[]) => names.forEach(name => own.add(name)),
    remove: (...names: string[]) => names.forEach(name => own.delete(name)),
    contains: (name: string) => all().has(name),
    toggle: (name: string) => {
      if (own.delete(name)) return false
      own.add(name)
      return true
    },
    get length(): number {
      return all().size
    },
    get value(): string {
      return [...all()].join(' ')
    },
    toString: () => [...all()].join(' '),
  }
}

/**
 * The one thing every stand-in needs and nothing else provides: a refusal that
 * names the member rather than answering `undefined`.
 *
 * `undefined` is the wrong answer here for the reason the whole module exists:
 * these are *drivers*, so a card that reads an unbuilt member and carries on has
 * a working-looking path that does nothing. A report and `undefined` is the
 * compromise — throwing would kill a script over a member we simply have not
 * built, which the `document.readyState` refusal already proved too expensive.
 * @param id - the anchor, for the report.
 * @param host - the report channel.
 * @param members - what this stand-in answers.
 * @returns a proxy that reports anything else, once per name.
 */
function reporting(id: string, host: AnchorHost, members: Record<string, unknown>): object {
  const said = new Set<string>()
  return new Proxy(members, {
    get(target, property): unknown {
      if (typeof property === 'symbol') return Reflect.get(target, property)
      if (Object.hasOwn(target, property)) return target[property]
      if (!said.has(property)) {
        said.add(property)
        host.report(
          `a card read #${id}.${property}, which Iris's stand-in for SillyTavern's element`
          + ' does not carry — it returned undefined, and the members that are built are the'
          + ' ones the corpus was measured to use',
          false,
        )
      }
      return undefined
    },
    set(target, property, value): boolean {
      if (typeof property === 'symbol') return Reflect.set(target, property, value)
      if (Object.hasOwn(target, property)) {
        // A real accessor: let the descriptor's setter run.
        Reflect.set(target, property, value)
        return true
      }
      /*
       * An unknown write is **remembered**, not refused. Cards park state on
       * these elements (`el.dataset.x`, `el._myFlag`), and upstream's real
       * element accepts it; refusing would be a divergence with no safety
       * argument behind it. Reported once so the surface's real extent stays
       * visible.
       */
      Reflect.set(target, property, value)
      if (!said.has(property)) {
        said.add(property)
        host.report(
          `a card wrote #${id}.${property}, which is not part of Iris's stand-in — the value`
          + ' was kept on the object, as upstream’s real element would keep it, but nothing'
          + ' in Iris reads it',
          false,
        )
      }
      return true
    },
  })
}

/**
 * Build the three stand-ins.
 * @param host - the shell's side of them.
 * @returns the anchors, by their SillyTavern id.
 */
export function createStAnchors(host: AnchorHost): Record<string, object> {
  /*
   * `#send_textarea`. Two measured variants, and the pair of them is what fixes
   * the design:
   *
   * - one writes `.value` (appending after a newline when non-empty), dispatches
   *   `input` and `change`, waits 300 ms, then clicks `#send_but`;
   * - the other uses jQuery `.val()`, **dispatches nothing**, and triggers the
   *   click straight away.
   *
   * So the send path may not depend on having seen an event. `setDraft` is
   * called from the value setter itself, which is the only point both variants
   * pass through.
   */
  const textarea: Record<string, unknown> = {
    id: 'send_textarea',
    tagName: 'TEXTAREA',
    nodeName: 'TEXTAREA',
    nodeType: 1,
    get value(): string {
      return host.draft()
    },
    set value(text: string) {
      host.setDraft(String(text))
    },
    // jQuery's `.val()` reads `defaultValue` in one branch and cards read it as
    // a "what was it before" hint. The draft is the only value this has.
    get defaultValue(): string {
      return host.draft()
    },
    get textContent(): string {
      return host.draft()
    },
    get disabled(): boolean {
      return host.generating()
    },
    get readOnly(): boolean {
      return host.generating()
    },
    /*
     * Accepted and dropped, with nothing said, and that is deliberate. One
     * variant dispatches `input`+`change` **after** the value setter has already
     * told the shell, so the dispatch is redundant by construction — reporting
     * it would put a line in the panel on the path that works.
     */
    dispatchEvent: (): boolean => true,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    focus: (): void => {},
    blur: (): void => {},
    select: (): void => {},
    setSelectionRange: (): void => {},
    /*
     * Non-zero so jQuery's `:visible` is true. jQuery decides visibility from
     * `offsetWidth || offsetHeight || getClientRects().length`, so a stand-in
     * reporting zeros would read as hidden and a card gating on it would skip
     * the composer entirely.
     */
    offsetWidth: 600,
    offsetHeight: 40,
    getClientRects: () => [{ width: 600, height: 40 }],
    getBoundingClientRect: () => ({
      x: 0, y: 0, width: 600, height: 40, top: 0, left: 0, right: 600, bottom: 40,
    }),
    style: {},
    dataset: {},
    // `scrollHeight` drives the auto-growing textarea trick several cards use.
    scrollHeight: 40,
    setAttribute: (): void => {},
    getAttribute: (name: string): string | null => (name === 'id' ? 'send_textarea' : null),
    removeAttribute: (): void => {},
  }

  /*
   * `#send_but`. Upstream's is a `div`, not a `button` — a card that checks
   * `tagName` or styles it as one would be wrong about a real SillyTavern too.
   *
   * `.click()` must exist as a **method** because jQuery's `.trigger('click')`
   * calls `elem[type]()` when it is a function; a stand-in with only a listener
   * would be triggered by one variant and not the other.
   */
  const button: Record<string, unknown> = {
    id: 'send_but',
    tagName: 'DIV',
    nodeName: 'DIV',
    nodeType: 1,
    click: (): void => {
      if (host.generating()) {
        host.report(
          'a card clicked #send_but while a generation was already running — Iris ignored it,'
          + ' as SillyTavern does with its own button disabled',
          false,
        )
        return
      }
      /*
       * **Reported every time, and this one is not a gap.** A card sending a
       * message on the reader's behalf is a card function upstream has, so it is
       * not refused — but it is an outward action, and the note is what carries
       * its visibility. Deliberately not deduplicated: two sends are two events.
       */
      host.report('a card sent a message through the composer', false)
      host.send()
    },
    get disabled(): boolean {
      return host.generating()
    },
    dispatchEvent: (): boolean => true,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    offsetWidth: 40,
    offsetHeight: 40,
    getClientRects: () => [{ width: 40, height: 40 }],
    getBoundingClientRect: () => ({
      x: 0, y: 0, width: 40, height: 40, top: 0, left: 0, right: 40, bottom: 40,
    }),
    style: {},
    dataset: {},
    setAttribute: (): void => {},
    getAttribute: (name: string): string | null => (name === 'id' ? 'send_but' : null),
    removeAttribute: (): void => {},
  }
  Object.defineProperty(button, 'classList', {
    // `disabled` as a **class** as well as a property: upstream's div carries
    // the class, and a card reading one spelling must not disagree with a card
    // reading the other.
    value: tokenList(() => (host.generating() ? ['disabled'] : [])),
    enumerable: true,
  })
  Object.defineProperty(button, 'className', {
    get: () => (host.generating() ? 'disabled' : ''),
    enumerable: true,
  })

  /*
   * `#mes_stop`. Read for exactly one thing: whether it is visible, which is how
   * a card knows a generation is running. jQuery's `:visible` is
   * `offsetWidth || offsetHeight || getClientRects().length`, so this reports
   * zeros when idle — **a display:none stand-in would not be enough**, because
   * jQuery does not read `style.display` for `:visible`.
   */
  const stop: Record<string, unknown> = {
    id: 'mes_stop',
    tagName: 'DIV',
    nodeName: 'DIV',
    nodeType: 1,
    get offsetWidth(): number {
      return host.generating() ? 40 : 0
    },
    get offsetHeight(): number {
      return host.generating() ? 40 : 0
    },
    getClientRects: () => (host.generating() ? [{ width: 40, height: 40 }] : []),
    getBoundingClientRect: () => ({
      x: 0, y: 0,
      width: host.generating() ? 40 : 0,
      height: host.generating() ? 40 : 0,
      top: 0, left: 0,
      right: host.generating() ? 40 : 0,
      bottom: host.generating() ? 40 : 0,
    }),
    // The other spelling of the same fact, for a card that reads the style.
    get style(): object {
      return { display: host.generating() ? 'block' : 'none' }
    },
    click: (): void => {
      host.report(
        'a card clicked #mes_stop, which would stop a running generation — Iris has not'
        + ' built that arm, so nothing was stopped',
        true,
      )
    },
    dispatchEvent: (): boolean => true,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    dataset: {},
    setAttribute: (): void => {},
    getAttribute: (name: string): string | null => (name === 'id' ? 'mes_stop' : null),
    removeAttribute: (): void => {},
  }

  return {
    send_textarea: reporting('send_textarea', host, textarea),
    send_but: reporting('send_but', host, button),
    mes_stop: reporting('mes_stop', host, stop),
  }
}

/**
 * SillyTavern ids Iris knows about and does not provide.
 *
 * Named so a lookup can say "this is SillyTavern's X and Iris has no stand-in"
 * rather than answering `null` and letting the card die a line later on
 * `null.querySelector` — which is exactly how 不要被神隐's script fails today.
 * Measured as **zero hits** in the corpus [3c], so nothing here is a gap being
 * deferred; they are named because a card that reaches for them should be told
 * which kind of nothing it found.
 */
export const KNOWN_ST_IDS: readonly string[] = [
  'send_form',
  'sheld',
  'chat',
  'character_popup',
  'options',
  'rightNavHolder',
  'left-nav-panel',
  'top-settings-holder',
  'expression-image',
  'bg1',
]
