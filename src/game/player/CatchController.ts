import { FreeCamera, Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS } from '../../../shared/constants';
import type { Vec3 } from '../../../shared/types';
import { sweptCatchFailReason, sweptParryFailReason } from '../../../shared/simulation/HandSim';
import { TUNING } from '../config/tuning';
import { Ball } from '../ball/Ball';
import { BallManager } from '../ball/BallManager';
import { BallState, HandSide } from '../ball/BallState';
import { angleBetweenDegrees } from '../utils/math';
import { cameraForward } from '../utils/vector';
import { InputManager } from '../input/InputManager';
import { MOUSE_BUTTON } from '../config/controls';
import { practiceCheats } from '../config/practiceCheats';
import { HandController } from './HandController';
import { MovementController, MovementSnapshot } from './MovementController';
import { DashController } from './DashController';
import { Effects } from '../effects/Effects';

interface CatchAttempt {
  openedAtMs: number;
  activeUntilMs: number;
}

const LOCAL_PLAYER_ID = 'local';

export class CatchController {
  private trackingTimeByBall = new Map<number, number>();
  private catchAttempts = new Map<HandSide, CatchAttempt>();
  private parryCooldown = 0;
  private elapsedMs = 0;

  constructor(
    private readonly camera: FreeCamera,
    private readonly ballManager: BallManager,
    private readonly hands: HandController,
    private readonly movement: MovementController,
    private readonly dash: DashController,
    private readonly effects: Effects
  ) {}

  update(dt: number, input: InputManager, movement: MovementSnapshot): void {
    this.elapsedMs += dt * 1000;
    // Offline testing aid: no-cooldown clears the parry cooldown so parries can be spammed.
    this.parryCooldown = practiceCheats.noCooldown ? 0 : Math.max(0, this.parryCooldown - dt);

    const forward = cameraForward(this.camera);
    const threats = this.ballManager.getLiveThreatsToward(this.camera.globalPosition);
    this.updateTracking(dt, movement, forward, threats);
    this.openCatchAttempt(input, movement, 'left', MOUSE_BUTTON.leftHand);
    this.openCatchAttempt(input, movement, 'right', MOUSE_BUTTON.rightHand);
    this.tryAutoParry(dt, movement, forward, threats);
    this.tryResolveCatchAttempts(dt, movement, forward);
    this.expireCatchAttempts();
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

  private openCatchAttempt(input: InputManager, movement: MovementSnapshot, side: HandSide, button: number): void {
    if (!input.pointerLocked || !input.wasMousePressed(button)) return;

    const hand = this.hands.getHand(side);
    if (hand.ball || hand.cooldown > 0 || movement.dashingThisFrame) return;

    this.catchAttempts.set(side, {
      openedAtMs: this.elapsedMs,
      activeUntilMs: this.elapsedMs + GAME_CONSTANTS.combat.catchStartupMs + GAME_CONSTANTS.combat.catchActiveMs
    });
    hand.cooldown = Math.max(hand.cooldown, GAME_CONSTANTS.combat.catchCooldownMs / 1000);
    this.hands.playCatchAttemptAnimation(side);
    this.effects.onCatchAttempt(side);
  }

  private tryResolveCatchAttempts(dt: number, movement: MovementSnapshot, forward: Vector3): void {
    if (this.catchAttempts.size === 0) return;

    const origin = this.camera.globalPosition;
    for (const [side, attempt] of this.catchAttempts) {
      const hand = this.hands.getHand(side);
      if (hand.ball) {
        this.catchAttempts.delete(side);
        continue;
      }

      const candidate = this.findCatchCandidate(dt, side, attempt, movement, origin, forward);
      if (!candidate) continue;

      this.hands.forceCatchBall(side, candidate);
      this.movement.addCatchRecoil(candidate.velocity);
      this.movement.addCatchBoost();
      this.dash.addChargeFromHit();
      this.trackingTimeByBall.delete(candidate.id);
      this.catchAttempts.delete(side);
      this.effects.onCatch();
    }
  }

  private tryAutoParry(dt: number, movement: MovementSnapshot, forward: Vector3, threats: Ball[]): void {
    if (!this.hands.hasTwoBalls() || this.parryCooldown > 0) return;

    const origin = this.camera.globalPosition;
    for (const ball of threats) {
      const curr = ball.mesh.position;
      const prev = previousBallPosition(ball, dt);
      const fail = sweptParryFailReason({
        heldBallCount: this.hands.heldBallCount(),
        parryCooldownSeconds: this.parryCooldown,
        defenderPlayerId: LOCAL_PLAYER_ID,
        ball: toSharedBall(ball),
        origin: toSharedVec3(origin),
        forward: toSharedVec3(forward),
        segmentStart: toSharedVec3(prev),
        segmentEnd: toSharedVec3(curr)
      });
      if (fail) continue;

      const wasSuper = ball.isSuper;
      const incomingSpeed = ball.velocity.length();
      ball.makeDead();
      ball.velocity = forward
        .scale(incomingSpeed * TUNING.parry.deflectSpeedMultiplier)
        .add(new Vector3(0, TUNING.parry.deflectUpVelocity, 0));
      ball.state = BallState.Dead;
      this.parryCooldown = TUNING.parry.cooldownSeconds;
      this.hands.playParryAnimation();
      this.effects.onParry(incomingSpeed, ball.mesh.position);

      if (wasSuper) {
        this.hands.dropOneBall(movement.position);
      }
      return;
    }
  }

  private findCatchCandidate(
    dt: number,
    side: HandSide,
    attempt: CatchAttempt,
    movement: MovementSnapshot,
    origin: Vector3,
    forward: Vector3
  ): Ball | null {
    let best: Ball | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const ball of this.ballManager.balls) {
      const curr = ball.mesh.position;
      const prev = previousBallPosition(ball, dt);
      const fail = sweptCatchFailReason({
        handEmpty: !this.hands.getHand(side).ball,
        handCooldownSeconds: 0,
        dashing: movement.dashingThisFrame,
        defenderPlayerId: LOCAL_PLAYER_ID,
        ball: toSharedBall(ball),
        origin: toSharedVec3(origin),
        forward: toSharedVec3(forward),
        segmentStart: toSharedVec3(prev),
        segmentEnd: toSharedVec3(curr),
        timing: {
          nowMs: this.elapsedMs,
          openedAtMs: attempt.openedAtMs,
          startupMs: GAME_CONSTANTS.combat.catchStartupMs,
          activeUntilMs: attempt.activeUntilMs
        }
      });
      if (fail) continue;

      const distance = Vector3.Distance(origin, curr);
      if (distance < bestDistance) {
        best = ball;
        bestDistance = distance;
      }
    }

    return best;
  }

  private expireCatchAttempts(): void {
    for (const [side, attempt] of this.catchAttempts) {
      if (this.elapsedMs > attempt.activeUntilMs) this.catchAttempts.delete(side);
    }
  }
}

function previousBallPosition(ball: Ball, dt: number): Vector3 {
  const curr = ball.mesh.position;
  return new Vector3(
    curr.x - ball.velocity.x * dt,
    curr.y - ball.velocity.y * dt,
    curr.z - ball.velocity.z * dt
  );
}

function toSharedVec3(v: Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function toSharedBall(ball: Ball): {
  phase: 'loose' | 'held' | 'live' | 'dead';
  velocity: Vec3;
  bounceCount: number;
  ownerId: string | null;
  isSuper: boolean;
} {
  return {
    phase: toSharedPhase(ball.state),
    velocity: toSharedVec3(ball.velocity),
    bounceCount: ball.bounceCount,
    ownerId: ball.owner === 'player' ? LOCAL_PLAYER_ID : null,
    isSuper: ball.isSuper
  };
}

function toSharedPhase(state: BallState): 'loose' | 'held' | 'live' | 'dead' {
  switch (state) {
    case BallState.Held:
      return 'held';
    case BallState.Live:
      return 'live';
    case BallState.Dead:
      return 'dead';
    case BallState.Loose:
    default:
      return 'loose';
  }
}
