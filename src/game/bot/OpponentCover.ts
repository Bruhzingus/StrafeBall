import { Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS } from '../../../shared/constants';
import { curveRampFactor } from '../../../shared/simulation/BallSim';
import { TUNING } from '../config/tuning';
import type { AABB, CollisionWorld } from '../map/Collider';

/** The court limits relevant to a bot looking for a place to throw from. */
export interface OpponentFiringBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  ownSideMinZ?: number;
  floorY?: number;
}

export interface OpponentShotTrajectory {
  origin: Vector3;
  /** Current target position; normally the local player's body center. */
  target: Vector3;
  /** The actual velocity returned by calculateThrow, including thrower movement. */
  velocity: Vector3;
  dropScale: number;
  curveAccel?: Vector3;
  collision?: CollisionWorld;
  radius?: number;
  floorY?: number;
  gravityScale?: number;
}

/**
 * Check the full 3D path of the ball center, with its collision radius, against live map cover.
 * A low, knocked-over mat will block a low throw but not a chest-height throw.
 */
export function shotLaneClear(
  origin: Vector3,
  target: Vector3,
  collision?: CollisionWorld,
  radius: number = TUNING.ball.radius
): boolean {
  return !segmentHitsCover(origin, target, collision, radius);
}

/**
 * Predict the first flight using the same gravity and curve ramp as Ball.update. The prediction
 * stops at the player's down-court plane. It is a cover veto, not a guarantee of a player hit.
 */
export function shotTrajectoryClear(shot: OpponentShotTrajectory): boolean {
  const { origin, target, velocity, collision } = shot;
  const radius = shot.radius ?? TUNING.ball.radius;
  const floorY = shot.floorY ?? 0;
  const towardX = target.x - origin.x;
  const towardZ = target.z - origin.z;
  const distance = Math.hypot(towardX, towardZ);
  if (distance < 0.01) return false;
  const axisX = towardX / distance;
  const axisZ = towardZ / distance;
  const forwardSpeed = velocity.x * axisX + velocity.z * axisZ;
  if (forwardSpeed <= 0.1) return false;

  // Smaller than an ordinary render step so a thin mat cannot be jumped over. The segment check
  // still sweeps between every pair of points, including the final truncated segment.
  const stepSeconds = 1 / 120;
  const maxSeconds = Math.min(2.5, Math.max(0.25, distance / forwardSpeed * 2 + 0.25));
  const curve = shot.curveAccel;
  const position = origin.clone();
  const moving = velocity.clone();
  let distanceTraveled = 0;

  for (let elapsed = 0; elapsed < maxSeconds; elapsed += stepSeconds) {
    const previous = position.clone();
    moving.y -= TUNING.ball.gravity * shot.dropScale * (shot.gravityScale ?? 1) * stepSeconds;
    if (curve) {
      const ramp = curveRampFactor(distanceTraveled, GAME_CONSTANTS);
      moving.x += curve.x * ramp * stepSeconds;
      moving.z += curve.z * ramp * stepSeconds;
    }
    position.addInPlaceFromFloats(moving.x * stepSeconds, moving.y * stepSeconds, moving.z * stepSeconds);
    distanceTraveled += moving.length() * stepSeconds;

    const progress = (position.x - origin.x) * axisX + (position.z - origin.z) * axisZ;
    const end = progress > distance
      ? Vector3.Lerp(previous, position, Math.max(0, Math.min(1,
        (distance - ((previous.x - origin.x) * axisX + (previous.z - origin.z) * axisZ)) /
        Math.max(1e-8, progress - ((previous.x - origin.x) * axisX + (previous.z - origin.z) * axisZ)))))
      : position;
    if (end.y < floorY + radius || segmentHitsCover(previous, end, collision, radius)) return false;
    if (progress >= distance) return true;
  }
  return false;
}

/**
 * Find a nearby reachable-feet candidate with a clear lane to the player's current position.
 * Return null when every sampled position is covered, so the caller can retain the ball and move.
 * `handOrigin - feet` keeps the search aligned with the bot's actual throwing hand.
 */
export function findClearFiringPosition(
  feet: Vector3,
  handOrigin: Vector3,
  target: Vector3,
  bounds: OpponentFiringBounds,
  collision?: CollisionWorld
): Vector3 | null {
  const footRadius = 0.42;
  const minX = bounds.minX + footRadius;
  const maxX = bounds.maxX - footRadius;
  const minZ = Math.max(bounds.minZ, bounds.ownSideMinZ ?? bounds.minZ) + footRadius;
  const maxZ = bounds.maxZ - footRadius;
  if (minX > maxX || minZ > maxZ) return null;
  const handOffset = handOrigin.subtract(feet);
  const floorY = bounds.floorY ?? feet.y;
  const clampedX = clamp(feet.x, minX, maxX);
  const clampedZ = clamp(feet.z, minZ, maxZ);
  let best: Vector3 | null = null;
  let bestCost = Number.POSITIVE_INFINITY;

  // Try nearby positions first, then other lanes. Sampling X across the full half is important
  // when several mats together close the central lane. The opponent's own movement path planner
  // handles reaching a chosen position around those mats.
  const xs = uniqueSorted([clampedX, ...sampleAxis(minX, maxX, 0.85)]);
  const zs = uniqueSorted([clampedZ, clamp(clampedZ - 1.8, minZ, maxZ),
    clamp(clampedZ + 1.8, minZ, maxZ), clamp(clampedZ - 3.6, minZ, maxZ),
    clamp(clampedZ + 3.6, minZ, maxZ)]);
  for (const z of zs) {
    for (const x of xs) {
      if (footPositionBlocked(x, z, floorY, footRadius, collision)) continue;
      const candidate = new Vector3(x, floorY, z);
      if (!shotLaneClear(candidate.add(handOffset), target, collision, TUNING.ball.radius + 0.2)) continue;
      const cost = Math.hypot(x - feet.x, z - feet.z) + 0.06 * Math.hypot(x - target.x, z - target.z);
      if (cost < bestCost) {
        best = candidate;
        bestCost = cost;
      }
    }
  }
  return best;
}

function footPositionBlocked(x: number, z: number, floorY: number, radius: number, world?: CollisionWorld): boolean {
  if (!world) return false;
  for (const box of world.boxes) {
    if (box.enabled === false || box.ramp || box.maxY <= floorY + TUNING.player.stepHeight ||
        box.minY >= floorY + TUNING.player.height) continue;
    if (x > box.minX - radius && x < box.maxX + radius &&
        z > box.minZ - radius && z < box.maxZ + radius) return true;
  }
  return false;
}

function segmentHitsCover(from: Vector3, to: Vector3, world: CollisionWorld | undefined, radius: number): boolean {
  if (!world) return false;
  for (const box of world.boxes) {
    if (box.enabled !== false && segmentIntersectsExpandedBox(from, to, box, radius)) return true;
  }
  return false;
}

/** Segment-versus-expanded-AABB slab intersection, matching Ball's radius-expanded box collision. */
function segmentIntersectsExpandedBox(from: Vector3, to: Vector3, box: AABB, radius: number): boolean {
  let near = 0;
  let far = 1;
  for (const [start, delta, min, max] of [
    [from.x, to.x - from.x, box.minX - radius, box.maxX + radius],
    [from.y, to.y - from.y, box.minY - radius, box.maxY + radius],
    [from.z, to.z - from.z, box.minZ - radius, box.maxZ + radius]
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (start < min || start > max) return false;
      continue;
    }
    const a = (min - start) / delta;
    const b = (max - start) / delta;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return false;
  }
  return far >= 0 && near <= 1;
}

function sampleAxis(min: number, max: number, spacing: number): number[] {
  const values = [min, max];
  for (let value = min + spacing; value < max; value += spacing) values.push(value);
  return values;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 1000) / 1000))].sort((a, b) => a - b);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
