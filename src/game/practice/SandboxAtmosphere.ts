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
  getPolishedHandles,
  registerPolishedHandles
} from '../effects/PolishedGraphics';
import type { CourseSkyPreset } from './creator/CreatorLayout';

export interface SandboxSkyStyle {
  zenith: readonly [number, number, number];
  horizon: readonly [number, number, number];
  ground: readonly [number, number, number];
  sunIntensity: number;
  sunDiffuse: readonly [number, number, number];
  hemiIntensity: number;
  hemiDiffuse: readonly [number, number, number];
  hemiGround: readonly [number, number, number];
  fogStart: number;
  fogEnd: number;
}

/** Resolve a cheap authored look using only the sandbox's existing sky, sun, hemi and fog. */
export function sandboxSkyStyle(preset: CourseSkyPreset = 'clear'): SandboxSkyStyle {
  const cfg = resolvePolishedConfig().sandbox;
  if (preset === 'sunset') return {
    zenith: [0.13, 0.25, 0.5], horizon: [0.96, 0.48, 0.24], ground: [0.25, 0.17, 0.2],
    sunIntensity: 0.95, sunDiffuse: [1, 0.67, 0.4],
    hemiIntensity: 0.48, hemiDiffuse: [0.78, 0.58, 0.66], hemiGround: [0.3, 0.22, 0.27],
    fogStart: 160, fogEnd: 540
  };
  if (preset === 'overcast') return {
    zenith: [0.38, 0.47, 0.58], horizon: [0.68, 0.73, 0.78], ground: [0.43, 0.45, 0.48],
    sunIntensity: 0.72, sunDiffuse: [0.82, 0.88, 0.96],
    hemiIntensity: 0.68, hemiDiffuse: [0.75, 0.82, 0.9], hemiGround: [0.42, 0.45, 0.49],
    fogStart: 135, fogEnd: 470
  };
  if (preset === 'night') return {
    zenith: [0.015, 0.025, 0.075], horizon: [0.07, 0.12, 0.23], ground: [0.018, 0.024, 0.05],
    sunIntensity: 0.38, sunDiffuse: [0.46, 0.58, 0.9],
    hemiIntensity: 0.3, hemiDiffuse: [0.3, 0.42, 0.68], hemiGround: [0.08, 0.1, 0.18],
    fogStart: 120, fogEnd: 430
  };
  return {
    zenith: cfg.sky.zenith, horizon: cfg.sky.horizon, ground: cfg.sky.ground,
    sunIntensity: cfg.sun.intensity, sunDiffuse: cfg.sun.diffuse,
    hemiIntensity: cfg.hemi.intensity, hemiDiffuse: cfg.hemi.diffuse, hemiGround: cfg.hemi.ground,
    fogStart: cfg.fog.start, fogEnd: cfg.fog.end
  };
}

/** Competitive keeps its established Clear Day exactly; alternate choices only change sky/fog. */
export function competitiveSandboxSkyStyle(preset: CourseSkyPreset = 'clear'): SandboxSkyStyle {
  const style = sandboxSkyStyle(preset);
  if (preset !== 'clear') return style;
  return { ...style, horizon: [0.52, 0.63, 0.79], fogStart: 240, fogEnd: 700 };
}

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
  preset: CourseSkyPreset;
}

let state: SandboxAtmosphereState | null = null;
let requestedPreset: CourseSkyPreset = 'clear';
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

function paintSkyTexture(texture: DynamicTexture, style: SandboxSkyStyle): void {
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, css(style.zenith));
  gradient.addColorStop(0.46, css(style.horizon));
  gradient.addColorStop(0.58, css(style.horizon));
  gradient.addColorStop(1, css(style.ground));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 512);
  texture.update(false);
}

function createSky(scene: Scene, preset: CourseSkyPreset): Pick<SandboxAtmosphereState, 'sky' | 'skyMaterial' | 'skyTexture'> {
  const texture = new DynamicTexture(
    'sandbox_sky_gradient_texture',
    { width: 32, height: 512 },
    scene,
    false,
    Texture.BILINEAR_SAMPLINGMODE
  );
  paintSkyTexture(texture, sandboxSkyStyle(preset));
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
  const style = sandboxSkyStyle(requestedPreset);
  const sky = createSky(scene, requestedPreset);
  const direction = new Vector3(cfg.sun.direction[0], cfg.sun.direction[1], cfg.sun.direction[2]);
  if (direction.lengthSquared() > 1e-6) direction.normalize();
  const sun = new DirectionalLight('sandbox_sun', direction, scene);
  sun.intensity = style.sunIntensity;
  sun.diffuse = color(style.sunDiffuse);
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
    saved: null,
    preset: requestedPreset
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

function applySkyStyle(current: SandboxAtmosphereState, preset: CourseSkyPreset): void {
  const style = sandboxSkyStyle(preset);
  current.preset = preset;
  paintSkyTexture(current.skyTexture, style);
  current.sun.intensity = style.sunIntensity;
  current.sun.diffuse = color(style.sunDiffuse);
  if (!current.active) return;

  const horizon = color(style.horizon);
  current.scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
  current.scene.fogColor = horizon;
  current.scene.fogStart = style.fogStart;
  current.scene.fogEnd = style.fogEnd;

  const hemi = getPolishedHandles().hemi;
  if (hemi) {
    hemi.intensity = style.hemiIntensity;
    hemi.diffuse.set(style.hemiDiffuse[0], style.hemiDiffuse[1], style.hemiDiffuse[2]);
    hemi.groundColor.set(style.hemiGround[0], style.hemiGround[1], style.hemiGround[2]);
  }
}

/** Select the current course sky. Safe before atmosphere construction and cheap to call repeatedly. */
export function setSandboxSkyPreset(scene: Scene, preset: CourseSkyPreset = 'clear'): void {
  requestedPreset = preset;
  if (state?.scene === scene) {
    if (state.preset !== preset) applySkyStyle(state, preset);
    return;
  }
  // Competitive has no dome/state; while the editor owns the already-active yard, still preview
  // the selected horizon and fog. MovementSandbox performs the initial save/apply on entry.
  if (getGraphicsQuality() !== 'polished') {
    const style = competitiveSandboxSkyStyle(preset);
    const horizon = color(style.horizon);
    scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
    scene.fogColor = horizon;
    scene.fogStart = style.fogStart;
    scene.fogEnd = style.fogEnd;
  }
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
  const style = sandboxSkyStyle(requestedPreset);
  const horizon = color(style.horizon);
  scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = horizon;
  scene.fogStart = style.fogStart;
  scene.fogEnd = style.fogEnd;
  current.sky.setEnabled(true);
  current.active = true;
  enterSandboxWorld();
  applySkyStyle(current, requestedPreset);
  if (isGraphicsDebugFlagEnabled()) {
    const info = getSandboxAtmosphereDebugInfo();
    console.log(`[graphics] SandboxAtmosphere: sky=gradient sun=active` +
      ` CSM=${info.csm ? `${info.cascades}x${resolvePolishedConfig().sandbox.csm.mapSize}` : 'unsupported'}` +
      ` casters=${info.casters} fog=${style.fogStart}-${style.fogEnd}`);
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
