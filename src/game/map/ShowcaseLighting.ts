import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  SpotLight,
  StandardMaterial,
  Vector3
} from '@babylonjs/core';
import { SHOWCASE_CONFIG, type ShowcaseTier } from '../config/graphicsConfig';
import { CEILING_FIXTURE_Y } from './GymArena';
import { TUNING } from '../config/tuning';

/**
 * Client-only SHOWCASE lighting + dynamic-shadow system for the gym (graphics mode "showcase").
 *
 * Replaces the Competitive single-directional "fake sun" with actual roof-source lighting laid out as a
 * symmetric 2×3 grid DERIVED FROM MAP HALF-EXTENTS (TUNING.map) — three columns across the width
 * (left/centre/right) × two rows along the length (front/back), all at the ceiling-fixture height. The
 * four corner cells are wide shadow-casting SpotLights, one per court quadrant, each aimed straight down
 * at its quadrant centre so coverage is even and mirrored left↔right and front↔back. The two
 * centre-column cells are unshadowed fill SpotLights that fill the central seam and remove dead zones.
 * A broad HemisphericLight + a low straight-down DirectionalLight add even fill so the room stays bright
 * and clean. Reflection/IBL response is handled separately by the hidden prefiltered .env
 * (GymVisualRevamp). Every position is computed from map dimensions and the grid fractions in
 * SHOWCASE_CONFIG.lights.roofGrid — no arbitrary hardcoded world coordinates.
 *
 * Shadows (Part 3): one ShadowGenerator per primary spot (four total). The two fill spots cast no
 * shadows. Nothing here is imported by server or shared code, and no gameplay state is derived from it.
 */

export interface ShowcaseLights {
  hemi: HemisphericLight;
  fillDirectional: DirectionalLight | null;
  primarySpots: SpotLight[];
  fillSpots: SpotLight[];
}

type ShadowCasterCategory = 'remotePlayer' | 'mat' | 'dummy' | 'static' | 'other';

interface ShowcaseShadowState {
  scene: Scene;
  generators: ShadowGenerator[];
  filteringMode: ShadowFilteringMode;
  mapSize: number;
  darkness: number;
  casters: Set<Mesh>;
  casterCategories: Map<Mesh, ShadowCasterCategory>;
}

type ShadowFilteringMode = 'pcf' | 'pcfsoft' | 'pcss' | 'poisson' | 'none';

const HEMI_NAME = 'gym_hemi_light';
const FILL_DIR_NAME = 'gym_showcase_fill_dir';
const PRIMARY_SPOT_PREFIX = 'gym_showcase_spot_primary_';
const FILL_SPOT_PREFIX = 'gym_showcase_spot_fill_';
const DEBUG_MARKER_PREFIX = 'gym_showcase_debug_';

let activeShadowState: ShowcaseShadowState | null = null;
let activeLights: ShowcaseLights | null = null;
// Lifetime create count (never reset) so the debug report can flag an accidental duplicate build.
let shadowSystemCreateCount = 0;

/** A primary roof spot covers a court quadrant; a fill spot sits in the centre column. */
type FixtureRole = 'primary' | 'fill';
interface FixtureLightPlacement {
  role: FixtureRole;
  /** Light position on the roof plane (Y = CEILING_FIXTURE_Y). */
  x: number;
  z: number;
  /** Floor aim point directly below (or pulled inward by roofGrid.targetInwardFraction). */
  targetX: number;
  targetZ: number;
  /** Human-readable court zone, surfaced only in the debug report. */
  zone: string;
}

/**
 * Compute the symmetric 2×3 roof-light grid from the map half-extents (TUNING.map) and the grid
 * fractions in SHOWCASE_CONFIG.lights.roofGrid — NOT from hardcoded coordinates. Three X columns
 * (left = −colX, centre = 0, right = +colX) × two Z rows (front = −rowZ, back = +rowZ). The four
 * corners are primary shadow-casting spots (one per court quadrant); the two centre-column cells are
 * fills. Each spot's floor target is its position scaled by targetInwardFraction, so coverage is
 * exactly mirrored left↔right and front↔back. Six placements total (4 primary + 2 fill).
 */
export function planFixtureLights(): FixtureLightPlacement[] {
  const { halfWidth, halfLength } = TUNING.map;
  const grid = SHOWCASE_CONFIG.lights.roofGrid;
  const colX = halfWidth * grid.columnFractionX;
  const rowZ = halfLength * grid.rowFractionZ;
  const inward = grid.targetInwardFraction;

  const place = (role: FixtureRole, x: number, z: number, zone: string): FixtureLightPlacement => ({
    role,
    x,
    z,
    targetX: x * inward,
    targetZ: z * inward,
    zone
  });

  const placements: FixtureLightPlacement[] = [];
  for (const z of [-rowZ, rowZ]) {
    // -Z is the south/"front" end-wall side in this scene's convention; +Z is north/"back".
    const row = z < 0 ? 'front' : 'back';
    placements.push(place('primary', -colX, z, `${row}-left`));
    placements.push(place('fill', 0, z, `${row}-centre`));
    placements.push(place('primary', colX, z, `${row}-right`));
  }
  return placements;
}

/** Mathematically derived aim: direction = normalize(floorTarget − roofPosition). No guessed vector. */
function placementDirection(placement: FixtureLightPlacement): Vector3 {
  const position = new Vector3(placement.x, CEILING_FIXTURE_Y, placement.z);
  const target = new Vector3(placement.targetX, 0, placement.targetZ);
  return target.subtract(position).normalize();
}

/**
 * Build the showcase lights. Idempotent: disposes any prior showcase lights / stray hemis first so a
 * scene rebuild, reconnect, or room reset can never leave duplicate lights behind.
 */
export function applyShowcaseLighting(scene: Scene): ShowcaseLights {
  disposeShowcaseLightMeshes(scene);

  const hemi = configureHemisphericFill(scene);
  const fillDirectional = SHOWCASE_CONFIG.lights.fillDirectional.enabled ? configureFillDirectional(scene) : null;

  const primarySpots: SpotLight[] = [];
  const fillSpots: SpotLight[] = [];
  for (const placement of planFixtureLights()) {
    if (placement.role === 'primary') {
      primarySpots.push(createPrimarySpot(scene, placement));
    } else if (SHOWCASE_CONFIG.lights.fillSpot.enabled) {
      fillSpots.push(createFillSpot(scene, placement));
    }
  }

  activeLights = { hemi, fillDirectional, primarySpots, fillSpots };
  return activeLights;
}

function configureHemisphericFill(scene: Scene): HemisphericLight {
  const existing = scene.lights.find((light): light is HemisphericLight => light instanceof HemisphericLight);
  const hemi = existing ?? new HemisphericLight(HEMI_NAME, new Vector3(0, 1, 0), scene);
  const c = SHOWCASE_CONFIG.lights.hemi;
  hemi.direction = new Vector3(0, 1, 0);
  hemi.intensity = c.intensity;
  hemi.diffuse = new Color3(...c.diffuse);
  hemi.groundColor = new Color3(...c.ground);
  hemi.specular = new Color3(...c.specular);
  // Collapse any duplicate hemis down to the one we keep.
  for (const light of scene.lights.slice()) {
    if (light instanceof HemisphericLight && light !== hemi) light.dispose();
  }
  return hemi;
}

function configureFillDirectional(scene: Scene): DirectionalLight {
  const stale = scene.getLightByName(FILL_DIR_NAME);
  if (stale) stale.dispose();
  const c = SHOWCASE_CONFIG.lights.fillDirectional;
  const dir = new Vector3(...c.direction);
  dir.normalize();
  const fill = new DirectionalLight(FILL_DIR_NAME, dir, scene);
  fill.intensity = c.intensity;
  fill.diffuse = new Color3(...c.diffuse);
  fill.specular = new Color3(0.05, 0.05, 0.05);
  // Broad visual fill ONLY — this light never owns a ShadowGenerator (no fake-sun shadow direction).
  fill.shadowEnabled = false;
  return fill;
}

function createPrimarySpot(scene: Scene, placement: FixtureLightPlacement): SpotLight {
  const c = SHOWCASE_CONFIG.lights.primarySpot;
  const spot = new SpotLight(
    `${PRIMARY_SPOT_PREFIX}${placement.zone}`,
    new Vector3(placement.x, CEILING_FIXTURE_Y, placement.z),
    placementDirection(placement),
    c.angleRadians,
    c.exponent,
    scene
  );
  spot.intensity = c.intensity;
  spot.range = c.range;
  spot.diffuse = new Color3(...c.diffuse);
  spot.specular = new Color3(...c.specular);
  // Depth bounds for the shadow map: casters live between the floor and just under the fixture.
  spot.shadowMinZ = 0.5;
  spot.shadowMaxZ = CEILING_FIXTURE_Y + 1;
  return spot;
}

function createFillSpot(scene: Scene, placement: FixtureLightPlacement): SpotLight {
  const c = SHOWCASE_CONFIG.lights.fillSpot;
  const spot = new SpotLight(
    `${FILL_SPOT_PREFIX}${placement.zone}`,
    new Vector3(placement.x, CEILING_FIXTURE_Y, placement.z),
    placementDirection(placement),
    c.angleRadians,
    c.exponent,
    scene
  );
  spot.intensity = c.intensity;
  spot.range = c.range;
  spot.diffuse = new Color3(...c.diffuse);
  spot.specular = new Color3(...c.specular);
  // Fill only — never gets a ShadowGenerator.
  spot.shadowEnabled = false;
  return spot;
}

/**
 * Create one ShadowGenerator per primary roof spot (four total). Map size + filtering come from the
 * resolved tier / central config. Disposes any prior showcase shadow system first so there is never
 * more than four generators per scene.
 */
export function createShowcaseShadowSystem(scene: Scene, primarySpots: SpotLight[], tier: ShowcaseTier): ShadowGenerator[] {
  disposeShowcaseShadowSystem();

  const cfg = SHOWCASE_CONFIG.shadows;
  const mapSize = cfg.mapSizeByTier[tier];
  // PCF needs WebGL2 / WebGPU. `webGLVersion` only exists on the WebGL engine; absent ⇒ WebGPU (PCF ok).
  const webGLVersion = (scene.getEngine() as { webGLVersion?: number }).webGLVersion;
  const supportsPcf = webGLVersion === undefined || webGLVersion > 1;

  let filteringMode: ShadowFilteringMode = 'none';
  const generators: ShadowGenerator[] = [];
  for (const spot of primarySpots) {
    const generator = new ShadowGenerator(mapSize, spot);
    generator.setDarkness(cfg.darkness);
    generator.bias = cfg.bias;
    generator.normalBias = cfg.normalBias;
    generator.transparencyShadow = false;

    if (!supportsPcf) {
      generator.usePoissonSampling = true;
      filteringMode = 'poisson';
    } else if (cfg.usePcss) {
      // Contact-hardening (PCSS) — Showcase-only, opt-in. Soft size relative to the wide fixture.
      generator.useContactHardeningShadow = true;
      generator.contactHardeningLightSizeUVRatio = 0.06;
      filteringMode = 'pcss';
    } else {
      generator.usePercentageCloserFiltering = true;
      generator.filteringQuality = cfg.filter === 'pcfsoft' ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_MEDIUM;
      filteringMode = cfg.filter === 'pcfsoft' ? 'pcfsoft' : 'pcf';
    }
    generators.push(generator);
  }

  activeShadowState = {
    scene,
    generators,
    filteringMode,
    mapSize,
    darkness: cfg.darkness,
    casters: new Set<Mesh>(),
    casterCategories: new Map()
  };
  shadowSystemCreateCount++;
  return generators;
}

/**
 * Register a shadow caster with EVERY primary-spot generator so each fixture casts the mesh's shadow.
 * `includeDescendants` pulls in parented child submeshes (e.g. a dummy's head/torso/limbs). Safe before
 * the system exists (no-op), idempotent, and auto-unregistered if the mesh is disposed.
 */
export function registerShowcaseShadowCaster(mesh: Mesh | null | undefined, includeDescendants = false): void {
  if (!mesh || !activeShadowState) return;
  if (activeShadowState.casters.has(mesh)) return;
  activeShadowState.casters.add(mesh);
  activeShadowState.casterCategories.set(mesh, categorizeShadowCaster(mesh));
  for (const generator of activeShadowState.generators) generator.addShadowCaster(mesh, includeDescendants);
  mesh.onDisposeObservable.addOnce(() => unregisterShowcaseShadowCaster(mesh));
}

export function unregisterShowcaseShadowCaster(mesh: Mesh | null | undefined): void {
  if (!mesh || !activeShadowState) return;
  if (!activeShadowState.casters.delete(mesh)) return;
  activeShadowState.casterCategories.delete(mesh);
  for (const generator of activeShadowState.generators) generator.removeShadowCaster(mesh, true);
}

/** Dispose the showcase shadow generators (lights are disposed separately by disposeShowcaseLightMeshes). */
export function disposeShowcaseShadowSystem(): void {
  if (!activeShadowState) return;
  activeShadowState.casters.clear();
  activeShadowState.casterCategories.clear();
  for (const generator of activeShadowState.generators) generator.dispose();
  activeShadowState = null;
}

/** Dispose generators AND showcase lights — full teardown on scene destruction. */
export function disposeShowcaseLighting(scene: Scene): void {
  disposeShowcaseShadowSystem();
  disposeShowcaseLightMeshes(scene);
  activeLights = null;
}

function disposeShowcaseLightMeshes(scene: Scene): void {
  const stale = scene.getLightByName(FILL_DIR_NAME);
  if (stale) stale.dispose();
  for (const light of scene.lights.slice()) {
    if (light.name.startsWith(PRIMARY_SPOT_PREFIX) || light.name.startsWith(FILL_SPOT_PREFIX)) light.dispose();
  }
  disposeShowcaseDebugMarkers(scene);
}

/**
 * DEBUG-ONLY roof-light visualization (Part: "add temporary debug visualization only if needed"). Drops
 * a coloured marker sphere at every roof spot (primary = warm, fill = cool) and a flat marker at each
 * spot's floor target, so the symmetric grid + aim can be verified by eye. Created ONLY when the caller
 * passes the graphics-debug flag; never present in normal play. Idempotent (clears prior markers first).
 */
export function createShowcaseDebugMarkers(scene: Scene): void {
  disposeShowcaseDebugMarkers(scene);

  const primaryMat = new StandardMaterial(`${DEBUG_MARKER_PREFIX}primary_mat`, scene);
  primaryMat.emissiveColor = new Color3(1, 0.35, 0.1);
  primaryMat.disableLighting = true;
  const fillMat = new StandardMaterial(`${DEBUG_MARKER_PREFIX}fill_mat`, scene);
  fillMat.emissiveColor = new Color3(0.1, 0.7, 1);
  fillMat.disableLighting = true;
  const targetMat = new StandardMaterial(`${DEBUG_MARKER_PREFIX}target_mat`, scene);
  targetMat.emissiveColor = new Color3(1, 1, 0.2);
  targetMat.disableLighting = true;

  for (const p of planFixtureLights()) {
    const isPrimary = p.role === 'primary';
    const source = MeshBuilder.CreateSphere(`${DEBUG_MARKER_PREFIX}src_${p.zone}`, { diameter: isPrimary ? 0.7 : 0.5 }, scene);
    source.position.set(p.x, CEILING_FIXTURE_Y, p.z);
    source.material = isPrimary ? primaryMat : fillMat;
    source.isPickable = false;

    const target = MeshBuilder.CreateDisc(`${DEBUG_MARKER_PREFIX}tgt_${p.zone}`, { radius: 0.6, tessellation: 16 }, scene);
    target.position.set(p.targetX, 0.06, p.targetZ);
    target.rotation.x = Math.PI / 2; // lay flat on the floor
    target.material = targetMat;
    target.isPickable = false;
  }
}

function disposeShowcaseDebugMarkers(scene: Scene): void {
  for (const mesh of scene.meshes.slice()) {
    if (mesh.name.startsWith(DEBUG_MARKER_PREFIX)) mesh.dispose();
  }
  for (const material of scene.materials.slice()) {
    if (material.name.startsWith(DEBUG_MARKER_PREFIX)) material.dispose();
  }
}

function categorizeShadowCaster(mesh: Mesh): ShadowCasterCategory {
  const name = mesh.name;
  if (name.startsWith('player_') || name.startsWith('remotePlayerBody_')) return 'remotePlayer';
  if (name === 'mat') return 'mat';
  if (name === 'moving_dummy' || name.startsWith('target_dummy')) return 'dummy';
  if (name.startsWith('bleacher_') || name.startsWith('decor_wall_pad_') || name.startsWith('decor_scoreboard_')) return 'static';
  return 'other';
}

function categorizeShadowMeshName(name: string): ShadowCasterCategory {
  if (name.startsWith('player_') || name.startsWith('remotePlayerBody_')) return 'remotePlayer';
  if (name === 'mat' || name.startsWith('mat_')) return 'mat';
  if (name.includes('dummy')) return 'dummy';
  if (name.startsWith('bleacher_') || name.startsWith('decor_wall_pad_') || name.startsWith('decor_scoreboard_')) return 'static';
  return 'other';
}

export interface ShowcaseSpotReport {
  zone: string;
  role: FixtureRole;
  /** Roof position. */
  x: number;
  z: number;
  /** Floor aim point where the cone axis meets y = 0 (derived from the light's real direction). */
  targetX: number;
  targetZ: number;
  angle: number;
  exponent: number;
  range: number;
  intensity: number;
  castsShadow: boolean;
}

export interface ShowcaseGraphicsDebugStats {
  lights: {
    hemiCount: number;
    fillDirectionalCount: number;
    primarySpotCount: number;
    fillSpotCount: number;
    /** Position, floor target, and cone params for every roof spot (4 primary + 2 fill). */
    spotReports: ShowcaseSpotReport[];
  };
  shadow: {
    generatorCount: number;
    lifetimeCreateCount: number;
    filteringMode: ShadowFilteringMode;
    mapSizePerGenerator: number | null;
    darkness: number | null;
    casterCount: number;
    casterCountsByCategory: Record<ShadowCasterCategory, number>;
    renderListCount: number;
    renderListCountsByCategory: Record<ShadowCasterCategory, number>;
  };
}

/** Project a spot's actual position + direction down to the floor (y = 0) for the report. */
function describeSpot(spot: SpotLight, role: FixtureRole, prefix: string, castsShadow: boolean): ShowcaseSpotReport {
  const dirY = spot.direction.y;
  // Distance along the axis until it reaches the floor plane (dirY is negative — pointing down).
  const t = dirY < 0 ? spot.position.y / -dirY : 0;
  return {
    zone: spot.name.replace(prefix, ''),
    role,
    x: spot.position.x,
    z: spot.position.z,
    targetX: spot.position.x + spot.direction.x * t,
    targetZ: spot.position.z + spot.direction.z * t,
    angle: spot.angle,
    exponent: spot.exponent,
    range: spot.range,
    intensity: spot.intensity,
    castsShadow
  };
}

/** Debug-only snapshot for the graphics report — never read for gameplay. */
export function getShowcaseGraphicsDebugStats(): ShowcaseGraphicsDebugStats {
  const emptyCounts = (): Record<ShadowCasterCategory, number> => ({ remotePlayer: 0, mat: 0, dummy: 0, static: 0, other: 0 });
  const casterCountsByCategory = emptyCounts();
  const renderListCountsByCategory = emptyCounts();
  let renderListCount = 0;

  if (activeShadowState) {
    for (const category of activeShadowState.casterCategories.values()) casterCountsByCategory[category]++;
    // All four generators share the same caster list; read generator[0] for the render-list breakdown.
    const renderList = activeShadowState.generators[0]?.getShadowMap()?.renderList ?? [];
    renderListCount = renderList.length;
    for (const mesh of renderList) renderListCountsByCategory[categorizeShadowMeshName(mesh.name)]++;
  }

  const spotReports: ShowcaseSpotReport[] = [
    ...(activeLights?.primarySpots ?? []).map((spot) => describeSpot(spot, 'primary', PRIMARY_SPOT_PREFIX, true)),
    ...(activeLights?.fillSpots ?? []).map((spot) => describeSpot(spot, 'fill', FILL_SPOT_PREFIX, false))
  ];

  return {
    lights: {
      hemiCount: activeLights?.hemi ? 1 : 0,
      fillDirectionalCount: activeLights?.fillDirectional ? 1 : 0,
      primarySpotCount: activeLights?.primarySpots.length ?? 0,
      fillSpotCount: activeLights?.fillSpots.length ?? 0,
      spotReports
    },
    shadow: {
      generatorCount: activeShadowState?.generators.length ?? 0,
      lifetimeCreateCount: shadowSystemCreateCount,
      filteringMode: activeShadowState?.filteringMode ?? 'none',
      mapSizePerGenerator: activeShadowState?.mapSize ?? null,
      darkness: activeShadowState?.darkness ?? null,
      casterCount: activeShadowState?.casters.size ?? 0,
      casterCountsByCategory,
      renderListCount,
      renderListCountsByCategory
    }
  };
}
