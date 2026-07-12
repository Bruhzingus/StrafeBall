import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  Scene,
  ShadowGenerator,
  Vector3
} from '@babylonjs/core';
import { TUNING } from '../config/tuning';

/**
 * Client-only competitive lighting + dynamic-shadow system for the gym.
 *
 * Replaces the old multi-PointLight rig with a fixed, performance-conscious setup: one ambient
 * HemisphericLight (fill / readability), one DirectionalLight (key light + dynamic shadows), and one
 * ShadowGenerator. There are zero runtime point/spot lights, no SSR/planar/screen-space reflections,
 * no SSAO, volumetrics, bloom, or any render target that updates every frame (the shadow map renders
 * once per shadow-casting draw call as usual). Reflection response for the gym's glossy surfaces is
 * handled separately by a hidden HDR environment texture (see GymVisualRevamp.applyGymEnvironment) —
 * no reflection probe is used. Nothing here is imported by server or shared code, and no gameplay
 * state is derived from these meshes.
 */

export interface CompetitiveLights {
  hemi: HemisphericLight;
  key: DirectionalLight;
}

type Tuple3 = [number, number, number];

/**
 * Optional light-value overrides (Polished mode passes POLISHED_CONFIG values through here; the
 * Performance/Neutral baseline omits them entirely). Every default equals the compiled Competitive
 * value, so a bare applyCompetitiveLighting(scene) is bit-identical to the pre-overhaul rig — ONE
 * lighting implementation, two value sets, instead of the parallel-module drift the old Showcase
 * rig suffered from.
 */
export interface CompetitiveLightingSpec {
  hemi?: { intensity?: number; diffuse?: Tuple3; ground?: Tuple3; specular?: Tuple3 };
  key?: { intensity?: number; direction?: Tuple3; diffuse?: Tuple3; specular?: Tuple3 };
}

export interface CompetitiveShadowOptions {
  /** Shadow map resolution. Competitive default is 1024. */
  mapSize?: number;
  /** Shadow darkness (Babylon: 0 = black, 1 = invisible). Competitive default ~0.2. */
  darkness?: number;
  /** Depth bias. Default 0.0015 (the long-standing Competitive value). */
  bias?: number;
  /** Normal-scaled bias. Default 0.02. First lever against static-geometry self-shadow acne. */
  normalBias?: number;
  /** Render only back faces into the shadow map — the standard acne fix for closed static meshes. */
  forceBackFacesOnly?: boolean;
}

/** Mesh category recorded per shadow caster, surfaced only through the debug stats below. */
type ShadowCasterCategory = 'remotePlayer' | 'mat' | 'dummy' | 'other';

interface ShadowSystemState {
  scene: Scene;
  generator: ShadowGenerator;
  casters: Set<Mesh>;
  casterCategories: Map<Mesh, ShadowCasterCategory>;
}

// One system per process. The app uses a single long-lived scene, so a module singleton is enough;
// createCompetitiveShadowSystem() still disposes any prior system first to guard against duplicate
// generators if lighting setup ever runs twice (scene rebuild / re-init).
let activeShadowSystem: ShadowSystemState | null = null;

// Lifetime creation count (never reset), purely so the debug report below can flag whether a
// reset/rebuild/reconnect ever created a second generator instead of reusing/disposing the first —
// createCompetitiveShadowSystem already disposes any prior instance, so this should only ever read
// 0 or 1 in normal operation; >1 would mean a caller bypassed the singleton guard.
let shadowSystemCreateCount = 0;

export interface CompetitiveGraphicsDebugStats {
  shadow: {
    /** Always 0 or 1 in this scene; >1 would indicate a duplicate-generator bug. */
    activeGeneratorCount: number;
    lifetimeCreateCount: number;
    filteringMode: 'pcf' | 'poisson' | 'none';
    mapSize: number | null;
    darkness: number | null;
    /** Registered caster ROOTS (one per registerCompetitiveShadowCaster call). */
    casterCount: number;
    casterCountsByCategory: Record<ShadowCasterCategory, number>;
    /** Total meshes actually in the shadow-map render list — INCLUDES parented child submeshes
     * (e.g. each dummy's head/torso/limbs), so it is the true count of things casting shadows. */
    renderListCount: number;
    /** renderListCount broken down by category (children included). This is what proves remote
     * player / mat / dummy child meshes are really registered as casters. */
    renderListCountsByCategory: Record<ShadowCasterCategory, number>;
  };
}

/** Categorize a shadow-map render-list mesh by name — handles parented child submeshes, not just
 * registered roots (e.g. 'dummy_head_moving', 'remotePlayerBody_<id>', the merged 'mat'). */
function categorizeShadowMeshName(name: string): ShadowCasterCategory {
  if (name.startsWith('player_') || name.startsWith('remotePlayerBody_')) return 'remotePlayer';
  if (name === 'mat' || name.startsWith('mat_')) return 'mat';
  if (name.includes('dummy')) return 'dummy';
  return 'other';
}

/** Debug-only snapshot for the graphics debug flag — never read for gameplay logic. */
export function getCompetitiveGraphicsDebugStats(): CompetitiveGraphicsDebugStats {
  const casterCountsByCategory: Record<ShadowCasterCategory, number> = {
    remotePlayer: 0,
    mat: 0,
    dummy: 0,
    other: 0
  };
  const renderListCountsByCategory: Record<ShadowCasterCategory, number> = {
    remotePlayer: 0,
    mat: 0,
    dummy: 0,
    other: 0
  };
  let filteringMode: 'pcf' | 'poisson' | 'none' = 'none';
  let mapSize: number | null = null;
  let darkness: number | null = null;
  let renderListCount = 0;
  if (activeShadowSystem) {
    for (const category of activeShadowSystem.casterCategories.values()) casterCountsByCategory[category]++;
    const generator = activeShadowSystem.generator;
    filteringMode = generator.usePercentageCloserFiltering ? 'pcf' : generator.usePoissonSampling ? 'poisson' : 'none';
    mapSize = generator.getShadowMap()?.getRenderSize() ?? null;
    darkness = generator.getDarkness();
    // The shadow map's renderList holds every mesh that actually casts — registered roots AND the
    // child submeshes pulled in via includeDescendants. Counting it (not just the roots) is what
    // proves the dummies' / remote players' child meshes are truly in the shadow pass.
    const renderList = generator.getShadowMap()?.renderList ?? [];
    renderListCount = renderList.length;
    for (const mesh of renderList) renderListCountsByCategory[categorizeShadowMeshName(mesh.name)]++;
  }

  return {
    shadow: {
      activeGeneratorCount: activeShadowSystem ? 1 : 0,
      lifetimeCreateCount: shadowSystemCreateCount,
      filteringMode,
      mapSize,
      darkness,
      casterCount: activeShadowSystem?.casters.size ?? 0,
      casterCountsByCategory,
      renderListCount,
      renderListCountsByCategory
    }
  };
}

/**
 * Set up the competitive lights. Reuses an existing HemisphericLight if the scene already has one
 * (the scene creates `gym_hemi_light` before the gym builds) so we never end up with duplicates,
 * and disposes any stray extra hemis. Returns the key light so the caller can hand it to the
 * shadow system.
 */
export function applyCompetitiveLighting(scene: Scene, spec: CompetitiveLightingSpec = {}): CompetitiveLights {
  const hemi = configureHemisphericLight(scene, spec.hemi ?? {});
  const key = configureKeyLight(scene, spec.key ?? {});
  return { hemi, key };
}

function color3(rgb: Tuple3): Color3 {
  return new Color3(rgb[0], rgb[1], rgb[2]);
}

function configureHemisphericLight(scene: Scene, spec: NonNullable<CompetitiveLightingSpec['hemi']>): HemisphericLight {
  const existing = scene.lights.find((light): light is HemisphericLight => light instanceof HemisphericLight);
  const hemi = existing ?? new HemisphericLight('gym_hemi_light', new Vector3(0, 1, 0), scene);

  // Straight-up ambient fill for competitive readability, not mood. This is the main broad-fill
  // lever: it lifts the ceiling underside, walls, and navy detail evenly like overhead gym lighting.
  // Intensity nudged up (0.75 → 0.79) to replace the brightness the removed fake floor-wash decals
  // used to fake — the room stays the bright baseline, now lit only by real lights.
  hemi.direction = new Vector3(0, 1, 0);
  hemi.intensity = spec.intensity ?? 0.79;
  hemi.diffuse = color3(spec.diffuse ?? [1.0, 0.98, 0.93]); // near-neutral, faint warm
  hemi.groundColor = color3(spec.ground ?? [0.46, 0.48, 0.52]); // subdued neutral-gray, lifted so it doesn't drag
  hemi.specular = color3(spec.specular ?? [0.12, 0.12, 0.13]);

  // Defensive: collapse any duplicate hemispheric lights down to the single one we keep.
  for (const light of scene.lights.slice()) {
    if (light instanceof HemisphericLight && light !== hemi) light.dispose();
  }
  return hemi;
}

function configureKeyLight(scene: Scene, spec: NonNullable<CompetitiveLightingSpec['key']>): DirectionalLight {
  // Never leave a stale key light behind if this runs again.
  const stale = scene.getLightByName('gym_key_light');
  if (stale) stale.dispose();

  const { halfWidth, halfLength, wallHeight } = TUNING.map;
  const margin = 5;
  const extent = Math.max(halfWidth, halfLength) + margin;

  // Gentle diagonal, strongly overhead so indoor shadows stay short and readable (no long
  // cinematic rake). Direction is a unit vector, not a world coordinate.
  const dir = spec.direction ?? [-0.35, -1, -0.25];
  const direction = new Vector3(dir[0], dir[1], dir[2]);
  direction.normalize();

  const key = new DirectionalLight('gym_key_light', direction, scene);
  key.intensity = spec.intensity ?? 0.92;
  key.diffuse = color3(spec.diffuse ?? [1.0, 0.99, 0.96]); // neutral white, tiny warm bias — not outdoor sun
  key.specular = color3(spec.specular ?? [0.2, 0.2, 0.2]); // restrained — soft floor highlights, not a mirror

  // Frustum derived from map dimensions. Place the light above court center, offset opposite its
  // direction, then pin a fixed orthographic frustum that covers the full court + margin. Fixed
  // (autoUpdateExtends = false) keeps the projection stable so shadows don't shimmer/resize as
  // players move.
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
 * Create the single competitive ShadowGenerator bound to the key light. Disposes any previous
 * system first so there is never more than one generator per scene.
 */
export function createCompetitiveShadowSystem(
  scene: Scene,
  light: DirectionalLight,
  options: CompetitiveShadowOptions = {}
): ShadowGenerator {
  disposeCompetitiveShadowSystem();

  const mapSize = options.mapSize ?? 1024;
  const generator = new ShadowGenerator(mapSize, light);
  generator.setDarkness(options.darkness ?? 0.2);
  // Conservative starting bias/normalBias — adjust after observing real acne / detached shadows.
  generator.bias = options.bias ?? 0.0015;
  generator.normalBias = options.normalBias ?? 0.02;
  generator.forceBackFacesOnly = options.forceBackFacesOnly ?? false;
  generator.transparencyShadow = false;

  // Prefer cheap PCF soft shadows where supported (WebGL2 / WebGPU). Fall back to Poisson sampling,
  // a low-cost soft filter that works on WebGL1, rather than failing or enabling anything heavier.
  // No PCSS / contact-hardening, no cascades. `webGLVersion` only exists on the WebGL engine; when
  // it's absent we're on WebGPU, which supports PCF.
  const webGLVersion = (scene.getEngine() as { webGLVersion?: number }).webGLVersion;
  const supportsPcf = webGLVersion === undefined || webGLVersion > 1;
  if (supportsPcf) {
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  } else {
    generator.usePoissonSampling = true;
  }

  activeShadowSystem = { scene, generator, casters: new Set<Mesh>(), casterCategories: new Map() };
  shadowSystemCreateCount++;
  return generator;
}

/**
 * Register a dynamic shadow caster (remote player body, mat, moving dummy). Pass a mesh that actually
 * has rendered geometry — Babylon only casts shadows from real submeshes, so a bare TransformNode /
 * empty parent would silently cast nothing. When the visible geometry lives in child meshes parented
 * under a root (e.g. the moving dummy: a base capsule + parented head/torso/limbs), pass
 * `includeDescendants = true` so every child submesh is added, not just the root. Safe to call before
 * the system exists (no-op) and idempotent; auto-unregistered if the mesh is disposed without an
 * explicit unregister (e.g. a remote player leaving the room).
 */
export function registerCompetitiveShadowCaster(mesh: Mesh | null | undefined, includeDescendants = false): void {
  if (!mesh || !activeShadowSystem) return;
  if (activeShadowSystem.casters.has(mesh)) return;
  activeShadowSystem.casters.add(mesh);
  activeShadowSystem.casterCategories.set(mesh, categorizeShadowCaster(mesh));
  activeShadowSystem.generator.addShadowCaster(mesh, includeDescendants);
  mesh.onDisposeObservable.addOnce(() => unregisterCompetitiveShadowCaster(mesh));
}

export function unregisterCompetitiveShadowCaster(mesh: Mesh | null | undefined): void {
  if (!mesh || !activeShadowSystem) return;
  if (!activeShadowSystem.casters.delete(mesh)) return;
  activeShadowSystem.casterCategories.delete(mesh);
  activeShadowSystem.generator.removeShadowCaster(mesh, true);
}

export function disposeCompetitiveShadowSystem(): void {
  if (!activeShadowSystem) return;
  activeShadowSystem.casters.clear();
  activeShadowSystem.casterCategories.clear();
  activeShadowSystem.generator.dispose();
  activeShadowSystem = null;
}

/** Best-effort caster category, purely for the debug stats below — never used for gameplay. */
function categorizeShadowCaster(mesh: Mesh): ShadowCasterCategory {
  const name = mesh.name;
  if (name.startsWith('player_') || name.startsWith('remotePlayerBody_')) return 'remotePlayer';
  if (name === 'mat') return 'mat';
  if (name === 'moving_dummy' || name.startsWith('target_dummy')) return 'dummy';
  return 'other';
}
