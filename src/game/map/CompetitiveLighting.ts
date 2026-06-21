import {
  AbstractMesh,
  Color3,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  ReflectionProbe,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  Vector3
} from '@babylonjs/core';
import { TUNING } from '../config/tuning';

/**
 * Client-only competitive lighting + shadow + static-reflection system for the gym.
 *
 * Replaces the old multi-PointLight rig with a fixed, performance-conscious setup: one ambient
 * HemisphericLight (fill / readability), one DirectionalLight (key light + dynamic shadows), one
 * ShadowGenerator, and one static (render-once) ReflectionProbe. There are zero runtime point/spot
 * lights, no SSR/planar/screen-space reflections, no SSAO, volumetrics, bloom, or any render target
 * that updates every frame (the shadow map renders once per shadow-casting draw call as usual; the
 * reflection probe's cubemap is captured exactly once and never refreshed). Nothing here is imported
 * by server or shared code, and no gameplay state is derived from these meshes.
 */

export interface CompetitiveLights {
  hemi: HemisphericLight;
  key: DirectionalLight;
}

export interface CompetitiveShadowOptions {
  /** Shadow map resolution. Competitive default is 1024. */
  mapSize?: number;
  /** Shadow darkness (Babylon: 0 = black, 1 = invisible). Competitive default ~0.2. */
  darkness?: number;
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

export interface CompetitiveReflectionOptions {
  /** Cubemap face resolution. Competitive default 256, High default 512. */
  size?: number;
  /** World position the probe captures from. Defaults to court-center, half wall height. */
  position?: Vector3;
}

interface ReflectionSystemState {
  probe: ReflectionProbe;
}

// Same one-per-scene guarding rationale as the shadow system above.
let activeReflectionSystem: ReflectionSystemState | null = null;

// Lifetime creation counts (never reset), purely so the debug report below can flag whether a
// reset/rebuild/reconnect ever created a second generator or probe instead of reusing/disposing the
// first — both create-functions already dispose any prior instance, so these should only ever read
// 0 or 1 in normal operation; >1 would mean a caller bypassed the singleton guard.
let shadowSystemCreateCount = 0;
let reflectionSystemCreateCount = 0;

export interface CompetitiveGraphicsDebugStats {
  shadow: {
    /** Always 0 or 1 in this scene; >1 would indicate a duplicate-generator bug. */
    activeGeneratorCount: number;
    lifetimeCreateCount: number;
    filteringMode: 'pcf' | 'poisson' | 'none';
    mapSize: number | null;
    casterCount: number;
    casterCountsByCategory: Record<ShadowCasterCategory, number>;
  };
  reflection: {
    activeProbeCount: number;
    lifetimeCreateCount: number;
    size: number | null;
    renderListCount: number | null;
  };
}

/** Debug-only snapshot for the graphics debug flag — never read for gameplay logic. */
export function getCompetitiveGraphicsDebugStats(): CompetitiveGraphicsDebugStats {
  const casterCountsByCategory: Record<ShadowCasterCategory, number> = {
    remotePlayer: 0,
    mat: 0,
    dummy: 0,
    other: 0
  };
  let filteringMode: 'pcf' | 'poisson' | 'none' = 'none';
  let mapSize: number | null = null;
  if (activeShadowSystem) {
    for (const category of activeShadowSystem.casterCategories.values()) casterCountsByCategory[category]++;
    const generator = activeShadowSystem.generator;
    filteringMode = generator.usePercentageCloserFiltering ? 'pcf' : generator.usePoissonSampling ? 'poisson' : 'none';
    mapSize = generator.getShadowMap()?.getRenderSize() ?? null;
  }

  return {
    shadow: {
      activeGeneratorCount: activeShadowSystem ? 1 : 0,
      lifetimeCreateCount: shadowSystemCreateCount,
      filteringMode,
      mapSize,
      casterCount: activeShadowSystem?.casters.size ?? 0,
      casterCountsByCategory
    },
    reflection: {
      activeProbeCount: activeReflectionSystem ? 1 : 0,
      lifetimeCreateCount: reflectionSystemCreateCount,
      size: activeReflectionSystem?.probe.cubeTexture.getRenderSize() ?? null,
      renderListCount: activeReflectionSystem?.probe.renderList?.length ?? null
    }
  };
}

/**
 * Set up the competitive lights. Reuses an existing HemisphericLight if the scene already has one
 * (the scene creates `gym_hemi_light` before the gym builds) so we never end up with duplicates,
 * and disposes any stray extra hemis. Returns the key light so the caller can hand it to the
 * shadow system.
 */
export function applyCompetitiveLighting(scene: Scene): CompetitiveLights {
  const hemi = configureHemisphericLight(scene);
  const key = configureKeyLight(scene);
  return { hemi, key };
}

function configureHemisphericLight(scene: Scene): HemisphericLight {
  const existing = scene.lights.find((light): light is HemisphericLight => light instanceof HemisphericLight);
  const hemi = existing ?? new HemisphericLight('gym_hemi_light', new Vector3(0, 1, 0), scene);

  // Straight-up ambient fill for competitive readability, not mood. This is the main broad-fill
  // lever: it lifts the ceiling underside, walls, and navy detail evenly like overhead gym lighting.
  hemi.direction = new Vector3(0, 1, 0);
  hemi.intensity = 0.75;
  hemi.diffuse = new Color3(1.0, 0.98, 0.93); // near-neutral, faint warm
  hemi.groundColor = new Color3(0.44, 0.47, 0.53); // subdued cool-gray, lifted so it doesn't drag
  hemi.specular = new Color3(0.12, 0.12, 0.13);

  // Defensive: collapse any duplicate hemispheric lights down to the single one we keep.
  for (const light of scene.lights.slice()) {
    if (light instanceof HemisphericLight && light !== hemi) light.dispose();
  }
  return hemi;
}

function configureKeyLight(scene: Scene): DirectionalLight {
  // Never leave a stale key light behind if this runs again.
  const stale = scene.getLightByName('gym_key_light');
  if (stale) stale.dispose();

  const { halfWidth, halfLength, wallHeight } = TUNING.map;
  const margin = 5;
  const extent = Math.max(halfWidth, halfLength) + margin;

  // Gentle diagonal, strongly overhead so indoor shadows stay short and readable (no long
  // cinematic rake). Direction is a unit vector, not a world coordinate.
  const direction = new Vector3(-0.35, -1, -0.25);
  direction.normalize();

  const key = new DirectionalLight('gym_key_light', direction, scene);
  key.intensity = 0.92;
  key.diffuse = new Color3(1.0, 0.99, 0.96); // neutral white, tiny warm bias — not outdoor sun
  key.specular = new Color3(0.2, 0.2, 0.2); // restrained — soft floor highlights, not a mirror

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
  generator.bias = 0.0015;
  generator.normalBias = 0.02;
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
 * Register a dynamic shadow caster (remote player body, mat, moving dummy). Safe to call before the
 * system exists (no-op) and idempotent. The mesh is auto-unregistered if it is disposed without an
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
  if (name.startsWith('player_')) return 'remotePlayer';
  if (name === 'mat') return 'mat';
  if (name === 'moving_dummy' || name.startsWith('target_dummy')) return 'dummy';
  return 'other';
}

/**
 * Static (render-once) reflection capture for subtle floor/pad/bleacher sheen. Creates exactly one
 * ReflectionProbe bound to the scene's static gym presentation meshes — never the floor itself,
 * players, balls, HUD, mats, dummies, or any other moving/dynamic mesh. The cubemap is rendered once
 * immediately after creation and then frozen (refreshRate = RENDER_ONCE) so it never costs a
 * per-frame render; call this once, right after the gym's static meshes exist and before any
 * dynamic mesh (player, balls, remote players, mats already exist as standing geometry which is
 * fine — they're excluded by name, not by creation order).
 *
 * Disposes any previous probe first so re-running this (e.g. a future scene rebuild) can never leave
 * a duplicate capture or duplicate render-once pass behind.
 */
export function createCompetitiveReflectionCapture(
  scene: Scene,
  options: CompetitiveReflectionOptions = {}
): ReflectionProbe {
  disposeCompetitiveReflectionCapture();

  const { wallHeight } = TUNING.map;
  const size = options.size ?? 256;
  const position = options.position ?? new Vector3(0, wallHeight * 0.5, 0);

  const probe = new ReflectionProbe('gym_static_reflection_probe', size, scene, false);
  probe.position.copyFrom(position);
  probe.renderList = staticGymPresentationMeshes(scene);
  // Render exactly once, then never again — no per-frame update, matching the "static capture" spec.
  probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  probe.cubeTexture.render();

  activeReflectionSystem = { probe };
  reflectionSystemCreateCount++;
  return probe;
}

export function disposeCompetitiveReflectionCapture(): void {
  if (!activeReflectionSystem) return;
  activeReflectionSystem.probe.dispose();
  activeReflectionSystem = null;
}

/**
 * The static gym render list: every currently-built mesh that is gym *presentation* geometry — wall,
 * ceiling/roof, bleacher, banner, fixture, scoreboard, and decorative trim meshes — and explicitly
 * never the floor (it receives the reflection, it shouldn't see itself), the standing mats, the
 * target dummies, half-court cones, or any floor-plane decal (court lines, zone tint, contact-shadow
 * decals, wax sheen, glints) — those sit on the surface that's reflecting, not the surrounding room.
 * Matched by the project's existing naming conventions (see GymArena.ts / GymVisualRevamp.ts) rather
 * than tracked via a second registration API, so this list needs no upkeep as new decor is added —
 * any newly named `decor_*` prop is included unless it matches one of the floor-decal prefixes below.
 */
function staticGymPresentationMeshes(scene: Scene): AbstractMesh[] {
  // 'mat' (no suffix) is the actual Babylon-generated name for every standing cover mat — ModelLoader
  // .createVisual('mat', ...) is called once per MAT_SPECS entry with no per-instance name override,
  // so all of them share this exact name rather than getting a unique mat_0/mat_1/... suffix.
  const excludedExact = new Set(['gym_floor', 'center_line', 'mat']);
  const excludedPrefixes = [
    'decor_floor_',
    'decor_contact_',
    'decor_court_line_',
    'zone_',
    'half_court_cone_',
    'target_dummy',
    'moving_dummy',
    // The dummy root meshes are named target_dummy/moving_dummy above, but every body-part child
    // (head/torso/hips/shoulder/leg/foot) is parented separately under `dummy_${suffix}...` and
    // would otherwise slip past those two name checks.
    'dummy_'
  ];

  return scene.meshes.filter((mesh) => {
    if (!(mesh instanceof Mesh)) return false;
    if (excludedExact.has(mesh.name)) return false;
    return !excludedPrefixes.some((prefix) => mesh.name.startsWith(prefix));
  });
}
