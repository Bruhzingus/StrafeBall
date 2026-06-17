import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { BallState, HandSide, HandState, PlayerHandsState, PlayerState, Vec3, ValidationResult } from '../types';
import { catchBall, deflectBall, dropHeldBall, holdBall, isBallCatchableInFlight, isBallPickupEligible, throwHeldBall, type ThrowBallRequest } from './BallSim';
import { closestPointOnSegment, distance, cloneVec3, isWithinCone, normalize, sweptSegmentInCone, vec3 } from './CollisionMath';

export type PickupValidationReason = 'hands-full' | 'ball-not-pickup-eligible';
export type ThrowHandValidationReason = 'empty-hand' | 'hand-ball-mismatch' | 'ball-not-held' | 'wrong-player' | 'wrong-hand';
export type CatchValidationReason = 'hand-full' | 'catch-cooldown' | 'not-live' | 'outside-catch-cone';
export type ParryValidationReason = 'hands-not-full' | 'parry-cooldown' | 'not-live' | 'outside-parry-cone';
export type SweptCatchFailReason =
  | 'no-empty-hand'
  | 'dashing'
  | 'ball-not-live'
  | 'out-of-range'
  | 'angle-too-wide'
  | 'too-early'
  | 'too-late'
  | 'catch-cooldown'
  | 'owner-invalid';
export type SweptParryFailReason =
  | 'no-two-balls'
  | 'parry-cooldown'
  | 'ball-not-live'
  | 'owner-invalid'
  | 'out-of-range'
  | 'angle-too-wide';

export interface SweptCatchRequest {
  handEmpty: boolean;
  handCooldownSeconds?: number;
  dashing: boolean;
  defenderPlayerId?: string | null;
  ball: Pick<BallState, 'phase' | 'velocity' | 'bounceCount' | 'ownerId'>;
  origin: Vec3;
  forward: Vec3;
  segmentStart: Vec3;
  segmentEnd: Vec3;
  timing?: {
    nowMs: number;
    openedAtMs: number;
    startupMs: number;
    activeUntilMs: number;
  };
}

export interface SweptParryRequest {
  heldBallCount: number;
  parryCooldownSeconds: number;
  defenderPlayerId?: string | null;
  ball: Pick<BallState, 'phase' | 'isSuper' | 'ownerId'>;
  origin: Vec3;
  forward: Vec3;
  segmentStart: Vec3;
  segmentEnd: Vec3;
}

export interface PickupResult {
  ok: true;
  hand: HandSide;
  hands: PlayerHandsState;
  ball: BallState;
}

export interface ThrowFromHandResult {
  ok: true;
  hands: PlayerHandsState;
  ball: BallState;
}

export interface DropFromHandResult {
  ok: true;
  hands: PlayerHandsState;
  ball: BallState;
}

export interface CatchResult {
  ok: true;
  hands: PlayerHandsState;
  ball: BallState;
}

export interface AutoParryResult {
  ok: true;
  ball: BallState;
  parryCooldownSeconds: number;
}

export function createHandState(side: HandSide, overrides: Partial<HandState> = {}): HandState {
  return {
    side,
    heldBallId: null,
    mode: 'empty',
    chargeSeconds: 0,
    cooldownSeconds: 0,
    catchTrackingSecondsByBallId: {},
    lastCatchAttemptId: 0,
    ...overrides
  };
}

export function createHands(overrides: Partial<PlayerHandsState> = {}): PlayerHandsState {
  return {
    left: overrides.left ?? createHandState('left'),
    right: overrides.right ?? createHandState('right')
  };
}

export function heldBallCount(hands: PlayerHandsState): number {
  return (hands.left.heldBallId ? 1 : 0) + (hands.right.heldBallId ? 1 : 0);
}

export function getFirstOpenHand(hands: PlayerHandsState): HandSide | null {
  if (!hands.left.heldBallId) return 'left';
  if (!hands.right.heldBallId) return 'right';
  return null;
}

export function validatePickup(player: PlayerState, hands: PlayerHandsState, ball: BallState, constants: GameConstants = GAME_CONSTANTS): ValidationResult<PickupValidationReason> {
  if (heldBallCount(hands) >= constants.ball.maxHeldBalls) return { ok: false, reason: 'hands-full' };
  if (!isBallPickupEligible(ball, player.movement.position, constants)) return { ok: false, reason: 'ball-not-pickup-eligible' };
  return { ok: true };
}

export function tryPickupBall(
  player: PlayerState,
  hands: PlayerHandsState,
  ball: BallState,
  constants: GameConstants = GAME_CONSTANTS
): PickupResult | { ok: false; reason: PickupValidationReason } {
  const validation = validatePickup(player, hands, ball, constants);
  if (!validation.ok) return validation;

  const side = getFirstOpenHand(hands);
  if (!side) return { ok: false, reason: 'hands-full' };

  return {
    ok: true,
    hand: side,
    hands: setHandHolding(hands, side, ball.id),
    ball: holdBall(ball, player.id, side)
  };
}

export function beginCharge(hands: PlayerHandsState, side: HandSide): PlayerHandsState {
  const hand = hands[side];
  if (!hand.heldBallId) return hands;
  return replaceHand(hands, side, { ...hand, mode: 'charging', chargeSeconds: 0 });
}

export function cancelCharge(hands: PlayerHandsState, side: HandSide): PlayerHandsState {
  const hand = hands[side];
  if (!hand.heldBallId) return hands;
  return replaceHand(hands, side, { ...hand, mode: 'holding', chargeSeconds: 0 });
}

export function tickHands(hands: PlayerHandsState, dt: number, constants: GameConstants = GAME_CONSTANTS): PlayerHandsState {
  return {
    left: tickHand(hands.left, dt, constants),
    right: tickHand(hands.right, dt, constants)
  };
}

export function validateThrowFromHand(player: PlayerState, hands: PlayerHandsState, side: HandSide, ball: BallState): ValidationResult<ThrowHandValidationReason> {
  const hand = hands[side];
  if (!hand.heldBallId) return { ok: false, reason: 'empty-hand' };
  if (hand.heldBallId !== ball.id) return { ok: false, reason: 'hand-ball-mismatch' };
  const validation = throwHeldBall(ball, {
    playerId: player.id,
    hand: side,
    origin: ball.position,
    velocity: ball.velocity
  });
  if (!validation.ok) return validation;
  return { ok: true };
}

export function throwBallFromHand(
  player: PlayerState,
  hands: PlayerHandsState,
  side: HandSide,
  ball: BallState,
  request: Omit<ThrowBallRequest, 'playerId' | 'hand'>
): ThrowFromHandResult | { ok: false; reason: ThrowHandValidationReason } {
  const hand = hands[side];
  if (!hand.heldBallId) return { ok: false, reason: 'empty-hand' };
  if (hand.heldBallId !== ball.id) return { ok: false, reason: 'hand-ball-mismatch' };

  const thrown = throwHeldBall(ball, {
    ...request,
    playerId: player.id,
    hand: side
  });
  if (!thrown.ok) return thrown;

  return {
    ok: true,
    hands: clearHand(hands, side),
    ball: thrown.ball
  };
}

export function dropBallFromHand(
  hands: PlayerHandsState,
  side: HandSide,
  ball: BallState,
  position: Vec3,
  velocity: Vec3 = vec3(0, -1.4, 0)
): DropFromHandResult | { ok: false; reason: 'empty-hand' | 'hand-ball-mismatch' } {
  const hand = hands[side];
  if (!hand.heldBallId) return { ok: false, reason: 'empty-hand' };
  if (hand.heldBallId !== ball.id) return { ok: false, reason: 'hand-ball-mismatch' };

  return {
    ok: true,
    hands: clearHand(hands, side),
    ball: dropHeldBall(ball, position, velocity)
  };
}

export function isInCatchCone(playerPosition: Vec3, aimForward: Vec3, ball: BallState, constants: GameConstants = GAME_CONSTANTS): boolean {
  return isWithinCone(playerPosition, aimForward, ball.position, constants.catch.coneDegrees, constants.catch.rangeMeters);
}

export function catchBallInHand(
  player: PlayerState,
  hands: PlayerHandsState,
  side: HandSide,
  ball: BallState,
  aimForward: Vec3,
  // Cone origin — pass the eye position so a chest-height ball aimed at horizontally is in-cone
  // (defaults to the feet position for backward compatibility).
  origin: Vec3 = player.movement.position,
  constants: GameConstants = GAME_CONSTANTS
): CatchResult | { ok: false; reason: CatchValidationReason } {
  const hand = hands[side];
  if (hand.heldBallId) return { ok: false, reason: 'hand-full' };
  if (hand.cooldownSeconds > 0) return { ok: false, reason: 'catch-cooldown' };
  if (ball.phase !== 'live') return { ok: false, reason: 'not-live' };
  if (!isInCatchCone(origin, aimForward, ball, constants)) return { ok: false, reason: 'outside-catch-cone' };

  return {
    ok: true,
    hands: replaceHand(hands, side, {
      ...hand,
      heldBallId: ball.id,
      mode: 'holding',
      chargeSeconds: 0,
      cooldownSeconds: constants.catch.cooldownSeconds
    }),
    ball: catchBall(ball, player.id, side)
  };
}

export function isInParryCone(playerPosition: Vec3, aimForward: Vec3, ball: BallState, constants: GameConstants = GAME_CONSTANTS): boolean {
  const coneDegrees = ball.isSuper ? constants.catch.superParryConeDegrees : constants.parry.coneDegrees;
  return isWithinCone(playerPosition, aimForward, ball.position, coneDegrees, constants.parry.rangeMeters);
}

export function autoParryBall(
  player: PlayerState,
  hands: PlayerHandsState,
  ball: BallState,
  aimForward: Vec3,
  parryCooldownSeconds: number,
  origin: Vec3 = player.movement.position,
  constants: GameConstants = GAME_CONSTANTS
): AutoParryResult | { ok: false; reason: ParryValidationReason } {
  if (heldBallCount(hands) < constants.ball.maxHeldBalls) return { ok: false, reason: 'hands-not-full' };
  if (parryCooldownSeconds > 0) return { ok: false, reason: 'parry-cooldown' };
  if (ball.phase !== 'live') return { ok: false, reason: 'not-live' };
  if (!isInParryCone(origin, aimForward, ball, constants)) return { ok: false, reason: 'outside-parry-cone' };

  return {
    ok: true,
    ball: deflectBall(ball, player.id, normalize(aimForward, vec3(0, 0, 1)), constants),
    parryCooldownSeconds: constants.parry.cooldownSeconds
  };
}

export function sweptCatchFailReason(
  request: SweptCatchRequest,
  constants: GameConstants = GAME_CONSTANTS
): SweptCatchFailReason | null {
  if (request.timing) {
    if (request.timing.nowMs < request.timing.openedAtMs + request.timing.startupMs) return 'too-early';
    if (request.timing.nowMs > request.timing.activeUntilMs) return 'too-late';
  }
  if (!request.handEmpty) return 'no-empty-hand';
  if ((request.handCooldownSeconds ?? 0) > 0) return 'catch-cooldown';
  if (request.dashing) return 'dashing';
  if (!isBallCatchableInFlight(request.ball, constants)) return 'ball-not-live';
  if (request.ball.ownerId !== null && request.ball.ownerId === request.defenderPlayerId) return 'owner-invalid';

  const closest = closestPointOnSegment(request.segmentStart, request.segmentEnd, request.origin);
  if (distance(request.origin, closest) > constants.catch.rangeMeters) return 'out-of-range';
  if (!sweptSegmentInCone(
    request.origin,
    request.forward,
    request.segmentStart,
    request.segmentEnd,
    constants.catch.coneDegrees,
    constants.catch.rangeMeters
  )) {
    return 'angle-too-wide';
  }
  return null;
}

export function sweptParryFailReason(
  request: SweptParryRequest,
  constants: GameConstants = GAME_CONSTANTS
): SweptParryFailReason | null {
  if (request.heldBallCount < constants.ball.maxHeldBalls) return 'no-two-balls';
  if (request.parryCooldownSeconds > 0) return 'parry-cooldown';
  if (request.ball.phase !== 'live') return 'ball-not-live';
  if (request.ball.ownerId !== null && request.ball.ownerId === request.defenderPlayerId) return 'owner-invalid';

  const coneDegrees = request.ball.isSuper ? constants.catch.superParryConeDegrees : constants.parry.coneDegrees;
  const closest = closestPointOnSegment(request.segmentStart, request.segmentEnd, request.origin);
  if (distance(request.origin, closest) > constants.parry.rangeMeters) return 'out-of-range';
  if (!sweptSegmentInCone(
    request.origin,
    request.forward,
    request.segmentStart,
    request.segmentEnd,
    coneDegrees,
    constants.parry.rangeMeters
  )) {
    return 'angle-too-wide';
  }
  return null;
}

function tickHand(hand: HandState, dt: number, constants: GameConstants): HandState {
  return {
    ...hand,
    cooldownSeconds: Math.max(0, hand.cooldownSeconds - dt),
    chargeSeconds: hand.mode === 'charging'
      ? Math.min(constants.ball.maxChargeSeconds, hand.chargeSeconds + dt)
      : hand.chargeSeconds
  };
}

function setHandHolding(hands: PlayerHandsState, side: HandSide, ballId: string): PlayerHandsState {
  return replaceHand(hands, side, {
    ...hands[side],
    heldBallId: ballId,
    mode: 'holding',
    chargeSeconds: 0,
    cooldownSeconds: 0,
    catchTrackingSecondsByBallId: {}
  });
}

function clearHand(hands: PlayerHandsState, side: HandSide): PlayerHandsState {
  return replaceHand(hands, side, {
    ...hands[side],
    heldBallId: null,
    mode: 'empty',
    chargeSeconds: 0,
    catchTrackingSecondsByBallId: {}
  });
}

function replaceHand(hands: PlayerHandsState, side: HandSide, hand: HandState): PlayerHandsState {
  const cleanHand = {
    ...hand,
    side,
    catchTrackingSecondsByBallId: { ...hand.catchTrackingSecondsByBallId }
  };
  return {
    left: side === 'left' ? cleanHand : cloneHand(hands.left),
    right: side === 'right' ? cleanHand : cloneHand(hands.right)
  };
}

function cloneHand(hand: HandState): HandState {
  return {
    ...hand,
    catchTrackingSecondsByBallId: { ...hand.catchTrackingSecondsByBallId }
  };
}

export function aimForwardFromYaw(yawRadians: number): Vec3 {
  return cloneVec3({ x: Math.sin(yawRadians), y: 0, z: Math.cos(yawRadians) });
}
