import { Color3, Material, Mesh, MeshBuilder, PBRMaterial, PointLight, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { MatObstacle, MAT_DIMENSIONS } from './MatObstacle';
import { AABB, CollisionWorld } from './Collider';
import { ModelLoader } from '../assets/ModelLoader';
import {
  MAT_SPECS,
  createBleacherCollisionBoxes,
  createBleacherPanelSpecs,
  createBleacherTierSpecs
} from '../../../shared/simulation/MapGeometry';

/**
 * Builds the gym. Each piece is split into two independent concerns:
 *   - VISUAL: a mesh requested from the ModelLoader by asset key (swappable for a GLB later).
 *   - PROXY:  collision is an AABB in `collision` (bleachers/mats) or the player bounds clamp
 *             (outer walls). Gameplay never reads the visual geometry.
 */
export class GymArena {
  public readonly mats: MatObstacle[] = [];
  // Player collision: bleachers + standing mats. Balls use a separate world (bleachers only) so a
  // thrown ball passes straight through a mat (mats are cover that affects players, not balls).
  public readonly collision = new CollisionWorld();
  public readonly ballCollision = new CollisionWorld();
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
    this.createCeiling();
    this.createCeilingLights();
    this.createScoreboard();

    // The gym is a fixed stage: every mesh built above is static except the moving dummy and the
    // mats (which tip over). Freeze the rest so Babylon stops recomputing their world matrices and
    // re-evaluating them for picking/culling every frame — a large per-frame CPU + GC win on a
    // scene with this many boxes (walls, pads, lines, bleacher tiers/seats/panels, scoreboard).
    this.freezeStaticMeshes();
  }

  /**
   * Freeze world matrices + disable picking on every static mesh in the gym. Skips the moving
   * dummy and the mat visuals, which animate. `freezeWorldMatrix` stops the per-frame matrix
   * recompute; `doNotSyncBoundingInfo`/`alwaysSelectAsActiveMesh` skip redundant culling work for
   * geometry that is always on screen-adjacent and never moves.
   */
  private freezeStaticMeshes(): void {
    const dynamic = new Set<Mesh>();
    // The moving dummy translates every frame; exclude it AND its parented child parts (a frozen
    // child of a moving parent would not follow). Mat visuals tip/reset, so exclude those too.
    if (this.movingDummy) {
      dynamic.add(this.movingDummy);
      for (const child of this.movingDummy.getChildMeshes(false)) {
        if (child instanceof Mesh) dynamic.add(child);
      }
    }
    for (const mat of this.mats) dynamic.add(mat.mesh);

    for (const mesh of this.scene.meshes) {
      if (!(mesh instanceof Mesh) || dynamic.has(mesh)) continue;
      // Static target dummies + their child parts get toggled (setEnabled) between practice/online
      // but never move, so freezing their matrices is safe and they still hide/show correctly.
      mesh.isPickable = false;
      mesh.doNotSyncBoundingInfo = true;
      mesh.freezeWorldMatrix();
    }
  }

  /**
   * Solid ceiling slab capping the gym at TUNING.map.wallHeight — the same plane the server uses
   * for the ball ceiling clamp + the side-wall/ceiling 1-bounce rule, so the visual lid matches the
   * gameplay surface. Visual only; the ball ceiling bounce is enforced authoritatively server-side.
   */
  private createCeiling(): void {
    const h = TUNING.map.wallHeight;
    const t = 0.35;
    const ceilingMat = new StandardMaterial('gym_ceiling_mat', this.scene);
    ceilingMat.diffuseColor = new Color3(0.16, 0.17, 0.2);
    ceilingMat.specularColor = new Color3(0.04, 0.04, 0.05);

    const ceiling = MeshBuilder.CreateBox('gym_ceiling', {
      width: TUNING.map.halfWidth * 2 + t * 2,
      height: t,
      depth: TUNING.map.halfLength * 2 + t * 2
    }, this.scene);
    ceiling.position.set(0, h + t / 2, 0);
    ceiling.material = ceilingMat;
    ceiling.isPickable = false;
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
    const seatMat = new StandardMaterial('bleacher_seat_mat', this.scene);
    seatMat.diffuseColor = new Color3(0.7, 0.72, 0.7);

    const panelMat = new StandardMaterial('bleacher_panel_mat', this.scene);
    panelMat.diffuseColor = new Color3(0.38, 0.4, 0.42);

    const railMat = new StandardMaterial('bleacher_rail_mat', this.scene);
    railMat.diffuseColor = new Color3(0.82, 0.84, 0.82);

    for (const tier of createBleacherTierSpecs()) {
      this.loader.createVisual('bleacher', {
        name: `bleacher_${tier.side}_${tier.step}`,
        size: tier.size,
        position: new Vector3(tier.center.x, tier.center.y, tier.center.z)
      });

      const seat = MeshBuilder.CreateBox(`bleacher_seat_${tier.side}_${tier.step}`, {
        width: tier.size.width - 0.045,
        height: 0.045,
        depth: tier.size.depth - 0.08
      }, this.scene);
      seat.position.set(tier.center.x, tier.center.y + tier.size.height * 0.5 + 0.023, tier.center.z);
      seat.material = seatMat;
      seat.isPickable = false;
    }

    for (const panel of createBleacherPanelSpecs()) {
      const mesh = MeshBuilder.CreateBox(`bleacher_${panel.name}_${panel.side}`, panel.size, this.scene);
      mesh.position.set(panel.center.x, panel.center.y, panel.center.z);
      mesh.material = panel.name === 'back' ? panelMat : railMat;
      mesh.isPickable = false;
    }

    for (const box of createBleacherCollisionBoxes()) {
      this.collision.add(box);
      this.ballCollision.add(box);
    }
  }

  private createMats(): void {
    // Built from the shared MAT_SPECS so the offline scene matches the server's mat layout AND
    // orientation (yaw 0 = broad face down-court; was incorrectly quarter-turned before). Mats are
    // added to the PLAYER collision world only — balls pass through them (ballCollision excludes mats).
    for (const spec of MAT_SPECS) {
      const visual = this.loader.createVisual('mat', {
        size: { width: MAT_DIMENSIONS.width, height: MAT_DIMENSIONS.height, depth: MAT_DIMENSIONS.depth }
      });
      const mat = new MatObstacle(spec.id, visual, new Vector3(spec.x, spec.y, spec.z), spec.yawRadians);
      this.mats.push(mat);
      this.collision.add(mat.getAABB());
    }
  }

  /**
   * Remove a knocked-over mat's collision box from the PLAYER world so it becomes walkable. Matched
   * by footprint (mats sit at fixed, distinct positions). Balls are unaffected (separate world).
   */
  removeMatCollision(mat: MatObstacle): void {
    const box = mat.getAABB();
    const idx = this.collision.boxes.findIndex((b) =>
      b.minX === box.minX && b.maxX === box.maxX && b.minZ === box.minZ && b.maxZ === box.maxZ
    );
    if (idx >= 0) this.collision.boxes.splice(idx, 1);
  }

  /** Reset every mat to upright AND restore the player collision world (leave online / reset practice). */
  resetMats(): void {
    for (const mat of this.mats) mat.reset();
    // Rebuild player collision: keep all non-mat boxes, then re-add every (now standing) mat box.
    const nonMat = this.collision.boxes.filter((b) => !this.isMatBox(b));
    this.collision.boxes.length = 0;
    for (const b of nonMat) this.collision.boxes.push(b);
    for (const mat of this.mats) this.collision.add(mat.getAABB());
  }

  private isMatBox(box: AABB): boolean {
    for (const mat of this.mats) {
      const m = mat.getAABB();
      if (m.minX === box.minX && m.maxX === box.maxX && m.minZ === box.minZ && m.maxZ === box.maxZ) return true;
    }
    return false;
  }

  private createTargetDummies(): void {
    const positions = [new Vector3(-3, 0.9, 8), new Vector3(0, 0.9, 9.5), new Vector3(3, 0.9, 8)];
    const dummyMat = this.loader.material('dummy');
    const dummyTrimMat = createPbrMaterial(this.scene, 'dummy_trim_mat', new Color3(0.09, 0.11, 0.16), {
      metallic: 0.12,
      roughness: 0.38
    });

    for (const pos of positions) {
      const dummy = this.loader.createVisual('dummy', { name: 'target_dummy', position: pos });
      dummy.metadata = { targetDummy: true, hitCount: 0 };

      this.buildTargetDummyDetails(dummy, dummyMat, dummyTrimMat, `static_${pos.x}`);
    }

    // Moving dummy — oscillates left-right at the back of the opponent's side.
    // Bright teal material so it's visually distinct from the static ones.
    const movingMat = createPbrMaterial(this.scene, 'moving_dummy_mat', new Color3(0.0, 0.78, 0.72), {
      roughness: 0.34,
      emissive: new Color3(0.0, 0.08, 0.07)
    });
    const movingTrimMat = createPbrMaterial(this.scene, 'moving_dummy_trim_mat', new Color3(0.02, 0.14, 0.16), {
      metallic: 0.12,
      roughness: 0.32,
      emissive: new Color3(0, 0.02, 0.025)
    });
    const movingMesh = this.loader.createVisual('dummy', { name: 'moving_dummy', position: new Vector3(0, 0.9, 7.5) });
    movingMesh.material = movingMat;
    movingMesh.metadata = { targetDummy: true, hitCount: 0 };
    this.buildTargetDummyDetails(movingMesh, movingMat, movingTrimMat, 'moving');
    this.movingDummy = movingMesh;
  }

  private buildTargetDummyDetails(root: Mesh, bodyMat: Material, trimMat: Material, suffix: string): void {
    const head = MeshBuilder.CreateSphere(`dummy_head_${suffix}`, { diameter: 0.44, segments: 14 }, this.scene);
    head.parent = root;
    head.position.set(0, 1.08, 0);
    head.scaling.set(1.0, 0.86, 0.95);
    head.material = bodyMat;
    head.isPickable = false;

    const torso = MeshBuilder.CreateBox(`dummy_torso_${suffix}`, { width: 0.58, height: 0.62, depth: 0.18 }, this.scene);
    torso.parent = root;
    torso.position.set(0, 0.2, -0.27);
    torso.material = trimMat;
    torso.isPickable = false;

    const hips = MeshBuilder.CreateBox(`dummy_hips_${suffix}`, { width: 0.5, height: 0.18, depth: 0.34 }, this.scene);
    hips.parent = root;
    hips.position.set(0, -0.48, 0);
    hips.material = trimMat;
    hips.isPickable = false;

    for (const sign of [-1, 1]) {
      const shoulder = MeshBuilder.CreateBox(`dummy_shoulder_${suffix}_${sign}`, { width: 0.34, height: 0.14, depth: 0.34 }, this.scene);
      shoulder.parent = root;
      shoulder.position.set(sign * 0.44, 0.48, -0.02);
      shoulder.rotation.z = -sign * 0.16;
      shoulder.material = trimMat;
      shoulder.isPickable = false;

      const leg = MeshBuilder.CreateCapsule(`dummy_leg_${suffix}_${sign}`, { height: 0.68, radius: 0.085 }, this.scene);
      leg.parent = root;
      leg.position.set(sign * 0.16, -0.8, 0);
      leg.material = bodyMat;
      leg.isPickable = false;

      const foot = MeshBuilder.CreateBox(`dummy_foot_${suffix}_${sign}`, { width: 0.24, height: 0.09, depth: 0.36 }, this.scene);
      foot.parent = root;
      foot.position.set(sign * 0.16, -1.16, -0.08);
      foot.material = trimMat;
      foot.isPickable = false;
    }
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

function createPbrMaterial(
  scene: Scene,
  name: string,
  albedo: Color3,
  options: { metallic?: number; roughness?: number; emissive?: Color3 } = {}
): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = albedo;
  material.metallic = options.metallic ?? 0;
  material.roughness = options.roughness ?? 0.5;
  if (options.emissive) material.emissiveColor = options.emissive;
  return material;
}
