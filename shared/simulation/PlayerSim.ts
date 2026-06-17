import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { DashState, LegalHalf, MovementInternalState, PlayerState, SpawnSide, Vec3 } from '../types';
import { createHands } from './HandSim';
import { add, cloneVec3, dot, length, lengthSquared, normalize, scale, vec3 } from './CollisionMath';

export function createDashState(overrides: Partial<DashState> = {}, constants: GameConstants = GAME_CONSTANTS): DashState {
  return {
    charges: constants.dash.maxCharges,
    rechargeTimerSeconds: 0,
    cooldownSeconds: 0,
    ...overrides
  };
}

export function createPlayerState(
  id: string,
  teamId: string,
  legalHalf: LegalHalf = 'negativeZ',
  overrides: Partial<PlayerState> = {}
): PlayerState {
  const spawnSide: SpawnSide = overrides.spawnSide ?? legalHalf;
  const base: PlayerState = {
    id,
    name: overrides.name ?? id,
    teamId,
    spawnSide,
    teamSlotIndex: overrides.teamSlotIndex ?? 0,
    legalHalf,
    movement: {
      position: vec3(),
      velocity: vec3(),
      yawRadians: 0,
      pitchRadians: 0,
      facing: vec3(0, 0, 1),
      grounded: true,
      crouching: false,
      sliding: false,
      wallRunning: false,
      dashingThisFrame: false,
      speed: 0
    },
    movementInternal: createMovementInternalState(),
    hands: createHands(),
    dash: createDashState(),
    score: 0,
    connected: true,
    reconnectDeadlineAtMs: overrides.reconnectDeadlineAtMs ?? null,
    lastProcessedInputSeq: 0
  };

  return {
    ...base,
    ...overrides,
    id,
    teamId,
    legalHalf,
    movement: {
      ...base.movement,
      ...overrides.movement,
      position: cloneVec3(overrides.movement?.position ?? base.movement.position),
      velocity: cloneVec3(overrides.movement?.velocity ?? base.movement.velocity),
      facing: cloneVec3(overrides.movement?.facing ?? base.movement.facing)
    },
    movementInternal: overrides.movementInternal
      ? { ...base.movementInternal, ...overrides.movementInternal }
      : base.movementInternal,
    hands: overrides.hands ?? base.hands,
    dash: overrides.dash ? { ...base.dash, ...overrides.dash } : base.dash,
    lastProcessedInputSeq: overrides.lastProcessedInputSeq ?? base.lastProcessedInputSeq
  };
}

export function createMovementInternalState(overrides: Partial<MovementInternalState> = {}): MovementInternalState {
  return {
    slideTimer: 0,
    jumpGraceTimer: 0,
    wallRunTimer: 0,
    wallReattachCooldown: 0,
    dashActiveTimer: 0,
    doubleJumpAvailable: true,
    catchBoostTimer: 0,
    groundHeight: 0,
    lastWallNormalX: 0,
    lastWallNormalZ: 0,
    backflipActive: false,
    backflipTimer: 0,
    backflipCooldown: 0,
    ...overrides
  };
}

export function advanceDashState(dash: DashState, dt: number, constants: GameConstants = GAME_CONSTANTS): DashState {
  const cooldownSeconds = Math.max(0, dash.cooldownSeconds - dt);
  if (dash.charges >= constants.dash.maxCharges) {
    return {
      ...dash,
      charges: constants.dash.maxCharges,
      rechargeTimerSeconds: 0,
      cooldownSeconds
    };
  }

  let charges = dash.charges;
  let rechargeTimerSeconds = dash.rechargeTimerSeconds + dt;
  while (charges < constants.dash.maxCharges && rechargeTimerSeconds >= constants.dash.rechargeSeconds) {
    charges += 1;
    rechargeTimerSeconds -= constants.dash.rechargeSeconds;
  }

  if (charges >= constants.dash.maxCharges) rechargeTimerSeconds = 0;

  return {
    charges,
    rechargeTimerSeconds,
    cooldownSeconds
  };
}

export function canSpendDashCharge(dash: DashState): boolean {
  return dash.charges > 0 && dash.cooldownSeconds <= 0;
}

export function spendDashCharge(dash: DashState, constants: GameConstants = GAME_CONSTANTS): DashState | null {
  if (!canSpendDashCharge(dash)) return null;
  return {
    charges: dash.charges - 1,
    rechargeTimerSeconds: dash.rechargeTimerSeconds,
    cooldownSeconds: constants.dash.cooldownBetweenDashes
  };
}

export function grantDashCharge(dash: DashState, constants: GameConstants = GAME_CONSTANTS): DashState {
  return {
    charges: Math.min(constants.dash.maxCharges, dash.charges + 1),
    rechargeTimerSeconds: dash.charges + 1 >= constants.dash.maxCharges ? 0 : dash.rechargeTimerSeconds,
    cooldownSeconds: dash.cooldownSeconds
  };
}

export function calculateDashVelocity(
  currentVelocity: Vec3,
  dashDirection: Vec3,
  constants: GameConstants = GAME_CONSTANTS
): Vec3 {
  const direction = normalize(dashDirection);
  if (lengthSquared(direction) <= 0) return cloneVec3(currentVelocity);

  const currentHorizontal = vec3(currentVelocity.x, 0, currentVelocity.z);
  const currentSpeed = length(currentHorizontal);
  const normalizedCurrent = currentSpeed > 0.001 ? scale(currentHorizontal, 1 / currentSpeed) : direction;
  const sameDirection = dot(normalizedCurrent, direction) >= constants.dash.similarDirectionDot;

  if (sameDirection) {
    return add(currentVelocity, scale(direction, constants.dash.impulse));
  }

  // Against momentum: retain more of the opposing velocity AND weaken the dash impulse, so a
  // reverse-dash can't snap you to full speed the other way instantly.
  return add(
    scale(currentVelocity, constants.dash.oppositeDirectionMomentumPenalty),
    scale(direction, constants.dash.impulse * constants.dash.oppositeDirectionImpulseScale)
  );
}

export function tryDash(
  dash: DashState,
  currentVelocity: Vec3,
  dashDirection: Vec3,
  constants: GameConstants = GAME_CONSTANTS
): { ok: true; dash: DashState; velocity: Vec3 } | { ok: false } {
  if (lengthSquared(dashDirection) <= 0.001) return { ok: false };
  const nextDash = spendDashCharge(dash, constants);
  if (!nextDash) return { ok: false };
  return {
    ok: true,
    dash: nextDash,
    velocity: calculateDashVelocity(currentVelocity, dashDirection, constants)
  };
}

export function tryUpwardDash(
  dash: DashState,
  currentVelocity: Vec3,
  constants: GameConstants = GAME_CONSTANTS
): { ok: true; dash: DashState; velocity: Vec3 } | { ok: false } {
  const nextDash = spendDashCharge(dash, constants);
  if (!nextDash) return { ok: false };
  return {
    ok: true,
    dash: nextDash,
    velocity: {
      ...currentVelocity,
      y: Math.max(currentVelocity.y, constants.dash.upwardImpulse)
    }
  };
}
