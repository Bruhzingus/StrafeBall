import { TUNING } from '../config/tuning';
import { backflipQteTier } from '../../../shared/simulation/ThrowMath';

export type QteResolution =
  | { kind: 'hit'; tier: number; offset: number }
  | { kind: 'miss' }      // clicked outside the hit zone
  | { kind: 'timeout' };  // bar lapsed with no click

/**
 * Backflip landing quick-time event (client-side timing + state).
 *
 * After a backflip, the moment the player lands while holding a ball, the QTE is armed: an indicator
 * sweeps once across a timing bar over `qte.durationSeconds`. A single click samples the indicator's
 * signed offset from center (−1..+1) and resolves to a success tier (1..5) or a miss. While armed, a
 * normal throw is suppressed — the QTE click is the only way to release the backflip throw. A miss or
 * timeout cancels the throw and keeps the ball (the player can then throw normally again).
 *
 * This controller owns ONLY the timing/state; the visual bar lives in BackflipQteHud and the actual
 * throw is performed by the caller using the resolved tier.
 */
export class BackflipQteController {
  private active = false;
  // Pre-roll delay (s) remaining before the bar appears + starts sweeping. While > 0 the QTE is
  // "active" (normal throws stay suppressed) but the bar is hidden and clicks are ignored.
  private delay = 0;
  private timer = 0;

  /** Arm the QTE (called once, on landing from a backflip while holding a throwable ball). */
  arm(): void {
    this.active = true;
    this.delay = TUNING.backflip.qte.armDelaySeconds;
    this.timer = 0;
  }

  cancel(): void {
    this.active = false;
    this.delay = 0;
    this.timer = 0;
  }

  isActive(): boolean {
    return this.active;
  }

  /** True once the arm delay has elapsed and the bar is sweeping (show the HUD + accept clicks). */
  isSweeping(): boolean {
    return this.active && this.delay <= 0;
  }

  /** Advance the sweep. Returns 'timeout' on the frame the bar lapses with no click, else null. */
  update(dt: number): QteResolution | null {
    if (!this.active) return null;
    if (this.delay > 0) {
      this.delay = Math.max(0, this.delay - dt);
      return null; // still in the pre-roll; bar not yet sweeping
    }
    this.timer += dt;
    if (this.timer >= TUNING.backflip.qte.durationSeconds) {
      this.active = false;
      this.timer = 0;
      return { kind: 'timeout' };
    }
    return null;
  }

  /** Current sweep progress in [0, 1] (for the HUD indicator). */
  progress01(): number {
    return Math.min(1, this.timer / TUNING.backflip.qte.durationSeconds);
  }

  /** Indicator's signed offset from center in [-1, 1] at the current instant. */
  currentOffset(): number {
    return -1 + 2 * this.progress01();
  }

  /**
   * Resolve a click at the current instant. Captures the indicator offset, maps it to a tier, and
   * deactivates the QTE. Returns a hit (with tier) or a miss.
   */
  resolveClick(): QteResolution {
    const offset = this.currentOffset();
    this.active = false;
    this.timer = 0;
    const tier = backflipQteTier(offset);
    return tier >= 1 ? { kind: 'hit', tier, offset } : { kind: 'miss' };
  }
}
