/**
 * A counter that learns the provider's real ratio.
 *
 * Every request comes back with `usage.inputTokens` — the exact count for a
 * prompt we just estimated. That pairing is free and it is the only way a
 * budget gets tighter than the ±30% a per-character model can offer, because
 * the residual error is vocabulary-specific: a model whose tokenizer merges
 * common Chinese words differs from one that does not, and no static table
 * knows which one is answering today.
 *
 * The correction is a single scale factor, smoothed and clamped. Deliberately
 * not per-character-class: with one observation per turn there is nowhere near
 * enough signal to fit five weights, and a fit that overreacts to one long code
 * block would make the budget worse than the constant it replaced.
 *
 * @module @iris/tokenizer/calibrate
 */

import {
  estimateRequest,
  estimateTokens,
  type ClassWeights,
  type CountableMessage,
} from './estimate.ts'

/** How the calibrator reacts to observations. */
export interface CalibrationOptions {
  weights?: ClassWeights
  /**
   * Weight of each new observation, 0–1. Low values are slow and steady; the
   * default moves most of the way in a handful of turns, which is the right
   * pace when a session may only have a handful.
   */
  smoothing?: number
  /**
   * Bounds on the correction. A provider reporting something absurd — a cached
   * prompt, a request that failed mid-flight — must not be able to make the
   * budget nonsense; clamping turns a bad observation into a small error
   * instead of a broken session.
   */
  minScale?: number
  maxScale?: number
}

/** A counter that improves as a session runs. */
export interface CalibratingCounter {
  /**
   * Estimate one string.
   * @param text - the text to measure.
   * @returns the corrected token count.
   */
  count(text: string): number
  /**
   * Estimate a whole request, overheads included.
   * @param messages - the conversation.
   * @param options - per-message and template overheads.
   * @returns the corrected prompt size.
   */
  countRequest(
    messages: readonly CountableMessage[],
    options?: { messageOverhead?: number, templateOverhead?: number },
  ): number
  /**
   * Record what a request actually cost.
   * @param estimated - the number **this counter returned** for that request,
   *   correction already applied. Passing a raw uncorrected estimate makes the
   *   scale compound on itself and run away.
   * @param actual - what the provider reported for the same request.
   */
  observe(estimated: number, actual: number): void
  /** Current correction factor; `1` until the first observation. */
  readonly scale: number
  /** How many observations have been folded in. */
  readonly samples: number
}

const DEFAULTS = { smoothing: 0.35, minScale: 0.5, maxScale: 2 }

/**
 * Build a counter that calibrates itself against reported usage.
 * @param options - weights and reaction bounds.
 * @returns the counter.
 */
export function createCalibratingCounter(options: CalibrationOptions = {}): CalibratingCounter {
  const weights = options.weights
  const smoothing = options.smoothing ?? DEFAULTS.smoothing
  const minScale = options.minScale ?? DEFAULTS.minScale
  const maxScale = options.maxScale ?? DEFAULTS.maxScale

  let scale = 1
  let samples = 0

  const estimateOptions = weights === undefined ? {} : { weights }

  return {
    count(text: string): number {
      return Math.ceil(estimateTokens(text, weights) * scale)
    },

    countRequest(messages, requestOptions = {}): number {
      return Math.ceil(estimateRequest(messages, { ...estimateOptions, ...requestOptions }) * scale)
    },

    observe(estimated: number, actual: number): void {
      // A zero or negative estimate carries no ratio, and a non-finite actual is
      // a transport artifact rather than a measurement.
      if (estimated <= 0 || !Number.isFinite(actual) || actual <= 0) return

      // The observed ratio is against the *already corrected* estimate, so it
      // composes with the current scale rather than replacing it.
      const observed = scale * (actual / estimated)
      scale = Math.min(Math.max(scale + (observed - scale) * smoothing, minScale), maxScale)
      samples += 1
    },

    get scale(): number {
      return scale
    },

    get samples(): number {
      return samples
    },
  }
}
