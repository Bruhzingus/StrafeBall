import { Vector3 } from '@babylonjs/core';
import { HandSide } from './BallState';
import { TUNING } from '../config/tuning';
import { lerp, safeNormalize } from '../utils/math';
import { backflipQteSpeed } from '../../../shared/simulation/ThrowMath';

export interface ThrowRequest {
  hand: HandSide;
  cameraForward: Vector3;
  playerVelocity: Vector3;
  charge01: number;
  isCrouching: boolean;
  isSliding: boolean;
  isWallRunning: boolean;
  isDashing: boolean;
  // Backflip landing QTE result: 0 = not a backflip throw, 1..5 = success tier (drives the speed
  // and marks the ball as a super/backflip throw so it renders yellow). Replaces the old timed
  // super-throw window.
  backflipTier: number;
  fastDoubleThrowPenalty: boolean;
}

export interface ThrowResult {
  velocity: Vector3;
  isSuper: boolean;
  // Gravity multiplier for the ball's first flight. Quick (tap) throws drop slightly,
  // charged/super throws fly straight. Blended by charge so partial charges drop less.
  dropScale: number;
  // Sustained sideways acceleration (world space) applied during flight for crouch curve
  // throws. Zero for normal throws.
  curveAccel: Vector3;
}

export class ThrowSystem {
  calculateThrow(request: ThrowRequest): ThrowResult {
    const forward = safeNormalize(request.cameraForward);
    const isBackflip = request.backflipTier >= 1;
    const charge01 = Math.max(0, Math.min(1, request.charge01));
    let baseSpeed = request.charge01 <= 0.05
      ? TUNING.ball.quickThrowSpeed
      : TUNING.ball.quickThrowSpeed + (TUNING.ball.chargedThrowSpeed - TUNING.ball.quickThrowSpeed) * charge01;

    if (request.isWallRunning) {
      baseSpeed *= 0.9;
    }

    if (request.isDashing) {
      baseSpeed = TUNING.ball.quickThrowSpeed;
    }

    if (request.fastDoubleThrowPenalty) {
      baseSpeed *= TUNING.ball.fastDoubleThrowPenalty;
    }

    // A backflip QTE throw ignores charge/penalties: its speed is set purely by the success tier
    // (tier 1 = a quick throw, top tier = 10% above the legacy super).
    if (isBackflip) {
      baseSpeed = backflipQteSpeed(request.backflipTier);
    }

    const movementBonus = request.playerVelocity.scale(TUNING.ball.movementThrowScale);
    let velocity = forward.scale(baseSpeed).add(movementBonus);

    // Crouch curve throw: a sustained sideways acceleration over the flight bends the path,
    // opposite the throwing hand (left hand curves right, right hand curves left). Cross(Up,
    // forward) is the camera's right vector; +sign = right.
    let curveAccel = Vector3.Zero();
    if (request.isCrouching) {
      const curveSign = request.hand === 'left' ? 1 : -1;
      const right = safeNormalize(Vector3.Cross(Vector3.Up(), forward));
      // Faster movement slightly amplifies the curve, rewarding movement chains.
      const movementCurveBoost = 1 + Math.min(0.5, request.playerVelocity.length() * 0.02);
      curveAccel = right.scale(curveSign * TUNING.ball.curveStrength * movementCurveBoost);
    }

    if (request.isSliding) {
      velocity = velocity.add(movementBonus.scale(0.25));
    }

    // Charged throws fly straight (dropScale -> chargedDropScale ~0); a quick tap drops
    // slightly (quickDropScale). Backflip throws are always straight regardless of charge.
    const dropScale = isBackflip
      ? TUNING.ball.chargedDropScale
      : lerp(TUNING.ball.quickDropScale, TUNING.ball.chargedDropScale, charge01);

    return {
      velocity,
      // A successful backflip throw is the "super" (golden) ball — yellow for player and opponent.
      isSuper: isBackflip,
      dropScale,
      curveAccel
    };
  }
}
