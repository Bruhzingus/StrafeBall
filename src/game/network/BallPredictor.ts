import type { ThrowEvent } from '../../../shared/protocol';
import type { BallState, Vec3 } from '../../../shared/types';
import { advanceBall, createBallState } from '../../../shared/simulation/BallSim';

/**
 * Client-side VISUAL prediction for live thrown balls (Phases 5/6). Purely cosmetic: it makes a
 * live ball move smoothly between snapshots by replaying the SAME deterministic shared simulation
 * (advanceBall — gravity + curve) the server runs, seeded from the authoritative throw event. It
 * NEVER decides hits/catches/parries/score/ownership; the authoritative ball state still flows in
 * snapshots and always wins on reconciliation.
 *
 * One predicted entry per ball id. It is created/replaced when a throw event with a new throwId
 * arrives, advanced each render frame to the current render time, and reconciled toward the
 * snapshot position (soft-correct small error, snap on large error / identity change).
 */

const FIXED_DT = 1 / 120; // prediction substep — fine enough that curve+gravity match the server.
const SOFT_CORRECT_PER_FRAME = 0.2; // fraction of small error corrected per frame (visual smoothing).
const MEDIUM_BLEND_PER_FRAME = 0.5; // faster blend for medium error.
const MEDIUM_ERROR_M = 0.6; // below this: soft-correct. above SNAP: hard snap. between: medium blend.
const SNAP_ERROR_M = 2.5; // prediction error above which we snap to the authoritative position.

interface PredictedBall {
  throwId: number;
  ballId: string;
  ownerId: string;
  /** Simulated ball used to carry forward position/velocity deterministically. */
  sim: BallState;
  /** Server time (ms) the simulation is currently advanced to. */
  simTimeMs: number;
  /** Last rendered position (after reconciliation) — what the mesh should show. */
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

export class BallPredictor {
  private readonly balls = new Map<string, PredictedBall>();

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
   * Advance a seeded prediction to `renderServerTimeMs` and return its position WITHOUT reconciling
   * against (or being invalidated by) the authoritative snapshot. Used only to bridge the brief
   * window after a local throw where the throw event has seeded prediction but the interpolation-
   * delayed snapshot still shows the ball held — so the thrower's ball detaches instantly. Returns
   * null if there is no seeded prediction for this ball.
   */
  advanceVisualOnly(ballId: string, renderServerTimeMs: number): Vec3 | null {
    const entry = this.balls.get(ballId);
    if (!entry) return null;
    if (renderServerTimeMs > entry.simTimeMs) {
      let remaining = Math.min(renderServerTimeMs - entry.simTimeMs, 500);
      while (remaining > 0) {
        const step = Math.min(FIXED_DT, remaining / 1000);
        entry.sim = advanceBall(entry.sim, step);
        remaining -= step * 1000;
      }
      entry.simTimeMs = renderServerTimeMs;
    }
    entry.render.x = entry.sim.position.x;
    entry.render.y = entry.sim.position.y;
    entry.render.z = entry.sim.position.z;
    return entry.render;
  }

  clear(): void {
    this.balls.clear();
  }

  has(ballId: string): boolean {
    return this.balls.has(ballId);
  }

  /**
   * Produce the predicted render position for a live ball at `renderServerTimeMs`, reconciled to the
   * authoritative `snapshotBall`. Returns null when there is no active prediction for this ball (the
   * caller should then fall back to plain snapshot interpolation). The returned position is what the
   * mesh should display this frame.
   */
  predict(snapshotBall: BallState, renderServerTimeMs: number): BallPredictionResult | null {
    const entry = this.balls.get(snapshotBall.id);
    if (!entry) return null;

    // Identity change → the prediction is stale; drop it and let the caller snap to the snapshot.
    // (A new throw event for the new throwId will reseed prediction.)
    if (snapshotBall.throwId !== entry.throwId || snapshotBall.ownerId !== entry.ownerId) {
      this.balls.delete(snapshotBall.id);
      return null;
    }
    // Phase left live/deflected (caught/dead/loose/held) → stop predicting, snapshot owns it now.
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
      entry.correctionCount += 1;
      return {
        position: entry.render,
        snapped: true,
        errorM: 0,
        correctionCount: entry.correctionCount,
        throwId: entry.throwId,
        snapReason: 'bounce'
      };
    }

    // Advance the deterministic sim forward to the render time (catch up missed substeps).
    let snapReason = '';
    if (renderServerTimeMs > entry.simTimeMs) {
      let remaining = renderServerTimeMs - entry.simTimeMs;
      // Cap catch-up so a long stall doesn't run thousands of substeps.
      remaining = Math.min(remaining, 500);
      while (remaining > 0) {
        const step = Math.min(FIXED_DT, remaining / 1000);
        entry.sim = advanceBall(entry.sim, step);
        remaining -= step * 1000;
      }
      entry.simTimeMs = renderServerTimeMs;
    }

    // Reconcile the predicted position toward the authoritative snapshot position.
    const predicted = entry.sim.position;
    const target = snapshotBall.position;
    const errorM = distance(predicted, target);

    if (errorM > SNAP_ERROR_M) {
      // Large divergence (bounce off wall/player the predictor didn't model, big desync): snap the
      // sim to authoritative state so prediction re-tracks reality.
      entry.sim = { ...entry.sim, position: { ...target }, velocity: { ...snapshotBall.velocity } };
      entry.render.x = target.x;
      entry.render.y = target.y;
      entry.render.z = target.z;
      entry.correctionCount += 1;
      snapReason = 'large-error';
    } else {
      // Render the predicted position, then ease it toward the authoritative one so small errors
      // wash out without visible popping. Medium errors blend faster.
      const k = errorM > MEDIUM_ERROR_M ? MEDIUM_BLEND_PER_FRAME : SOFT_CORRECT_PER_FRAME;
      entry.render.x = predicted.x + (target.x - predicted.x) * k;
      entry.render.y = predicted.y + (target.y - predicted.y) * k;
      entry.render.z = predicted.z + (target.z - predicted.z) * k;
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
}

function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
