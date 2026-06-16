import { Color3, Mesh, MeshBuilder, PointLight, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { MatObstacle, MAT_DIMENSIONS } from './MatObstacle';
import { CollisionWorld, aabbFromCenter } from './Collider';
import { ModelLoader } from '../assets/ModelLoader';

/**
 * Builds the gym. Each piece is split into two independent concerns:
 *   - VISUAL: a mesh requested from the ModelLoader by asset key (swappable for a GLB later).
 *   - PROXY:  collision is an AABB in `collision` (bleachers/mats) or the player bounds clamp
 *             (outer walls). Gameplay never reads the visual geometry.
 */
export class GymArena {
  public readonly mats: MatObstacle[] = [];
  public readonly collision = new CollisionWorld();
  /** The 4th target dummy; oscillates side-to-side each frame for catch/throw practice. */
  public movingDummy: Mesh | null = null;
  private readonly movingDummyAmplitude = 4.5; // meters from center
  private readonly movingDummyPeriod = 3.8;    // seconds per full oscillation

  constructor(private readonly scene: Scene, private readonly loader: ModelLoader) {}

  build(): void {
    this.createFloor();
    this.createHalfCourtZones();
    this.createWalls();
    this.createWallPads();
    this.createCourtLines();
    this.createBallSpawnMarkers();
    this.createBleachers();
    this.createMats();
    this.createTargetDummies();
    this.createCeilingLights();
    this.createScoreboard();
  }

  private createFloor(): void {
    this.loader.createVisual('floor', {
      name: 'gym_floor',
      size: { width: TUNING.map.halfWidth * 2, depth: TUNING.map.halfLength * 2, height: 0.08 },
      position: new Vector3(0, -0.04, 0)
    });
  }

  /**
   * Two opaque floor overlays (1 mm above floor surface) that tint each half of the court in
   * the school color palette: cool blue on the player's side, warm red on the opponent's side.
   * Opaque so they don't trigger the transparent render pass and appear under court lines.
   */
  private createHalfCourtZones(): void {
    const halfW = TUNING.map.halfWidth;
    const halfL = TUNING.map.halfLength;
    const th = 0.004;
    const y = th / 2 + 0.001; // just above floor surface

    const playerMat = new StandardMaterial('zone_player_mat', this.scene);
    playerMat.diffuseColor = new Color3(0.62, 0.65, 0.88);

    const oppMat = new StandardMaterial('zone_opp_mat', this.scene);
    oppMat.diffuseColor = new Color3(0.88, 0.58, 0.44);

    for (const [name, zCenter, mat] of [
      ['zone_player', -halfL / 2, playerMat],
      ['zone_opp', halfL / 2, oppMat]
    ] as [string, number, StandardMaterial][]) {
      const zone = MeshBuilder.CreateBox(name, {
        width: halfW * 2,
        height: th,
        depth: halfL - 0.02
      }, this.scene);
      zone.position.set(0, y, zCenter);
      zone.material = mat;
      zone.isPickable = false;
    }
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

  /** Lower 1.5 m of every wall gets a navy foam-pad layer (visual only, no collision change). */
  private createWallPads(): void {
    const padH = 1.5;
    const padT = 0.06;
    const pads = [
      { name: 'pad_north', pos: new Vector3(0, padH / 2, TUNING.map.halfLength - padT / 2), size: { width: TUNING.map.halfWidth * 2, height: padH, depth: padT } },
      { name: 'pad_south', pos: new Vector3(0, padH / 2, -TUNING.map.halfLength + padT / 2), size: { width: TUNING.map.halfWidth * 2, height: padH, depth: padT } },
      { name: 'pad_east', pos: new Vector3(TUNING.map.halfWidth - padT / 2, padH / 2, 0), size: { width: padT, height: padH, depth: TUNING.map.halfLength * 2 } },
      { name: 'pad_west', pos: new Vector3(-TUNING.map.halfWidth + padT / 2, padH / 2, 0), size: { width: padT, height: padH, depth: TUNING.map.halfLength * 2 } }
    ];
    for (const pad of pads) {
      this.loader.createVisual('wallPad', { name: pad.name, size: pad.size, position: pad.pos });
    }
  }

  private createCourtLines(): void {
    const halfW = TUNING.map.halfWidth;
    const halfL = TUNING.map.halfLength;
    const lineY = 0.012;

    // Bold center stripe — the most important line on the court.
    this.loader.createVisual('line', {
      name: 'center_line',
      size: { width: halfW * 2, height: 0.018, depth: 0.20 },
      position: new Vector3(0, lineY, 0)
    });

    // Attack lines (4.5 m from center — marking the approach zone).
    for (const z of [-4.5, 4.5]) {
      this.loader.createVisual('line', {
        name: `attack_line_${z}`,
        size: { width: halfW * 2, height: 0.013, depth: 0.06 },
        position: new Vector3(0, lineY - 0.001, z)
      });
    }

    // Half-court warning lines (8.5 m from center).
    for (const z of [-8.5, 8.5]) {
      this.loader.createVisual('line', {
        name: `warning_line_${z}`,
        size: { width: halfW * 2, height: 0.013, depth: 0.06 },
        position: new Vector3(0, lineY - 0.001, z)
      });
    }

    // Side boundary lines along the long walls.
    for (const x of [-(halfW - 0.08), halfW - 0.08]) {
      this.loader.createVisual('line', {
        name: `side_line_${x > 0 ? 'r' : 'l'}`,
        size: { width: 0.07, height: 0.013, depth: halfL * 2 },
        position: new Vector3(x, lineY - 0.001, 0)
      });
    }
  }

  /**
   * Small flat disc markers at each ball spawn position so players can quickly orient to
   * where balls will reset. Spawn positions mirror BallManager.spawnCenterLineBalls().
   */
  private createBallSpawnMarkers(): void {
    const count = TUNING.map.ballCount;
    const spacing = 2.0;
    const start = -((count - 1) * spacing) / 2;

    const mat = new StandardMaterial('spawn_marker_mat', this.scene);
    mat.diffuseColor = new Color3(0.95, 0.92, 0.75);

    for (let i = 0; i < count; i++) {
      const disc = MeshBuilder.CreateCylinder(`spawn_marker_${i}`, {
        diameter: 0.58,
        height: 0.008,
        tessellation: 20
      }, this.scene);
      disc.position.set(start + i * spacing, 0.020, 0);
      disc.material = mat;
      disc.isPickable = false;
    }
  }

  private createBleachers(): void {
    const width = 2.0;
    const height = 0.35;
    const depth = TUNING.map.halfLength * 1.3;

    const seatMat = new StandardMaterial('bleacher_seat_mat', this.scene);
    seatMat.diffuseColor = new Color3(0.76, 0.6, 0.38);

    for (const side of [-1, 1]) {
      for (let step = 0; step < 4; step += 1) {
        const cx = side * (TUNING.map.halfWidth - 1.2 - step * 0.42);
        const cy = 0.17 + step * 0.28;
        this.loader.createVisual('bleacher', {
          name: `bleacher_${side}_${step}`,
          size: { width, height, depth },
          position: new Vector3(cx, cy, 0)
        });
        this.collision.add(aabbFromCenter(cx, cy, 0, width / 2, height / 2, depth / 2));

        // Seat-plank strip on top of each tier (slightly lighter warm wood).
        const seat = MeshBuilder.CreateBox(`bleacher_seat_${side}_${step}`, {
          width: width - 0.06,
          height: 0.04,
          depth: depth - 0.06
        }, this.scene);
        seat.position.set(cx, cy + height / 2 + 0.02, 0);
        seat.material = seatMat;
        seat.isPickable = false;
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
    const dummyMat = this.loader.material('dummy');

    for (const pos of positions) {
      const dummy = this.loader.createVisual('dummy', { name: 'target_dummy', position: pos });
      dummy.metadata = { targetDummy: true, hitCount: 0 };

      // Head sphere parented to the body for a more readable humanoid silhouette.
      // Not marked targetDummy so hit detection (radius check vs body center) isn't duplicated.
      const head = MeshBuilder.CreateSphere(`dummy_head_${pos.x}`, { diameter: 0.42, segments: 10 }, this.scene);
      head.parent = dummy;
      head.position.set(0, 1.08, 0); // local Y: top of capsule + half head radius
      head.material = dummyMat;
      head.isPickable = false;
    }

    // Moving dummy — oscillates left-right at the back of the opponent's side.
    // Bright teal material so it's visually distinct from the static ones.
    const movingMat = new StandardMaterial('moving_dummy_mat', this.scene);
    movingMat.diffuseColor = new Color3(0.0, 0.78, 0.72);
    movingMat.emissiveColor = new Color3(0.0, 0.18, 0.16);
    const movingMesh = this.loader.createVisual('dummy', { name: 'moving_dummy', position: new Vector3(0, 0.9, 7.5) });
    movingMesh.material = movingMat;
    movingMesh.metadata = { targetDummy: true, hitCount: 0 };
    const movingHead = MeshBuilder.CreateSphere('dummy_head_moving', { diameter: 0.42, segments: 10 }, this.scene);
    movingHead.parent = movingMesh;
    movingHead.position.set(0, 1.08, 0);
    movingHead.material = movingMat;
    movingHead.isPickable = false;
    this.movingDummy = movingMesh;
  }

  /** Call once per frame with the scene's accumulated elapsed time (seconds). */
  update(elapsed: number): void {
    if (!this.movingDummy) return;
    this.movingDummy.position.x = Math.sin((elapsed / this.movingDummyPeriod) * Math.PI * 2) * this.movingDummyAmplitude;
  }

  /**
   * Six fluorescent fixtures hanging from the ceiling, each paired with a PointLight that
   * illuminates the court below. Together with the scene's HemisphericLight they produce a
   * brighter, more directional school-gym feel.
   */
  private createCeilingLights(): void {
    const fixtureMat = new StandardMaterial('ceil_fixture_mat', this.scene);
    fixtureMat.diffuseColor = new Color3(0.92, 0.92, 0.88);
    fixtureMat.emissiveColor = new Color3(0.72, 0.72, 0.65);

    const fixtureY = TUNING.map.wallHeight - 0.12; // hang just below ceiling

    const positions: [number, number][] = [
      [-5, -8], [5, -8],
      [-5, 0],  [5, 0],
      [-5, 8],  [5, 8]
    ];

    for (const [x, z] of positions) {
      const housing = MeshBuilder.CreateBox(`ceil_light_${x}_${z}`, {
        width: 0.28, height: 0.08, depth: 1.1
      }, this.scene);
      housing.position.set(x, fixtureY, z);
      housing.material = fixtureMat;
      housing.isPickable = false;

      const pt = new PointLight(`ceil_pt_${x}_${z}`, new Vector3(x, fixtureY - 0.1, z), this.scene);
      pt.diffuse = new Color3(1.0, 0.97, 0.92);
      pt.specular = new Color3(0.3, 0.3, 0.28);
      pt.intensity = 0.42;
      pt.range = 13;
    }
  }

  /**
   * 3D scoreboard prop on the north end wall. The actual score numbers live in the HTML HUD;
   * this is a visual anchor so players have something to look at across the court.
   */
  private createScoreboard(): void {
    const wallZ = TUNING.map.halfLength;

    // Dark backing board protruding slightly from the wall.
    this.loader.createVisual('scoreboard', {
      name: 'scoreboard_backing',
      size: { width: 5.2, height: 1.9, depth: 0.14 },
      position: new Vector3(0, 3.1, wallZ - 0.07)
    });

    // Near-black LED display face.
    const faceMat = new StandardMaterial('scoreboard_face_mat', this.scene);
    faceMat.diffuseColor = new Color3(0.04, 0.06, 0.1);
    faceMat.emissiveColor = new Color3(0.01, 0.02, 0.05);
    const face = MeshBuilder.CreateBox('scoreboard_face', {
      width: 4.75, height: 1.5, depth: 0.07
    }, this.scene);
    face.position.set(0, 3.1, wallZ - 0.01);
    face.material = faceMat;
    face.isPickable = false;

    // Gold accent rim along the top edge.
    const rimMat = new StandardMaterial('scoreboard_rim_mat', this.scene);
    rimMat.diffuseColor = new Color3(1.0, 0.82, 0.1);
    rimMat.emissiveColor = new Color3(0.52, 0.36, 0.0);
    const rim = MeshBuilder.CreateBox('scoreboard_rim', {
      width: 5.2, height: 0.065, depth: 0.15
    }, this.scene);
    rim.position.set(0, 3.1 + 0.95 + 0.033, wallZ - 0.07);
    rim.material = rimMat;
    rim.isPickable = false;
  }
}
