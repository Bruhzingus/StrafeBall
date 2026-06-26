import { Mesh, Vector3 } from '@babylonjs/core';
import { AABB } from './Collider';
import { matCollisionBox, matFallDirection, matKnockedOverBox } from '../../../shared/simulation/MapGeometry';

/** Physical dimensions of a dodgeball mat. Source of truth for both visual size and proxy AABB. */
export const MAT_DIMENSIONS = { width: 2.6, height: 1.75, depth: 0.18 };

/**
 * Gameplay representation of a dodgeball mat. Owns a collision proxy (an AABB derived from
 * MAT_DIMENSIONS) and a reference to a visual mesh it positions. The visual is created by the
 * ModelLoader and passed in, so it can become a GLB later without touching this logic.
 *
 * Mats are upright cover panels: balls pass straight through them, but players collide with them.
 * A player walking into a standing mat tips it flat (it does NOT fly away) and it then lies on the
 * floor, walkable, until reset. The server is authoritative for the online knock-over; offline,
 * `knockOver` is driven by the local player walking into it.
 */
export class MatObstacle {
  public knockedOver = false;

  private readonly standingPosition: Vector3;
  // Horizontal heading the mat fell in (set on knockOver), so its flat collision box can be placed.
  private readonly knockDir = new Vector3(0, 0, 1);

  constructor(
    public readonly id: string,
    public readonly mesh: Mesh,
    position: Vector3,
    private readonly rotationY: number
  ) {
    this.standingPosition = position.clone();
    this.mesh.position.copyFrom(position);
    this.mesh.rotation.set(0, rotationY, 0);
  }

  /** Shared MatSpec view of this mat (same source of truth the server collision uses). */
  private spec(): { id: string; x: number; y: number; z: number; yawRadians: number } {
    const p = this.standingPosition;
    return { id: this.id, x: p.x, y: p.y, z: p.z, yawRadians: this.rotationY };
  }

  /**
   * World-space AABB while standing — the upright cover box (tagged kind 'mat' + id). Built from the
   * SAME shared helper the server uses so offline and online mat collision agree.
   */
  getAABB(): AABB {
    return matCollisionBox(this.spec());
  }

  /**
   * World-space AABB while knocked over: the low flat panel lying on the floor (top ~0.18 m up).
   * Balls bounce off it (and stay live) and the player steps onto it. Placed via the recorded knock
   * heading, matching the visual in knockOver().
   */
  getKnockedOverAABB(): AABB {
    return matKnockedOverBox(this.spec(), { x: this.knockDir.x, z: this.knockDir.z });
  }

  /**
   * Tip the mat flat in the (horizontal) push direction — a quarter rotation about the axis
   * perpendicular to the push, settling the panel on the floor. No translation impulse beyond
   * laying it down, so nothing "flies". Idempotent once knocked over.
   */
  knockOver(direction: Vector3): void {
    if (this.knockedOver) return;
    this.knockedOver = true;
    const flat = new Vector3(direction.x, 0, direction.z);
    const pushed = flat.lengthSquared() > 1e-4 ? flat.normalize() : new Vector3(0, 0, 1);
    const fall = matFallDirection({ x: pushed.x, z: pushed.z });
    const dir = new Vector3(fall.x, 0, fall.z);
    this.knockDir.copyFrom(dir);

    // Lay flat: rotate 90° so the broad face is up. Yaw the lying mat to the push heading and pitch
    // it down onto the floor. The fallen panel's top sits at ~depth above the floor.
    this.mesh.rotation.set(Math.PI / 2, Math.atan2(dir.x, dir.z), 0);
    this.mesh.position.set(
      this.standingPosition.x + dir.x * (MAT_DIMENSIONS.height * 0.5),
      MAT_DIMENSIONS.depth * 0.5,
      this.standingPosition.z + dir.z * (MAT_DIMENSIONS.height * 0.5)
    );
  }

  /** Restore the upright starting pose (room/practice reset). */
  reset(): void {
    this.knockedOver = false;
    this.mesh.rotation.set(0, this.rotationY, 0);
    this.mesh.position.copyFrom(this.standingPosition);
  }
}
