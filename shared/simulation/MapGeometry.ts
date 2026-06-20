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
export const MAT_DIMENSIONS = { width: 2.6, height: 1.75, depth: 0.18 };

/**
 * Canonical mat layout — the single source of truth for both the server's authoritative mat state
 * and the client visuals. Mats are upright cover panels. Orientation: the broad 2.1 m face runs
 * along X and the thin 0.18 m depth along Z, so the panel faces down-court (toward ±Z) and acts as
 * cover from throws — yawRadians = 0 (NOT quarter-turned). When knocked over a mat lies flat and
 * stops colliding, so its footprint is omitted from the player collision set.
 */
export interface MatSpec {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Standing yaw about Y. 0 = broad face toward ±Z (down-court cover). */
  yawRadians: number;
}

export const MAT_SPECS: readonly MatSpec[] = [
  { id: 'mat_-4.5_-5.5', x: -4.5, y: MAT_DIMENSIONS.height / 2, z: -5.5, yawRadians: 0 },
  { id: 'mat_4.5_-5.5', x: 4.5, y: MAT_DIMENSIONS.height / 2, z: -5.5, yawRadians: 0 },
  { id: 'mat_-4.5_5.5', x: -4.5, y: MAT_DIMENSIONS.height / 2, z: 5.5, yawRadians: 0 },
  { id: 'mat_4.5_5.5', x: 4.5, y: MAT_DIMENSIONS.height / 2, z: 5.5, yawRadians: 0 }
];

/**
 * Deterministic mat layouts per host `matPreset` setting (0 / 2 / 4 standing cover mats). The 2-mat
 * layout is the point-symmetric diagonal pair (one mat per spawn side, rotationally mirrored through
 * center) so neither team gets more cover — matching the court's 180° rotational symmetry. Any
 * unrecognized preset falls back to the full 4-mat layout. This is the single source of truth the
 * server's authoritative mat state AND both worlds' collision derive from, so visuals + player + ball
 * collision always agree on which mats exist.
 */
const MAT_PRESET_IDS: Record<number, readonly string[]> = {
  0: [],
  2: ['mat_-4.5_-5.5', 'mat_4.5_5.5'],
  4: MAT_SPECS.map((spec) => spec.id)
};

export function matSpecsForPreset(matPreset: number): MatSpec[] {
  const ids = MAT_PRESET_IDS[matPreset] ?? MAT_PRESET_IDS[4];
  const idSet = new Set(ids);
  return MAT_SPECS.filter((spec) => idSet.has(spec.id));
}

/** Standing-mat collision AABB for a spec. Quarter-turned mats swap width/depth extents. */
export function matCollisionBox(spec: MatSpec): AABB {
  const quarterTurned = Math.abs(Math.round(spec.yawRadians / (Math.PI / 2))) % 2 === 1;
  const halfX = (quarterTurned ? MAT_DIMENSIONS.depth : MAT_DIMENSIONS.width) / 2;
  const halfZ = (quarterTurned ? MAT_DIMENSIONS.width : MAT_DIMENSIONS.depth) / 2;
  return aabbFromCenter(spec.x, spec.y, spec.z, halfX, MAT_DIMENSIONS.height / 2, halfZ, { kind: 'mat', id: spec.id });
}
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
  for (const spec of MAT_SPECS) {
    boxes.push(matCollisionBox(spec));
  }
  return boxes;
}

/**
 * Player collision boxes given the live mat state: bleachers always collide; a mat collides only
 * while it is still standing. Knocked-over mats lie flat and become walkable, so they are omitted.
 * `knockedOverMatIds` is the set of mats currently down (empty = all standing).
 */
export function createPlayerCollisionBoxes(
  knockedOverMatIds?: ReadonlySet<string>,
  /** The mats that currently exist (active preset). Defaults to the full set for offline/legacy use. */
  activeMatSpecs: readonly MatSpec[] = MAT_SPECS
): AABB[] {
  const boxes: AABB[] = createBleacherCollisionBoxes();
  for (const spec of activeMatSpecs) {
    if (knockedOverMatIds?.has(spec.id)) continue;
    boxes.push(matCollisionBox(spec));
  }
  return boxes;
}

/**
 * Collision boxes balls bounce off: bleachers + STANDING mats. A standing mat is solid cover that
 * blocks dodgeballs (they bounce back off it); a knocked-over mat lies flat and is skipped so balls
 * pass over it. Mirrors createPlayerCollisionBoxes so player and ball worlds agree on mat state.
 */
export function createBallCollisionBoxes(
  knockedOverMatIds?: ReadonlySet<string>,
  /** The mats that currently exist (active preset). Defaults to the full set for offline/legacy use. */
  activeMatSpecs: readonly MatSpec[] = MAT_SPECS
): AABB[] {
  const boxes: AABB[] = createBleacherCollisionBoxes();
  for (const spec of activeMatSpecs) {
    if (knockedOverMatIds?.has(spec.id)) continue;
    boxes.push(matCollisionBox(spec));
  }
  return boxes;
}
