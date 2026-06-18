import { Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { HandSide } from './BallState';
import { Ball } from './Ball';
import { BallState } from './BallState';
import { safeNormalize } from '../utils/math';
import { CollisionWorld } from '../map/Collider';
import { ModelLoader } from '../assets/ModelLoader';
import { isBallPickupStateEligible } from '../../../shared/simulation/BallSim';
import { ballVariantForState, createBallMesh, getBallMaterial, updateBallBlobShadow } from './BallVisualFactory';
import type { BallVisualEffects } from './BallVisualEffects';
import { BALL_QTE_TRAIL_SPEED_THRESHOLD, BALL_TRAIL_INTERVAL_SECONDS } from './BallVisualEffects';

const BALL_SQUASH_XZ_SCALE = 0.08;
const BALL_SQUASH_Y_SCALE = 0.12;

export class BallManager {
  public readonly balls: Ball[] = [];
  private highlightedBallId: number | null = null;

  constructor(
    private readonly loader: ModelLoader,
    private readonly collision: CollisionWorld,
    private readonly onBallImpact?: (speed: number, bounceCount: number, position: Vector3) => void,
    private readonly visualEffects?: BallVisualEffects
  ) {}

  createBall(name: string, position: Vector3): Ball {
    const visual = createBallMesh(this.loader.scene, name, position);
    return new Ball(visual, position, this.onBallImpact);
  }

  spawnCenterLineBalls(): void {
    this.clear();
    const count = TUNING.map.ballCount;
    const spacing = 2.0;
    const start = -((count - 1) * spacing) / 2;

    for (let i = 0; i < count; i += 1) {
      const position = new Vector3(start + i * spacing, TUNING.ball.radius + 0.05, 0);
      this.balls.push(this.createBall(`ball_${i}`, position));
    }
  }

  clear(): void {
    for (const ball of this.balls) {
      ball.mesh.dispose();
    }
    this.balls.length = 0;
    this.highlightedBallId = null;
  }

  update(dt: number): void {
    // Swap shared material/effect state only from ball state; gameplay physics stays in Ball.
    for (const ball of this.balls) {
      ball.update(dt, this.collision);
      this.updateBallVisual(ball, dt);
    }
  }

  setPickupHighlight(ball: Ball | null): void {
    this.highlightedBallId = ball?.id ?? null;
  }

  findPickupLookCandidate(origin: Vector3, forward: Vector3): Ball | null {
    const maxDistance = TUNING.ball.pickupRadius + 0.65;
    const maxDistanceSq = maxDistance * maxDistance;
    const forwardLenSq = forward.x * forward.x + forward.y * forward.y + forward.z * forward.z;
    if (forwardLenSq <= 0.0001) return null;

    const invForwardLen = 1 / Math.sqrt(forwardLenSq);
    let best: Ball | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const ball of this.balls) {
      if (!this.canPickup(ball)) continue;
      const dx = ball.mesh.position.x - origin.x;
      const dy = ball.mesh.position.y - origin.y;
      const dz = ball.mesh.position.z - origin.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= 0.0001 || distSq > maxDistanceSq) continue;

      const dot = (dx * forward.x + dy * forward.y + dz * forward.z) / Math.sqrt(distSq) * invForwardLen;
      if (dot < 0.78) continue;
      const score = dot * 2 - distSq * 0.04;
      if (score > bestScore) {
        best = ball;
        bestScore = score;
      }
    }

    return best;
  }

  private updateBallVisual(ball: Ball, dt: number): void {
    // Only reassign when it actually changes (on a throw/catch transition) so we don't dirty
    // Babylon's render state / break sub-mesh batching every frame.
    const desired = getBallMaterial(
      ball.mesh.getScene(),
      ballVariantForState({ phase: ball.state, isSuper: ball.isSuper, highlighted: ball.id === this.highlightedBallId })
    );
    if (ball.mesh.material !== desired) ball.mesh.material = desired;
    this.updateTrail(ball, dt);
    this.updateImpactSquash(ball, dt);
    updateBallBlobShadow(ball.mesh);
  }

  private updateTrail(ball: Ball, dt: number): void {
    if (!this.visualEffects || ball.state !== BallState.Live || !ball.isSuper) {
      ball.visualTrailTimer = 0;
      return;
    }

    const speedSq = ball.velocity.x * ball.velocity.x + ball.velocity.y * ball.velocity.y + ball.velocity.z * ball.velocity.z;
    if (speedSq < BALL_QTE_TRAIL_SPEED_THRESHOLD * BALL_QTE_TRAIL_SPEED_THRESHOLD) {
      ball.visualTrailTimer = 0;
      return;
    }

    ball.visualTrailTimer -= dt;
    if (ball.visualTrailTimer > 0) return;
    this.visualEffects.spawnTrail(ball.mesh.position, ball.velocity);
    ball.visualTrailTimer = BALL_TRAIL_INTERVAL_SECONDS;
  }

  private updateImpactSquash(ball: Ball, dt: number): void {
    if (ball.impactPulse > 0) {
      const amount = ball.impactPulse;
      ball.mesh.scaling.set(1 + amount * BALL_SQUASH_XZ_SCALE, 1 - amount * BALL_SQUASH_Y_SCALE, 1 + amount * BALL_SQUASH_XZ_SCALE);
      ball.impactPulse = Math.max(0, ball.impactPulse - dt * 8.5);
      return;
    }
    if (ball.mesh.scaling.x !== 1 || ball.mesh.scaling.y !== 1 || ball.mesh.scaling.z !== 1) {
      ball.mesh.scaling.setAll(1);
    }
  }

  findPickupCandidate(position: Vector3): Ball | null {
    let best: Ball | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const ball of this.balls) {
      if (!this.canPickup(ball)) continue;
      const dist = Vector3.Distance(position, ball.mesh.position);
      if (dist <= TUNING.ball.pickupRadius && dist < bestDist) {
        best = ball;
        bestDist = dist;
      }
    }

    return best;
  }

  canPickup(ball: Ball): boolean {
    // A ball already held in a hand is never a pickup candidate. It sits in front of the
    // camera at zero velocity, so without this guard holding the interact key would re-grab
    // the same ball into the second hand (the "ball in both hands" bug).
    return isBallPickupStateEligible({ phase: ball.state, velocity: ball.velocity });
  }

  /** A ball the debug launcher can safely reuse: never one held in a player's hand. */
  findFreeBall(): Ball | null {
    return (
      this.balls.find((b) => b.state === BallState.Loose) ??
      this.balls.find((b) => b.state === BallState.Dead) ??
      this.balls.find((b) => b.state !== BallState.Held) ??
      null
    );
  }

  /**
   * Nearest ball already settled on the map (loose or dead) to a point, ignoring distance.
   * Used by the practice bot to re-arm from balls in play — it never spawns new ones. Returns
   * null when every ball is held or in flight, in which case the bot simply waits.
   */
  findNearestFreeBall(position: Vector3): Ball | null {
    let best: Ball | null = null;
    let bestSq = Number.POSITIVE_INFINITY;
    for (const ball of this.balls) {
      if (ball.state !== BallState.Loose && ball.state !== BallState.Dead) continue;
      const dx = ball.mesh.position.x - position.x;
      const dy = ball.mesh.position.y - position.y;
      const dz = ball.mesh.position.z - position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < bestSq) {
        best = ball;
        bestSq = distSq;
      }
    }
    return best;
  }

  throwBall(
    ball: Ball,
    origin: Vector3,
    direction: Vector3,
    speed: number,
    owner: 'player' | 'launcher' | 'bot',
    isSuper: boolean,
    dropScale = 1,
    curveAccel?: Vector3
  ): void {
    ball.mesh.position.copyFrom(origin);
    ball.throw(owner, safeNormalize(direction).scale(speed), isSuper, dropScale, curveAccel);
  }

  dropBall(ball: Ball, position: Vector3, velocity?: Vector3): void {
    ball.drop(position, velocity);
  }

  getLiveThreatsToward(position: Vector3): Ball[] {
    // Scalar dot of the (normalized) ball velocity against the (normalized) direction to the
    // player — no per-ball Vector3 allocations (this runs every frame for every live ball).
    return this.balls.filter((ball) => {
      if (ball.state !== BallState.Live) return false;
      const tx = position.x - ball.mesh.position.x;
      const ty = position.y - ball.mesh.position.y;
      const tz = position.z - ball.mesh.position.z;
      const toLenSq = tx * tx + ty * ty + tz * tz;
      if (toLenSq <= 0.001) return false;
      const vx = ball.velocity.x;
      const vy = ball.velocity.y;
      const vz = ball.velocity.z;
      const vLenSq = vx * vx + vy * vy + vz * vz;
      if (vLenSq <= 1e-6) return false;
      const dot = tx * vx + ty * vy + tz * vz;
      return dot / Math.sqrt(toLenSq * vLenSq) > 0.35;
    });
  }

  attachHeldBall(ball: Ball, hand: HandSide, position: Vector3): void {
    ball.setHeld(hand);
    ball.mesh.position.copyFrom(position);
  }
}
