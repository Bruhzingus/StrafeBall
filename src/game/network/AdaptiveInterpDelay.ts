import {
  ADAPTIVE_INTERP_GAP_DECAY_PER_WINDOW,
  ADAPTIVE_INTERP_GAP_MARGIN_MS,
  ADAPTIVE_INTERP_MAX_DELAY_MS,
  ADAPTIVE_INTERP_MIN_DELAY_MS,
  ADAPTIVE_INTERP_SHRINK_PER_WINDOW_MS,
  ADAPTIVE_INTERP_UNDERRUN_TOLERANCE,
  INTERPOLATION_DELAY_MS,
  SNAPSHOT_INTERVAL_MS
} from '../../../shared/netConfig';

export interface AdaptiveInterpDelayOptions {
  startDelayMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  nominalIntervalMs?: number;
  gapDecayPerWindow?: number;
  shrinkPerWindowMs?: number;
  gapMarginMs?: number;
  underrunTolerance?: number;
}

/**
 * Per-client interpolation-delay controller. NetworkRenderer feeds it one observation per
 * ~1s metric window (worst snapshot inter-arrival gap + extrapolation underrun count) and it
 * returns the delay the render clock should target.
 *
 * Sizing model: the buffer must cover the worst recent delivery gap plus a margin. We track a
 * DECAYED PEAK of the observed gap (spikes register instantly, then age out over ~8 windows)
 * rather than an average — an average would size the buffer for the common case and render
 * every tail-latency spike as a visible stutter, which is exactly the failure mode this exists
 * to remove. Asymmetric response: widen to target immediately (a too-small buffer is visible
 * NOW), shrink a few ms per window (reclaiming latency is never urgent).
 *
 * Underruns are a second witness: a stall can straddle the window boundary so no single
 * inter-arrival gap records it, but the extrapolation counter still catches it. When underruns
 * exceed tolerance, the current delay itself is proven insufficient, so the peak is raised to
 * current delay + one interval.
 */
export class AdaptiveInterpDelay {
  private readonly startDelayMs: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly nominalIntervalMs: number;
  private readonly gapDecayPerWindow: number;
  private readonly shrinkPerWindowMs: number;
  private readonly gapMarginMs: number;
  private readonly underrunTolerance: number;

  private peakGapMs = 0;
  private delayMs: number;

  constructor(options: AdaptiveInterpDelayOptions = {}) {
    this.startDelayMs = options.startDelayMs ?? INTERPOLATION_DELAY_MS;
    this.minDelayMs = options.minDelayMs ?? ADAPTIVE_INTERP_MIN_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? ADAPTIVE_INTERP_MAX_DELAY_MS;
    this.nominalIntervalMs = options.nominalIntervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.gapDecayPerWindow = options.gapDecayPerWindow ?? ADAPTIVE_INTERP_GAP_DECAY_PER_WINDOW;
    this.shrinkPerWindowMs = options.shrinkPerWindowMs ?? ADAPTIVE_INTERP_SHRINK_PER_WINDOW_MS;
    this.gapMarginMs = options.gapMarginMs ?? ADAPTIVE_INTERP_GAP_MARGIN_MS;
    this.underrunTolerance = options.underrunTolerance ?? ADAPTIVE_INTERP_UNDERRUN_TOLERANCE;
    this.delayMs = this.clamp(this.startDelayMs);
  }

  get currentDelayMs(): number {
    return this.delayMs;
  }

  /**
   * Feed one ~1s metric window; returns the new delay. `maxIntervalMs` is the worst snapshot
   * inter-arrival gap observed in the window (0 when no two snapshots arrived — e.g. mid-join),
   * `underruns` the number of frames sampled past the newest snapshot (extrapolated).
   */
  observeWindow(maxIntervalMs: number, underruns: number): number {
    let gap = Math.max(0, maxIntervalMs);
    if (underruns > this.underrunTolerance) {
      gap = Math.max(gap, this.delayMs + this.nominalIntervalMs);
    }
    this.peakGapMs = Math.max(gap, this.peakGapMs * this.gapDecayPerWindow);

    const target = this.clamp(this.peakGapMs + this.gapMarginMs);
    if (target > this.delayMs) {
      this.delayMs = target;
    } else {
      this.delayMs = Math.max(target, this.delayMs - this.shrinkPerWindowMs);
    }
    return this.delayMs;
  }

  /** Back to the mode's static starting delay; learned jitter is discarded (new connection). */
  reset(): void {
    this.peakGapMs = 0;
    this.delayMs = this.clamp(this.startDelayMs);
  }

  private clamp(value: number): number {
    return Math.min(this.maxDelayMs, Math.max(this.minDelayMs, value));
  }
}
