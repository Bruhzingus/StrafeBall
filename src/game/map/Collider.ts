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
