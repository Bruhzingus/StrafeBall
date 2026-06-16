import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { Vec3 } from '../types';
import { clamp, cross, normalize, vec3 } from './CollisionMath';

export interface LookVectors {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export function clampLookPitch(pitchRadians: number, constants: GameConstants = GAME_CONSTANTS): number {
  return clamp(pitchRadians, -constants.player.lookPitchLimitRadians, constants.player.lookPitchLimitRadians);
}

export function facingFromAngles(yawRadians: number, pitchRadians: number, constants: GameConstants = GAME_CONSTANTS): Vec3 {
  const pitch = clampLookPitch(pitchRadians, constants);
  const pitchCos = Math.cos(pitch);
  const x = Math.sin(yawRadians) * pitchCos;
  const y = -Math.sin(pitch);
  const z = Math.cos(yawRadians) * pitchCos;
  return normalize({ x, y, z }, vec3(0, 0, 1));
}

export function lookVectorsFromAngles(yawRadians: number, pitchRadians: number, constants: GameConstants = GAME_CONSTANTS): LookVectors {
  const forward = facingFromAngles(yawRadians, pitchRadians, constants);
  const yawRight = vec3(Math.cos(yawRadians), 0, -Math.sin(yawRadians));
  const right = normalize(cross(vec3(0, 1, 0), forward), yawRight);
  const up = normalize(cross(forward, right), vec3(0, 1, 0));
  return { forward, right, up };
}
