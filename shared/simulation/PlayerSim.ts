import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { DashState, LegalHalf, PlayerState, SpawnSide, Vec3 } from '../types';
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
    hands: createHands(),
    dash: createDashState(),
    score: 0,
    connected: true
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
    hands: overrides.hands ?? base.hands,
    dash: overrides.dash ? { ...base.dash, ...overrides.dash } : base.dash
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

  return add(scale(currentVelocity, constants.dash.oppositeDirectionMomentumPenalty), scale(direction, constants.dash.impulse));
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
