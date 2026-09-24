import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { Vec3 } from '../types';

const EPSILON = 1e-6;

function horizontalDirection(dx: number, dz: number, fallback: Vec3): { x: number; z: number } {
  const distance = Math.hypot(dx, dz);
  if (distance > EPSILON) return { x: dx / distance, z: dz / distance };

  const fallbackDistance = Math.hypot(fallback.x, fallback.z);
  if (fallbackDistance > EPSILON) return { x: fallback.x / fallbackDistance, z: fallback.z / fallbackDistance };
  return { x: 0, z: 1 };
}

/** Linear blast falloff that keeps the outer edge useful while rewarding point-blank placement. */
export function shockwaveFalloff(distance: number, radius: number): number {
  if (!Number.isFinite(distance) || distance > radius) return 0;
  return 1 - 0.5 * Math.max(0, distance) / radius;
}

/**
 * Player shockwaves add to existing momentum. In particular, an already-rising jump contributes its
 * vertical speed to the blast, making a well-timed point-blank jump capable of crossing the court.
 * Downward velocity is discarded so a shockwave always launches rather than merely slowing a fall.
 */
export function shockwavePlayerVelocity(
  position: Vec3,
  velocity: Vec3,
  blastPosition: Vec3,
  fallbackDirection: Vec3,
  c: GameConstants = GAME_CONSTANTS
): Vec3 | null {
  const dx = position.x - blastPosition.x;
  const dy = position.y + c.player.height / 2 - blastPosition.y;
  const dz = position.z - blastPosition.z;
  const falloff = shockwaveFalloff(Math.hypot(dx, dy, dz), c.powerup.shockRadius);
  if (falloff <= 0) return null;

  const direction = horizontalDirection(dx, dz, fallbackDirection);
  return {
    x: velocity.x + direction.x * c.powerup.shockPlayerSpeed * falloff,
    y: Math.max(0, velocity.y) + c.powerup.shockPlayerLift * falloff,
    z: velocity.z + direction.z * c.powerup.shockPlayerSpeed * falloff
  };
}

/** Loose balls are redirected radially rather than preserving their pre-blast path. */
export function shockwaveBallVelocity(
  position: Vec3,
  blastPosition: Vec3,
  fallbackDirection: Vec3,
  c: GameConstants = GAME_CONSTANTS
): Vec3 | null {
  const dx = position.x - blastPosition.x;
  const dy = position.y - blastPosition.y;
  const dz = position.z - blastPosition.z;
  const falloff = shockwaveFalloff(Math.hypot(dx, dy, dz), c.powerup.shockRadius);
  if (falloff <= 0) return null;

  const direction = horizontalDirection(dx, dz, fallbackDirection);
  return {
    x: direction.x * c.powerup.shockBallSpeed * falloff,
    y: c.powerup.shockBallLift * falloff,
    z: direction.z * c.powerup.shockBallSpeed * falloff
  };
}
