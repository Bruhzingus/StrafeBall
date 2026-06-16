import { Mesh, Vector3 } from '@babylonjs/core';
import { AABB, aabbFromCenter } from './Collider';

/** Physical dimensions of a dodgeball mat. Source of truth for both visual size and proxy AABB. */
export const MAT_DIMENSIONS = { width: 2.1, height: 1.35, depth: 0.18 };

/**
 * Gameplay representation of a dodgeball mat. Owns a collision proxy (an AABB derived from
 * MAT_DIMENSIONS) and a reference to a visual mesh it positions. The visual is created by the
 * ModelLoader and passed in, so it can become a GLB later without touching this logic.
 */
export class MatObstacle {
  public knockedOver = false;

  constructor(public readonly mesh: Mesh, position: Vector3, private readonly rotationY: number) {
    this.mesh.position.copyFrom(position);
    this.mesh.rotation.y = rotationY;
  }

  /**
   * World-space AABB. Mats sit at axis-aligned yaws (0 or ±90°), so a quarter-turn just swaps
   * the width/depth extents — no oriented-box math needed for the greybox proxy.
   */
  getAABB(): AABB {
    const quarterTurned = Math.abs(Math.round(this.rotationY / (Math.PI / 2))) % 2 === 1;
    const halfX = (quarterTurned ? MAT_DIMENSIONS.depth : MAT_DIMENSIONS.width) / 2;
    const halfZ = (quarterTurned ? MAT_DIMENSIONS.width : MAT_DIMENSIONS.depth) / 2;
    const p = this.mesh.position;
    return aabbFromCenter(p.x, p.y, p.z, halfX, MAT_DIMENSIONS.height / 2, halfZ);
  }

  knockOver(direction: Vector3): void {
    if (this.knockedOver) return;
    this.knockedOver = true;
    this.mesh.rotation.x = Math.PI / 2;
    this.mesh.position.addInPlace(direction.normalizeToNew().scale(0.35));
  }
}
