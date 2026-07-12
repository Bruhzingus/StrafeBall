/**
 * Polished-only outdoor renderer for the Movement Sandbox / Creator course world.
 *
 * The atmosphere is scene-scoped and deliberately survives individual MovementSandbox rebuilds:
 * courses are disposed/recreated on every entry, while the gradient sky, sun and CSM are expensive
 * scene resources that should be constructed once. Course meshes register through the facade below;
 * registrations made before first entry are queued and disposal removes them automatically.
 */

import {
  CascadedShadowGenerator,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  Vector3
} from '@babylonjs/core';
import { getGraphicsQuality, isGraphicsDebugFlagEnabled } from '../config/graphicsConfig';
import { resolvePolishedConfig } from '../config/graphicsTuning';
import {
  enterGymWorld,
  enterSandboxWorld,
  registerPolishedHandles
} from '../effects/PolishedGraphics';

interface SavedSceneAtmosphere {
  clearColor: Color4;
  fogMode: number;
  fogColor: Color3;
  fogStart: number;
  fogEnd: number;
  fogDensity: number;
}

interface SandboxAtmosphereState {
  scene: Scene;
  sky: Mesh;
  skyMaterial: StandardMaterial;
  skyTexture: DynamicTexture;
  sun: DirectionalLight;
  csm: CascadedShadowGenerator | null;
  active: boolean;
  saved: SavedSceneAtmosphere | null;
}

let state: SandboxAtmosphereState | null = null;
/** Mesh -> whether it should cast. Every registered mesh receives, including the yard ground. */
const shadowGeometry = new Map<Mesh, boolean>();

function color(rgb: readonly [number, number, number]): Color3 {
  return new Color3(rgb[0], rgb[1], rgb[2]);
}

function css(rgb: readonly [number, number, number]): string {
  const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
  return `rgb(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])})`;
}

function addCaster(mesh: Mesh, castsShadow: boolean): void {
  if (!castsShadow || !state?.csm || state.scene !== mesh.getScene() || mesh.isDisposed()) return;
  state.csm.addShadowCaster(mesh, false);
}

/**
 * Make real sandbox/course geometry receive the outdoor sun and optionally cast into the CSM.
 * Safe before atmosphere construction and a no-op outside Polished mode.
 */
export function registerSandboxShadowGeometry(
  mesh: Mesh | null | undefined,
  castsShadow = true
): void {
  if (!mesh || mesh.isDisposed() || getGraphicsQuality() !== 'polished') return;
  mesh.receiveShadows = true;
  const previous = shadowGeometry.get(mesh);
  if (previous !== undefined) {
    if (!previous && castsShadow) {
      shadowGeometry.set(mesh, true);
      addCaster(mesh, true);
    }
    return;
  }
  shadowGeometry.set(mesh, castsShadow);
  addCaster(mesh, castsShadow);
  mesh.onDisposeObservable.addOnce(() => unregisterSandboxShadowGeometry(mesh));
}

export function unregisterSandboxShadowGeometry(mesh: Mesh | null | undefined): void {
  if (!mesh || !shadowGeometry.delete(mesh)) return;
  if (state?.csm && state.scene === mesh.getScene()) state.csm.removeShadowCaster(mesh, false);
}

function createSky(scene: Scene): Pick<SandboxAtmosphereState, 'sky' | 'skyMaterial' | 'skyTexture'> {
  const cfg = resolvePolishedConfig().sandbox.sky;
  const texture = new DynamicTexture(
    'sandbox_sky_gradient_texture',
    { width: 32, height: 512 },
    scene,
    false,
    Texture.BILINEAR_SAMPLINGMODE
  );
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, css(cfg.zenith));
  gradient.addColorStop(0.46, css(cfg.horizon));
  gradient.addColorStop(0.58, css(cfg.horizon));
  gradient.addColorStop(1, css(cfg.ground));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 512);
  texture.update(false);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;

  const material = new StandardMaterial('sandbox_sky_material', scene);
  // Bind through emissive as the authoritative unshaded path. Keep diffuse bound as a backend
  // fallback: Babylon's StandardMaterial compiles diffuse out when disableLighting is true on some
  // WebGL paths, which otherwise turns the dome opaque black.
  material.diffuseColor = Color3.White();
  material.diffuseTexture = texture;
  material.emissiveColor = Color3.White();
  material.emissiveTexture = texture;
  material.disableLighting = true;
  // Keep normal far-depth writes. A depthless infinite-distance sphere can be composited over the
  // scene by SSAO/post pipelines on some WebGL drivers, producing a black full-frame occluder.
  material.disableDepthWrite = false;
  material.backFaceCulling = true;

  const sky = MeshBuilder.CreateSphere(
    'sandbox_sky_dome',
    { diameter: 900, segments: 24, sideOrientation: Mesh.BACKSIDE },
    scene
  );
  sky.material = material;
  sky.isPickable = false;
  sky.applyFog = false;
  sky.infiniteDistance = true;
  sky.alwaysSelectAsActiveMesh = true;
  sky.setEnabled(false);
  return { sky, skyMaterial: material, skyTexture: texture };
}

function createState(scene: Scene): SandboxAtmosphereState {
  const cfg = resolvePolishedConfig().sandbox;
  const sky = createSky(scene);
  const direction = new Vector3(cfg.sun.direction[0], cfg.sun.direction[1], cfg.sun.direction[2]);
  if (direction.lengthSquared() > 1e-6) direction.normalize();
  const sun = new DirectionalLight('sandbox_sun', direction, scene);
  sun.intensity = cfg.sun.intensity;
  sun.diffuse = color(cfg.sun.diffuse);
  sun.specular = color(cfg.sun.specular);
  sun.setEnabled(false);

  let csm: CascadedShadowGenerator | null = null;
  if (CascadedShadowGenerator.IsSupported) {
    const c = cfg.csm;
    // Keep camera null so Babylon follows scene.activeCamera. Creator free-fly swaps cameras while
    // the same atmosphere remains active; pinning the player camera would leave its cascades behind.
    csm = new CascadedShadowGenerator(c.mapSize, sun, false, null);
    csm.numCascades = c.cascades;
    csm.lambda = c.lambda;
    csm.shadowMaxZ = c.shadowMaxZ;
    csm.stabilizeCascades = c.stabilizeCascades;
    csm.bias = c.bias;
    csm.normalBias = c.normalBias;
    csm.forceBackFacesOnly = true;
    csm.usePercentageCloserFiltering = true;
    csm.setDarkness(c.darkness);
    // Moving platforms are normal course roots, so bounds must continue updating each frame.
    csm.freezeShadowCastersBoundingInfo = false;
  }

  const next: SandboxAtmosphereState = {
    scene,
    ...sky,
    sun,
    csm,
    active: false,
    saved: null
  };
  state = next;
  for (const [mesh, casts] of shadowGeometry) {
    if (mesh.getScene() === scene) addCaster(mesh, casts);
  }
  registerPolishedHandles({ sandboxSun: sun, sandboxCsm: csm ?? undefined });
  return next;
}

function ensureState(scene: Scene): SandboxAtmosphereState {
  if (state?.scene === scene) return state;
  if (state) disposeSandboxAtmosphere(state.scene);
  return createState(scene);
}

/** Enable outdoor sky/fog/sun and switch off gym-only reflection/shadow work. Idempotent. */
export function enterSandboxAtmosphere(scene: Scene): void {
  if (getGraphicsQuality() !== 'polished') return;
  const current = ensureState(scene);
  if (current.active) return;
  current.saved = {
    clearColor: scene.clearColor.clone(),
    fogMode: scene.fogMode,
    fogColor: scene.fogColor.clone(),
    fogStart: scene.fogStart,
    fogEnd: scene.fogEnd,
    fogDensity: scene.fogDensity
  };
  const cfg = resolvePolishedConfig().sandbox;
  const horizon = color(cfg.sky.horizon);
  scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = horizon;
  scene.fogStart = cfg.fog.start;
  scene.fogEnd = cfg.fog.end;
  current.sky.setEnabled(true);
  current.active = true;
  enterSandboxWorld();
  if (isGraphicsDebugFlagEnabled()) {
    const info = getSandboxAtmosphereDebugInfo();
    console.log(`[graphics] SandboxAtmosphere: sky=gradient sun=active` +
      ` CSM=${info.csm ? `${info.cascades}x${cfg.csm.mapSize}` : 'unsupported'}` +
      ` casters=${info.casters} fog=${cfg.fog.start}-${cfg.fog.end}`);
  }
}

/** Restore the exact gym scene atmosphere and re-enable its renderer. Idempotent. */
export function exitSandboxAtmosphere(scene: Scene): void {
  const current = state;
  if (!current || current.scene !== scene || !current.active) return;
  current.sky.setEnabled(false);
  const saved = current.saved;
  if (saved) {
    scene.clearColor = saved.clearColor;
    scene.fogMode = saved.fogMode;
    scene.fogColor = saved.fogColor;
    scene.fogStart = saved.fogStart;
    scene.fogEnd = saved.fogEnd;
    scene.fogDensity = saved.fogDensity;
  }
  current.saved = null;
  current.active = false;
  enterGymWorld();
}

/** Scene teardown. Individual sandbox rebuilds intentionally do not call this. */
export function disposeSandboxAtmosphere(scene?: Scene): void {
  const current = state;
  if (!current || (scene && current.scene !== scene)) return;
  if (current.active) exitSandboxAtmosphere(current.scene);
  current.csm?.dispose();
  current.sun.dispose();
  current.sky.dispose();
  current.skyMaterial.dispose();
  current.skyTexture.dispose();
  for (const mesh of [...shadowGeometry.keys()]) {
    if (mesh.getScene() === current.scene) shadowGeometry.delete(mesh);
  }
  state = null;
  registerPolishedHandles({ sandboxSun: undefined, sandboxCsm: undefined });
}

export function getSandboxAtmosphereDebugInfo(): {
  created: boolean;
  active: boolean;
  csm: boolean;
  casters: number;
  cascades: number | null;
} {
  const current = state;
  if (!current) return { created: false, active: false, csm: false, casters: 0, cascades: null };
  const casters = [...shadowGeometry].filter(([mesh, casts]) => casts && mesh.getScene() === current.scene).length;
  return {
    created: true,
    active: current.active,
    csm: current.csm !== null,
    casters,
    cascades: current.csm?.numCascades ?? null
  };
}
