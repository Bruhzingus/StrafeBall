/**
 * Creator Sandbox — the offline MovementWorld derived from a layout.
 *
 * In Playtest Mode the real offline MovementController is driven against this world: it provides the
 * expanded XZ bounds + ceiling for the position clamp, wall-run faces, and wall-bounce faces.
 * It mirrors the MovementSandbox's MovementWorld implementation exactly (so wall-run/wall-jump feel
 * identical), but the faces + bounds come from the editable layout instead of the static descriptors.
 *
 * Local/offline only. Never read by the server, shared simulation, prediction, or networking.
 */

import { Vector3 } from '@babylonjs/core';
import { AABB, aabbFromCenter, orientedAabb, rampAabb } from '../../map/Collider';
import { MovementWorld } from '../../player/MovementController';
import { SANDBOX_CENTER, SANDBOX_CEILING_Y } from '../MovementSandboxLayout';
import {
  CreatorLayout,
  objectCollisionBoxes,
  objectCollisionRamps,
  orientedBoxAabb,
  type OrientedBox
} from './CreatorLayout';

/** How far off a face the player can be and still attach to it. Exported so the mover runtime's
 *  rider test uses the exact same reach the face query does. */
export const WALL_RUN_MARGIN = 1.0;
/** Vertical reach used to test face overlap against the player's body (feet y is what's queried). */
export const PLAYER_BODY_HEIGHT = 1.8;

/** A vertical wall-run surface (face line in world XZ with an outward normal). */
export interface CreatorWallFace {
  nx: number;
  nz: number;
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  halfLen: number;
  topY: number;
  /** Bottom of the physical face. Faces don't extend below their box (floating platforms). */
  bottomY: number;
  /**
   * Owning layout object, so the mover runtime can find and translate this face each frame (exactly
   * as it does the object's colliders). Left UNDEFINED for the yard boundary faces — they belong to
   * no object and must never be claimed by a mover.
   */
  objectId?: string;
  /** When false the face is skipped by the wall query — an object whose collision a trigger turned
   *  off is also un-wall-runnable. Undefined ⇒ active, so untouched faces are unaffected. */
  enabled?: boolean;
}

/** The four vertical wall-run faces of one oriented box (normals point outward). */
function boxFaces(box: OrientedBox, objectId: string): CreatorWallFace[] {
  const cos = Math.cos(box.ry);
  const sin = Math.sin(box.ry);
  const hw = box.w / 2;
  const hd = box.d / 2;
  const top = box.cy + box.h / 2;
  const bottom = box.cy - box.h / 2;
  const local: Array<{ n: [number, number]; t: [number, number]; off: number; half: number }> = [
    { n: [-1, 0], t: [0, 1], off: hw, half: hd },
    { n: [1, 0], t: [0, 1], off: hw, half: hd },
    { n: [0, -1], t: [1, 0], off: hd, half: hw },
    { n: [0, 1], t: [1, 0], off: hd, half: hw }
  ];
  const faces: CreatorWallFace[] = [];
  for (const f of local) {
    const nx = f.n[0] * cos + f.n[1] * sin;
    const nz = -f.n[0] * sin + f.n[1] * cos;
    const tx = f.t[0] * cos + f.t[1] * sin;
    const tz = -f.t[0] * sin + f.t[1] * cos;
    faces.push({ nx, nz, ox: box.cx + nx * f.off, oz: box.cz + nz * f.off, tx, tz, halfLen: f.half, topY: top, bottomY: bottom, objectId });
  }
  return faces;
}

/**
 * Nearest face within range whose vertical band overlaps the player's body, else null.
 * The ONE face query for both wall-run and wall-bounce, shared by CreatorWorld (editor playtest)
 * and MovementSandbox (the yard) so course walls always feel identical in both.
 *
 * `y` is the player's FEET height (MovementController root). A face counts while the feet are below
 * its top (can't ride above a wall) AND the body still reaches its bottom — without the bottom
 * check, floating platforms projected phantom faces all the way to the ground, which both allowed
 * bouncing off empty air below them and could hijack the query from the REAL wall behind it (the
 * reported "wall bounce doesn't work / picks the wrong wall" in stacked-box courses).
 */
export function creatorWallNormalAt(faces: readonly CreatorWallFace[], x: number, z: number, y: number): Vector3 | null {
  let best: CreatorWallFace | null = null;
  let bestDist = WALL_RUN_MARGIN;
  for (const f of faces) {
    if (f.enabled === false) continue; // trigger-disabled collision: no wall-run either
    if (y > f.topY) continue;
    if (y + PLAYER_BODY_HEIGHT < f.bottomY) continue;
    const d = (x - f.ox) * f.nx + (z - f.oz) * f.nz; // distance along the outward normal
    if (d < 0 || d > bestDist) continue;
    const t = (x - f.ox) * f.tx + (z - f.oz) * f.tz; // position along the face tangent
    if (t < -f.halfLen || t > f.halfLen) continue;
    best = f;
    bestDist = d;
  }
  return best ? new Vector3(best.nx, 0, best.nz) : null;
}

export interface CreatorWorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function layoutWorldBounds(layout: CreatorLayout): CreatorWorldBounds {
  const halfX = Math.max(10, layout.ground.bounds.width / 2);
  const halfZ = Math.max(10, layout.ground.bounds.depth / 2);
  return {
    minX: SANDBOX_CENTER.x - halfX,
    maxX: SANDBOX_CENTER.x + halfX,
    minZ: SANDBOX_CENTER.z - halfZ,
    maxZ: SANDBOX_CENTER.z + halfZ
  };
}

/** Player-collision AABBs for every solid, collision-enabled module (tagged so they're removable). */
export function buildCreatorCollisionBoxes(layout: CreatorLayout, idPrefix: string): AABB[] {
  const boxes: AABB[] = [];
  for (const obj of layout.objects) {
    const subs = objectCollisionBoxes(obj);
    for (let i = 0; i < subs.length; i += 1) {
      const s = subs[i];
      // Rotated sub-boxes become true oriented colliders (exact push-out); axis-aligned ones (ry≈0/90°)
      // stay plain AABBs — their enclosing box is already exact, keeping the proven fast path.
      const nearAxis = Math.abs(Math.sin(s.ry)) < 1e-3 || Math.abs(Math.cos(s.ry)) < 1e-3;
      let box: AABB;
      if (nearAxis) {
        const a = orientedBoxAabb(s);
        box = aabbFromCenter((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, (a.maxY - a.minY) / 2, (a.maxZ - a.minZ) / 2);
      } else {
        box = orientedAabb(s.cx, s.cy, s.cz, s.w / 2, s.h / 2, s.d / 2, s.ry);
      }
      box.id = `${idPrefix}${obj.id}_${i}`;
      boxes.push(box);
    }
    const ramps = objectCollisionRamps(obj);
    for (let i = 0; i < ramps.length; i += 1) {
      const r = ramps[i];
      const box = rampAabb(r.cx, r.baseY, r.cz, r.w, r.h, r.d, r.ry);
      box.id = `${idPrefix}${obj.id}_ramp_${i}`;
      boxes.push(box);
    }
  }
  return boxes;
}

/** Add the four inward-facing yard boundary surfaces. */
function appendBoundaryFaces(faces: CreatorWallFace[], layout: CreatorLayout): void {
  const b = layoutWorldBounds(layout);
  const cx = SANDBOX_CENTER.x;
  const cz = SANDBOX_CENTER.z;
  const halfX = (b.maxX - b.minX) / 2;
  const halfZ = (b.maxZ - b.minZ) / 2;
  const BOUNDARY_BOTTOM = -1000; // boundary walls reach the floor whatever the ground height is
  faces.push({ nx: 1, nz: 0, ox: b.minX, oz: cz, tx: 0, tz: 1, halfLen: halfZ, topY: SANDBOX_CEILING_Y, bottomY: BOUNDARY_BOTTOM });
  faces.push({ nx: -1, nz: 0, ox: b.maxX, oz: cz, tx: 0, tz: 1, halfLen: halfZ, topY: SANDBOX_CEILING_Y, bottomY: BOUNDARY_BOTTOM });
  faces.push({ nx: 0, nz: 1, ox: cx, oz: b.minZ, tx: 1, tz: 0, halfLen: halfX, topY: SANDBOX_CEILING_Y, bottomY: BOUNDARY_BOTTOM });
  faces.push({ nx: 0, nz: -1, ox: cx, oz: b.maxZ, tx: 1, tz: 0, halfLen: halfX, topY: SANDBOX_CEILING_Y, bottomY: BOUNDARY_BOTTOM });
}

function buildCreatorSurfaceFaces(layout: CreatorLayout, kind: 'run' | 'bounce'): CreatorWallFace[] {
  const faces: CreatorWallFace[] = [];
  for (const obj of layout.objects) {
    // Independent per-object toggles: an author can make a wall bounce-only (wallrun off),
    // run-only (wallbounce off), or fully inert (both off). Missing = enabled, like old layouts.
    if (kind === 'run' && obj.wallrunEnabled === false) continue;
    if (kind === 'bounce' && obj.wallbounceEnabled === false) continue;
    // Moving platforms DO contribute faces, by the same toggles as any other solid. Each face carries
    // its objectId so CreatorMovers can translate it every frame alongside the object's colliders —
    // the mover only ever translates (its yaw never animates), and nx/nz/tx/tz/halfLen derive purely
    // from the box's yaw + size, so a moving face stays exact with 4 scalars updated.
    for (const box of objectCollisionBoxes(obj)) faces.push(...boxFaces(box, obj.id));
  }

  appendBoundaryFaces(faces, layout);
  return faces;
}

/** All wall-run faces: wallrun-enabled solid boxes + the four inner boundary faces. */
export function buildCreatorWallFaces(layout: CreatorLayout): CreatorWallFace[] {
  return buildCreatorSurfaceFaces(layout, 'run');
}

/** All wall-bounce faces: wallbounce-enabled solid boxes + the four inner boundary faces. */
export function buildCreatorWallBounceFaces(layout: CreatorLayout): CreatorWallFace[] {
  return buildCreatorSurfaceFaces(layout, 'bounce');
}

export class CreatorWorld implements MovementWorld {
  public minX = 0;
  public maxX = 0;
  public minZ = 0;
  public maxZ = 0;
  public readonly ceilingY = SANDBOX_CEILING_Y;
  public floorY = 0;

  private wallRunFaces: CreatorWallFace[] = [];
  private wallBounceFaces: CreatorWallFace[] = [];

  constructor(layout: CreatorLayout) {
    this.rebuild(layout);
  }

  /** Recompute bounds + movement surfaces from the (edited) layout. Cheap; call on layout change. */
  rebuild(layout: CreatorLayout): void {
    const b = layoutWorldBounds(layout);
    this.minX = b.minX;
    this.maxX = b.maxX;
    this.minZ = b.minZ;
    this.maxZ = b.maxZ;
    this.floorY = layout.ground.bounds.y ?? 0;
    this.wallRunFaces = buildCreatorWallFaces(layout);
    this.wallBounceFaces = buildCreatorWallBounceFaces(layout);
  }

  wallNormalAt(x: number, z: number, y: number): Vector3 | null {
    return creatorWallNormalAt(this.wallRunFaces, x, z, y);
  }

  wallBounceNormalAt(x: number, z: number, y: number): Vector3 | null {
    return creatorWallNormalAt(this.wallBounceFaces, x, z, y);
  }

  /**
   * The live face arrays, for CreatorMovers to bind to and translate in place. These are the SAME
   * arrays the queries above read, and `rebuild()` REPLACES them — so anything holding them must
   * re-bind after every rebuild (CreatorEditor.installWorldAndCollision does, in that order).
   */
  runFaces(): CreatorWallFace[] {
    return this.wallRunFaces;
  }

  bounceFaces(): CreatorWallFace[] {
    return this.wallBounceFaces;
  }
}
