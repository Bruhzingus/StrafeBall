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

export class CatchController {
  private trackingTimeByBall = new Map<number, number>();
  private parryCooldown = 0;

  constructor(
    private readonly camera: FreeCamera,
    private readonly ballManager: BallManager,
    private readonly hands: HandController,
    private readonly movement: MovementController
  ) {}

  update(dt: number, input: InputManager, movement: MovementSnapshot): void {
    this.parryCooldown = Math.max(0, this.parryCooldown - dt);
    // Compute the forward ray and live-threat list once per frame and share them with both
    // tracking and the auto-parry (previously each recomputed both — a Ray + a filtered array
    // every frame, twice).
    const forward = cameraForward(this.camera);
    const threats = this.ballManager.getLiveThreatsToward(this.camera.globalPosition);
    this.updateTracking(dt, movement, forward, threats);
    this.tryAutoParry(movement, forward, threats);
    this.tryManualCatch(input, movement, 'left', MOUSE_BUTTON.leftHand);
    this.tryManualCatch(input, movement, 'right', MOUSE_BUTTON.rightHand);
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

  private tryManualCatch(input: InputManager, movement: MovementSnapshot, side: HandSide, button: number): void {
    if (!input.pointerLocked) return;
    const hand = this.hands.getHand(side);
    if (hand.ball || hand.cooldown > 0 || movement.dashingThisFrame) return;
    // Press edge only. Previously this also fired on the RELEASE edge, so the release frame of
    // a throw (which empties the hand) doubled as a catch input — auto-catching your own throw
    // and stamping a spurious catch cooldown on whiffs. A catch is a deliberate click.
    if (!input.wasMousePressed(button)) return;

    const candidate = this.findCatchCandidate(false);
    if (!candidate) {
      this.hands.setCooldown(side, TUNING.catch.cooldownSeconds);
      return;
    }

    this.hands.forceCatchBall(side, candidate);
    this.movement.addCatchBoost();
    this.trackingTimeByBall.delete(candidate.id);
  }

  private tryAutoParry(movement: MovementSnapshot, forward: Vector3, threats: Ball[]): void {
    if (!this.hands.hasTwoBalls() || this.parryCooldown > 0) return;

    for (const ball of threats) {
      const toBall = ball.mesh.position.subtract(this.camera.globalPosition);
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

      if (wasSuper) {
        this.hands.dropOneBall(movement.position);
      }
      return;
    }
  }

  private findCatchCandidate(allowDead: boolean): Ball | null {
    let best: Ball | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const ball of this.ballManager.balls) {
      if (ball.state !== BallState.Live && !(allowDead && ball.state === BallState.Dead)) continue;
      const tracked = this.trackingTimeByBall.get(ball.id) ?? 0;
      if (tracked < TUNING.catch.trackingSeconds) continue;
      const distance = Vector3.Distance(this.camera.globalPosition, ball.mesh.position);
      if (distance > TUNING.catch.rangeMeters || distance > bestDistance) continue;
      best = ball;
      bestDistance = distance;
    }

    return best;
  }
}
