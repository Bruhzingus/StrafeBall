import { GAME_CONSTANTS } from '../constants';

/** Axis-aligned bounding box used by the shared movement simulation for static collision. */
export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  kind?: 'bleacher' | 'mat';
  id?: string;
}

export function aabbFromCenter(
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  meta: Pick<AABB, 'kind' | 'id'> = {}
): AABB {
  return {
    minX: cx - hx,
    maxX: cx + hx,
    minY: cy - hy,
    maxY: cy + hy,
    minZ: cz - hz,
    maxZ: cz + hz,
    ...meta
  };
}

// Mirrors MAT_DIMENSIONS in the client MatObstacle so server and client agree on mat collision.
const MAT_DIMENSIONS = { width: 2.1, height: 1.35, depth: 0.18 };
export const BLEACHER_LAYOUT = {
  tierCount: 5,
  tierRun: 0.54,
  tierRise: 0.32,
  wallInset: 0.35,
  lengthScale: 1.45,
  backThickness: 0.16,
  backHeight: 2.08,
  sideThickness: 0.18
} as const;

export interface BleacherTierSpec {
  side: -1 | 1;
  step: number;
  center: { x: number; y: number; z: number };
  size: { width: number; height: number; depth: number };
}

export interface BleacherPanelSpec {
  side: -1 | 1;
  name: string;
  center: { x: number; y: number; z: number };
  size: { width: number; height: number; depth: number };
}

export function createBleacherTierSpecs(): BleacherTierSpec[] {
  const halfWidth = GAME_CONSTANTS.map.halfWidth;
  const halfLength = GAME_CONSTANTS.map.halfLength;
  const length = halfLength * BLEACHER_LAYOUT.lengthScale;
  const totalRun = BLEACHER_LAYOUT.tierCount * BLEACHER_LAYOUT.tierRun;
  const innerEdge = halfWidth - BLEACHER_LAYOUT.wallInset - totalRun;
  const specs: BleacherTierSpec[] = [];

  for (const side of [-1, 1] as const) {
    for (let step = 0; step < BLEACHER_LAYOUT.tierCount; step += 1) {
      const height = (step + 1) * BLEACHER_LAYOUT.tierRise;
      specs.push({
        side,
        step,
        center: {
          x: side * (innerEdge + BLEACHER_LAYOUT.tierRun * (step + 0.5)),
          y: height * 0.5,
          z: 0
        },
        size: {
          width: BLEACHER_LAYOUT.tierRun,
          height,
          depth: length
        }
      });
    }
  }

  return specs;
}

export function createBleacherPanelSpecs(): BleacherPanelSpec[] {
  const halfWidth = GAME_CONSTANTS.map.halfWidth;
  const halfLength = GAME_CONSTANTS.map.halfLength;
  const length = halfLength * BLEACHER_LAYOUT.lengthScale;
  const totalRun = BLEACHER_LAYOUT.tierCount * BLEACHER_LAYOUT.tierRun;
  const innerEdge = halfWidth - BLEACHER_LAYOUT.wallInset - totalRun;
  const centerRun = innerEdge + totalRun * 0.5;
  const panelY = BLEACHER_LAYOUT.backHeight * 0.5;
  const specs: BleacherPanelSpec[] = [];

  for (const side of [-1, 1] as const) {
    specs.push({
      side,
      name: 'back',
      center: {
        x: side * (halfWidth - BLEACHER_LAYOUT.wallInset + BLEACHER_LAYOUT.backThickness * 0.5),
        y: panelY,
        z: 0
      },
      size: {
        width: BLEACHER_LAYOUT.backThickness,
        height: BLEACHER_LAYOUT.backHeight,
        depth: length
      }
    });

    for (const zSign of [-1, 1] as const) {
      specs.push({
        side,
        name: zSign < 0 ? 'south_side' : 'north_side',
        center: {
          x: side * centerRun,
          y: panelY,
          z: zSign * (length * 0.5 + BLEACHER_LAYOUT.sideThickness * 0.5)
        },
        size: {
          width: totalRun,
          height: BLEACHER_LAYOUT.backHeight,
          depth: BLEACHER_LAYOUT.sideThickness
        }
      });
    }
  }

  return specs;
}

export function createBleacherCollisionBoxes(): AABB[] {
  const boxes: AABB[] = [];

  for (const tier of createBleacherTierSpecs()) {
    boxes.push(aabbFromCenter(
      tier.center.x,
      tier.center.y,
      tier.center.z,
      tier.size.width * 0.5,
      tier.size.height * 0.5,
      tier.size.depth * 0.5,
      { kind: 'bleacher', id: `bleacher_tier_${tier.side}_${tier.step}` }
    ));
  }

  for (const panel of createBleacherPanelSpecs()) {
    boxes.push(aabbFromCenter(
      panel.center.x,
      panel.center.y,
      panel.center.z,
      panel.size.width * 0.5,
      panel.size.height * 0.5,
      panel.size.depth * 0.5,
      { kind: 'bleacher', id: `bleacher_${panel.name}_${panel.side}` }
    ));
  }

  return boxes;
}

/**
 * The static collision boxes of the gym (bleachers + mats), computed purely from constants so
 * the authoritative server and the client's prediction resolve movement against IDENTICAL
 * geometry. These values replicate GymArena.createBleachers()/createMats() exactly. Outer walls
 * are handled by the bounds clamp, not boxes.
 */
export function createGymCollisionBoxes(): AABB[] {
  const boxes: AABB[] = createBleacherCollisionBoxes();

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
    boxes.push(aabbFromCenter(x, y, z, matHalfX, matHalfY, matHalfZ, { kind: 'mat', id: `mat_${x}_${z}` }));
  }

  return boxes;
}
