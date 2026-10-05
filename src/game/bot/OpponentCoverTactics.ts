import { Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { CollisionWorld, type AABB } from '../map/Collider';
import { shotLaneClear, type OpponentFiringBounds } from './OpponentCover';

export interface OpponentCoverPlan {
  /** Bot feet behind the mat, with its torso shielded from the player. */
  hide: Vector3;
  /** Feet at a side of the mat where a hand-height throw has a clear lane. */
  peek: Vector3;
  /** A second clear side, when court bounds and other cover allow one. */
  oppositePeek: Vector3 | null;
  coverId: string;
}

/** Optional path cost supplied by the bot's navigator. Return Infinity for unreachable points. */
export type CoverRouteDistance = (from: Vector3, to: Vector3) => number;

const BODY_RADIUS = 0.42;
const BODY_HEIGHT = 1.8;
const TORSO_HEIGHT = 1.0;
const HAND_HEIGHT = 1.4;
const PEEK_CLEARANCE = TUNING.ball.radius + 0.12;
const MAX_COVER_TRAVEL = 12;

/**
 * Choose a nearby standing mat the bot can hide behind and peek around. Each call reads the live
 * collision world, so a disabled or knocked-over mat stops being a cover option immediately.
 * The caller can pass its actual route distance when a direct foot path crosses other cover.
 */
export function findCoverPlan(
  feet: Vector3,
  playerEye: Vector3,
  bounds: OpponentFiringBounds,
  collision?: CollisionWorld,
  preferredSide: -1 | 1 = 1,
  routeDistance?: CoverRouteDistance
): OpponentCoverPlan | null {
  if (!collision) return null;
  const floorY = bounds.floorY ?? feet.y;
  const playerBody = new Vector3(playerEye.x, playerEye.y - 0.52, playerEye.z);
  let best: OpponentCoverPlan | null = null;
  let bestCost = Number.POSITIVE_INFINITY;

  for (const [index, mat] of collision.boxes.entries()) {
    if (!isStandingMat(mat, floorY)) continue;
    const cx = (mat.minX + mat.maxX) / 2;
    const cz = (mat.minZ + mat.maxZ) / 2;
    const halfX = (mat.maxX - mat.minX) / 2;
    const halfZ = (mat.maxZ - mat.minZ) / 2;
    const fromPlayerX = cx - playerEye.x;
    const fromPlayerZ = cz - playerEye.z;
    const playerDistance = Math.hypot(fromPlayerX, fromPlayerZ);
    if (playerDistance < 0.5) continue;
    const awayX = fromPlayerX / playerDistance;
    const awayZ = fromPlayerZ / playerDistance;
    const tangentX = awayZ;
    const tangentZ = -awayX;
    const depth = Math.abs(awayX) * halfX + Math.abs(awayZ) * halfZ;
    const width = Math.abs(tangentX) * halfX + Math.abs(tangentZ) * halfZ;
    const hideDistance = depth + BODY_RADIUS + 0.45;
    const peekDistance = width + BODY_RADIUS + 0.7;
    const matWorld = new CollisionWorld([mat]);

    // Offset the hiding point a little along the mat to prefer a nearby end without losing cover.
    for (const offset of [0, -Math.min(width * 0.5, 0.8), Math.min(width * 0.5, 0.8)]) {
      const hide = new Vector3(
        cx + awayX * hideDistance + tangentX * offset,
        floorY,
        cz + awayZ * hideDistance + tangentZ * offset
      );
      if (!bodyPositionFree(hide, bounds, collision, floorY)) continue;
      if (Math.hypot(hide.x - feet.x, hide.z - feet.z) > MAX_COVER_TRAVEL) continue;
      const torso = new Vector3(hide.x, floorY + TORSO_HEIGHT, hide.z);
      if (shotLaneClear(playerEye, torso, matWorld, TUNING.ball.radius)) continue;

      const positive = findPeek(hide, 1, peekDistance, tangentX, tangentZ, playerBody,
        bounds, collision, floorY, routeDistance);
      const negative = findPeek(hide, -1, peekDistance, tangentX, tangentZ, playerBody,
        bounds, collision, floorY, routeDistance);
      const peek = preferredSide === 1 ? positive ?? negative : negative ?? positive;
      if (!peek) continue;
      const oppositePeek = peek === positive ? negative : positive;

      const toHide = routeDistance ? routeDistance(feet, hide)
        : Math.hypot(hide.x - feet.x, hide.z - feet.z);
      const toPeek = routeDistance ? routeDistance(hide, peek)
        : Math.hypot(hide.x - peek.x, hide.z - peek.z);
      if (!Number.isFinite(toHide) || toHide < 0 || !Number.isFinite(toPeek) || toPeek < 0) continue;
      const cost = toHide + toPeek * 0.15 + (oppositePeek ? -0.2 : 0);
      if (cost < bestCost) {
        best = { hide, peek, oppositePeek, coverId: mat.id ?? `mat:${index}` };
        bestCost = cost;
      }
    }
  }
  return best;
}

function findPeek(
  hide: Vector3,
  side: -1 | 1,
  minimumDistance: number,
  tangentX: number,
  tangentZ: number,
  playerBody: Vector3,
  bounds: OpponentFiringBounds,
  collision: CollisionWorld,
  floorY: number,
  routeDistance?: CoverRouteDistance
): Vector3 | null {
  for (const extra of [0, 0.35, 0.75, 1.2, 1.8]) {
    const distance = side * (minimumDistance + extra);
    const peek = new Vector3(hide.x + tangentX * distance, floorY, hide.z + tangentZ * distance);
    if (!bodyPositionFree(peek, bounds, collision, floorY)) continue;
    const hand = new Vector3(peek.x, floorY + HAND_HEIGHT, peek.z);
    if (!shotLaneClear(hand, playerBody, collision, PEEK_CLEARANCE)) continue;
    if (routeDistance) {
      const distanceToPeek = routeDistance(hide, peek);
      if (!Number.isFinite(distanceToPeek) || distanceToPeek < 0) continue;
    }
    return peek;
  }
  return null;
}

function isStandingMat(box: AABB, floorY: number): boolean {
  return box.kind === 'mat' && box.enabled !== false && !box.ramp &&
    box.minY <= floorY + TORSO_HEIGHT && box.maxY >= floorY + TORSO_HEIGHT + TUNING.ball.radius;
}

function bodyPositionFree(
  position: Vector3,
  bounds: OpponentFiringBounds,
  collision: CollisionWorld,
  floorY: number
): boolean {
  const minZ = Math.max(bounds.minZ, bounds.ownSideMinZ ?? bounds.minZ);
  if (position.x < bounds.minX + BODY_RADIUS || position.x > bounds.maxX - BODY_RADIUS ||
      position.z < minZ + BODY_RADIUS || position.z > bounds.maxZ - BODY_RADIUS) return false;
  for (const box of collision.boxes) {
    if (box.enabled === false || box.ramp || box.maxY <= floorY + TUNING.player.stepHeight ||
        box.minY >= floorY + BODY_HEIGHT) continue;
    if (position.x > box.minX - BODY_RADIUS && position.x < box.maxX + BODY_RADIUS &&
        position.z > box.minZ - BODY_RADIUS && position.z < box.maxZ + BODY_RADIUS) return false;
  }
  return true;
}
