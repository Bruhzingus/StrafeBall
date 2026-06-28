import { aabbFromCenter, AABB } from '../map/Collider';

/**
 * Data-driven layout for the local outdoor Movement Sandbox — a large, mostly-flat free-movement
 * yard placed FAR from the gym (so the player never sees the indoor court). Everything here is plain
 * data + pure derivation: ground bounds, the outer boundary, and a flat list of standalone wall
 * descriptors (position / rotation / size / style). A future map editor can edit these descriptors
 * (and re-derive collision + wall-run faces) without touching ArenaScene or the builder.
 *
 * Local/offline-only. Nothing here is read by the server, shared simulation, prediction, or
 * networking. Coordinates are yard-LOCAL (relative to SANDBOX_CENTER); the builder adds the world
 * offset. Distances are calibrated against the real offline controller (ground ~6 m/s, soft cap 18,
 * dash +6, jump ~0.7m, wall-run climb ~3 m/s over ~2.5s) so a full-speed traversal of the yard is
 * ~10–15s and the wall-run walls are long enough for a sustained run.
 */

/** World-space centre of the yard — far from the gym (origin) so the gym is never in view. */
export const SANDBOX_CENTER = { x: 800, z: 0 } as const;

/** Half-extents of the playable ground (yard is 2*half on each axis ≈ 330 m square). */
export const SANDBOX_HALF_X = 165;
export const SANDBOX_HALF_Z = 165;

/** Movement ceiling for the yard (well above the tallest wall so wall-runs never hit it). */
export const SANDBOX_CEILING_Y = 40;

export const BOUNDARY_HEIGHT = 22;
export const BOUNDARY_THICKNESS = 3;

/** Spawn near the west-centre edge, facing +X down the long open runway (yaw π/2 ⇒ +X). */
export const SANDBOX_SPAWN_LOCAL = { x: -SANDBOX_HALF_X + 16, z: 0, yaw: Math.PI / 2 } as const;

/** Leave-course portal, just beside spawn. */
export const SANDBOX_LEAVE_LOCAL = { x: -SANDBOX_HALF_X + 8, z: 6, radius: 2.6, holdSeconds: 0.6 } as const;

export type WallStyle = 'pad' | 'concrete' | 'accent';

export interface WallDescriptor {
  id: string;
  /** Centre in yard-local XZ (relative to SANDBOX_CENTER). */
  center: { x: number; z: number };
  /** Rotation about Y (radians). v1 uses 0 / ±π/2 only; wall-run detection honours any angle, but
   *  AABB collision assumes axis-aligned — see note in MovementSandboxLayout. */
  rotationY: number;
  /** Box size, pre-rotation: width = X extent, height = Y, depth = Z extent. */
  size: { width: number; height: number; depth: number };
  style: WallStyle;
}

/**
 * Standalone wall structures. A small number of large, widely-spaced walls is the entire point of
 * the sandbox; keep big open gaps between them. L/U shapes are just several plain box walls sharing
 * an id prefix. All axis-aligned in v1 for exact, reliable collision.
 */
export const SANDBOX_WALLS: readonly WallDescriptor[] = [
  // --- Two very long parallel wall-run walls (the centrepiece), 12 m lane between, along Z ---
  { id: 'parallel_a', center: { x: 8, z: 0 }, rotationY: 0, size: { width: 3, height: 14, depth: 110 }, style: 'pad' },
  { id: 'parallel_b', center: { x: 20, z: 0 }, rotationY: 0, size: { width: 3, height: 14, depth: 110 }, style: 'pad' },

  // --- A long perpendicular wall (along X) for different approach angles ---
  { id: 'long_x', center: { x: -34, z: 74 }, rotationY: 0, size: { width: 92, height: 12, depth: 3 }, style: 'concrete' },

  // --- Two more big perpendicular/parallel walls spread across the yard for varied entry lines ---
  { id: 'perp_a', center: { x: 74, z: 42 }, rotationY: 0, size: { width: 3, height: 13, depth: 72 }, style: 'concrete' },
  { id: 'perp_b', center: { x: -62, z: -72 }, rotationY: 0, size: { width: 82, height: 12, depth: 3 }, style: 'pad' },

  // --- L-shape (corner near +X/−Z) for chaining a wall-run into a wall-jump around a corner ---
  { id: 'l_arm1', center: { x: 92, z: -70 }, rotationY: 0, size: { width: 3, height: 15, depth: 46 }, style: 'accent' },
  { id: 'l_arm2', center: { x: 70, z: -49 }, rotationY: 0, size: { width: 46, height: 15, depth: 3 }, style: 'accent' },

  // --- U-shape (opening toward +X) for wrapping wall-runs / multi-wall chains ---
  { id: 'u_back', center: { x: -122, z: 28 }, rotationY: 0, size: { width: 3, height: 16, depth: 54 }, style: 'pad' },
  { id: 'u_arm_n', center: { x: -100, z: 53 }, rotationY: 0, size: { width: 44, height: 16, depth: 3 }, style: 'pad' },
  { id: 'u_arm_s', center: { x: -100, z: 3 }, rotationY: 0, size: { width: 44, height: 16, depth: 3 }, style: 'pad' },

  // --- A couple of standalone medium walls in open ground for angled-approach practice ---
  { id: 'solo_a', center: { x: 58, z: -122 }, rotationY: 0, size: { width: 3, height: 12, depth: 42 }, style: 'concrete' },
  { id: 'solo_b', center: { x: -44, z: 120 }, rotationY: 0, size: { width: 42, height: 12, depth: 3 }, style: 'concrete' }
];

/** A vertical wall-run surface: a face line in world XZ with an outward (into open space) normal. */
export interface WallRunFace {
  nx: number;
  nz: number;
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  halfLen: number;
  topY: number;
}

export function sandboxWorldBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: SANDBOX_CENTER.x - SANDBOX_HALF_X,
    maxX: SANDBOX_CENTER.x + SANDBOX_HALF_X,
    minZ: SANDBOX_CENTER.z - SANDBOX_HALF_Z,
    maxZ: SANDBOX_CENTER.z + SANDBOX_HALF_Z
  };
}

export function sandboxSpawnWorld(): { x: number; z: number; yaw: number } {
  return { x: SANDBOX_CENTER.x + SANDBOX_SPAWN_LOCAL.x, z: SANDBOX_CENTER.z + SANDBOX_SPAWN_LOCAL.z, yaw: SANDBOX_SPAWN_LOCAL.yaw };
}

export function sandboxLeaveWorld(): { x: number; z: number; radius: number; holdSeconds: number } {
  return {
    x: SANDBOX_CENTER.x + SANDBOX_LEAVE_LOCAL.x,
    z: SANDBOX_CENTER.z + SANDBOX_LEAVE_LOCAL.z,
    radius: SANDBOX_LEAVE_LOCAL.radius,
    holdSeconds: SANDBOX_LEAVE_LOCAL.holdSeconds
  };
}

/** Player-collision AABBs for the standalone walls (world space, tagged so they're removable). */
export function buildStandaloneWallBoxes(idPrefix: string): AABB[] {
  const boxes: AABB[] = [];
  for (const wall of SANDBOX_WALLS) {
    const cx = SANDBOX_CENTER.x + wall.center.x;
    const cz = SANDBOX_CENTER.z + wall.center.z;
    // v1: axis-aligned, so the AABB is exact. (A rotated wall would need an oriented box; deferred.)
    const box = aabbFromCenter(cx, wall.size.height / 2, cz, wall.size.width / 2, wall.size.height / 2, wall.size.depth / 2);
    box.id = `${idPrefix}${wall.id}`; // tagged so it's removed cleanly on exit; no kind (not a bleacher/mat)
    boxes.push(box);
  }
  return boxes;
}

/**
 * All wall-run faces: the four vertical faces of every standalone wall (normals point OUTWARD into
 * the open yard) plus the INNER face of each of the four boundary walls (normals point inward). A
 * player within range of a face — below its top, within its span, on its open side — can wall-run it.
 */
export function buildWallRunFaces(): WallRunFace[] {
  const faces: WallRunFace[] = [];

  for (const wall of SANDBOX_WALLS) {
    const cx = SANDBOX_CENTER.x + wall.center.x;
    const cz = SANDBOX_CENTER.z + wall.center.z;
    const hw = wall.size.width / 2;
    const hd = wall.size.depth / 2;
    const top = wall.size.height;
    const cos = Math.cos(wall.rotationY);
    const sin = Math.sin(wall.rotationY);
    // Local face definitions (normal, tangent, offset along normal, half-span along tangent), then
    // rotated into world space — so this already supports angled walls for a future editor.
    const local: Array<{ n: [number, number]; t: [number, number]; off: number; half: number }> = [
      { n: [-1, 0], t: [0, 1], off: hw, half: hd }, // west
      { n: [1, 0], t: [0, 1], off: hw, half: hd },  // east
      { n: [0, -1], t: [1, 0], off: hd, half: hw },  // south
      { n: [0, 1], t: [1, 0], off: hd, half: hw }   // north
    ];
    for (const f of local) {
      const nx = f.n[0] * cos + f.n[1] * sin;
      const nz = -f.n[0] * sin + f.n[1] * cos;
      const tx = f.t[0] * cos + f.t[1] * sin;
      const tz = -f.t[0] * sin + f.t[1] * cos;
      faces.push({ nx, nz, ox: cx + nx * f.off, oz: cz + nz * f.off, tx, tz, halfLen: f.half, topY: top });
    }
  }

  // Boundary inner faces (long surfaces hugging the yard edge, normals pointing inward).
  const b = sandboxWorldBounds();
  const cz = SANDBOX_CENTER.z;
  const cx = SANDBOX_CENTER.x;
  faces.push({ nx: 1, nz: 0, ox: b.minX, oz: cz, tx: 0, tz: 1, halfLen: SANDBOX_HALF_Z, topY: BOUNDARY_HEIGHT });  // west wall, faces +X
  faces.push({ nx: -1, nz: 0, ox: b.maxX, oz: cz, tx: 0, tz: 1, halfLen: SANDBOX_HALF_Z, topY: BOUNDARY_HEIGHT }); // east wall, faces -X
  faces.push({ nx: 0, nz: 1, ox: cx, oz: b.minZ, tx: 1, tz: 0, halfLen: SANDBOX_HALF_X, topY: BOUNDARY_HEIGHT });  // south wall, faces +Z
  faces.push({ nx: 0, nz: -1, ox: cx, oz: b.maxZ, tx: 1, tz: 0, halfLen: SANDBOX_HALF_X, topY: BOUNDARY_HEIGHT }); // north wall, faces -Z

  return faces;
}
