/**
 * Creator Sandbox — the offline MovementWorld derived from a layout.
 *
 * In Playtest Mode the real offline MovementController is driven against this world: it provides the
 * expanded XZ bounds + ceiling for the position clamp and the wall-run faces for every solid module.
 * It mirrors the MovementSandbox's MovementWorld implementation exactly (so wall-run/wall-jump feel
 * identical), but the faces + bounds come from the editable layout instead of the static descriptors.
 *
 * Local/offline only. Never read by the server, shared simulation, prediction, or networking.
 */

import { Vector3 } from '@babylonjs/core';
import { AABB, aabbFromCenter } from '../../map/Collider';
import { MovementWorld } from '../../player/MovementController';
import { SANDBOX_CENTER, SANDBOX_CEILING_Y } from '../MovementSandboxLayout';
import {
  CreatorLayout,
  objectCollisionBoxes,
  orientedBoxAabb,
  type OrientedBox
} from './CreatorLayout';

const WALL_RUN_MARGIN = 1.0;

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
}

/** The four vertical wall-run faces of one oriented box (normals point outward). */
function boxFaces(box: OrientedBox): CreatorWallFace[] {
  const cos = Math.cos(box.ry);
  const sin = Math.sin(box.ry);
  const hw = box.w / 2;
  const hd = box.d / 2;
  const top = box.cy + box.h / 2;
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
    faces.push({ nx, nz, ox: box.cx + nx * f.off, oz: box.cz + nz * f.off, tx, tz, halfLen: f.half, topY: top });
  }
  return faces;
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
      const a = orientedBoxAabb(subs[i]);
      const cx = (a.minX + a.maxX) / 2;
      const cy = (a.minY + a.maxY) / 2;
      const cz = (a.minZ + a.maxZ) / 2;
      const box = aabbFromCenter(cx, cy, cz, (a.maxX - a.minX) / 2, (a.maxY - a.minY) / 2, (a.maxZ - a.minZ) / 2);
      box.id = `${idPrefix}${obj.id}_${i}`;
      boxes.push(box);
    }
  }
  return boxes;
}

/** All wall-run faces: every solid box's four faces + the four inner boundary faces. */
export function buildCreatorWallFaces(layout: CreatorLayout): CreatorWallFace[] {
  const faces: CreatorWallFace[] = [];
  for (const obj of layout.objects) {
    for (const box of objectCollisionBoxes(obj)) faces.push(...boxFaces(box));
  }

  const b = layoutWorldBounds(layout);
  const cx = SANDBOX_CENTER.x;
  const cz = SANDBOX_CENTER.z;
  const halfX = (b.maxX - b.minX) / 2;
  const halfZ = (b.maxZ - b.minZ) / 2;
  faces.push({ nx: 1, nz: 0, ox: b.minX, oz: cz, tx: 0, tz: 1, halfLen: halfZ, topY: SANDBOX_CEILING_Y });
  faces.push({ nx: -1, nz: 0, ox: b.maxX, oz: cz, tx: 0, tz: 1, halfLen: halfZ, topY: SANDBOX_CEILING_Y });
  faces.push({ nx: 0, nz: 1, ox: cx, oz: b.minZ, tx: 1, tz: 0, halfLen: halfX, topY: SANDBOX_CEILING_Y });
  faces.push({ nx: 0, nz: -1, ox: cx, oz: b.maxZ, tx: 1, tz: 0, halfLen: halfX, topY: SANDBOX_CEILING_Y });
  return faces;
}

export class CreatorWorld implements MovementWorld {
  public minX = 0;
  public maxX = 0;
  public minZ = 0;
  public maxZ = 0;
  public readonly ceilingY = SANDBOX_CEILING_Y;

  private faces: CreatorWallFace[] = [];

  constructor(layout: CreatorLayout) {
    this.rebuild(layout);
  }

  /** Recompute bounds + wall-run faces from the (edited) layout. Cheap; call on layout change. */
  rebuild(layout: CreatorLayout): void {
    const b = layoutWorldBounds(layout);
    this.minX = b.minX;
    this.maxX = b.maxX;
    this.minZ = b.minZ;
    this.maxZ = b.maxZ;
    this.faces = buildCreatorWallFaces(layout);
  }

  wallNormalAt(x: number, z: number, y: number): Vector3 | null {
    let best: CreatorWallFace | null = null;
    let bestDist = WALL_RUN_MARGIN;
    for (const f of this.faces) {
      if (y > f.topY) continue;
      const d = (x - f.ox) * f.nx + (z - f.oz) * f.nz;
      if (d < 0 || d > bestDist) continue;
      const t = (x - f.ox) * f.tx + (z - f.oz) * f.tz;
      if (t < -f.halfLen || t > f.halfLen) continue;
      best = f;
      bestDist = d;
    }
    return best ? new Vector3(best.nx, 0, best.nz) : null;
  }
}
