import { GAME_CONSTANTS } from '../constants';

/** Axis-aligned bounding box used by the shared movement simulation for static collision. */
export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function aabbFromCenter(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): AABB {
  return { minX: cx - hx, maxX: cx + hx, minY: cy - hy, maxY: cy + hy, minZ: cz - hz, maxZ: cz + hz };
}

// Mirrors MAT_DIMENSIONS in the client MatObstacle so server and client agree on mat collision.
const MAT_DIMENSIONS = { width: 2.1, height: 1.35, depth: 0.18 };

/**
 * The static collision boxes of the gym (bleachers + mats), computed purely from constants so
 * the authoritative server and the client's prediction resolve movement against IDENTICAL
 * geometry. These values replicate GymArena.createBleachers()/createMats() exactly. Outer walls
 * are handled by the bounds clamp, not boxes.
 */
export function createGymCollisionBoxes(): AABB[] {
  const boxes: AABB[] = [];
  const halfWidth = GAME_CONSTANTS.map.halfWidth;
  const halfLength = GAME_CONSTANTS.map.halfLength;

  // Bleachers: four tiers per side.
  const width = 2.0;
  const height = 0.35;
  const depth = halfLength * 1.3;
  for (const side of [-1, 1]) {
    for (let step = 0; step < 4; step += 1) {
      const cx = side * (halfWidth - 1.2 - step * 0.42);
      const cy = 0.17 + step * 0.28;
      boxes.push(aabbFromCenter(cx, cy, 0, width / 2, height / 2, depth / 2));
    }
  }

  // Mats: rotated a quarter turn, so width/depth extents swap.
  const matPositions: [number, number, number][] = [
    [-4.5, 0.72, -5.5],
    [4.5, 0.72, -5.5],
    [-4.5, 0.72, 5.5],
    [4.5, 0.72, 5.5]
  ];
  const matHalfX = MAT_DIMENSIONS.depth / 2;
  const matHalfZ = MAT_DIMENSIONS.width / 2;
  const matHalfY = MAT_DIMENSIONS.height / 2;
  for (const [x, y, z] of matPositions) {
    boxes.push(aabbFromCenter(x, y, z, matHalfX, matHalfY, matHalfZ));
  }

  return boxes;
}
