import { FreeCamera, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { Ball } from '../ball/Ball';
import { BallManager } from '../ball/BallManager';
import { BallState, HandSide } from '../ball/BallState';
import { angleBetweenDegrees } from '../utils/math';
import { cameraForward } from '../utils/vector';
import { InputManager } from '../input/InputManager';
import { MOUSE_BUTTON } from '../config/controls';
import { HandController } from './HandController';
import { MovementController, MovementSnapshot } from './MovementController';
import { Effects } from '../effects/Effects';

export class CatchController {
  private trackingTimeByBall = new Map<number, number>();
  private parryCooldown = 0;

  constructor(
    private readonly camera: FreeCamera,
    private readonly ballManager: BallManager,
    private readonly hands: HandController,
    private readonly movement: MovementController,
    private readonly effects: Effects
  ) {}

  update(dt: number, input: InputManager, movement: MovementSnapshot): void {
    this.parryCooldown = Math.max(0, this.parryCooldown - dt);
    // Compute the forward ray and live-threat list once per frame and share them with both
    // tracking and the auto-parry (previously each recomputed both — a Ray + a filtered array
    // every frame, twice).
    const forward = cameraForward(this.camera);
    const threats = this.ballManager.getLiveThreatsToward(this.camera.globalPosition);
    this.updateTracking(dt, movement, forward, threats);
    this.tryAutoParry(dt, movement, forward, threats);
    this.tryManualCatch(dt, input, movement, 'left', MOUSE_BUTTON.leftHand);
    this.tryManualCatch(dt, input, movement, 'right', MOUSE_BUTTON.rightHand);
  }

  getDebugTrackingTime(): number {
    let best = 0;
    for (const value of this.trackingTimeByBall.values()) best = Math.max(best, value);
    return best;
  }

  getParryCooldown(): number {
    return this.parryCooldown;
  }

  private updateTracking(dt: number, movement: MovementSnapshot, forward: Vector3, threats: Ball[]): void {
    const seen = new Set<number>();

    for (const ball of threats) {
      const toBall = ball.mesh.position.subtract(this.camera.globalPosition);
      const angle = angleBetweenDegrees(forward, toBall);
      if (angle <= TUNING.catch.coneDegrees) {
        const previous = this.trackingTimeByBall.get(ball.id) ?? 0;
        this.trackingTimeByBall.set(ball.id, previous + dt);
        seen.add(ball.id);
      }
    }

    for (const id of this.trackingTimeByBall.keys()) {
      if (!seen.has(id)) this.trackingTimeByBall.delete(id);
    }

    if (movement.dashingThisFrame) {
      this.trackingTimeByBall.clear();
    }
  }

  private tryManualCatch(dt: number, input: InputManager, movement: MovementSnapshot, side: HandSide, button: number): void {
    if (!input.pointerLocked) return;
    const hand = this.hands.getHand(side);
    if (hand.ball || hand.cooldown > 0 || movement.dashingThisFrame) return;
    // Press edge only. Previously this also fired on the RELEASE edge, so the release frame of
    // a throw (which empties the hand) doubled as a catch input — auto-catching your own throw
    // and stamping a spurious catch cooldown on whiffs. A catch is a deliberate click.
    if (!input.wasMousePressed(button)) return;

    const candidate = this.findCatchCandidate(dt, false);
    if (!candidate) {
      this.hands.setCooldown(side, TUNING.catch.cooldownSeconds);
      return;
    }

    this.hands.forceCatchBall(side, candidate);
    this.movement.addCatchBoost();
    this.trackingTimeByBall.delete(candidate.id);
    this.effects.onCatch();
  }

  private tryAutoParry(dt: number, movement: MovementSnapshot, forward: Vector3, threats: Ball[]): void {
    if (!this.hands.hasTwoBalls() || this.parryCooldown > 0) return;

    const origin = this.camera.globalPosition;
    for (const ball of threats) {
      // Test the ball's swept path this frame, not just its current point. A fast throw can cross the
      // parry cone between two frames without ever landing inside it on a frame boundary; reconstruct
      // the previous position (curr − velocity·dt) and check the closest approach of that segment.
      // This mirrors the server's swept parry and is what makes parries land consistently.
      const curr = ball.mesh.position;
      const prev = new Vector3(
        curr.x - ball.velocity.x * dt,
        curr.y - ball.velocity.y * dt,
        curr.z - ball.velocity.z * dt
      );
      const closest = closestApproach(prev, curr, origin);
      const toBall = closest.subtract(origin);
      const distance = toBall.length();
      if (distance > TUNING.parry.rangeMeters) continue;

      const requiredAngle = ball.isSuper ? TUNING.catch.superParryConeDegrees : TUNING.parry.coneDegrees;
      const angle = angleBetweenDegrees(forward, toBall);
      if (angle > requiredAngle) continue;

      const wasSuper = ball.isSuper;
      const incomingSpeed = ball.velocity.length();
      ball.makeDead();
      ball.velocity = forward.scale(incomingSpeed * TUNING.parry.deflectSpeedMultiplier).add(new Vector3(0, 1.5, 0));
      ball.state = BallState.Dead;
      this.parryCooldown = TUNING.parry.cooldownSeconds;
      this.effects.onParry();

      if (wasSuper) {
        this.hands.dropOneBall(movement.position);
      }
      return;
    }
  }

  private findCatchCandidate(dt: number, allowDead: boolean): Ball | null {
    let best: Ball | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const forward = cameraForward(this.camera);
    const origin = this.camera.globalPosition;

    for (const ball of this.ballManager.balls) {
      // Catchable = a Live ball, OR a freshly-bounced (Dead, ≤1 bounce, still fast) ball you can
      // pluck out of the air. Matches the server's isBallCatchableInFlight so online + offline agree.
      const catchable = ball.state === BallState.Live || this.isBouncedCatchable(ball);
      if (!catchable && !(allowDead && ball.state === BallState.Dead)) continue;
      const tracked = this.trackingTimeByBall.get(ball.id) ?? 0;
      if (tracked < TUNING.catch.trackingSeconds) continue;
      // Test the ball's swept path this frame, not just its current point — a fast throw can cross
      // your catch cone between two frames without ever sitting inside it on a frame boundary, which
      // made fast-ball catches whiff. Evaluate the closest approach of (prev → curr), same as parry
      // and the server's swept catch check.
      const curr = ball.mesh.position;
      const prev = new Vector3(
        curr.x - ball.velocity.x * dt,
        curr.y - ball.velocity.y * dt,
        curr.z - ball.velocity.z * dt
      );
      const closest = closestApproach(prev, curr, origin);
      const toBall = closest.subtract(origin);
      const distance = toBall.length();
      if (distance > TUNING.catch.rangeMeters || distance > bestDistance) continue;
      // Must actually be looking at it (cone gate — same skill requirement as a live catch).
      if (angleBetweenDegrees(forward, toBall) > TUNING.catch.coneDegrees) continue;
      best = ball;
      bestDistance = distance;
    }

    return best;
  }

  /** A Dead ball that just bounced once and is still moving fast is still catchable in the air. */
  private isBouncedCatchable(ball: Ball): boolean {
    return (
      ball.state === BallState.Dead &&
      ball.bounceCount <= TUNING.catch.bouncedCatchMaxBounces &&
      ball.velocity.length() >= TUNING.catch.bouncedCatchMinSpeed
    );
  }
}

/**
 * Closest point on the segment [a, b] to point p — the ball's nearest approach to the eye along its
 * path this frame. Used so a fast ball that crosses the parry cone between frames is still evaluated
 * at the instant it was closest, instead of only at its current (possibly already-past) position.
 */
function closestApproach(a: Vector3, b: Vector3, p: Vector3): Vector3 {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq <= 1e-10) return a.clone();
  const t = Math.max(0, Math.min(1,
    ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / abLenSq
  ));
  return new Vector3(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}
