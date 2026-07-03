// Lightweight axis-aligned bounding box collision for the greybox.
// All static map geometry the player and balls should collide with (bleachers, mats)
// is reduced to AABBs and resolved with simple minimum-translation push-out. This is
// deliberately allocation-free in the hot path and easy to move server-side later.

export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  kind?: 'bleacher' | 'mat';
  id?: string;
  /**
   * Optional oriented (Y-rotated) box. When set, collision resolves EXACTLY in the box's local frame
   * instead of using the enclosing min/max — so a rotated wall collides as its true thin footprint, not
   * a fat axis-aligned square. minX..maxZ still hold the enclosing AABB (broad-phase + fallback). Only
   * the offline MovementController honours this; anything AABB-only (balls, gym) sees the enclosing box.
   */
  ry?: number; // Y rotation, radians
  cx?: number; // center X
  cz?: number; // center Z
  hx?: number; // half-extent along the box's local X
  hz?: number; // half-extent along the box's local Z
  /**
   * Optional smooth ramp prism. min/max still hold the enclosing AABB for broad-phase/removal, while
   * ramp data lets the offline player resolver use the sloped top plane instead of treating it as a
   * full rectangular block. Non-ramp code can ignore this and keep seeing a conservative AABB.
   */
  ramp?: RampCollider;
}

export interface RampCollider {
  centerX: number;
  baseY: number;
  centerZ: number;
  width: number;
  height: number;
  depth: number;
  ry: number;
  normalX: number;
  normalY: number;
  normalZ: number;
}

/**
 * Build a Y-rotated (oriented) box collider. min/max are the enclosing AABB; the oriented fields let
 * the offline resolver push out along the box's real faces. Half-extents hx/hz are along the box's
 * OWN local X/Z (pre-rotation).
 */
export function orientedAabb(
  centerX: number,
  centerY: number,
  centerZ: number,
  halfX: number,
  halfY: number,
  halfZ: number,
  ry: number
): AABB {
  const c = Math.abs(Math.cos(ry));
  const s = Math.abs(Math.sin(ry));
  const ex = halfX * c + halfZ * s;
  const ez = halfX * s + halfZ * c;
  return {
    minX: centerX - ex,
    maxX: centerX + ex,
    minY: centerY - halfY,
    maxY: centerY + halfY,
    minZ: centerZ - ez,
    maxZ: centerZ + ez,
    ry,
    cx: centerX,
    cz: centerZ,
    hx: halfX,
    hz: halfZ
  };
}

/** Build the enclosing AABB + exact top-plane metadata for a smooth wedge ramp. */
export function rampAabb(
  centerX: number,
  baseY: number,
  centerZ: number,
  width: number,
  height: number,
  depth: number,
  ry: number
): AABB {
  const c = Math.abs(Math.cos(ry));
  const s = Math.abs(Math.sin(ry));
  const ex = (width / 2) * c + (depth / 2) * s;
  const ez = (width / 2) * s + (depth / 2) * c;
  const slope = height / Math.max(0.0001, width);
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  const nLen = Math.hypot(slope, 1);
  return {
    minX: centerX - ex,
    maxX: centerX + ex,
    minY: baseY,
    maxY: baseY + height,
    minZ: centerZ - ez,
    maxZ: centerZ + ez,
    ramp: {
      centerX,
      baseY,
      centerZ,
      width,
      height,
      depth,
      ry,
      normalX: (-slope * cos) / nLen,
      normalY: 1 / nLen,
      normalZ: (slope * sin) / nLen
    }
  };
}

/** Build an AABB from a center and half-extents (the natural form for box meshes). */
export function aabbFromCenter(
  centerX: number,
  centerY: number,
  centerZ: number,
  halfX: number,
  halfY: number,
  halfZ: number
): AABB {
  return {
    minX: centerX - halfX,
    maxX: centerX + halfX,
    minY: centerY - halfY,
    maxY: centerY + halfY,
    minZ: centerZ - halfZ,
    maxZ: centerZ + halfZ
  };
}

export class CollisionWorld {
  constructor(public readonly boxes: AABB[] = []) {}

  add(box: AABB): void {
    this.boxes.push(box);
  }
}
