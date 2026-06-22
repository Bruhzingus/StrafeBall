import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { BallPhase, BallState, HandSide, Vec3, ValidationResult } from '../types';
import {
  add,
  cloneVec3,
  distance,
  distXZ,
  length,
  normalize,
  scale,
  vec3
} from './CollisionMath';

export interface ThrowBallRequest {
  playerId: string;
  hand: HandSide;
  origin: Vec3;
  velocity: Vec3;
  ownerKind?: 'player' | 'launcher' | 'bot';
  isSuper?: boolean;
  dropScale?: number;
  curveAccel?: Vec3;
  /** Fresh throw identity assigned by the server (see BallState.throwId). */
  throwId?: number;
}

export type ThrowValidationReason = 'ball-not-held' | 'wrong-player' | 'wrong-hand';

export function createBallState(id: string, position: Vec3 = vec3(), overrides: Partial<BallState> = {}): BallState {
  const base: BallState = {
    id,
    phase: 'loose',
    position: cloneVec3(position),
    velocity: vec3(),
    ownerKind: null,
    ownerId: null,
    heldByPlayerId: null,
    heldHand: null,
    bounceCount: 0,
    isSuper: false,
    dropScale: 1,
    curveAccel: vec3(),
    curveDistance: 0,
    lastTouchedByPlayerId: null,
    throwId: 0
  };

  return {
    ...base,
    ...overrides,
    id,
    position: cloneVec3(overrides.position ?? position),
    velocity: cloneVec3(overrides.velocity ?? base.velocity),
    curveAccel: cloneVec3(overrides.curveAccel ?? base.curveAccel)
  };
}

export function isBallPickupStateEligible(
  ball: Pick<BallState, 'phase' | 'velocity'> | { phase: BallPhase | string; velocity: Vec3 },
  constants: GameConstants = GAME_CONSTANTS
): boolean {
  if (ball.phase === 'held') return false;
  if (ball.phase === 'loose' || ball.phase === 'dead') return true;
  return length(ball.velocity) <= constants.ball.slowPickupSpeed;
}

/**
 * Whether a ball is in a CATCHABLE in-flight state. A 'live' or 'deflected' ball is always catchable.
 * A ball that has bounced (off floor/back-wall/bleachers) is marked 'dead' — it can no longer score
 * a hit — but while it is still moving fast enough to be airborne/playable, it stays catchable no
 * matter how many times it has bounced. This does NOT affect scoring: a dead ball never scores
 * regardless (see canScorePlayerHit).
 */
export function isBallCatchableInFlight(
  ball: Pick<BallState, 'phase' | 'velocity' | 'bounceCount'>,
  constants: GameConstants = GAME_CONSTANTS
): boolean {
  if (ball.phase === 'live' || ball.phase === 'deflected') return true;
  if (ball.phase !== 'dead') return false;
  return (
    length(ball.velocity) >= constants.catch.bouncedCatchMinSpeed
  );
}

export function isBallPickupEligible(
  ball: Pick<BallState, 'phase' | 'position' | 'velocity'>,
  playerPosition: Vec3,
  constants: GameConstants = GAME_CONSTANTS
): boolean {
  if (!isBallPickupStateEligible(ball, constants)) return false;
  // Use XZ + vertical separately: a ball at the player's feet on the floor should be
  // reachable even if the 3D distance is inflated by height difference, and a ball at
  // the same XZ but far above should not be reachable via floor pickup.
  if (distXZ(ball.position, playerPosition) > constants.ball.pickupRadius) return false;
  if (Math.abs(ball.position.y - playerPosition.y) > constants.ball.pickupVerticalTolerance) return false;
  return true;
}

export function holdBall(ball: BallState, playerId: string, hand: HandSide): BallState {
  return {
    ...ball,
    phase: 'held',
    velocity: vec3(),
    ownerKind: 'player',
    ownerId: playerId,
    heldByPlayerId: playerId,
    heldHand: hand,
    bounceCount: 0,
    isSuper: false,
    dropScale: 1,
    curveAccel: vec3(),
    curveDistance: 0,
    lastTouchedByPlayerId: playerId
  };
}

export function markBallDead(ball: BallState, velocity: Vec3 = ball.velocity): BallState {
  return {
    ...ball,
    phase: 'dead',
    velocity: cloneVec3(velocity),
    ownerKind: null,
    ownerId: null,
    heldByPlayerId: null,
    heldHand: null,
    isSuper: false
  };
}

export function dropHeldBall(ball: BallState, position: Vec3, velocity: Vec3 = vec3(0, -1.4, 0)): BallState {
  return {
    ...markBallDead(ball, velocity),
    position: cloneVec3(position),
    bounceCount: 1
  };
}

export function validateThrowBall(ball: BallState, playerId: string, hand: HandSide): ValidationResult<ThrowValidationReason> {
  if (ball.phase !== 'held') return { ok: false, reason: 'ball-not-held' };
  if (ball.heldByPlayerId !== playerId) return { ok: false, reason: 'wrong-player' };
  if (ball.heldHand !== hand) return { ok: false, reason: 'wrong-hand' };
  return { ok: true };
}

export function throwHeldBall(ball: BallState, request: ThrowBallRequest): { ok: true; ball: BallState } | { ok: false; reason: ThrowValidationReason } {
  const validation = validateThrowBall(ball, request.playerId, request.hand);
  if (!validation.ok) return validation;

  return {
    ok: true,
    ball: {
      ...ball,
      phase: 'live',
      position: cloneVec3(request.origin),
      velocity: cloneVec3(request.velocity),
      ownerKind: request.ownerKind ?? 'player',
      ownerId: request.playerId,
      heldByPlayerId: null,
      heldHand: null,
      bounceCount: 0,
      isSuper: request.isSuper ?? false,
      dropScale: request.dropScale ?? 1,
      curveAccel: cloneVec3(request.curveAccel ?? vec3()),
      curveDistance: 0,
      lastTouchedByPlayerId: request.playerId,
      throwId: request.throwId ?? ball.throwId
    }
  };
}

export function catchBall(ball: BallState, playerId: string, hand: HandSide): BallState {
  return holdBall(ball, playerId, hand);
}

export function deflectBall(ball: BallState, defenderPlayerId: string, forward: Vec3, constants: GameConstants = GAME_CONSTANTS, throwId?: number): BallState {
  const incomingSpeed = length(ball.velocity);
  const deflectForward = normalize(forward, vec3(0, 0, 1));
  const deflectedVelocity = add(
    scale(deflectForward, incomingSpeed * constants.parry.deflectSpeedMultiplier),
    vec3(0, constants.parry.deflectUpVelocity, 0)
  );

  return {
    ...ball,
    phase: 'deflected',
    velocity: deflectedVelocity,
    ownerKind: 'player',
    ownerId: defenderPlayerId,
    heldByPlayerId: null,
    heldHand: null,
    bounceCount: 0,
    isSuper: false,
    curveAccel: vec3(),
    curveDistance: 0,
    lastTouchedByPlayerId: defenderPlayerId,
    // A deflect is a new live identity — bump throwId so the client snaps its prediction.
    throwId: throwId ?? ball.throwId
  };
}

/**
 * Per-room override for how many bounces a live/deflected ball survives. Sourced from the host
 * setting `maxLiveBallBounces` (see roomSettings.ts) so the bounce rule is settings-driven instead of
 * hardcoded to the GAME_CONSTANTS value. When omitted, the constants are used (offline / legacy).
 */
export interface BounceRule {
  deadAfterBounces: number;
  deflectedDeadAfterBounces: number;
}

export function applyBallBounce(
  ball: BallState,
  bounceRule?: BounceRule,
  constants: GameConstants = GAME_CONSTANTS
): BallState {
  if (ball.phase !== 'live' && ball.phase !== 'deflected') {
    return { ...ball, bounceCount: ball.bounceCount + 1 };
  }

  const bounceCount = ball.bounceCount + 1;
  const deadAfterBounces = ball.phase === 'deflected'
    ? bounceRule?.deflectedDeadAfterBounces ?? constants.ball.deflectedDeadAfterBounces
    : bounceRule?.deadAfterBounces ?? constants.ball.deadAfterBounces;

  if (bounceCount >= deadAfterBounces) {
    return {
      ...markBallDead(ball),
      bounceCount
    };
  }

  return {
    ...ball,
    bounceCount
  };
}

/**
 * Bounce off a mat (standing cover OR a knocked-over mat lying flat). A mat reflects the ball but
 * NEVER kills it: a live ball stays live (a deflected ball stays deflected), so it can still score
 * and be caught. A mat is the ONLY surface that keeps a ball alive after a floor-level bounce —
 * every other surface (floor, back walls, bleachers) still kills via applyBallBounce. bounceCount is
 * incremented so the throw's first-flight curve/drop ends and impact effects fire, but the phase is
 * intentionally left untouched.
 */
export function applyMatBounce(ball: BallState): BallState {
  return { ...ball, bounceCount: ball.bounceCount + 1 };
}

export function settleBallIfSlow(ball: BallState, constants: GameConstants = GAME_CONSTANTS): BallState {
  if (ball.phase !== 'dead' || length(ball.velocity) >= constants.ball.settleSpeed) return ball;
  return {
    ...ball,
    phase: 'loose',
    velocity: vec3(),
    ownerKind: null,
    ownerId: null,
    heldByPlayerId: null,
    heldHand: null,
    isSuper: false
  };
}

/**
 * Smooth 0→1 ramp for the crouch curve: flat zero until `curveStartDistance` meters into the
 * flight, then a smoothstep rise to full strength over the next `curveRampDistance` meters. Short
 * ramp distance = a sharp snap into the curve; longer = a gentler build-up.
 */
export function curveRampFactor(distanceTraveled: number, constants: GameConstants): number {
  const { curveStartDistance, curveRampDistance } = constants.ball;
  const t = Math.max(0, Math.min(1, (distanceTraveled - curveStartDistance) / curveRampDistance));
  return t * t * (3 - 2 * t);
}

export function advanceBall(ball: BallState, dt: number, constants: GameConstants = GAME_CONSTANTS): BallState {
  if (ball.phase !== 'live' && ball.phase !== 'dead' && ball.phase !== 'loose' && ball.phase !== 'deflected') return ball;

  const firstLiveFlight = ball.phase === 'live' && ball.bounceCount === 0;
  const gravityScale = firstLiveFlight ? ball.dropScale : 1;
  const velocityWithGravity = add(ball.velocity, vec3(0, -constants.ball.gravity * gravityScale * dt, 0));
  const rampFactor = firstLiveFlight ? curveRampFactor(ball.curveDistance, constants) : 0;
  let velocity = firstLiveFlight
    ? add(velocityWithGravity, scale(ball.curveAccel, rampFactor * dt))
    : velocityWithGravity;

  // Apply floor friction to dead/loose balls resting on or near the ground so they don't
  // slide forever. Only damp the XZ plane when the ball is on the floor (y ≈ radius).
  if ((ball.phase === 'dead' || ball.phase === 'loose') && ball.position.y <= constants.ball.radius + 0.05) {
    const friction = constants.ball.looseFriction;
    const frictionFactor = Math.max(0, 1 - friction * dt);
    velocity = vec3(velocity.x * frictionFactor, velocity.y, velocity.z * frictionFactor);
  }

  return {
    ...ball,
    velocity,
    position: add(ball.position, scale(velocity, dt)),
    curveDistance: firstLiveFlight ? ball.curveDistance + length(scale(velocity, dt)) : ball.curveDistance
  };
}
