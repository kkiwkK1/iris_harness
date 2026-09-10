/**
 * The Iris marks: the aperture identity, the five-petal blossom, the ink branches.
 *
 * One module rather than four inline copies of the same path data. The blossom
 * alone appears in the composer's writing surface and on a turn boundary, and
 * the branch is drawn twice at different widths — path data copied into a
 * component is data that drifts one copy at a time, which is the failure the
 * token layer already exists to prevent for colours.
 *
 * **Two families live here and they are not the same kind of thing.** The
 * aperture ({@link ApertureMark}) is the product's *identity*: it names Iris,
 * it appears exactly once per window, and it is the only mark here that has
 * states. The blossom and the branches are 「梅花」 *decoration* — a theme's
 * handwriting, which is why the composer's seal and the character page's bough
 * are untouched by the identity work and stay exactly where they were.
 *
 * **Every fill and stroke is a token, never a literal.** The artboards are
 * 雪-only, so their `#b3374a` and `#4a4543` are transcribed here as
 * `var(--iris-accent)` and `var(--iris-ink-secondary)`: the same marks then draw
 * correctly under 墨 and 宣 with no second copy. SVG presentation attributes
 * accept `var()` the way CSS properties do, which is why this works at all.
 *
 * **Decoration lives in exactly two places** (canvas.json: 装饰只在两处) — the
 * composer's top edge and the character page's head — plus the blossom, which
 * is a mark rather than decoration, and the small spray on a turn boundary
 * (回目分隔用一小段枝). Nothing here is interactive and nothing here carries
 * meaning, so every root is `aria-hidden`.
 *
 * @module iris-web/app/marks
 */

import type { CSSProperties, ReactElement } from 'react'

/**
 * How many blades the aperture carries.
 *
 * Six, and the number is load-bearing twice: it is the angular step each blade
 * is drawn at (360/6 = 60°), and it is what makes the closed form read as shut
 * — the 38° each blade turns plus the 5.5px it travels inward carries its tip
 * past the centre, so six of them overlap into a solid disc. Fewer blades leave
 * gaps at the same angle and would need a different travel.
 */
const APERTURE_BLADES = 6

/**
 * The aperture: the Iris identity, open or closed.
 *
 * A camera iris, which is what the product is named after — an outer ring, six
 * blades around it, and a round hole in the middle that the blades close over.
 * It replaces the plum blossom in the sidebar's head, where the blossom was
 * doing two jobs at once: it was the theme's decoration *and* the thing that
 * said "Iris", so the identity changed whenever the theme did.
 *
 * **The two states are one drawing, not two.** `open` toggles a class and
 * `shell.css` moves the blades' `rotate` and the hole's `r` — so collapsing the
 * sidebar animates the mark it already had rather than swapping in a second
 * asset, and the closed form is guaranteed to be the open form's own geometry.
 * `Rail.dc.html` draws the closed mark as a solid `r=6.5` dot; that is what six
 * converged blades look like, and drawing it separately would have been a
 * second copy of a shape the mechanism already produces.
 *
 * The blades' base angles are CSS custom properties rather than the artboards'
 * `transform="rotate(60 22 22)"` presentation attributes, because a CSS
 * `transform` **replaces** the attribute rather than composing with it: with
 * the base rotation left in the markup, every blade would have snapped to 0°
 * the moment the transition touched it.
 * @param props.size - the drawn edge in pixels; the artboards use 18.
 * @param props.open - the blades stand apart and the hole is lit.
 * @returns the mark.
 */
export function ApertureMark({ size, open }: { size: number, open: boolean }): ReactElement {
  return (
    <svg
      className={open ? 'iris-mark iris-aperture' : 'iris-mark iris-aperture iris-aperture--shut'}
      width={size}
      height={size}
      viewBox="0 0 44 44"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="22" cy="22" r="20" fill="none" stroke="var(--iris-accent)" strokeWidth="2.2" />
      <g fill="var(--iris-accent)">
        {Array.from({ length: APERTURE_BLADES }, (_blade, index) => (
          <path
            key={index}
            className="iris-aperture__blade"
            // The one inline style in this module, and it is data rather than
            // styling: which of the six positions this blade holds. The
            // stylesheet reads it for both states, so the angle exists once.
            style={{ '--iris-blade-at': `${String((index * 360) / APERTURE_BLADES)}deg` } as CSSProperties}
            d="M22 10.5c4.2 0 7.6 2.2 9.5 5.6l-5.4 3.1c-1-1.6-2.5-2.5-4.1-2.5z"
          />
        ))}
      </g>
      <circle
        className="iris-aperture__hole"
        cx="22"
        cy="22"
        r="5.2"
        fill="none"
        stroke="var(--iris-accent)"
        strokeWidth="2.2"
      />
    </svg>
  )
}

/**
 * The five-petal plum blossom: 「梅花」's own mark, and the seal on the writing
 * surface.
 *
 * **No longer the sidebar's identity.** It sits in the composer's writing
 * surface and on a turn boundary, where it is the theme signing its own paper.
 *
 * The centre dot is painted in the ground the mark sits on rather than in a
 * fixed white, because it appears on two different grounds — the sidebar's desk
 * and the composer's raised sheet — and a white dot on 墨 would be a hole.
 * @param props.size - the drawn edge in pixels; the artboards use 18.
 * @param props.on - the token the centre dot takes, as a CSS colour.
 * @returns the mark.
 */
export function PlumBlossom({
  size,
  on = 'var(--iris-bg-page)',
}: {
  size: number
  on?: string
}): ReactElement {
  return (
    <svg
      className="iris-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="6.2" r="3.1" fill="var(--iris-accent)" />
      <circle cx="17.5" cy="10.2" r="3.1" fill="var(--iris-accent)" />
      <circle cx="15.4" cy="16.7" r="3.1" fill="var(--iris-accent)" />
      <circle cx="8.6" cy="16.7" r="3.1" fill="var(--iris-accent)" />
      <circle cx="6.5" cy="10.2" r="3.1" fill="var(--iris-accent)" />
      <circle cx="12" cy="12" r="1.6" fill={on} />
    </svg>
  )
}

/**
 * The branch that crosses the composer's top edge, in place of a hairline.
 *
 * `preserveAspectRatio="none"` with a 100% width is what lets one path follow a
 * column that reflows: the artboards draw this at 1160, 1132 and 740 wide for
 * the same three states of the same panel, which is three transcriptions of one
 * curve. Stretching it horizontally is honest for a branch — the blossoms are
 * drawn as separate circles in their own scale so they never become ellipses.
 *
 * The flowers sit in two groups on purpose: filled ones in plum, and open ones
 * in the paper's blush with a hairline edge, which is how the artboards keep the
 * accent from appearing eight times in one strip.
 * @returns the branch.
 */
export function PlumBranch(): ReactElement {
  return (
    <span className="iris-branch" aria-hidden="true">
      <svg
        className="iris-branch__line"
        viewBox="0 0 1160 34"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M0 18 C 120 14, 220 26, 360 16 S 600 6, 760 18 S 1000 30, 1160 12"
          stroke="var(--iris-ink-secondary)"
          strokeWidth="1.3"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M360 16 C 380 8, 392 4, 404 -2"
          stroke="var(--iris-ink-secondary)"
          strokeWidth="1"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M760 18 C 780 24, 796 30, 812 36"
          stroke="var(--iris-ink-secondary)"
          strokeWidth="1"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M1000 26 C 1012 20, 1020 16, 1030 8"
          stroke="var(--iris-ink-secondary)"
          strokeWidth="1"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/*
        The flowers ride a second, unstretched layer positioned in percentages of
        the same viewBox, so they stay round at every column width. The offsets
        are the artboard's own x values over 1160 and y values over 34.
      */}
      <span className="iris-branch__flowers">
        <Flower at={34.8} up={-2} r={3.4} open={false} />
        <Flower at={47.2} up={10} r={2.4} open={false} />
        <Flower at={70.0} up={34} r={3.2} open={false} />
        <Flower at={88.8} up={8} r={3} open={false} />
        <Flower at={17.2} up={22} r={3} open />
        <Flower at={56.9} up={9} r={3} open />
        <Flower at={77.6} up={26} r={3} open />
        <Flower at={96.6} up={14} r={2.6} open />
      </span>
    </span>
  )
}

/**
 * One blossom on the branch, placed as a percentage of the strip.
 * @param props.at - horizontal position, in percent of the strip's width.
 * @param props.up - vertical position, in the artboard's 34px-tall strip.
 * @param props.r - the drawn radius, in pixels.
 * @param props.open - an unfilled flower: the paper's blush inside a hairline.
 * @returns the flower.
 */
function Flower({
  at,
  up,
  r,
  open = false,
}: {
  at: number
  up: number
  r: number
  open?: boolean
}): ReactElement {
  return (
    <span
      className={open ? 'iris-branch__flower iris-branch__flower--open' : 'iris-branch__flower'}
      style={{ left: `${String(at)}%`, top: `${String(up)}px`, width: `${String(r * 2)}px`, height: `${String(r * 2)}px` }}
    />
  )
}

/**
 * The one large decoration: a branch over the character page's head.
 *
 * Its own path rather than `PlumBranch`'s, because the artboard draws a
 * different curve at a different scale (`Library.dc.html`, 1040×200) and the
 * blossoms are part of the drawing rather than a separate layer — nothing here
 * stretches, so they stay round without the two-layer trick the composer needs.
 * @returns the branch.
 */
export function PlumBough(): ReactElement {
  return (
    <svg
      className="iris-bough"
      viewBox="0 0 1040 200"
      preserveAspectRatio="xMinYMin slice"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M-20 40 C 140 30, 260 70, 400 52 S 640 20, 760 44 S 960 90, 1060 60"
        stroke="var(--iris-ink-secondary)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M400 52 C 430 30, 450 18, 470 6"
        stroke="var(--iris-ink-secondary)"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <path
        d="M760 44 C 790 60, 810 76, 840 100"
        stroke="var(--iris-ink-secondary)"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <g fill="var(--iris-accent)">
        <circle cx="470" cy="6" r="3.2" />
        <circle cx="612" cy="31" r="2.6" />
        <circle cx="840" cy="100" r="3.2" />
      </g>
      <g fill="var(--iris-blush)" stroke="var(--iris-rule)" strokeWidth="0.8">
        <circle cx="300" cy="62" r="3" />
        <circle cx="700" cy="30" r="3" />
        <circle cx="920" cy="82" r="3" />
      </g>
    </svg>
  )
}

/**
 * The small spray that sits on a turn boundary — 回目分隔用一小段枝.
 *
 * The rule either side of it is drawn by the boundary's own border
 * (`reading.css`), so this is only the mark in the middle: a twig and one
 * blossom, 42×14 as the artboards draw it.
 * @returns the spray.
 */
export function PlumSpray(): ReactElement {
  return (
    <svg
      width="42"
      height="14"
      viewBox="0 0 42 14"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M1 10 C10 9, 16 4, 28 6 S38 9, 41 4"
        stroke="var(--iris-ink-secondary)"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="20" cy="4.5" r="2" fill="var(--iris-accent)" />
    </svg>
  )
}
