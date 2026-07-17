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
 *   2. carry anything riding the mover by the frame delta (position write — the following movement
 *      resolution then re-grounds/re-attaches them on the moved collider, no jitter). Three riders:
 *        - a player STANDING on top (grounded, inside the box footprint);
 *        - a player WALL-RUNNING one of its faces (airborne, hugging the side);
 *        - loose/live BALLS resting on or touching it;
 *   3. translate the mover's collider entries, wall FACES and visual root IN PLACE (never rebuilt, so
 *      gym.collision and the world's face arrays keep the same references).
 *
 * Translation only (yaw never animates — MoverSpec has no rotation field), so oriented (OBB) collision
 * stays exact while moving, and a wall face needs only 4 scalars moved (ox/oz/topY/bottomY): its
 * nx/nz/tx/tz/halfLen derive purely from the box's yaw + size, which don't change.
 *
 * No per-frame allocations. Never read by the server, shared simulation, prediction, or networking.
 */

import { AABB } from '../../map/Collider';
import { PlayerController } from '../../player/PlayerController';
import { TUNING } from '../../config/tuning';
import { CreatorLayout } from './CreatorLayout';
import type { CreatorGeometry } from './CreatorGeometry';
import type { CreatorWallFace } from './CreatorWorld';
import { WALL_RUN_MARGIN, PLAYER_BODY_HEIGHT } from './CreatorWorld';
import type { Ball } from '../../ball/Ball';
import { BallState } from '../../ball/BallState';

export interface MoverSpec {
  dx: number;
  dy: number;
  dz: number;
  speed: number;
  pauseSeconds: number;
}

/** Scratch offset, reused by offsetOf() callers that want an allocation-free per-frame query. */
export interface MoverOffset {
  x: number;
  y: number;
  z: number;
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

/**
 * Pure wall-run rider test (exported for tests): is a player at (px,py,pz) — whose active wall-run
 * normal is (wnx,wnz) — hugging `face`?
 *
 * This is deliberately the SAME geometry creatorWallNormalAt uses to hand out that normal (feet below
 * the face top, body reaching its bottom, within WALL_RUN_MARGIN along the outward normal, inside the
 * tangent span), plus a normal match. The normal match is what stops a mover stealing a rider off a
 * DIFFERENT wall that happens to sit within a metre of one of its faces — the player is only carried
 * by the wall they're actually attached to.
 */
export function wallRunningOnMoverFace(
  face: CreatorWallFace,
  wnx: number,
  wnz: number,
  px: number,
  py: number,
  pz: number
): boolean {
  // Same wall? Both are unit XZ normals, so a dot near 1 means the same facing.
  if (face.nx * wnx + face.nz * wnz < 0.99) return false;
  if (py > face.topY) return false;
  if (py + PLAYER_BODY_HEIGHT < face.bottomY) return false;
  const d = (px - face.ox) * face.nx + (pz - face.oz) * face.nz; // distance along the outward normal
  if (d < 0 || d > WALL_RUN_MARGIN) return false;
  const t = (px - face.ox) * face.tx + (pz - face.oz) * face.tz; // position along the face tangent
  return t >= -face.halfLen && t <= face.halfLen;
}

/**
 * Pure ball rider test (exported for tests): is a ball of `radius` at (bx,by,bz) resting on the TOP
 * of a box whose top is at topY? Deliberately narrower than the player's: a ball is a point + radius,
 * so the vertical band is tight (it must be sitting ON the surface, not merely above it) and the
 * footprint isn't padded by a body radius.
 */
export function ballRidingMoverBox(
  box: Pick<AABB, 'minX' | 'maxX' | 'minZ' | 'maxZ' | 'ry' | 'cx' | 'cz' | 'hx' | 'hz'>,
  topY: number,
  bx: number,
  by: number,
  bz: number,
  radius: number
): boolean {
  if (by < topY + radius - 0.12 || by > topY + radius + 0.35) return false;
  if (box.ry !== undefined && box.cx !== undefined && box.cz !== undefined && box.hx !== undefined && box.hz !== undefined) {
    const cos = Math.cos(box.ry);
    const sin = Math.sin(box.ry);
    const dx = bx - box.cx;
    const dz = bz - box.cz;
    const lx = cos * dx - sin * dz;
    const lz = sin * dx + cos * dz;
    return Math.abs(lx) <= box.hx + radius && Math.abs(lz) <= box.hz + radius;
  }
  return bx >= box.minX - radius && bx <= box.maxX + radius && bz >= box.minZ - radius && bz <= box.maxZ + radius;
}

interface MoverRuntime {
  spec: MoverSpec;
  distance: number;
  /**
   * This mover's OWN phase clock (seconds), advanced by dt only while `running`. Per-mover rather
   * than one shared clock so a trigger can pause/resume a single platform: a continuously-running
   * mover's phase tracks the global elapsed exactly, so nothing changes for platforms no trigger
   * touches. Frozen (not reset) by a stop, so a resume continues from where it was.
   */
  phase: number;
  running: boolean;
  /** Home run-state, restored by resetPhase(): a startPaused platform waits for a trigger. */
  startsRunning: boolean;
  /** Live collider entries (same references gym.collision holds) + their zero-offset snapshots. */
  boxes: AABB[];
  baseBoxes: Array<{
    minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
    cx?: number; cz?: number;
    rampCenterX?: number; rampBaseY?: number; rampCenterZ?: number;
  }>;
  /** Live wall faces (same references the world's query arrays hold) + their zero-offset snapshots. */
  faces: CreatorWallFace[];
  baseFaces: Array<{ ox: number; oz: number; topY: number; bottomY: number }>;
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
  private readonly byObjectId = new Map<string, MoverRuntime>();
  private geometry: CreatorGeometry | null = null;
  /** Balls to carry, injected by the host (offline creator actors only). Empty when there are none. */
  private balls: readonly Ball[] = [];

  /**
   * Bind the runtime to a built world: the layout's mover objects, the ALREADY-BUILT collider list
   * (entries are matched by their `${idPrefix}${objectId}_…` ids and then mutated in place), the
   * ALREADY-BUILT wall face arrays (matched by face.objectId), and the geometry whose object roots
   * provide the visuals. Call after build/rebuild; cheap for no movers.
   *
   * The face arrays are REQUIRED, not optional, on purpose: CreatorWorld and MovementSandbox each own
   * a separate copy of the movement world, and a host that forgot to pass its faces would silently
   * ship static walls on moving platforms. Making it a compile error keeps the two hosts at parity.
   */
  build(
    layout: CreatorLayout,
    collisionBoxes: readonly AABB[],
    geometry: CreatorGeometry | null,
    idPrefix: string,
    wallRunFaces: readonly CreatorWallFace[],
    wallBounceFaces: readonly CreatorWallFace[]
  ): void {
    this.movers = [];
    this.byObjectId.clear();
    this.geometry = geometry;
    for (const obj of layout.objects) {
      const spec = obj.metadata?.mover;
      if (!spec) continue;
      const distance = Math.hypot(spec.dx, spec.dy, spec.dz);
      // Colliders are matched on the `${objId}_` PREFIX (the trailing underscore is load-bearing —
      // without it `obj_1` would also swallow `obj_10`'s boxes). Faces carry the real id, so they
      // match on exact equality and don't re-create that hazard. Boundary faces have no objectId and
      // can therefore never be claimed here.
      const boxes = collisionBoxes.filter((b) => b.id?.startsWith(`${idPrefix}${obj.id}_`));
      const faces = [
        ...wallRunFaces.filter((f) => f.objectId === obj.id),
        ...wallBounceFaces.filter((f) => f.objectId === obj.id)
      ];
      const runtime: MoverRuntime = {
        spec: { ...spec },
        distance,
        phase: 0,
        running: spec.startPaused !== true,
        startsRunning: spec.startPaused !== true,
        boxes,
        baseBoxes: boxes.map((b) => ({
          minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, minZ: b.minZ, maxZ: b.maxZ,
          cx: b.cx, cz: b.cz,
          rampCenterX: b.ramp?.centerX, rampBaseY: b.ramp?.baseY, rampCenterZ: b.ramp?.centerZ
        })),
        faces,
        baseFaces: faces.map((f) => ({ ox: f.ox, oz: f.oz, topY: f.topY, bottomY: f.bottomY })),
        objectId: obj.id,
        baseNodeX: obj.position[0],
        baseNodeY: obj.position[1],
        baseNodeZ: obj.position[2],
        offX: 0,
        offY: 0,
        offZ: 0
      };
      this.movers.push(runtime);
      this.byObjectId.set(obj.id, runtime);
    }
  }

  /** Balls the movers should carry (offline creator actors). Pass [] to carry none. */
  setBalls(balls: readonly Ball[]): void {
    this.balls = balls;
  }

  hasMovers(): boolean {
    return this.movers.length > 0;
  }

  /**
   * Current world offset of `objectId`'s platform, written into `out`; false when the object isn't a
   * mover (leaving `out` untouched). The layout stores an object's AUTHORED position and movers never
   * write back to it, so every runtime that reads obj.position — trigger volumes, ability pads, kill
   * blocks, course gates — must add this to follow a platform. Out-param, not a fresh object: every
   * caller runs per-frame and this file is deliberately allocation-free.
   */
  offsetOf(objectId: string, out: MoverOffset): boolean {
    const m = this.byObjectId.get(objectId);
    if (!m) return false;
    out.x = m.offX;
    out.y = m.offY;
    out.z = m.offZ;
    return true;
  }

  /**
   * Re-zero every mover's clock, restore its home run-state, AND snap it home (start of a
   * run/playtest/yard entry). A startPaused platform is parked and NOT running until a trigger starts
   * it — so trigger-driven routes are as repeatable as free-running ones: identical at t=0 every
   * attempt, then driven purely by (deterministic) player input.
   */
  resetPhase(): void {
    for (const m of this.movers) {
      m.phase = 0;
      m.running = m.startsRunning;
      this.applyOffset(m, 0, 0, 0, null);
    }
  }

  /**
   * Advance one frame. MUST run BEFORE the player's movement update: riders are carried by the frame
   * delta first, then the colliders + faces move, then movement resolves against the new positions
   * (a rider stays grounded / stays attached; a wall face shoves via normal penetration push-out).
   */
  update(dt: number, player: PlayerController | null): void {
    if (this.movers.length === 0) return;
    const step = Math.max(0, dt);
    for (const m of this.movers) {
      if (m.running) m.phase += step;
      const f = moverFractionAt(m.phase, m.distance, m.spec.speed, m.spec.pauseSeconds);
      this.applyOffset(m, m.spec.dx * f, m.spec.dy * f, m.spec.dz * f, player);
    }
  }

  /**
   * Start or stop a single platform's motion (trigger effects mover_start / mover_stop). A stop
   * freezes it exactly where it is; a start resumes from there. No-op for a non-mover id. Returns
   * true if it addressed a mover, so a trigger can tell whether the target was a platform at all.
   */
  setMoverRunning(objectId: string, running: boolean): boolean {
    const m = this.byObjectId.get(objectId);
    if (!m) return false;
    m.running = running;
    return true;
  }

  /** Is this platform currently moving? (For toggle triggers + the inspector read-out.) */
  isMoverRunning(objectId: string): boolean {
    return this.byObjectId.get(objectId)?.running ?? false;
  }

  private applyOffset(m: MoverRuntime, nx: number, ny: number, nz: number, player: PlayerController | null): void {
    const dx = nx - m.offX;
    const dy = ny - m.offY;
    const dz = nz - m.offZ;
    if (dx === 0 && dy === 0 && dz === 0) return;

    // Carry riders by the frame delta BEFORE the colliders/faces move — i.e. tested against where the
    // mover actually WAS while they were riding it last frame.
    if (player) this.carryPlayer(m, dx, dy, dz, player);
    if (this.balls.length > 0) this.carryBalls(m, dx, dy, dz);

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

    // Wall faces: only the 4 position scalars move. Recomputed from the base (not incremented) so a
    // long session can't accumulate float drift, exactly like the colliders above.
    for (let i = 0; i < m.faces.length; i += 1) {
      const face = m.faces[i];
      const base = m.baseFaces[i];
      face.ox = base.ox + nx;
      face.oz = base.oz + nz;
      face.topY = base.topY + ny;
      face.bottomY = base.bottomY + ny;
    }

    const node = this.geometry?.getObjectRoot(m.objectId);
    if (node) node.position.set(m.baseNodeX + nx, m.baseNodeY + ny, m.baseNodeZ + nz);

    m.offX = nx;
    m.offY = ny;
    m.offZ = nz;
  }

  /**
   * Carry the player if they're riding this mover — standing on top OR wall-running one of its faces.
   * Both channels exist because a platform must behave as ONE solid: without the wall-run channel,
   * moving the faces alone would be cosmetic (a platform at the shipped speeds outruns the 1m attach
   * margin within a few frames, so the run would just drop).
   */
  private carryPlayer(m: MoverRuntime, dx: number, dy: number, dz: number, player: PlayerController): void {
    const p = player.root.position;
    const radius = TUNING.player.radius;

    if (player.movement.grounded) {
      for (let i = 0; i < m.boxes.length; i += 1) {
        const box = m.boxes[i];
        if (box.enabled === false) continue; // intangible: the player fell through, not riding it
        if (standingOnMoverBox(box, box.maxY, p.x, p.y, p.z, radius)) {
          p.x += dx;
          p.y += dy;
          p.z += dz;
          return;
        }
      }
      return; // grounded on something else — a wall-run can't also be active
    }

    const wallNormal = player.movement.activeWallNormal();
    if (!wallNormal) return;
    for (let i = 0; i < m.faces.length; i += 1) {
      if (wallRunningOnMoverFace(m.faces[i], wallNormal.x, wallNormal.z, p.x, p.y, p.z)) {
        p.x += dx;
        p.y += dy;
        p.z += dz;
        return;
      }
    }
  }

  /** Carry loose/live balls resting on this mover, so a ball on a platform rides instead of jittering. */
  private carryBalls(m: MoverRuntime, dx: number, dy: number, dz: number): void {
    const radius = TUNING.ball.radius;
    for (const ball of this.balls) {
      // A held ball is pinned to the hand every frame; carrying it would fight that write.
      if (ball.state === BallState.Held) continue;
      const p = ball.mesh.position;
      for (let i = 0; i < m.boxes.length; i += 1) {
        const box = m.boxes[i];
        if (box.enabled === false) continue; // intangible: the ball fell through, not riding it
        if (ballRidingMoverBox(box, box.maxY, p.x, p.y, p.z, radius)) {
          p.x += dx;
          p.y += dy;
          p.z += dz;
          break;
        }
      }
    }
  }
}
