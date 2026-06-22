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
import { CEILING_FIXTURE_POSITIONS, CEILING_FIXTURE_Y } from './GymArena';
import { TUNING } from '../config/tuning';

/**
 * Client-only SHOWCASE lighting + dynamic-shadow system for the gym (graphics mode "showcase").
 *
 * Phase 6 — ONE coherent fixture-aligned rig (replaces the old 2×3 derived-grid stack):
 *   - SIX broad, low-intensity SpotLights, one directly under each VISIBLE ceiling fixture. Positions
 *     are REUSED from CEILING_FIXTURE_POSITIONS (the single authoritative fixture source in GymArena) —
 *     never re-derived from map half-extents — so every direct light sits under a real fixture and no
 *     light exists without a matching fixture. Aimed straight down, very wide soft cones, low specular:
 *     they read as fluorescent fixture pools, never theatrical circles. They NEVER cast shadows.
 *   - ONE low HemisphericLight for broad even fill (keeps walls/ceiling bright, shadows off-black).
 *   - ONE subtle shadow-casting DirectionalLight — the ONLY shadow source — driving exactly ONE
 *     ShadowGenerator. Mostly straight down with a slight tilt so shadows read with one consistent
 *     direction (no conflicting shadow directions).
 *
 * Final runtime: 8 lights (6 fixture spots + 1 hemi + 1 shadow directional) and exactly 1 ShadowGenerator.
 * No .env IBL, no reflection probe, no SSAO, no bloom (post is FXAA-only, owned by ArenaScene). Nothing
 * here is imported by server or shared code, and no gameplay state is derived from it.
 */

export interface ShowcaseLights {
  hemi: HemisphericLight;
  /** Six shadowless fixture spots, one under each visible ceiling fixture. */
  fixtureSpots: SpotLight[];
  /** The single shadow-casting directional — the only light bound to the ShadowGenerator. */
  shadowKey: DirectionalLight;
}

type ShadowCasterCategory = 'remotePlayer' | 'mat' | 'dummy' | 'static' | 'other';

interface ShowcaseShadowState {
  scene: Scene;
  generator: ShadowGenerator;
  filteringMode: ShadowFilteringMode;
  mapSize: number;
  darkness: number;
  casters: Set<Mesh>;
  casterCategories: Map<Mesh, ShadowCasterCategory>;
}

type ShadowFilteringMode = 'pcf' | 'pcfsoft' | 'poisson' | 'none';

const HEMI_NAME = 'gym_hemi_light';
const SHADOW_KEY_NAME = 'gym_showcase_shadow_key';
const FIXTURE_SPOT_PREFIX = 'gym_showcase_fixture_';
const DEBUG_MARKER_PREFIX = 'gym_showcase_debug_';

let activeShadowState: ShowcaseShadowState | null = null;
let activeLights: ShowcaseLights | null = null;
// Lifetime create count (never reset) so the debug report can flag an accidental duplicate build.
let shadowSystemCreateCount = 0;

interface FixtureLightPlacement {
  /** Light position on the fixture plane (Y = CEILING_FIXTURE_Y). */
  x: number;
  z: number;
  /** Human-readable court zone, surfaced only in the debug report. */
  zone: string;
}

/**
 * The six fixture placements, taken DIRECTLY from CEILING_FIXTURE_POSITIONS (the same list that builds
 * the visible fixture housings) so each light sits exactly under a real fixture. No map-half-extent
 * derivation, no arbitrary coordinates — the lights and the visible fixtures are guaranteed to match.
 */
export function planFixtureLights(): FixtureLightPlacement[] {
  return CEILING_FIXTURE_POSITIONS.map(([x, z]) => {
    const row = z < 0 ? 'south' : z > 0 ? 'north' : 'mid';
    const col = x < 0 ? 'left' : 'right';
    return { x, z, zone: `${row}-${col}` };
  });
}

/**
 * Build the showcase lights. Idempotent: disposes any prior showcase lights / stray hemis first so a
 * scene rebuild, reconnect, or room reset can never leave duplicate lights behind.
 */
export function applyShowcaseLighting(scene: Scene): ShowcaseLights {
  disposeShowcaseLightMeshes(scene);

  const hemi = configureHemisphericFill(scene);
  const fixtureSpots = planFixtureLights().map((placement, index) => createFixtureSpot(scene, placement, index));
  const shadowKey = configureShadowKey(scene);

  activeLights = { hemi, fixtureSpots, shadowKey };
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

/** One broad shadowless fixture spot, aimed straight down from under a visible ceiling fixture. */
function createFixtureSpot(scene: Scene, placement: FixtureLightPlacement, index: number): SpotLight {
  const c = SHOWCASE_CONFIG.lights.fixtureSpot;
  const spot = new SpotLight(
    `${FIXTURE_SPOT_PREFIX}${index}_${placement.zone}`,
    new Vector3(placement.x, CEILING_FIXTURE_Y, placement.z),
    new Vector3(0, -1, 0), // straight down — even pool directly below the fixture
    c.angleRadians,
    c.exponent,
    scene
  );
  spot.intensity = c.intensity;
  spot.range = c.range;
  spot.diffuse = new Color3(...c.diffuse);
  spot.specular = new Color3(...c.specular);
  // Fixture lights NEVER cast shadows — only the single shadowKey directional does.
  spot.shadowEnabled = false;
  return spot;
}

/**
 * The single shadow-casting directional. Mirrors the proven Competitive key-light frustum (fixed
 * orthographic projection derived from map dimensions so shadows don't shimmer/resize), but at lower
 * intensity so the fixtures own the room brightness and this only adds a subtle shadow direction.
 */
function configureShadowKey(scene: Scene): DirectionalLight {
  const stale = scene.getLightByName(SHADOW_KEY_NAME);
  if (stale) stale.dispose();

  const c = SHOWCASE_CONFIG.lights.shadowKey;
  const { halfWidth, halfLength, wallHeight } = TUNING.map;
  const margin = 5;
  const extent = Math.max(halfWidth, halfLength) + margin;

  const direction = new Vector3(...c.direction);
  direction.normalize();

  const key = new DirectionalLight(SHADOW_KEY_NAME, direction, scene);
  key.intensity = c.intensity;
  key.diffuse = new Color3(...c.diffuse);
  key.specular = new Color3(...c.specular);

  // Fixed orthographic frustum covering the full court + margin, placed above court centre opposite
  // the light direction (autoUpdateExtends off keeps the projection stable as players move).
  const distance = wallHeight * 1.5 + extent;
  key.position = direction.scale(-distance);
  key.autoUpdateExtends = false;
  key.orthoLeft = -extent;
  key.orthoRight = extent;
  key.orthoTop = extent;
  key.orthoBottom = -extent;
  key.shadowMinZ = Math.max(1, distance - extent - 5);
  key.shadowMaxZ = distance + extent + 5;

  return key;
}

/**
 * Create the SINGLE Showcase ShadowGenerator, bound to the shadowKey directional. Map size + filtering
 * come from the resolved tier / central config. Disposes any prior showcase shadow system first so there
 * is never more than one generator per scene.
 */
export function createShowcaseShadowSystem(scene: Scene, shadowKey: DirectionalLight, tier: ShowcaseTier): ShadowGenerator {
  disposeShowcaseShadowSystem();

  const cfg = SHOWCASE_CONFIG.shadows;
  const mapSize = cfg.mapSizeByTier[tier];
  // PCF needs WebGL2 / WebGPU. `webGLVersion` only exists on the WebGL engine; absent ⇒ WebGPU (PCF ok).
  const webGLVersion = (scene.getEngine() as { webGLVersion?: number }).webGLVersion;
  const supportsPcf = webGLVersion === undefined || webGLVersion > 1;

  const generator = new ShadowGenerator(mapSize, shadowKey);
  generator.setDarkness(cfg.darkness);
  generator.bias = cfg.bias;
  generator.normalBias = cfg.normalBias;
  generator.transparencyShadow = false;

  let filteringMode: ShadowFilteringMode = 'none';
  if (!supportsPcf) {
    generator.usePoissonSampling = true;
    filteringMode = 'poisson';
  } else {
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = cfg.filter === 'pcfsoft' ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_MEDIUM;
    filteringMode = cfg.filter === 'pcfsoft' ? 'pcfsoft' : 'pcf';
  }

  activeShadowState = {
    scene,
    generator,
    filteringMode,
    mapSize,
    darkness: cfg.darkness,
    casters: new Set<Mesh>(),
    casterCategories: new Map()
  };
  shadowSystemCreateCount++;
  return generator;
}

/**
 * Register a shadow caster with the single Showcase generator. `includeDescendants` pulls in parented
 * child submeshes (e.g. a dummy's head/torso/limbs). Safe before the system exists (no-op), idempotent,
 * and auto-unregistered if the mesh is disposed.
 */
export function registerShowcaseShadowCaster(mesh: Mesh | null | undefined, includeDescendants = false): void {
  if (!mesh || !activeShadowState) return;
  if (activeShadowState.casters.has(mesh)) return;
  activeShadowState.casters.add(mesh);
  activeShadowState.casterCategories.set(mesh, categorizeShadowCaster(mesh));
  activeShadowState.generator.addShadowCaster(mesh, includeDescendants);
  mesh.onDisposeObservable.addOnce(() => unregisterShowcaseShadowCaster(mesh));
}

export function unregisterShowcaseShadowCaster(mesh: Mesh | null | undefined): void {
  if (!mesh || !activeShadowState) return;
  if (!activeShadowState.casters.delete(mesh)) return;
  activeShadowState.casterCategories.delete(mesh);
  activeShadowState.generator.removeShadowCaster(mesh, true);
}

/** Dispose the showcase shadow generator (lights are disposed separately by disposeShowcaseLightMeshes). */
export function disposeShowcaseShadowSystem(): void {
  if (!activeShadowState) return;
  activeShadowState.casters.clear();
  activeShadowState.casterCategories.clear();
  activeShadowState.generator.dispose();
  activeShadowState = null;
}

/** Dispose generator AND showcase lights — full teardown on scene destruction. */
export function disposeShowcaseLighting(scene: Scene): void {
  disposeShowcaseShadowSystem();
  disposeShowcaseLightMeshes(scene);
  activeLights = null;
}

function disposeShowcaseLightMeshes(scene: Scene): void {
  const stale = scene.getLightByName(SHADOW_KEY_NAME);
  if (stale) stale.dispose();
  for (const light of scene.lights.slice()) {
    if (light.name.startsWith(FIXTURE_SPOT_PREFIX)) light.dispose();
  }
  disposeShowcaseDebugMarkers(scene);
}

/**
 * DEBUG-ONLY fixture-light visualization. Drops a warm marker sphere at every fixture spot and a flat
 * marker on the floor directly below it, so the fixture-aligned grid can be verified by eye. Created
 * ONLY when the caller passes the graphics-debug flag; never present in normal play. Idempotent.
 */
export function createShowcaseDebugMarkers(scene: Scene): void {
  disposeShowcaseDebugMarkers(scene);

  const sourceMat = new StandardMaterial(`${DEBUG_MARKER_PREFIX}src_mat`, scene);
  sourceMat.emissiveColor = new Color3(1, 0.78, 0.4);
  sourceMat.disableLighting = true;
  const targetMat = new StandardMaterial(`${DEBUG_MARKER_PREFIX}target_mat`, scene);
  targetMat.emissiveColor = new Color3(1, 1, 0.2);
  targetMat.disableLighting = true;

  for (const p of planFixtureLights()) {
    const source = MeshBuilder.CreateSphere(`${DEBUG_MARKER_PREFIX}src_${p.zone}`, { diameter: 0.6 }, scene);
    source.position.set(p.x, CEILING_FIXTURE_Y, p.z);
    source.material = sourceMat;
    source.isPickable = false;

    const target = MeshBuilder.CreateDisc(`${DEBUG_MARKER_PREFIX}tgt_${p.zone}`, { radius: 0.6, tessellation: 16 }, scene);
    target.position.set(p.x, 0.06, p.z);
    target.rotation.x = Math.PI / 2; // lay flat on the floor directly below the fixture
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

export interface ShowcaseFixtureReport {
  zone: string;
  /** Fixture (and light) position. */
  x: number;
  z: number;
  angle: number;
  exponent: number;
  range: number;
  intensity: number;
  castsShadow: boolean;
}

export interface ShowcaseGraphicsDebugStats {
  lights: {
    hemiCount: number;
    fixtureSpotCount: number;
    shadowKeyCount: number;
    /** Position + cone params for every fixture spot (6 total, none casting). */
    fixtureReports: ShowcaseFixtureReport[];
  };
  shadow: {
    generatorCount: number;
    lifetimeCreateCount: number;
    filteringMode: ShadowFilteringMode;
    mapSize: number | null;
    darkness: number | null;
    casterCount: number;
    casterCountsByCategory: Record<ShadowCasterCategory, number>;
    renderListCount: number;
    renderListCountsByCategory: Record<ShadowCasterCategory, number>;
  };
}

function describeFixture(spot: SpotLight, zone: string): ShowcaseFixtureReport {
  return {
    zone,
    x: spot.position.x,
    z: spot.position.z,
    angle: spot.angle,
    exponent: spot.exponent,
    range: spot.range,
    intensity: spot.intensity,
    castsShadow: false
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
    const renderList = activeShadowState.generator.getShadowMap()?.renderList ?? [];
    renderListCount = renderList.length;
    for (const mesh of renderList) renderListCountsByCategory[categorizeShadowMeshName(mesh.name)]++;
  }

  const fixtureReports: ShowcaseFixtureReport[] = (activeLights?.fixtureSpots ?? []).map((spot) =>
    describeFixture(spot, spot.name.replace(FIXTURE_SPOT_PREFIX, ''))
  );

  return {
    lights: {
      hemiCount: activeLights?.hemi ? 1 : 0,
      fixtureSpotCount: activeLights?.fixtureSpots.length ?? 0,
      shadowKeyCount: activeLights?.shadowKey ? 1 : 0,
      fixtureReports
    },
    shadow: {
      generatorCount: activeShadowState ? 1 : 0,
      lifetimeCreateCount: shadowSystemCreateCount,
      filteringMode: activeShadowState?.filteringMode ?? 'none',
      mapSize: activeShadowState?.mapSize ?? null,
      darkness: activeShadowState?.darkness ?? null,
      casterCount: activeShadowState?.casters.size ?? 0,
      casterCountsByCategory,
      renderListCount,
      renderListCountsByCategory
    }
  };
}
