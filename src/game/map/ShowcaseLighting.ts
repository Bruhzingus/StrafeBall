import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  Scene,
  ShadowGenerator,
  Vector3
} from '@babylonjs/core';
import { SHOWCASE_CONFIG, type ShowcaseTier } from '../config/graphicsConfig';
import { TUNING } from '../config/tuning';

/**
 * Client-only SHOWCASE lighting + dynamic-shadow system for the gym (graphics mode "showcase").
 *
 * The gym is lit by EVEN ambient room light, not aimed sources (the old 6-spotlight rig pooled under
 * each fixture and read like stage lights):
 *   - ONE broad HemisphericLight — the main fill. Warm-white on upward faces; a deliberately DARKER cool
 *     ground colour so downward-facing surfaces, corners, and under-bleacher areas fall off naturally,
 *     giving the whole map depth and darker corners with no fake AO.
 *   - ONE angled DirectionalLight — the key (modelling + the single ShadowGenerator). It rakes across
 *     the court so shadows give depth; corners away from it stay darker.
 * The visible ceiling fixtures stay emissive housings (built in GymArena / GymVisualRevamp); they are
 * NOT light sources here, so there are no spotlight pools.
 *
 * Final runtime: 2 lights (1 hemi + 1 directional) and exactly 1 ShadowGenerator. No .env IBL, no
 * reflection probe, no SSAO, no bloom (post is FXAA-only, owned by ArenaScene). Nothing here is imported
 * by server or shared code, and no gameplay state is derived from it.
 */

export interface ShowcaseLights {
  hemi: HemisphericLight;
  /** The single directional key — modelling light and the only ShadowGenerator source. */
  key: DirectionalLight;
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
const KEY_NAME = 'gym_showcase_key';

let activeShadowState: ShowcaseShadowState | null = null;
let activeLights: ShowcaseLights | null = null;
// Lifetime create count (never reset) so the debug report can flag an accidental duplicate build.
let shadowSystemCreateCount = 0;

/**
 * Build the showcase lights. Idempotent: disposes any prior showcase lights / stray hemis first so a
 * scene rebuild, reconnect, or room reset can never leave duplicate lights behind.
 */
export function applyShowcaseLighting(scene: Scene): ShowcaseLights {
  disposeShowcaseLightMeshes(scene);

  const hemi = configureHemisphericFill(scene);
  const key = configureKeyLight(scene);

  activeLights = { hemi, key };
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

/**
 * The single directional key. Fixed orthographic frustum derived from map dimensions (so shadows don't
 * shimmer/resize as players move), angled diagonally for modelling + depth. Drives the ShadowGenerator.
 */
function configureKeyLight(scene: Scene): DirectionalLight {
  const stale = scene.getLightByName(KEY_NAME);
  if (stale) stale.dispose();

  const c = SHOWCASE_CONFIG.lights.key;
  const { halfWidth, halfLength, wallHeight } = TUNING.map;
  const margin = 5;
  const extent = Math.max(halfWidth, halfLength) + margin;

  const direction = new Vector3(...c.direction);
  direction.normalize();

  const key = new DirectionalLight(KEY_NAME, direction, scene);
  key.intensity = c.intensity;
  key.diffuse = new Color3(...c.diffuse);
  key.specular = new Color3(...c.specular);

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
 * Create the SINGLE Showcase ShadowGenerator, bound to the directional key. Map size + filtering come
 * from the resolved tier / central config. Disposes any prior showcase shadow system first so there is
 * never more than one generator per scene.
 */
export function createShowcaseShadowSystem(scene: Scene, key: DirectionalLight, tier: ShowcaseTier): ShadowGenerator {
  disposeShowcaseShadowSystem();

  const cfg = SHOWCASE_CONFIG.shadows;
  const mapSize = cfg.mapSizeByTier[tier];
  // PCF needs WebGL2 / WebGPU. `webGLVersion` only exists on the WebGL engine; absent ⇒ WebGPU (PCF ok).
  const webGLVersion = (scene.getEngine() as { webGLVersion?: number }).webGLVersion;
  const supportsPcf = webGLVersion === undefined || webGLVersion > 1;

  const generator = new ShadowGenerator(mapSize, key);
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
  const stale = scene.getLightByName(KEY_NAME);
  if (stale) stale.dispose();
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

export interface ShowcaseGraphicsDebugStats {
  lights: {
    hemiCount: number;
    keyCount: number;
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

  return {
    lights: {
      hemiCount: activeLights?.hemi ? 1 : 0,
      keyCount: activeLights?.key ? 1 : 0
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
