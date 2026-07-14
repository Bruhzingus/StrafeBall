import { AbstractMesh, PBRMaterial, ReflectionProbe, RenderTargetTexture, Scene, Vector3 } from '@babylonjs/core';
import { resolvePolishedConfig } from '../config/graphicsTuning';
import { TUNING } from '../config/tuning';

/**
 * Client-only POLISHED-mode reflection probe (graphics overhaul Phase 1 — originally written for the
 * retired Showcase pass, now the polished IBL source). ONE static Babylon ReflectionProbe centred
 * near mid-court between floor and ceiling, rendered ONCE after the static gym is built, capturing
 * only an EXPLICIT allow-list of static structural meshes (walls, ceiling panels, real fixture
 * housings, bleachers, wall pads, scoreboard casing, trim). Receivers get a subtle, broad, blurred
 * reflection of the ACTUAL gym — this is why it cannot reproduce the old HDR-environment failure
 * (a gray wash of alien cafeteria content at grazing angles): the reflected content IS the room.
 *
 * Receivers (per POLISHED_CONFIG.probe.intensities): the four walls, cover mats, bleachers, and —
 * wired lazily via applyGymProbeToBallMaterial, since ball materials are created on first ball
 * spawn — the ball PBR materials. The FLOOR is deliberately NOT a receiver: the Phase 3 planar
 * mirror owns the floor's reflection slot; until then the floor keeps the gradient environment.
 *
 * The floor is also excluded from the capture list (no recursion); HUD/UI, player arms, remote
 * players, balls, bots, dynamic/movable mats, cones, dummies are all absent by construction (they
 * are simply not on the allow-list). Render-once means zero per-frame cost. Nothing here is
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
  'decor_wall_pad_module_', // wall pad modules
  'decor_scoreboard_back_panel_', // scoreboard casing
  'decor_ceiling_', // ceiling conduits / junction boxes / rim trim
  'decor_overhead_light_lens_', // fixture lens housings (bright fixtures)
  'decor_overhead_light_side_rail_', 'decor_overhead_light_end_cap_' // fixture frame rails
];

/**
 * PBR receiver materials that sample the probe, with their reflection strength from
 * POLISHED_CONFIG.probe.intensities. The FLOOR is intentionally ABSENT (the Phase 3 planar mirror
 * owns the floor); ball materials are wired lazily by applyGymProbeToBallMaterial because they are
 * created on first ball spawn, after this probe exists.
 */
function probeReceivers(): { materialName: string; intensity: number }[] {
  const p = resolvePolishedConfig().probe.intensities;
  return [
    { materialName: 'north_wall_brick_mat', intensity: p.wall },
    { materialName: 'south_wall_brick_mat', intensity: p.wall },
    { materialName: 'east_wall_brick_mat', intensity: p.wall },
    { materialName: 'west_wall_brick_mat', intensity: p.wall },
    { materialName: 'mat_material', intensity: p.coverMat }, // tiny satin response
    { materialName: 'bleacher_material', intensity: p.bleacher } // less
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
  probe.position = new Vector3(0, TUNING.map.wallHeight * resolvePolishedConfig().probe.centerHeightFraction, 0);

  // Explicit static render list — only the allow-listed structural meshes. The floor is not on the
  // list, so it is excluded from its own capture (no reflection recursion).
  const renderList: AbstractMesh[] = [];
  for (const mesh of scene.meshes) {
    if (matchesStaticInclude(mesh.name)) renderList.push(mesh);
  }
  probe.renderList = renderList;

  // Render EXACTLY ONCE, on the next frame after this static setup — no per-frame reflection cost.
  probe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

  // Wire the probe cube onto the receiver PBR materials only AFTER the one-time render has fully
  // completed and unbound. Wiring synchronously here caused a WebGL "Feedback loop formed between
  // Framebuffer and active Texture" error burst at load (observed on a player's machine): the walls
  // and bleachers are on the probe's OWN render list above, so if their materials already sample
  // reflectionTexture = this cube when the cube renders, the draw reads the texture currently bound
  // as the render target. Deferring one tick is free — render-once means the first frame that could
  // show the reflection is the frame after the capture anyway. Dispose-safe: RenderTargetTexture
  // .dispose() clears onAfterUnbindObservable, so an early teardown just drops this callback.
  probe.cubeTexture.onAfterUnbindObservable.addOnce(() => {
    for (const receiver of probeReceivers()) {
      const material = scene.getMaterialByName(receiver.materialName);
      if (material instanceof PBRMaterial) {
        material.reflectionTexture = probe.cubeTexture;
        material.environmentIntensity = receiver.intensity;
      }
    }
  });

  activeProbe = probe;
  return probe;
}

/**
 * Wire the probe onto a lazily-created ball PBR material (balls spawn after the probe is built, so
 * name-based wiring at probe creation can't reach them). No-op when no probe is active — i.e. in
 * Performance/Neutral mode, or before the gym finishes building — so BallVisualFactory can call this
 * unconditionally.
 */
export function applyGymProbeToBallMaterial(material: PBRMaterial): void {
  if (!activeProbe) return;
  material.reflectionTexture = activeProbe.cubeTexture;
  material.environmentIntensity = resolvePolishedConfig().probe.intensities.ball;
}

/**
 * Dispose the probe and detach it from EVERY material that samples it — the named receivers AND the
 * lazily-wired ball materials — by scanning for the cube reference. Safe when no probe exists.
 */
export function disposeGymReflectionProbe(): void {
  if (!activeProbe) return;
  const cube = activeProbe.cubeTexture;
  for (const material of activeProbe.getScene().materials) {
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
