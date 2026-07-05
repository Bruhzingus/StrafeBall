/**
 * Creator Sandbox — MOVING PLATFORM runtime (offline only).
 *
 * Solid terrain objects with metadata.mover ping-pong between their placed position and
 * position+(dx,dy,dz) at `speed` m/s, dwelling `pauseSeconds` at each end. Driven by accumulated
 * elapsed time so every run is deterministic; resetPhase() re-zeros the clock (called on playtest /
 * yard entry and when a timed course run starts, so platform routes are identical every attempt).
 *
 * Per frame (BEFORE the player's movement update — the host calls update() first):
 *   1. compute this frame's offset from the pure ping-pong phase math;
 *   2. if the player is standing ON a mover, carry them by the frame delta (position write — the
 *      following movement resolution then grounds them on the moved collider, no jitter);
 *   3. translate the mover's collider entries IN PLACE (min/max + oriented cx/cz + ramp fields —
 *      never rebuilt, so gym.collision keeps the same box references) and its visual root.
 *
 * Translation only (yaw never animates), so oriented (OBB) collision stays exact while moving.
 * No per-frame allocations. Never read by the server, shared simulation, prediction, or networking.
 */

import { AABB } from '../../map/Collider';
import { PlayerController } from '../../player/PlayerController';
import { TUNING } from '../../config/tuning';
import { CreatorLayout } from './CreatorLayout';
import type { CreatorGeometry } from './CreatorGeometry';

export interface MoverSpec {
  dx: number;
  dy: number;
  dz: number;
  speed: number;
  pauseSeconds: number;
}

/**
 * Pure ping-pong phase: the travel FRACTION (0 → 1 → 0 …) at time t for a mover of `distance`
 * metres at `speed` m/s with `pauseSeconds` dwell at each end. Degenerate movers (no distance /
 * no speed) stay at 0. Exported for tests.
 */
export function moverFractionAt(tSeconds: number, distance: number, speed: number, pauseSeconds: number): number {
  if (!(distance > 1e-6) || !(speed > 1e-6) || !Number.isFinite(tSeconds)) return 0;
  const travel = distance / speed;
  const pause = Math.max(0, pauseSeconds);
  const cycle = 2 * (travel + pause);
  const t = ((tSeconds % cycle) + cycle) % cycle;
  if (t < travel) return t / travel; // outbound
  if (t < travel + pause) return 1; // dwell at the far end
  if (t < 2 * travel + pause) return 1 - (t - travel - pause) / travel; // return leg
  return 0; // dwell at home
}

/**
 * Pure standing test (exported for tests): is a grounded player at (px,py,pz) riding a box whose
 * TOP is at topY? XZ containment honours the box's yaw; the vertical band tolerates the ground
 * snap (slightly below the top) and the player origin sitting above the feet.
 */
export function standingOnMoverBox(
  box: Pick<AABB, 'minX' | 'maxX' | 'minZ' | 'maxZ' | 'ry' | 'cx' | 'cz' | 'hx' | 'hz'>,
  topY: number,
  px: number,
  py: number,
  pz: number,
  radius: number
): boolean {
  if (py < topY - 0.35 || py > topY + 2.4) return false;
  if (box.ry !== undefined && box.cx !== undefined && box.cz !== undefined && box.hx !== undefined && box.hz !== undefined) {
    // Same world→local convention as CreatorPads' oriented tests (proven against these objects).
    const cos = Math.cos(box.ry);
    const sin = Math.sin(box.ry);
    const dx = px - box.cx;
    const dz = pz - box.cz;
    const lx = cos * dx - sin * dz;
    const lz = sin * dx + cos * dz;
    return Math.abs(lx) <= box.hx + radius && Math.abs(lz) <= box.hz + radius;
  }
  return px >= box.minX - radius && px <= box.maxX + radius && pz >= box.minZ - radius && pz <= box.maxZ + radius;
}

interface MoverRuntime {
  spec: MoverSpec;
  distance: number;
  /** Live collider entries (same references gym.collision holds) + their zero-offset snapshots. */
  boxes: AABB[];
  baseBoxes: Array<{
    minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
    cx?: number; cz?: number;
    rampCenterX?: number; rampBaseY?: number; rampCenterZ?: number;
  }>;
  /** Visual root (CreatorGeometry object node) + its zero-offset position. */
  objectId: string;
  baseNodeX: number;
  baseNodeY: number;
  baseNodeZ: number;
  /** Current applied offset (metres) — the frame delta is nextOffset - this. */
  offX: number;
  offY: number;
  offZ: number;
}

export class CreatorMovers {
  private movers: MoverRuntime[] = [];
  private geometry: CreatorGeometry | null = null;
  private elapsed = 0;

  /**
   * Bind the runtime to a built world: the layout's mover objects, the ALREADY-BUILT collider list
   * (entries are matched by their `${idPrefix}${objectId}_…` ids and then mutated in place), and the
   * geometry whose object roots provide the visuals. Call after build/rebuild; cheap for no movers.
   */
  build(layout: CreatorLayout, collisionBoxes: readonly AABB[], geometry: CreatorGeometry | null, idPrefix: string): void {
    this.movers = [];
    this.geometry = geometry;
    this.elapsed = 0;
    for (const obj of layout.objects) {
      const spec = obj.metadata?.mover;
      if (!spec) continue;
      const distance = Math.hypot(spec.dx, spec.dy, spec.dz);
      const boxes = collisionBoxes.filter((b) => b.id?.startsWith(`${idPrefix}${obj.id}_`));
      this.movers.push({
        spec: { ...spec },
        distance,
        boxes,
        baseBoxes: boxes.map((b) => ({
          minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, minZ: b.minZ, maxZ: b.maxZ,
          cx: b.cx, cz: b.cz,
          rampCenterX: b.ramp?.centerX, rampBaseY: b.ramp?.baseY, rampCenterZ: b.ramp?.centerZ
        })),
        objectId: obj.id,
        baseNodeX: obj.position[0],
        baseNodeY: obj.position[1],
        baseNodeZ: obj.position[2],
        offX: 0,
        offY: 0,
        offZ: 0
      });
    }
  }

  hasMovers(): boolean {
    return this.movers.length > 0;
  }

  /** Re-zero the deterministic clock AND snap every mover home (start of a run/playtest/yard entry). */
  resetPhase(): void {
    this.elapsed = 0;
    for (const m of this.movers) this.applyOffset(m, 0, 0, 0, null);
  }

  /**
   * Advance one frame. MUST run BEFORE the player's movement update: the standing player is carried
   * by the frame delta first, then the colliders move, then movement resolves against the new boxes
   * (a rider stays grounded; a wall face shoves via normal penetration push-out).
   */
  update(dt: number, player: PlayerController | null): void {
    if (this.movers.length === 0) return;
    this.elapsed += Math.max(0, dt);
    const radius = TUNING.player.radius;
    for (const m of this.movers) {
      const f = moverFractionAt(this.elapsed, m.distance, m.spec.speed, m.spec.pauseSeconds);
      const nx = m.spec.dx * f;
      const ny = m.spec.dy * f;
      const nz = m.spec.dz * f;
      this.applyOffset(m, nx, ny, nz, player);
    }
  }

  private applyOffset(m: MoverRuntime, nx: number, ny: number, nz: number, player: PlayerController | null): void {
    const dx = nx - m.offX;
    const dy = ny - m.offY;
    const dz = nz - m.offZ;
    if (dx === 0 && dy === 0 && dz === 0) return;

    // Carry a standing rider by the frame delta BEFORE the colliders move (checked against the
    // box's CURRENT top, i.e. where the player actually stood last frame).
    if (player && player.movement.grounded) {
      const p = player.root.position;
      for (let i = 0; i < m.boxes.length; i += 1) {
        const box = m.boxes[i];
        if (standingOnMoverBox(box, box.maxY, p.x, p.y, p.z, TUNING.player.radius)) {
          p.x += dx;
          p.y += dy;
          p.z += dz;
          break;
        }
      }
    }

    for (let i = 0; i < m.boxes.length; i += 1) {
      const box = m.boxes[i];
      const base = m.baseBoxes[i];
      box.minX = base.minX + nx;
      box.maxX = base.maxX + nx;
      box.minY = base.minY + ny;
      box.maxY = base.maxY + ny;
      box.minZ = base.minZ + nz;
      box.maxZ = base.maxZ + nz;
      if (base.cx !== undefined) box.cx = base.cx + nx;
      if (base.cz !== undefined) box.cz = base.cz + nz;
      if (box.ramp && base.rampCenterX !== undefined) {
        box.ramp.centerX = base.rampCenterX + nx;
        box.ramp.baseY = (base.rampBaseY ?? 0) + ny;
        box.ramp.centerZ = (base.rampCenterZ ?? 0) + nz;
      }
    }

    const node = this.geometry?.getObjectRoot(m.objectId);
    if (node) node.position.set(m.baseNodeX + nx, m.baseNodeY + ny, m.baseNodeZ + nz);

    m.offX = nx;
    m.offY = ny;
    m.offZ = nz;
  }
}
