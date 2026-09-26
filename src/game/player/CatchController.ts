import { FreeCamera, Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS } from '../../../shared/constants';
import type { BallState as SharedBallState, Vec3 } from '../../../shared/types';
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
  private frameDefense: { movement: MovementSnapshot; origin: Vector3; forward: Vector3 } | null = null;
  private resolvedDefenseThisFrame = false;

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
    this.frameDefense = { movement, origin: this.camera.globalPosition.clone(), forward };
    this.resolvedDefenseThisFrame = false;
    const threats = this.ballManager.getLiveThreatsToward(this.camera.globalPosition);
    this.updateTracking(dt, movement, forward, threats);
    this.expireCatchAttempts();
    this.openCatchAttempt(input, movement, 'left', MOUSE_BUTTON.leftHand);
    this.openCatchAttempt(input, movement, 'right', MOUSE_BUTTON.rightHand);
  }

  /** Called by BallManager on the integrated path, before this ball resolves a wall or mat contact. */
  resolveAdvancedBall(ball: Ball, segmentStart: Vector3, segmentEnd: Vector3): void {
    const defense = this.frameDefense;
    if (!defense) return;
    // Match server order: the same swept segment gets auto-parry first, then each open catch hand.
    if (this.tryAutoParry(ball, segmentStart, segmentEnd, defense)) return;
    this.tryResolveCatchAttempt(ball, segmentStart, segmentEnd, defense);
  }

  /** A catch window persists across frames, but aim/movement must be supplied by this frame's input. */
  finishBallUpdate(): boolean {
    const resolved = this.resolvedDefenseThisFrame;
    this.frameDefense = null;
    this.resolvedDefenseThisFrame = false;
    return resolved;
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

  private tryResolveCatchAttempt(
    ball: Ball,
    segmentStart: Vector3,
    segmentEnd: Vector3,
    defense: { movement: MovementSnapshot; origin: Vector3; forward: Vector3 }
  ): void {
    if (this.catchAttempts.size === 0) return;

    for (const [side, attempt] of this.catchAttempts) {
      const hand = this.hands.getHand(side);
      if (hand.ball) {
        this.catchAttempts.delete(side);
        continue;
      }

      const fail = sweptCatchFailReason({
        handEmpty: true,
        handCooldownSeconds: 0,
        dashing: defense.movement.dashingThisFrame,
        defenderPlayerId: LOCAL_PLAYER_ID,
        ball: toSharedBall(ball),
        origin: toSharedVec3(defense.origin),
        forward: toSharedVec3(defense.forward),
        segmentStart: toSharedVec3(segmentStart),
        segmentEnd: toSharedVec3(segmentEnd),
        timing: {
          nowMs: this.elapsedMs,
          openedAtMs: attempt.openedAtMs,
          startupMs: GAME_CONSTANTS.combat.catchStartupMs,
          activeUntilMs: attempt.activeUntilMs
        }
      });
      if (fail) continue;

      // setHeld zeroes velocity; retain the incoming speed for the same recoil used online.
      const incomingVelocity = ball.velocity.clone();
      this.hands.forceCatchBall(side, ball);
      this.movement.addCatchRecoil(incomingVelocity);
      this.movement.addCatchBoost();
      this.dash.addChargeFromHit();
      this.trackingTimeByBall.delete(ball.id);
      this.catchAttempts.delete(side);
      this.effects.onCatch(incomingVelocity.length());
      this.resolvedDefenseThisFrame = true;
      return;
    }
  }

  private tryAutoParry(
    ball: Ball,
    segmentStart: Vector3,
    segmentEnd: Vector3,
    defense: { movement: MovementSnapshot; origin: Vector3; forward: Vector3 }
  ): boolean {
    if (!this.hands.hasTwoBalls() || this.parryCooldown > 0) return false;

    const fail = sweptParryFailReason({
      heldBallCount: this.hands.heldBallCount(),
      parryCooldownSeconds: this.parryCooldown,
      defenderPlayerId: LOCAL_PLAYER_ID,
      ball: toSharedBall(ball),
      origin: toSharedVec3(defense.origin),
      forward: toSharedVec3(defense.forward),
      segmentStart: toSharedVec3(segmentStart),
      segmentEnd: toSharedVec3(segmentEnd)
    });
    if (fail) return false;

    const wasSuper = ball.isSuper;
    const incomingSpeed = ball.velocity.length();
    ball.makeDead();
    ball.velocity = defense.forward
      .scale(incomingSpeed * TUNING.parry.deflectSpeedMultiplier)
      .add(new Vector3(0, TUNING.parry.deflectUpVelocity, 0));
    ball.state = BallState.Dead;
    this.parryCooldown = TUNING.parry.cooldownSeconds;
    this.hands.playParryAnimation();
    this.effects.onParry(incomingSpeed, ball.mesh.position);

    if (wasSuper) this.hands.dropOneBall(defense.movement.position);
    this.resolvedDefenseThisFrame = true;
    return true;
  }

  private expireCatchAttempts(): void {
    for (const [side, attempt] of this.catchAttempts) {
      if (this.elapsedMs > attempt.activeUntilMs) this.catchAttempts.delete(side);
    }
  }
}

function toSharedVec3(v: Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function toSharedBall(ball: Ball): Pick<SharedBallState, 'phase' | 'velocity' | 'bounceCount' | 'ownerId' | 'kind' | 'armedAtMs' | 'isSuper'> {
  return {
    phase: toSharedPhase(ball.state),
    velocity: toSharedVec3(ball.velocity),
    bounceCount: ball.bounceCount,
    ownerId: ball.owner === 'player' ? LOCAL_PLAYER_ID : null,
    isSuper: ball.isSuper,
    kind: ball.powerupKind ?? 'normal',
    armedAtMs: ball.armedAtMs
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
