import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS } from '../../../shared/constants';
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
const COURT_LINE_BASE_GLOW = new Color3(0.045, 0.03, 0.01);
const COURT_LINE_ACTIVE_GLOW = new Color3(0.42, 0.26, 0.08);

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
].map(([x, z]) => [x / 13 * TUNING.map.halfWidth, z / 18 * TUNING.map.halfLength] as const);

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
  /** Live 3D scoreboards (one per end wall). Driven from match state; buzz on score change. */
  public readonly scoreboards: Scoreboard3D[] = [];
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
    this.createCeiling();
    this.createCeilingFixtures();
    applyGymVisualRevamp(this.scene);
    this.scoreboards.push(...createSideScoreboards(this.scene));

    // The gym is a fixed stage: every mesh built above is static except the mats
    // (which tip over). Freeze the rest so Babylon stops recomputing their world matrices and
    // re-evaluating them for picking/culling every frame — a large per-frame CPU + GC win on a
    // scene with this many boxes (walls, pads, lines, bleacher tiers/seats/panels, scoreboard).
    this.freezeStaticMeshes();
  }

  /**
   * Freeze world matrices + disable picking on every static mesh in the gym. Skips
   * the mat visuals, which animate. `freezeWorldMatrix` stops the per-frame matrix
   * recompute; `doNotSyncBoundingInfo`/`alwaysSelectAsActiveMesh` skip redundant culling work for
   * geometry that is always on screen-adjacent and never moves.
   */
  private freezeStaticMeshes(): void {
    const dynamic = new Set<Mesh>();
    // Mat visuals tip/reset, so exclude those from world-matrix freezing.
    for (const mat of this.mats) dynamic.add(mat.mesh);
    for (const cone of this.halfCourtCones) dynamic.add(cone.mesh);
    // Scoreboards shake on a buzz (their parented meshes move with the root), so never freeze them.
    for (const board of this.scoreboards) {
      for (const mesh of board.meshes) dynamic.add(mesh);
    }

    for (const mesh of this.scene.meshes) {
      if (!(mesh instanceof Mesh) || dynamic.has(mesh)) continue;
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
    const edgeMat = this.createCourtLineMaterial('court_line_keyline_mat', new Color3(0.035, 0.09, 0.16), Color3.Black());

    const depth = GAME_CONSTANTS.match.neutralZoneHalfDepth;
    const keylines: Mesh[] = [];
    for (const sign of [-1, 1]) {
      // A narrow navy keyline keeps the actual crossing limits readable on bright maple.
      const keyline = MeshBuilder.CreateGround(`neutral_edge_keyline_${sign}`, { width: halfW * 2, height: 0.27 }, this.scene);
      keyline.position.set(0, 0.01, sign * depth);
      keylines.push(keyline);
      const line = this.loader.createVisual('line', {
        name: `neutral_edge_${sign}`,
        size: { width: halfW * 2, height: 0.018, depth: 0.16 },
        position: new Vector3(0, lineY, sign * depth)
      });
      line.material = this.courtLineCenterMat;
    }
    const edges = Mesh.MergeMeshes(keylines, true, true, undefined, false, false) ?? keylines[0];
    edges.name = 'neutral_edge_keylines';
    edges.material = edgeMat;
    edges.isPickable = false;
    const band = MeshBuilder.CreateGround('neutral_zone_band', { width: halfW * 2, height: depth * 2 }, this.scene);
    band.position.y = 0.006; band.isPickable = false;
    const mat = new StandardMaterial('neutral_band_mat', this.scene);
    mat.diffuseColor = new Color3(0.93, 0.91, 0.85); mat.emissiveColor = Color3.Black();
    mat.alpha = 0.12; mat.specularColor = Color3.Black(); band.material = mat;
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

    const coneXs = [-11.2, -8.4, -5.6, -2.8, 0, 2.8, 5.6, 8.4, 11.2].map(x => x / 13 * TUNING.map.halfWidth);
    const rowZ = GAME_CONSTANTS.match.neutralZoneHalfDepth + 0.25;
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
        material: this.loader.material('mat'),
        // Broad rolled border and a crown strong enough to read while moving past the obstacle.
        border: 0.105,
        raise: 0.032
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

  /** Call once per frame with the scene's accumulated elapsed time (seconds). */
  update(elapsed: number): void {
    this.updateCourtLines(elapsed);
    this.updateHalfCourtCones(elapsed);
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
    this.setLineGlow(center, COURT_LINE_BASE_GLOW, COURT_LINE_ACTIVE_GLOW, Math.max(suddenPulse, centerBoost));
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

    if (!this.conesReleased) return;

    this.coneReleaseSeconds = Math.max(0, elapsed - this.coneReleaseStartedAt);
    for (const cone of this.halfCourtCones) {
      // Released cones stay hidden until reset. Stop updating their transforms once the exit
      // animation finishes, including during a long sudden-death round in either graphics preset.
      if (!cone.mesh.isEnabled()) continue;
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
