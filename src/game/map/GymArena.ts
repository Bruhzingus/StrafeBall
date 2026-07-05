import { Color3, Material, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { MatObstacle, MAT_DIMENSIONS } from './MatObstacle';
import { AABB, CollisionWorld } from './Collider';
import { ModelLoader } from '../assets/ModelLoader';
import { Scoreboard3D, createSideScoreboards } from './Scoreboard3D';
import { applyGymVisualRevamp, createBeveledPanelMesh } from './GymVisualRevamp';
import {
  MAT_SPECS,
  createBleacherCollisionBoxes,
  createBleacherPanelSpecs,
  createBleacherTierSpecs
} from '../../../shared/simulation/MapGeometry';
import { buildBleacherEndCapCorner, createBleacherEndCapMaterials } from './BleacherEndCap';

/** Y height (metres) of the hanging ceiling fixtures: just under the ceiling slab at wallHeight. */
export const CEILING_FIXTURE_Y = TUNING.map.wallHeight - 0.12;

/**
 * The gym's ceiling light-fixture grid in floor (X,Z) metres: two columns (X = ±5) × three rows
 * (Z = −8, 0, +8). createCeilingFixtures() builds the emissive housings from this list, and the
 * Showcase roof SpotLights derive their positions from the SAME list so every light sits under a real
 * fixture (no arbitrary world coordinates, and the fixtures visually correspond to the lights above
 * the court). The four corner fixtures become the primary shadow-casting spots; the two centre
 * fixtures (Z = 0) become the optional unshadowed fill spots. See ShowcaseLighting.
 */
export const CEILING_FIXTURE_POSITIONS: readonly (readonly [number, number])[] = [
  [-5, -8], [5, -8],
  [-5, 0], [5, 0],
  [-5, 8], [5, 8]
];

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
  /** Live 3D scoreboards (one per end wall). Driven from match state; buzz on score change. */
  public readonly scoreboards: Scoreboard3D[] = [];
  private readonly movingDummyAmplitude = 4.5; // meters from center
  private readonly movingDummyPeriod = 3.8;    // seconds per full oscillation
  private courtLineCenterMat: StandardMaterial | null = null;
  private courtLineState = {
    negativeHalfActive: false,
    positiveHalfActive: false,
    suddenDeath: false
  };
  private readonly halfCourtCones: Array<{
    mesh: Mesh;
    basePosition: Vector3;
    drift: Vector3;
    spin: Vector3;
    baseRotationY: number;
    phase: number;
    releaseDelay: number;
  }> = [];
  private coneReleaseSeconds = 0;
  private conesReleased = false;
  private coneReleaseStartedAt = 0;

  constructor(private readonly scene: Scene, private readonly loader: ModelLoader) {}

  build(): void {
    this.createFloor();
    this.createWalls();
    this.createCourtLines();
    this.createHalfCourtCones();
    this.createBleachers();
    this.createMats();
    this.createTargetDummies();
    this.createCeiling();
    this.createCeilingFixtures();
    applyGymVisualRevamp(this.scene);
    this.scoreboards.push(...createSideScoreboards(this.scene));

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
    for (const cone of this.halfCourtCones) dynamic.add(cone.mesh);
    // Scoreboards shake on a buzz (their parented meshes move with the root), so never freeze them.
    for (const board of this.scoreboards) {
      for (const mesh of board.meshes) dynamic.add(mesh);
    }

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
   * gameplay surface. Movement and ball bounds now treat this plane as solid in both modes.
   */
  private createCeiling(): void {
    const h = TUNING.map.wallHeight;
    const t = 0.35;
    const ceilingMat = new StandardMaterial('gym_ceiling_mat', this.scene);
    ceilingMat.diffuseColor = new Color3(0.72, 0.73, 0.68);
    ceilingMat.specularColor = new Color3(0.015, 0.015, 0.014);

    const panelMat = new StandardMaterial('gym_roof_panel_mat', this.scene);
    panelMat.diffuseColor = new Color3(0.82, 0.83, 0.78);
    panelMat.specularColor = new Color3(0.01, 0.01, 0.009);

    const beamMat = new StandardMaterial('gym_roof_beam_mat', this.scene);
    beamMat.diffuseColor = new Color3(0.34, 0.36, 0.38);
    beamMat.specularColor = new Color3(0.025, 0.025, 0.025);

    const seamMat = new StandardMaterial('gym_roof_seam_mat', this.scene);
    seamMat.diffuseColor = new Color3(0.22, 0.23, 0.24);
    seamMat.specularColor = new Color3(0.004, 0.004, 0.004);

    const ceiling = MeshBuilder.CreateBox('gym_ceiling', {
      width: TUNING.map.halfWidth * 2 + t * 2,
      height: t,
      depth: TUNING.map.halfLength * 2 + t * 2
    }, this.scene);
    ceiling.position.set(0, h + t / 2, 0);
    ceiling.material = ceilingMat;
    ceiling.isPickable = false;

    const panelY = h - 0.035;
    const panelRows = 6;
    const panelDepth = (TUNING.map.halfLength * 2 - 1.2) / panelRows;
    for (let i = 0; i < panelRows; i += 1) {
      const z = -TUNING.map.halfLength + 0.6 + panelDepth * (i + 0.5);
      const panel = MeshBuilder.CreateBox(`gym_roof_panel_${i}`, {
        width: TUNING.map.halfWidth * 2 - 1.0,
        height: 0.03,
        depth: panelDepth - 0.18
      }, this.scene);
      panel.position.set(0, panelY, z);
      panel.material = panelMat;
      panel.isPickable = false;
    }

    for (const x of [-9, -4.5, 0, 4.5, 9]) {
      const purlin = MeshBuilder.CreateBox(`gym_roof_purlin_${x}`, {
        width: 0.12,
        height: 0.12,
        depth: TUNING.map.halfLength * 2 - 0.6
      }, this.scene);
      purlin.position.set(x, h - 0.16, 0);
      purlin.material = beamMat;
      purlin.isPickable = false;
    }

    for (const z of [-15, -9, -3, 3, 9, 15]) {
      const rafter = MeshBuilder.CreateBox(`gym_roof_rafter_${z}`, {
        width: TUNING.map.halfWidth * 2 + 0.2,
        height: 0.16,
        depth: 0.16
      }, this.scene);
      rafter.position.set(0, h - 0.25, z);
      rafter.material = beamMat;
      rafter.isPickable = false;

      const seam = MeshBuilder.CreateBox(`gym_roof_seam_${z}`, {
        width: TUNING.map.halfWidth * 2 - 0.6,
        height: 0.04,
        depth: 0.06
      }, this.scene);
      seam.position.set(0, h - 0.07, z + 3);
      seam.material = seamMat;
      seam.isPickable = false;
    }
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
      const mesh = this.loader.createVisual('wall', { name: wall.name, size: wall.size, position: wall.position });
      // Pickable so nametags can raycast against the walls for line-of-sight occlusion.
      mesh.isPickable = true;
      mesh.metadata = { ...(mesh.metadata ?? {}), nametagOccluder: true };
    }
  }

  private createCourtLines(): void {
    const halfW = TUNING.map.halfWidth;
    const lineY = 0.012;
    this.courtLineCenterMat = this.createCourtLineMaterial('court_line_center_mat', new Color3(1.0, 0.98, 0.92), new Color3(0.045, 0.03, 0.01));

    // Bold center stripe — the only court line kept; the rest (attack/warning/side lines) read as
    // visual clutter on the floor and were removed.
    const centerLine = this.loader.createVisual('line', {
      name: 'center_line',
      size: { width: halfW * 2, height: 0.018, depth: 0.20 },
      position: new Vector3(0, lineY, 0)
    });
    centerLine.material = this.courtLineCenterMat;
  }

  /**
   * Two rows of small gym cones straddling the half line so players can read the crossing limit at
   * a glance. They are visual-only and float away when no-boundaries begins.
   */
  private createHalfCourtCones(): void {
    const coneBlue = new StandardMaterial('half_court_cone_blue_mat', this.scene);
    coneBlue.diffuseColor = new Color3(0.22, 0.56, 0.92);
    coneBlue.emissiveColor = new Color3(0.03, 0.07, 0.12);
    coneBlue.specularColor = new Color3(0.12, 0.14, 0.16);

    const coneRed = new StandardMaterial('half_court_cone_red_mat', this.scene);
    coneRed.diffuseColor = new Color3(0.96, 0.44, 0.28);
    coneRed.emissiveColor = new Color3(0.12, 0.04, 0.02);
    coneRed.specularColor = new Color3(0.16, 0.12, 0.1);

    const coneXs = [-11.2, -8.4, -5.6, -2.8, 0, 2.8, 5.6, 8.4, 11.2];
    const rowZ = 0.62;
    const baseY = 0.14;

    for (const side of [-1, 1] as const) {
      for (let i = 0; i < coneXs.length; i += 1) {
        const x = coneXs[i];
        const mesh = MeshBuilder.CreateCylinder(`half_court_cone_${side}_${i}`, {
          height: 0.24,
          diameterTop: 0.11,
          diameterBottom: 0.4,
          tessellation: 20
        }, this.scene);
        const basePosition = new Vector3(x, baseY, side * rowZ);
        const baseRotationY = side < 0 ? Math.PI * 0.08 : -Math.PI * 0.08;
        mesh.position.copyFrom(basePosition);
        mesh.rotation.y = baseRotationY;
        mesh.material = side < 0 ? coneBlue : coneRed;
        mesh.isPickable = false;

        this.halfCourtCones.push({
          mesh,
          basePosition,
          drift: new Vector3(x * 0.04, 1.4 + Math.abs(x) * 0.018, side * (1.3 + Math.abs(x) * 0.035)),
          spin: new Vector3(1.4 + Math.abs(x) * 0.05, 2.2 + Math.abs(x) * 0.04, side * 1.1),
          baseRotationY,
          phase: i * 0.55 + (side < 0 ? 0.2 : 0.85),
          releaseDelay: i * 0.03
        });
      }
    }
  }

  private createBleachers(): void {
    const seatMat = new StandardMaterial('bleacher_seat_mat', this.scene);
    seatMat.diffuseColor = new Color3(0.7, 0.72, 0.7);

    const panelMat = new StandardMaterial('bleacher_panel_mat', this.scene);
    panelMat.diffuseColor = new Color3(0.38, 0.4, 0.42);

    const tierSpecs = createBleacherTierSpecs();
    for (const tier of tierSpecs) {
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

    // The back panel (outer wall behind the top tier) stays a flat solid panel. The two side panels
    // (the exposed ends of the stand) are replaced below with a see-through grandstand end-cap — same
    // collision AABB (added from createBleacherCollisionBoxes() further down, unchanged), different look.
    for (const panel of createBleacherPanelSpecs()) {
      if (panel.name !== 'back') continue;
      const mesh = MeshBuilder.CreateBox(`bleacher_${panel.name}_${panel.side}`, panel.size, this.scene);
      mesh.position.set(panel.center.x, panel.center.y, panel.center.z);
      mesh.material = panelMat;
      mesh.isPickable = false;
    }

    const endCapMaterials = createBleacherEndCapMaterials(this.scene);
    const sidePanels = createBleacherPanelSpecs().filter((panel) => panel.name !== 'back');
    for (const side of [-1, 1] as const) {
      const tiersForSide = tierSpecs.filter((tier) => tier.side === side).sort((a, b) => a.step - b.step);
      for (const zSign of [-1, 1] as const) {
        const panel = sidePanels.find((p) => p.side === side && p.name === (zSign < 0 ? 'south_side' : 'north_side'));
        if (!panel) continue;
        buildBleacherEndCapCorner(this.scene, endCapMaterials, side, zSign, tiersForSide, panel.center.z);
      }
    }

    for (const box of createBleacherCollisionBoxes()) {
      this.collision.add(box);
      this.ballCollision.add(box);
    }
  }

  private createMats(): void {
    // Built from the shared MAT_SPECS so the offline scene matches the server's mat layout AND
    // orientation (yaw 0 = broad face down-court; was incorrectly quarter-turned before). A standing
    // mat is solid cover for BOTH players and balls: its AABB goes into the player world AND the ball
    // world, so thrown dodgeballs bounce off it. A knocked-over mat is removed from both worlds.
    for (const spec of MAT_SPECS) {
      // Visual-only padded-panel mesh (core box + inset raised cushion on each broad face), merged to
      // one mesh sharing the tuned navy 'mat_material'. Purely cosmetic depth/edge light-catch — the
      // mat's collision is the separate MAT_DIMENSIONS AABB below, never derived from this mesh.
      const visual = createBeveledPanelMesh(this.scene, 'mat', {
        width: MAT_DIMENSIONS.width,
        height: MAT_DIMENSIONS.height,
        depth: MAT_DIMENSIONS.depth,
        material: this.loader.material('mat')
      });
      const mat = new MatObstacle(spec.id, visual, new Vector3(spec.x, spec.y, spec.z), spec.yawRadians);
      this.mats.push(mat);
      this.collision.add(mat.getAABB());
      this.ballCollision.add(mat.getAABB());
    }
  }

  /** Remove any collision box belonging to this mat (standing OR knocked-over) from both worlds. */
  removeMatCollision(mat: MatObstacle): void {
    for (const world of [this.collision, this.ballCollision]) {
      for (let i = world.boxes.length - 1; i >= 0; i -= 1) {
        if (world.boxes[i].id === mat.id) world.boxes.splice(i, 1);
      }
    }
  }

  /** Re-add a (now standing) mat's upright cover box to both collision worlds. */
  addMatCollision(mat: MatObstacle): void {
    this.setMatCollision(mat, 'standing');
  }

  /**
   * Set this mat's collision in BOTH worlds to match its pose. 'standing' = the upright cover box;
   * 'knocked' = the low flat panel lying on the floor — balls bounce off it (and stay live) and the
   * player steps onto it (a small, noticeable ledge). Any prior box for this mat is removed first, so
   * it is safe to call on every standing↔knocked transition. Each world gets its own box instance.
   */
  setMatCollision(mat: MatObstacle, mode: 'standing' | 'knocked'): void {
    this.removeMatCollision(mat);
    for (const world of [this.collision, this.ballCollision]) {
      world.add(mode === 'knocked' ? mat.getKnockedOverAABB() : mat.getAABB());
    }
  }

  /** Reset every mat to upright AND restore both collision worlds (leave online / reset practice). */
  resetMats(): void {
    for (const mat of this.mats) mat.reset();
    // Rebuild both worlds: keep all non-mat boxes, then re-add every (now standing) mat box.
    for (const world of [this.collision, this.ballCollision]) {
      const nonMat = world.boxes.filter((b) => b.kind !== 'mat');
      world.boxes.length = 0;
      for (const b of nonMat) world.boxes.push(b);
      for (const mat of this.mats) world.add(mat.getAABB());
    }
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
    this.updateCourtLines(elapsed);
    this.updateHalfCourtCones(elapsed);
    if (!this.movingDummy) return;
    this.movingDummy.position.x = Math.sin((elapsed / this.movingDummyPeriod) * Math.PI * 2) * this.movingDummyAmplitude;
  }

  setCourtLineState(state: { negativeHalfActive: boolean; positiveHalfActive: boolean; suddenDeath: boolean }): void {
    this.courtLineState = state;
  }

  /**
   * Show/hide the half-court cone props. Used by the local Movement Course to clear the mid-floor
   * cones from the course area; reversible. (Their per-frame motion lives in updateHalfCourtCones,
   * which the course step path does not call, so they stay put while hidden.)
   */
  setHalfCourtConesVisible(visible: boolean): void {
    for (const cone of this.halfCourtCones) cone.mesh.setEnabled(visible);
  }

  /**
   * Six fluorescent fixtures hanging from the ceiling. These are emissive visual props only — the
   * competitive lighting rig (one HemisphericLight + one DirectionalLight, set up by ArenaScene via
   * CompetitiveLighting) does all the actual lighting, so no runtime PointLights are created here.
   * The housing meshes stay, lit by a restrained emissive so they read as "on" without a GlowLayer
   * or fake floor-reflection planes.
   */
  private createCeilingFixtures(): void {
    const fixtureMat = new StandardMaterial('ceil_fixture_mat', this.scene);
    fixtureMat.diffuseColor = new Color3(0.92, 0.92, 0.88);
    fixtureMat.emissiveColor = new Color3(0.6, 0.6, 0.54);

    const fixtureY = CEILING_FIXTURE_Y; // hang just below ceiling

    for (const [x, z] of CEILING_FIXTURE_POSITIONS) {
      const housing = MeshBuilder.CreateBox(`ceil_light_${x}_${z}`, {
        width: 0.28, height: 0.08, depth: 1.1
      }, this.scene);
      housing.position.set(x, fixtureY, z);
      housing.material = fixtureMat;
      housing.isPickable = false;
    }
  }

  /** Advance the scoreboard buzz animations. Call once per frame. */
  updateScoreboards(dt: number): void {
    for (const board of this.scoreboards) board.update(dt);
  }

  /** Push the current blue/red scores (+ optional banner) to both end-wall scoreboards. */
  setScoreboardScores(blue: number, red: number, label = ''): void {
    for (const board of this.scoreboards) board.setScores(blue, red, label);
  }

  /** Buzz both scoreboards (e.g. on a hit taken). */
  buzzScoreboards(): void {
    for (const board of this.scoreboards) board.buzz();
  }

  /** Show/hide the 3D end-wall scoreboards (drives the "disable scoreboard" setting). */
  setScoreboardsVisible(visible: boolean): void {
    for (const board of this.scoreboards) board.setVisible(visible);
  }

  dispose(): void {
    for (const board of this.scoreboards) board.dispose();
  }

  private createCourtLineMaterial(name: string, diffuse: Color3, emissive: Color3): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = diffuse;
    material.emissiveColor = emissive.clone();
    material.specularColor = new Color3(0.05, 0.05, 0.045);
    return material;
  }

  private updateCourtLines(elapsed: number): void {
    const center = this.courtLineCenterMat;
    if (!center) return;

    const suddenPulse = this.courtLineState.suddenDeath ? 0.82 + 0.18 * Math.sin(elapsed * 7.5) : 0;
    const centerBoost = this.courtLineState.negativeHalfActive || this.courtLineState.positiveHalfActive ? 0.7 : 0;
    this.setLineGlow(center, new Color3(0.045, 0.03, 0.01), new Color3(0.42, 0.26, 0.08), Math.max(suddenPulse, centerBoost));
  }

  private updateHalfCourtCones(elapsed: number): void {
    if (this.courtLineState.suddenDeath && !this.conesReleased) {
      this.conesReleased = true;
      this.coneReleaseStartedAt = elapsed;
      this.coneReleaseSeconds = 0;
    } else if (!this.courtLineState.suddenDeath && this.conesReleased) {
      this.conesReleased = false;
      this.coneReleaseSeconds = 0;
      for (const cone of this.halfCourtCones) {
        cone.mesh.setEnabled(true);
        cone.mesh.visibility = 1;
        cone.mesh.position.copyFrom(cone.basePosition);
        cone.mesh.rotation.set(0, cone.baseRotationY, 0);
        cone.mesh.scaling.set(1, 1, 1);
      }
    }

    if (!this.conesReleased) {
      for (const cone of this.halfCourtCones) {
        cone.mesh.position.y = cone.basePosition.y + Math.sin(elapsed * 2.1 + cone.phase) * 0.018;
        cone.mesh.rotation.y = cone.baseRotationY + Math.sin(elapsed * 1.4 + cone.phase) * 0.035;
      }
      return;
    }

    this.coneReleaseSeconds = Math.max(0, elapsed - this.coneReleaseStartedAt);
    for (const cone of this.halfCourtCones) {
      const t = Math.max(0, Math.min(1, (this.coneReleaseSeconds - cone.releaseDelay) / 2.6));
      const eased = 1 - Math.pow(1 - t, 3);
      const bob = Math.sin((elapsed + cone.phase) * 8) * 0.055 * (1 - t);
      cone.mesh.setEnabled(t < 0.995);
      cone.mesh.visibility = Math.max(0, 1 - t * 1.08);
      cone.mesh.position.set(
        cone.basePosition.x + cone.drift.x * eased,
        cone.basePosition.y + cone.drift.y * eased + 1.8 * eased * eased + bob,
        cone.basePosition.z + cone.drift.z * eased
      );
      cone.mesh.rotation.set(
        cone.spin.x * eased,
        cone.baseRotationY + cone.spin.y * eased,
        cone.spin.z * eased
      );
      const squash = 1 + 0.16 * Math.sin(t * Math.PI);
      cone.mesh.scaling.set(1 / squash, squash, 1 / squash);
    }
  }

  private setLineGlow(material: StandardMaterial, base: Color3, peak: Color3, amount: number): void {
    material.emissiveColor.set(
      base.r + (peak.r - base.r) * amount,
      base.g + (peak.g - base.g) * amount,
      base.b + (peak.b - base.b) * amount
    );
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
