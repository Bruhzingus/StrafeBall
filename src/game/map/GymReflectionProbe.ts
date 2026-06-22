import { AbstractMesh, PBRMaterial, ReflectionProbe, RenderTargetTexture, Scene, Vector3 } from '@babylonjs/core';
import { SHOWCASE_CONFIG } from '../config/graphicsConfig';
import { TUNING } from '../config/tuning';

/**
 * Client-only SHOWCASE reflection probe (Phase 7). ONE static Babylon ReflectionProbe centred near
 * mid-court between floor and ceiling, rendered ONCE after the static gym is built, capturing only an
 * EXPLICIT allow-list of static structural meshes (walls, ceiling panels, real fixture housings,
 * bleachers, wall pads, scoreboard casing, trim). It gives the floor a subtle, broad, blurred reflection
 * of the ACTUAL gym fixtures — not a generic HDR wash and not a fake reflection plane.
 *
 * The floor is excluded from its own capture (no recursion); HUD/UI, player arms, remote players, balls,
 * bots, dynamic/movable mats, cones, dummies, and the fake-light decals are all absent by construction
 * (they are simply not on the allow-list). Render-once means zero per-frame cost. Nothing here is
 * imported by server or shared code, and no gameplay state is derived from it.
 */

const PROBE_NAME = 'gym_fixture_reflection_probe';

/**
 * Explicit allow-list of static structural mesh name prefixes to capture. This is the whole render list
 * (an allow-list by category) — NOT a global scene capture. Floor (`gym_floor`), dynamic gameplay
 * objects, UI, banners/signage, scoreboard text, and the fake-light decal planes are intentionally
 * ABSENT, so they never enter the reflection.
 */
const STATIC_INCLUDE_PREFIXES: readonly string[] = [
  'north_wall', 'south_wall', 'east_wall', 'west_wall', // the four lower walls
  'gym_ceiling', 'gym_roof_', // ceiling slab + panels / purlins / rafters / seams
  'ceil_light_', // the actual ceiling fixture housings (the bright source we want reflected)
  'bleacher_', // bleacher structures + seats
  'decor_bleacher_', // bleacher trim
  'decor_wall_pad_raised_panel_', // wall pads
  'decor_scoreboard_back_panel_', // scoreboard casing
  'decor_ceiling_', // ceiling conduits / junction boxes / rim trim
  'decor_overhead_light_lens_', // fixture lens housings (bright fixtures)
  'decor_overhead_light_side_rail_', 'decor_overhead_light_end_cap_' // fixture frame rails
];

/**
 * PBR receiver materials that sample the probe, with their reflection strength. The floor is the only
 * moderate one; cover mats get a tiny satin response, bleachers less. Walls, ceiling, and the
 * StandardMaterial wall pads receive NONE (absent here) — "nearly none" per spec. Strengths come from
 * SHOWCASE_CONFIG.materials so they sit beside the other Showcase material tunables.
 */
function probeReceivers(): { materialName: string; intensity: number }[] {
  const m = SHOWCASE_CONFIG.materials;
  return [
    { materialName: 'floor_material', intensity: m.floor.environmentIntensity }, // moderate
    { materialName: 'mat_material', intensity: m.coverMat.environmentIntensity }, // tiny
    { materialName: 'bleacher_material', intensity: m.bleacher.environmentIntensity } // less
  ];
}

let activeProbe: ReflectionProbe | null = null;

function matchesStaticInclude(name: string): boolean {
  return STATIC_INCLUDE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Create the single static reflection probe and wire it onto the floor (+ tiny cover-mat / bleacher)
 * PBR materials. Idempotent: disposes any prior probe first so a scene rebuild / graphics-mode switch
 * can never leave a duplicate probe alive. Must be called AFTER the static gym meshes + materials exist.
 */
export function createGymReflectionProbe(scene: Scene, resolution: number): ReflectionProbe {
  disposeGymReflectionProbe();

  // generateMipMaps defaults true → the PBR roughness blur samples lower mips for BROAD, blurred
  // reflections (no mirror), which is exactly the "fuzzy fixture response" we want on the waxed floor.
  const probe = new ReflectionProbe(PROBE_NAME, resolution, scene);
  // Centred at mid-court, roughly between floor and ceiling.
  probe.position = new Vector3(0, TUNING.map.wallHeight * SHOWCASE_CONFIG.reflectionProbe.centerHeightFraction, 0);

  // Explicit static render list — only the allow-listed structural meshes. The floor is not on the
  // list, so it is excluded from its own capture (no reflection recursion).
  const renderList: AbstractMesh[] = [];
  for (const mesh of scene.meshes) {
    if (matchesStaticInclude(mesh.name)) renderList.push(mesh);
  }
  probe.renderList = renderList;

  // Render EXACTLY ONCE, on the next frame after this static setup — no per-frame reflection cost.
  probe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

  // Wire the probe cube as the reflection source on the receiver PBR materials (metallic stays 0; the
  // strength per surface is the environmentIntensity already applied by the Showcase material pass).
  for (const receiver of probeReceivers()) {
    const material = scene.getMaterialByName(receiver.materialName);
    if (material instanceof PBRMaterial) {
      material.reflectionTexture = probe.cubeTexture;
      material.environmentIntensity = receiver.intensity;
    }
  }

  activeProbe = probe;
  return probe;
}

/** Dispose the probe and detach it from any receiver material. Safe to call when no probe exists. */
export function disposeGymReflectionProbe(): void {
  if (!activeProbe) return;
  const cube = activeProbe.cubeTexture;
  for (const receiver of probeReceivers()) {
    const material = activeProbe.getScene().getMaterialByName(receiver.materialName);
    if (material instanceof PBRMaterial && material.reflectionTexture === cube) {
      material.reflectionTexture = null;
    }
  }
  activeProbe.dispose();
  activeProbe = null;
}

/** Debug-only: the active probe (or null) for the graphics report. Never read for gameplay. */
export function getGymReflectionProbeDebugInfo(): { active: boolean; resolution: number | null; renderListCount: number | null } {
  if (!activeProbe) return { active: false, resolution: null, renderListCount: null };
  return {
    active: true,
    resolution: activeProbe.cubeTexture.getRenderSize(),
    renderListCount: activeProbe.renderList?.length ?? 0
  };
}
