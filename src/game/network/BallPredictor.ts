import type { ThrowEvent } from '../../../shared/protocol';
import type { BallState, Vec3 } from '../../../shared/types';
import { EXTRAPOLATION_LIMIT_MS, LIVE_BALL_COMBAT_SUBSTEPS, SERVER_FIXED_DT } from '../../../shared/netConfig';
import { advanceBall, createBallState } from '../../../shared/simulation/BallSim';
import { GAME_CONSTANTS, type GameConstants } from '../../../shared/constants';

/**
 * Client-side VISUAL prediction for live thrown balls. Purely cosmetic: it replays the shared ball
 * simulation from authoritative throw events, then reconciles toward authoritative snapshots.
 * It never decides hits, catches, parries, score, ownership, or rules.
 */
const DEFAULT_PREDICTION_FIXED_DT = SERVER_FIXED_DT / Math.max(1, LIVE_BALL_COMBAT_SUBSTEPS);
const PREDICTION_MAX_CATCHUP_MS = EXTRAPOLATION_LIMIT_MS;
const SOFT_CORRECT_PER_FRAME = 0.2;
const MEDIUM_BLEND_PER_FRAME = 0.5;
const MEDIUM_ERROR_M = 0.6;
const SNAP_ERROR_M = 2.5;
const CORRECTION_COUNT_EPSILON_M = 0.03;

interface PredictedBall {
  throwId: number;
  ballId: string;
  ownerId: string;
  throwTimeMs: number;
  sim: BallState;
  simTimeMs: number;
  render: Vec3;
  renderOffset: Vec3;
  lastRenderTimeMs: number | null;
  lastSnapshotTimeMs: number | null;
  correctionCount: number;
}

export interface BallPredictionResult {
  position: Vec3;
  snapped: boolean;
  /** For debug: how far the raw prediction was from the snapshot before correcting. */
  errorM: number;
  correctionCount: number;
  throwId: number;
  snapReason: string;
}

export interface BallPredictorStats {
  activePredictions: number;
  totalCorrections: number;
  maxCorrections: number;
  maxErrorM: number;
  lastErrorM: number;
  snapCount: number;
  softCorrectionCount: number;
  mediumCorrectionCount: number;
  snapReasonCounts: Record<string, number>;
}

export class BallPredictor {
  // Replay step matches the ROOM's server sim substep so the deterministic ball replay integrates
  // with the same dt the server used. Default = compiled mode; NetworkRenderer passes the room's
  // resolved rate when a tick preset is negotiated.
  private readonly fixedDt: number;
  /** Ball-sim constants for the running map effect (moon gravity). Set from the latest room state. */
  ballConstants: GameConstants = GAME_CONSTANTS;
  private readonly balls = new Map<string, PredictedBall>();
  private totalCorrections = 0;
  private maxCorrections = 0;
  private maxErrorM = 0;
  private lastErrorM = 0;
  private snapCount = 0;
  private softCorrectionCount = 0;
  private mediumCorrectionCount = 0;
  private readonly snapReasonCounts: Record<string, number> = {};

  constructor(options: { fixedDt?: number } = {}) {
    this.fixedDt = options.fixedDt ?? DEFAULT_PREDICTION_FIXED_DT;
  }

  /** Seed/replace a predicted ball from an authoritative throw event (new throw identity). */
  applyThrowEvent(event: ThrowEvent): void {
    const sim = createBallState(event.ballId, event.origin, {
      phase: 'live',
      velocity: { ...event.velocity },
      curveAccel: { ...event.curveAccel },
      dropScale: event.dropScale,
      isSuper: event.isSuper,
      ownerKind: 'player',
      ownerId: event.ownerId,
      bounceCount: 0,
      throwId: event.throwId
    });
    this.balls.set(event.ballId, {
      throwId: event.throwId,
      ballId: event.ballId,
      ownerId: event.ownerId,
      throwTimeMs: event.serverTimeMs,
      sim,
      simTimeMs: event.serverTimeMs,
      render: { ...event.origin },
      renderOffset: { x: 0, y: 0, z: 0 },
      lastRenderTimeMs: null,
      lastSnapshotTimeMs: null,
      correctionCount: 0
    });
  }

  /** Forget a predicted ball (phase left live, caught, dead, reset, etc.). */
  forget(ballId: string): void {
    this.balls.delete(ballId);
  }

  /** Event queues are drained by type; an older catch/parry must not cancel a later rethrow. */
  forgetThrough(ballId: string, serverTimeMs: number): void {
    const entry = this.balls.get(ballId);
    if (entry && entry.throwTimeMs <= serverTimeMs) this.forget(ballId);
  }

  /**
   * Advance a seeded prediction to `renderServerTimeMs`. When supplied, a fresh authoritative
   * sample refreshes the baseline or ends the flight, even while the visible pose is still held.
   */
  advanceVisualOnly(
    ballId: string,
    renderServerTimeMs: number,
    authoritative?: BallState,
    snapshotServerTimeMs?: number
  ): Vec3 | null {
    const entry = this.balls.get(ballId);
    if (!entry) return null;
    if (authoritative && snapshotServerTimeMs !== undefined) {
      return this.predict(authoritative, renderServerTimeMs, snapshotServerTimeMs)?.position ?? null;
    }
    const predicted = this.advancePrediction(entry, renderServerTimeMs);
    entry.render.x = predicted.position.x;
    entry.render.y = predicted.position.y;
    entry.render.z = predicted.position.z;
    entry.lastRenderTimeMs = renderServerTimeMs;
    return entry.render;
  }

  clear(): void {
    this.balls.clear();
    this.totalCorrections = 0;
    this.maxCorrections = 0;
    this.maxErrorM = 0;
    this.lastErrorM = 0;
    this.snapCount = 0;
    this.softCorrectionCount = 0;
    this.mediumCorrectionCount = 0;
    for (const reason in this.snapReasonCounts) delete this.snapReasonCounts[reason];
  }

  has(ballId: string): boolean {
    return this.balls.has(ballId);
  }

  getStats(): BallPredictorStats {
    return {
      activePredictions: this.balls.size,
      totalCorrections: this.totalCorrections,
      maxCorrections: this.maxCorrections,
      maxErrorM: this.maxErrorM,
      lastErrorM: this.lastErrorM,
      snapCount: this.snapCount,
      softCorrectionCount: this.softCorrectionCount,
      mediumCorrectionCount: this.mediumCorrectionCount,
      snapReasonCounts: { ...this.snapReasonCounts }
    };
  }

  /**
   * Produce the predicted render position for a live ball at `renderServerTimeMs`, reconciled to the
   * authoritative `snapshotBall` at its own timestamp. Returns null when prediction no longer
   * owns this visual. Reconciliation compares states at the SAME server time; comparing a future
   * prediction to an old packet position would drag the ball backward on every rendered frame.
   */
  predict(
    snapshotBall: BallState,
    renderServerTimeMs: number,
    snapshotServerTimeMs = renderServerTimeMs
  ): BallPredictionResult | null {
    const entry = this.balls.get(snapshotBall.id);
    if (!entry) return null;

    // An immediate throw can arrive while the newest ball lane still describes an earlier held,
    // loose, or live state. Only a snapshot at/after our baseline can invalidate that throw.
    const canReconcile = snapshotServerTimeMs >= entry.simTimeMs;
    if (canReconcile && (snapshotBall.throwId !== entry.throwId || snapshotBall.ownerId !== entry.ownerId)) {
      this.recordSnap('identity-change');
      this.balls.delete(snapshotBall.id);
      return null;
    }

    if (canReconcile && snapshotBall.phase !== 'live' && snapshotBall.phase !== 'deflected') {
      this.balls.delete(snapshotBall.id);
      return null;
    }

    let errorM = 0;
    let snapReason = '';
    if (canReconcile && (entry.lastSnapshotTimeMs === null || snapshotServerTimeMs > entry.lastSnapshotTimeMs)) {
      const atSnapshot = this.advancePrediction(entry, snapshotServerTimeMs);
      const before = this.advancePrediction(entry, renderServerTimeMs);
      errorM = distance(atSnapshot.position, snapshotBall.position);
      this.recordError(errorM);
      const bounced = snapshotBall.bounceCount !== entry.sim.bounceCount;

      // Refresh the complete simulation baseline, including velocity and curve progress. Small
      // position-only corrections used to leave a wrong trajectory alive for the entire throw.
      entry.sim = createBallState(snapshotBall.id, snapshotBall.position, snapshotBall);
      entry.simTimeMs = snapshotServerTimeMs;
      entry.lastSnapshotTimeMs = snapshotServerTimeMs;
      const after = this.advancePrediction(entry, renderServerTimeMs);
      if (bounced || errorM > SNAP_ERROR_M) {
        snapReason = bounced ? 'bounce' : 'large-error';
        entry.renderOffset = { x: 0, y: 0, z: 0 };
        this.recordEntryCorrection(entry);
        this.recordSnap(snapReason);
      } else {
        if (entry.lastRenderTimeMs !== null) {
          entry.renderOffset.x += before.position.x - after.position.x;
          entry.renderOffset.y += before.position.y - after.position.y;
          entry.renderOffset.z += before.position.z - after.position.z;
        }
        if (errorM > CORRECTION_COUNT_EPSILON_M) {
          if (errorM > MEDIUM_ERROR_M) this.mediumCorrectionCount += 1;
          else this.softCorrectionCount += 1;
          this.recordEntryCorrection(entry);
        }
      }
    }

    const predicted = this.advancePrediction(entry, renderServerTimeMs).position;
    const elapsedSeconds = entry.lastRenderTimeMs === null
      ? 1 / 60
      : Math.max(0, renderServerTimeMs - entry.lastRenderTimeMs) / 1000;
    const offsetM = Math.hypot(entry.renderOffset.x, entry.renderOffset.y, entry.renderOffset.z);
    const correction = offsetM > MEDIUM_ERROR_M ? MEDIUM_BLEND_PER_FRAME : SOFT_CORRECT_PER_FRAME;
    const retained = Math.pow(1 - correction, elapsedSeconds * 60);
    entry.renderOffset.x *= retained;
    entry.renderOffset.y *= retained;
    entry.renderOffset.z *= retained;
    entry.render.x = predicted.x + entry.renderOffset.x;
    entry.render.y = predicted.y + entry.renderOffset.y;
    entry.render.z = predicted.z + entry.renderOffset.z;
    entry.lastRenderTimeMs = renderServerTimeMs;

    return {
      position: entry.render,
      snapped: snapReason !== '',
      errorM,
      correctionCount: entry.correctionCount,
      throwId: entry.throwId,
      snapReason
    };
  }

  private advancePrediction(entry: PredictedBall, renderServerTimeMs: number): BallState {
    // Replay from the authoritative baseline each time. Carrying fractional render-frame steps
    // into the next frame makes semi-implicit gravity/curve integration depend on monitor Hz.
    let sim = entry.sim;
    if (renderServerTimeMs <= entry.simTimeMs) return sim;
    let remaining = Math.min(renderServerTimeMs - entry.simTimeMs, PREDICTION_MAX_CATCHUP_MS);
    while (remaining > 0) {
      const step = Math.min(this.fixedDt, remaining / 1000);
      sim = advanceBall(sim, step, this.ballConstants);
      remaining -= step * 1000;
    }
    return sim;
  }

  private recordEntryCorrection(entry: PredictedBall): void {
    entry.correctionCount += 1;
    this.totalCorrections += 1;
    this.maxCorrections = Math.max(this.maxCorrections, entry.correctionCount);
  }

  private recordError(errorM: number): void {
    this.lastErrorM = errorM;
    this.maxErrorM = Math.max(this.maxErrorM, errorM);
  }

  private recordSnap(reason: string): void {
    this.snapCount += 1;
    this.snapReasonCounts[reason] = (this.snapReasonCounts[reason] ?? 0) + 1;
  }
}

function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
