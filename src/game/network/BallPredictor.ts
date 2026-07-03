import type { ThrowEvent } from '../../../shared/protocol';
import type { BallState, Vec3 } from '../../../shared/types';
import { LIVE_BALL_COMBAT_SUBSTEPS, SERVER_FIXED_DT } from '../../../shared/netConfig';
import { advanceBall, createBallState } from '../../../shared/simulation/BallSim';

/**
 * Client-side VISUAL prediction for live thrown balls. Purely cosmetic: it replays the shared ball
 * simulation from authoritative throw events, then reconciles toward authoritative snapshots.
 * It never decides hits, catches, parries, score, ownership, or rules.
 */
const DEFAULT_PREDICTION_FIXED_DT = SERVER_FIXED_DT / Math.max(1, LIVE_BALL_COMBAT_SUBSTEPS);
const PREDICTION_MAX_CATCHUP_MS = 500;
const SOFT_CORRECT_PER_FRAME = 0.2;
const MEDIUM_BLEND_PER_FRAME = 0.5;
const MEDIUM_ERROR_M = 0.6;
const SNAP_ERROR_M = 2.5;
const CORRECTION_COUNT_EPSILON_M = 0.03;

interface PredictedBall {
  throwId: number;
  ballId: string;
  ownerId: string;
  sim: BallState;
  simTimeMs: number;
  render: Vec3;
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
      sim,
      simTimeMs: event.serverTimeMs,
      render: { ...event.origin },
      correctionCount: 0
    });
  }

  /** Forget a predicted ball (phase left live, caught, dead, reset, etc.). */
  forget(ballId: string): void {
    this.balls.delete(ballId);
  }

  /**
   * Advance a seeded prediction to `renderServerTimeMs` and return its position without reconciling
   * against the authoritative snapshot. Used only to bridge the brief local-throw detach window.
   */
  advanceVisualOnly(ballId: string, renderServerTimeMs: number): Vec3 | null {
    const entry = this.balls.get(ballId);
    if (!entry) return null;
    this.advancePrediction(entry, renderServerTimeMs);
    entry.render.x = entry.sim.position.x;
    entry.render.y = entry.sim.position.y;
    entry.render.z = entry.sim.position.z;
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
   * authoritative `snapshotBall`. Returns null when prediction no longer owns this visual.
   */
  predict(snapshotBall: BallState, renderServerTimeMs: number): BallPredictionResult | null {
    const entry = this.balls.get(snapshotBall.id);
    if (!entry) return null;

    if (snapshotBall.throwId !== entry.throwId || snapshotBall.ownerId !== entry.ownerId) {
      this.recordSnap('identity-change');
      this.balls.delete(snapshotBall.id);
      return null;
    }

    if (snapshotBall.phase !== 'live' && snapshotBall.phase !== 'deflected') {
      this.balls.delete(snapshotBall.id);
      return null;
    }

    if (snapshotBall.bounceCount !== entry.sim.bounceCount) {
      entry.sim = {
        ...snapshotBall,
        position: { ...snapshotBall.position },
        velocity: { ...snapshotBall.velocity },
        curveAccel: { ...snapshotBall.curveAccel }
      };
      entry.simTimeMs = renderServerTimeMs;
      entry.render.x = snapshotBall.position.x;
      entry.render.y = snapshotBall.position.y;
      entry.render.z = snapshotBall.position.z;
      this.recordEntryCorrection(entry);
      this.recordSnap('bounce');
      return {
        position: entry.render,
        snapped: true,
        errorM: 0,
        correctionCount: entry.correctionCount,
        throwId: entry.throwId,
        snapReason: 'bounce'
      };
    }

    this.advancePrediction(entry, renderServerTimeMs);

    const predicted = entry.sim.position;
    const target = snapshotBall.position;
    const errorM = distance(predicted, target);
    this.recordError(errorM);

    let snapReason = '';
    if (errorM > SNAP_ERROR_M) {
      entry.sim = { ...entry.sim, position: { ...target }, velocity: { ...snapshotBall.velocity } };
      entry.render.x = target.x;
      entry.render.y = target.y;
      entry.render.z = target.z;
      this.recordEntryCorrection(entry);
      this.recordSnap('large-error');
      snapReason = 'large-error';
    } else {
      const k = errorM > MEDIUM_ERROR_M ? MEDIUM_BLEND_PER_FRAME : SOFT_CORRECT_PER_FRAME;
      entry.render.x = predicted.x + (target.x - predicted.x) * k;
      entry.render.y = predicted.y + (target.y - predicted.y) * k;
      entry.render.z = predicted.z + (target.z - predicted.z) * k;
      if (errorM > MEDIUM_ERROR_M) {
        this.mediumCorrectionCount += 1;
        this.recordEntryCorrection(entry);
      } else if (errorM > CORRECTION_COUNT_EPSILON_M) {
        this.softCorrectionCount += 1;
        this.recordEntryCorrection(entry);
      }
    }

    return {
      position: entry.render,
      snapped: snapReason !== '',
      errorM,
      correctionCount: entry.correctionCount,
      throwId: entry.throwId,
      snapReason
    };
  }

  private advancePrediction(entry: PredictedBall, renderServerTimeMs: number): void {
    if (renderServerTimeMs <= entry.simTimeMs) return;
    let remaining = Math.min(renderServerTimeMs - entry.simTimeMs, PREDICTION_MAX_CATCHUP_MS);
    while (remaining > 0) {
      const step = Math.min(this.fixedDt, remaining / 1000);
      entry.sim = advanceBall(entry.sim, step);
      remaining -= step * 1000;
    }
    entry.simTimeMs = renderServerTimeMs;
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
