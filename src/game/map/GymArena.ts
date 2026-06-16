import { Scene, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { MatObstacle, MAT_DIMENSIONS } from './MatObstacle';
import { CollisionWorld, aabbFromCenter } from './Collider';
import { ModelLoader } from '../assets/ModelLoader';

/**
 * Builds the greybox gym. Each piece is split into two independent concerns:
 *   - VISUAL: a mesh requested from the ModelLoader by asset key (swappable for a GLB later).
 *   - PROXY:  collision is an AABB in `collision` (bleachers/mats) or the player bounds clamp
 *             (outer walls). Gameplay never reads the visual geometry.
 */
export class GymArena {
  public readonly mats: MatObstacle[] = [];
  public readonly collision = new CollisionWorld();

  constructor(private readonly scene: Scene, private readonly loader: ModelLoader) {}

  build(): void {
    this.createFloor();
    this.createWalls();
    this.createCourtLines();
    this.createBleachers();
    this.createMats();
    this.createTargetDummies();
  }

  private createFloor(): void {
    this.loader.createVisual('floor', {
      name: 'gym_floor',
      size: { width: TUNING.map.halfWidth * 2, depth: TUNING.map.halfLength * 2, height: 0.08 },
      position: new Vector3(0, -0.04, 0)
    });
  }

  private createWalls(): void {
    const h = TUNING.map.wallHeight;
    const t = 0.35;
    const walls = [
      { name: 'north_wall', position: new Vector3(0, h / 2, TUNING.map.halfLength + t / 2), size: { width: TUNING.map.halfWidth * 2, height: h, depth: t } },
      { name: 'south_wall', position: new Vector3(0, h / 2, -TUNING.map.halfLength - t / 2), size: { width: TUNING.map.halfWidth * 2, height: h, depth: t } },
      { name: 'east_wall', position: new Vector3(TUNING.map.halfWidth + t / 2, h / 2, 0), size: { width: t, height: h, depth: TUNING.map.halfLength * 2 } },
      { name: 'west_wall', position: new Vector3(-TUNING.map.halfWidth - t / 2, h / 2, 0), size: { width: t, height: h, depth: TUNING.map.halfLength * 2 } }
    ];

    for (const wall of walls) {
      this.loader.createVisual('wall', { name: wall.name, size: wall.size, position: wall.position });
    }
  }

  private createCourtLines(): void {
    this.loader.createVisual('line', {
      name: 'center_line',
      size: { width: TUNING.map.halfWidth * 2, height: 0.015, depth: 0.08 },
      position: new Vector3(0, 0.012, 0)
    });

    for (const z of [-8.5, 8.5]) {
      this.loader.createVisual('line', {
        name: `court_line_${z}`,
        size: { width: TUNING.map.halfWidth * 2, height: 0.015, depth: 0.05 },
        position: new Vector3(0, 0.014, z)
      });
    }
  }

  private createBleachers(): void {
    const width = 2.0;
    const height = 0.35;
    const depth = TUNING.map.halfLength * 1.3;
    for (const side of [-1, 1]) {
      for (let step = 0; step < 4; step += 1) {
        const cx = side * (TUNING.map.halfWidth - 1.2 - step * 0.42);
        const cy = 0.17 + step * 0.28;
        this.loader.createVisual('bleacher', { name: `bleacher_${side}_${step}`, size: { width, height, depth }, position: new Vector3(cx, cy, 0) });
        // Climbable solid proxy: stand on top, blocked from the side.
        this.collision.add(aabbFromCenter(cx, cy, 0, width / 2, height / 2, depth / 2));
      }
    }
  }

  private createMats(): void {
    const positions = [
      new Vector3(-4.5, 0.72, -5.5),
      new Vector3(4.5, 0.72, -5.5),
      new Vector3(-4.5, 0.72, 5.5),
      new Vector3(4.5, 0.72, 5.5)
    ];

    for (const pos of positions) {
      const visual = this.loader.createVisual('mat', {
        size: { width: MAT_DIMENSIONS.width, height: MAT_DIMENSIONS.height, depth: MAT_DIMENSIONS.depth }
      });
      const mat = new MatObstacle(visual, pos, Math.PI / 2);
      this.mats.push(mat);
      this.collision.add(mat.getAABB());
    }
  }

  private createTargetDummies(): void {
    const positions = [new Vector3(-3, 0.9, 8), new Vector3(0, 0.9, 9.5), new Vector3(3, 0.9, 8)];
    for (const pos of positions) {
      const dummy = this.loader.createVisual('dummy', { name: 'target_dummy', position: pos });
      // Hit detection uses a proxy radius (TUNING.ball.hitRadius), not this mesh's geometry.
      dummy.metadata = { targetDummy: true, hitCount: 0 };
    }
  }
}
