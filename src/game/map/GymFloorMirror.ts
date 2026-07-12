/**
 * Client-only POLISHED-mode planar floor mirror (graphics overhaul Phase 3) — the signature
 * "waxed NBA court" feature: ONE half-res Babylon MirrorTexture on the gym floor's PBRMaterial, so
 * players, balls, dummies, banners, the scoreboard and the room itself visibly REFLECT and MOVE in
 * the floor, faded naturally by the PBR Fresnel (weak head-on, stronger at grazing angles) and
 * softened by the mirror's gaussian blurKernel (the PBR mip-roughness blur can't soften a live RTT,
 * so the kernel is the softness lever — never rely on roughness for this texture).
 *
 * Budget & correctness by construction:
 *  - Half-res RTT (POLISHED_CONFIG.mirror.ratio), blur runs at that reduced size.
 *  - EXPLICIT render list only. Static content is seeded once by name-prefix scan, sorted by
 *    bounding size and capped at mirror.maxRenderListSize so tiny trim never eats budget. Dynamic
 *    content (remote players, balls, dummies, mats, portal props) registers through
 *    registerGymMirrorMesh — idempotent, auto-unregistered on dispose, uncapped (it's few meshes).
 *  - NEVER in the list (excluded by simply never matching/registering): the floor itself (no
 *    self-reflection/recursion), coplanar court-line decals (z-fight shimmer), first-person
 *    viewmodel arms, ball blob shadows, particles, HUD planes, creator/sandbox geometry.
 *  - pause()/resume() detaches/reattaches the texture from the floor material — a detached RTT is
 *    never rendered, so the whole cost disappears while the Movement Sandbox owns the frame
 *    (worlds never render simultaneously; Phase 6 drives this on world switch).
 *
 * Singleton like CompetitiveLighting/GymReflectionProbe: create disposes any prior instance.
 * Nothing here is imported by server or shared code; no gameplay state derives from it.
 */

import { AbstractMesh, Mesh, MirrorTexture, PBRMaterial, Plane, Scene } from '@babylonjs/core';
import { resolvePolishedConfig } from '../config/graphicsTuning';

const MIRROR_NAME = 'gym_floor_mirror';
const FLOOR_MATERIAL_NAME = 'floor_material';

/**
 * Static structural content seeded into the mirror once at creation. Deliberately the probe's
 * allow-list PLUS the eye-catching court-adjacent props (banners, scoreboards, portal plinths are
 * dynamic-registered by their owners) and MINUS nothing that would recurse — the floor and its
 * coplanar line decals are simply not matchable by any of these prefixes.
 */
const STATIC_INCLUDE_PREFIXES: readonly string[] = [
  'north_wall', 'south_wall', 'east_wall', 'west_wall',
  'gym_ceiling', 'gym_roof_',
  'ceil_light_',
  'decor_overhead_light_lens_', 'decor_overhead_light_side_rail_', 'decor_overhead_light_end_cap_',
  'bleacher_', 'decor_bleacher_',
  'decor_wall_pad_module_',
  'decor_scoreboard_back_panel_', 'scoreboard_',
  'decor_banner_',
  'decor_cove_' // polished cove/strip lighting — the glowing lines reflecting in the floor
];

interface MirrorState {
  scene: Scene;
  texture: MirrorTexture;
  staticList: AbstractMesh[];
  dynamic: Set<AbstractMesh>;
  paused: boolean;
}

let state: MirrorState | null = null;

function matchesStaticInclude(name: string): boolean {
  return STATIC_INCLUDE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function floorMaterial(scene: Scene): PBRMaterial | null {
  const material = scene.getMaterialByName(FLOOR_MATERIAL_NAME);
  return material instanceof PBRMaterial ? material : null;
}

/** Rebuild the RTT's render list from the capped static seed + the live dynamic set. */
function syncRenderList(): void {
  if (!state) return;
  state.texture.renderList = [...state.staticList, ...state.dynamic];
}

/**
 * Create the floor mirror and wire it onto the floor material. Call AFTER the static gym is built
 * (the prefix scan needs the meshes to exist). Idempotent — disposes any prior mirror first.
 */
export function createGymFloorMirror(scene: Scene): MirrorTexture | null {
  disposeGymFloorMirror();
  const cfg = resolvePolishedConfig().mirror;
  const floor = floorMaterial(scene);
  if (!floor) return null;

  const texture = new MirrorTexture(MIRROR_NAME, { ratio: cfg.ratio }, scene, true);
  // Floor top surface is world y=0; normal (0,-1,0) mirrors the space ABOVE the plane.
  texture.mirrorPlane = new Plane(0, -1, 0, 0);
  texture.blurKernel = cfg.blurKernel;

  // Static seed: prefix scan, biggest-first (walls/ceiling/bleachers), capped so small trim can't
  // crowd the budget. Dynamic registrations are separate and never evicted by this cap.
  const matched: AbstractMesh[] = [];
  for (const mesh of scene.meshes) {
    if (mesh instanceof Mesh && matchesStaticInclude(mesh.name)) matched.push(mesh);
  }
  matched.sort(
    (a, b) => b.getBoundingInfo().boundingSphere.radiusWorld - a.getBoundingInfo().boundingSphere.radiusWorld
  );
  const staticList = matched.slice(0, Math.max(0, cfg.maxRenderListSize));

  state = { scene, texture, staticList, dynamic: new Set(), paused: false };
  syncRenderList();

  floor.reflectionTexture = texture;
  floor.environmentIntensity = cfg.floorEnvironmentIntensity;
  // Suppress the floor's ANALYTIC light specular: the key + hemi highlights are view-dependent
  // blobs that follow the camera at a fixed angle across the gloss ("two light reflections that
  // follow you around"). The mirror (parallax-correct, geometry-anchored) owns the floor's shine.
  floor.specularIntensity = cfg.floorSpecularIntensity;
  return texture;
}

/**
 * Register a DYNAMIC mesh so it reflects in the floor (remote player bodies, balls, dummies, mats,
 * portal props). Pass includeDescendants=true for roots whose visible geometry lives in child
 * meshes. Safe no-op before the mirror exists / in Performance/Neutral mode; idempotent;
 * auto-unregistered when the mesh is disposed (e.g. a remote player leaving).
 */
export function registerGymMirrorMesh(mesh: Mesh | null | undefined, includeDescendants = false): void {
  if (!mesh || !state) return;
  const additions: AbstractMesh[] = includeDescendants
    ? [mesh, ...mesh.getChildMeshes(false)]
    : [mesh];
  let changed = false;
  for (const add of additions) {
    // Blob shadows ride along as ball/dummy children — a flat black disc in the reflection reads
    // as a hole in the floor, so they are excluded even via descendant registration.
    if (add.name.endsWith('_blobShadow')) continue;
    if (state.dynamic.has(add)) continue;
    state.dynamic.add(add);
    changed = true;
    add.onDisposeObservable.addOnce(() => unregisterGymMirrorMesh(add));
  }
  if (changed) syncRenderList();
}

export function unregisterGymMirrorMesh(mesh: AbstractMesh | null | undefined): void {
  if (!mesh || !state) return;
  if (state.dynamic.delete(mesh)) syncRenderList();
}

/**
 * Detach the mirror from the floor while another world owns the frame (Movement Sandbox / Creator).
 * A detached RTT is never rendered, so the mirror's whole per-frame cost disappears.
 */
export function pauseGymFloorMirror(): void {
  if (!state || state.paused) return;
  const floor = floorMaterial(state.scene);
  if (floor && floor.reflectionTexture === state.texture) floor.reflectionTexture = null;
  state.paused = true;
}

/** Reattach after pause (returning to the gym). No-op when not paused / no mirror. */
export function resumeGymFloorMirror(): void {
  if (!state || !state.paused) return;
  const floor = floorMaterial(state.scene);
  if (floor) {
    const cfg = resolvePolishedConfig().mirror;
    floor.reflectionTexture = state.texture;
    floor.environmentIntensity = cfg.floorEnvironmentIntensity;
    floor.specularIntensity = cfg.floorSpecularIntensity;
  }
  state.paused = false;
}

/** Dispose the mirror and restore the floor to the plain environment response. */
export function disposeGymFloorMirror(): void {
  if (!state) return;
  const floor = floorMaterial(state.scene);
  if (floor && floor.reflectionTexture === state.texture) floor.reflectionTexture = null;
  state.texture.dispose();
  state = null;
}

/** Live handle for the dev tuning panel (blurKernel / floor intensity are set directly). */
export function getGymFloorMirror(): MirrorTexture | null {
  return state?.texture ?? null;
}

/** Debug-only info for the [graphics] audit. Never read for gameplay. */
export function getGymFloorMirrorDebugInfo(): {
  active: boolean;
  paused: boolean;
  renderListSize: number | null;
  staticCount: number | null;
  dynamicCount: number | null;
} {
  if (!state) return { active: false, paused: false, renderListSize: null, staticCount: null, dynamicCount: null };
  return {
    active: true,
    paused: state.paused,
    renderListSize: state.texture.renderList?.length ?? 0,
    staticCount: state.staticList.length,
    dynamicCount: state.dynamic.size
  };
}
