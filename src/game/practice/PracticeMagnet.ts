import { GAME_CONSTANTS as C } from '../../../shared/constants';
import type { Vec3 } from '../../../shared/types';

export interface PracticeMagnetStep {
  settledSeconds: number;
  distantPulling: boolean;
  reachedPlayer: boolean;
  pulling: boolean;
  velocity: Vec3;
}

/** Apply the server magnet's horizontal pull rules to one loose normal ball. */
export function stepPracticeMagnetBall(
  position: Vec3,
  velocity: Vec3,
  playerPosition: Vec3,
  dt: number,
  previousSettledSeconds: number,
  wasDistantPulling: boolean,
  canCollect: boolean
): PracticeMagnetStep {
  const elapsed = Math.max(0, dt);
  const settledSeconds = Math.hypot(velocity.x, velocity.y, velocity.z) < 0.1
    ? previousSettledSeconds + elapsed
    : 0;
  const idle = { settledSeconds, distantPulling: false, reachedPlayer: false, pulling: false, velocity };
  if (!canCollect) return idle;

  const dx = playerPosition.x - position.x;
  const dz = playerPosition.z - position.z;
  const distance = Math.hypot(dx, dz);
  const nearby = distance <= C.powerup.magnetRadius;
  if (!nearby && settledSeconds <= C.powerup.stationarySeconds && !wasDistantPulling) return idle;

  if (distance < 0.85 && Math.abs(playerPosition.y - position.y) < C.ball.pickupVerticalTolerance) {
    return { ...idle, reachedPlayer: true };
  }

  const acceleration = nearby ? C.powerup.magnetAcceleration : C.powerup.distantMagnetAcceleration;
  const maxSpeed = nearby ? C.powerup.magnetSpeed : C.powerup.distantMagnetSpeed;
  const vx = velocity.x + dx / Math.max(0.01, distance) * acceleration * elapsed;
  const vz = velocity.z + dz / Math.max(0.01, distance) * acceleration * elapsed;
  const scale = Math.min(1, maxSpeed / Math.max(0.01, Math.hypot(vx, vz)));
  return {
    settledSeconds,
    distantPulling: !nearby,
    reachedPlayer: false,
    pulling: true,
    velocity: { x: vx * scale, y: velocity.y, z: vz * scale }
  };
}
