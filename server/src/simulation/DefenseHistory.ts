import type { BallState, HandSide, Vec3 } from '../../../shared/types';

/**
 * One sampled snapshot of a player's DEFENSIVE state at a server tick. The catch/parry validator
 * rewinds to the sample nearest the moment a defender clicked (lag compensation), so a high-ping
 * defender is judged by where they were aiming when they saw the ball — not by their delayed,
 * present-time state. Server stays authoritative; this only supplies the historical state to test.
 */
export interface DefenseSample {
  serverTimeMs: number;
  tick: number;
  /** Cone origin (eye position) used for catch/parry tests. */
  eye: Vec3;
  /** Normalized aim forward (from yaw+pitch) at this tick. */
  forward: Vec3;
  yaw: number;
  pitch: number;
  leftHandEmpty: boolean;
  rightHandEmpty: boolean;
  leftHeldBallId: string | null;
  rightHeldBallId: string | null;
  heldBallCount: number;
  dashing: boolean;
}

/**
 * One sampled ball state at a server tick. Lets the catch validator reconstruct the ball's swept
 * segment AND its catchability/ownership around the rewound click time, even after the present ball
 * has died (e.g. it already hit the defender) — lag compensation judges the catch by what the
 * defender SAW, so it must read the ball's past phase/velocity/owner, not the current ones.
 */
export interface BallSample {
  serverTimeMs: number;
  tick: number;
  position: Vec3;
  velocity: Vec3;
  phase: BallState['phase'];
  ownerId: string | null;
  bounceCount: number;
}

/**
 * Fixed-capacity ring of recent samples keyed by server time. Stores at most `windowMs` of history
 * (so memory is bounded regardless of session length) and supports nearest-time lookup for rewind.
 */
export class TimeRing<T extends { serverTimeMs: number }> {
  private readonly samples: T[] = [];

  constructor(private readonly windowMs: number) {}

  push(sample: T): void {
    this.samples.push(sample);
    const cutoff = sample.serverTimeMs - this.windowMs;
    // Drop anything older than the window. Samples are pushed in increasing time order, so the
    // stale ones are always at the front.
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].serverTimeMs < cutoff) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);
  }

  /**
   * Sample nearest the requested server time, or null if empty. Used for lag-comp rewind. On a tie
   * (multiple samples at the same time — can happen when several ticks share a wall-clock ms) the
   * LATEST such sample wins, so we never rewind to a staler state than necessary. Samples are stored
   * in increasing time order, so iterating with `<=` naturally keeps the last equal-or-closer one.
   */
  nearest(serverTimeMs: number): T | null {
    if (this.samples.length === 0) return null;
    let best = this.samples[0];
    let bestDelta = Math.abs(best.serverTimeMs - serverTimeMs);
    for (let i = 1; i < this.samples.length; i += 1) {
      const delta = Math.abs(this.samples[i].serverTimeMs - serverTimeMs);
      if (delta <= bestDelta) {
        best = this.samples[i];
        bestDelta = delta;
      }
    }
    return best;
  }

  /**
   * The two samples straddling `serverTimeMs` — [before, after] — for reconstructing a swept
   * segment at a rewound time. If the time is outside the buffer (or only one sample exists) both
   * entries are the nearest single sample (a degenerate zero-length segment, still valid). Samples
   * are stored in increasing time order.
   */
  bracket(serverTimeMs: number): [T, T] | null {
    if (this.samples.length === 0) return null;
    if (this.samples.length === 1) return [this.samples[0], this.samples[0]];
    for (let i = 0; i < this.samples.length - 1; i += 1) {
      if (this.samples[i].serverTimeMs <= serverTimeMs && serverTimeMs <= this.samples[i + 1].serverTimeMs) {
        return [this.samples[i], this.samples[i + 1]];
      }
    }
    // Outside the range: clamp to the closest end pair.
    if (serverTimeMs < this.samples[0].serverTimeMs) return [this.samples[0], this.samples[0]];
    const last = this.samples[this.samples.length - 1];
    return [last, last];
  }

  /** Most recent sample, or null. */
  latest(): T | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
  }

  /** Age (ms) of the sample nearest `serverTimeMs` relative to it — for debug. */
  ageOfNearest(serverTimeMs: number): number {
    const n = this.nearest(serverTimeMs);
    return n ? Math.abs(n.serverTimeMs - serverTimeMs) : Number.POSITIVE_INFINITY;
  }

  clear(): void {
    this.samples.length = 0;
  }

  get size(): number {
    return this.samples.length;
  }
}

/** Which hand's emptiness a defense sample reports. */
export function defenseHandEmpty(sample: DefenseSample, hand: HandSide): boolean {
  return hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty;
}
