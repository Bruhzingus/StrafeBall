/**
 * Client-only POLISHED-mode cove/strip lighting (graphics overhaul — reference-image pass).
 *
 * The user's reference render's signature element is warm LED strip lighting: a continuous cove
 * line around the ceiling perimeter, a glowing accent band along the walls above the pads, and a
 * bright strip on the nose of every bleacher step. This module builds that geometry as thin emissive
 * boxes (StandardMaterial, disableLighting — they ARE the light visually; the actual illumination
 * remains the hemi+key rig, so this adds zero scene lights and zero shadow cost).
 *
 * Mesh names use the 'decor_cove_' prefix:
 *  - GymFloorMirror's static allow-list includes the prefix, so the strips reflect in the court
 *    floor (the reference's most striking detail).
 *  - ArenaScene registers them with the polished GlowLayer for the soft bloom halo.
 *
 * Built ONLY in polished mode, after the static gym exists. Purely visual: no collision, no
 * pickability, frozen world matrices. Nothing here is imported by server or shared code.
 */

import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial } from '@babylonjs/core';
import { createBleacherTierSpecs } from '../../../shared/simulation/MapGeometry';
import { resolvePolishedConfig } from '../config/graphicsTuning';
import { TUNING } from '../config/tuning';

const COVE_PREFIX = 'decor_cove_';

/** Warm white for the ceiling cove + wall band (reference: soft warm-white LED). */
const COVE_WARM_WHITE = new Color3(1.0, 0.9, 0.72);
/** Warm amber for the bleacher step noses (reference: yellow-gold step edge strips). */
const COVE_STEP_AMBER = new Color3(1.0, 0.78, 0.38);

let built: Mesh[] = [];

function emissiveMat(scene: Scene, name: string, color: Color3): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.emissiveColor = color.clone();
  mat.diffuseColor = new Color3(0, 0, 0);
  mat.specularColor = new Color3(0, 0, 0);
  mat.disableLighting = true;
  return mat;
}

function strip(
  scene: Scene,
  name: string,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  material: StandardMaterial
): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
  mesh.position.set(cx, cy, cz);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  built.push(mesh);
  return mesh;
}

/**
 * Build all cove strips. Call once after the static gym is built (bleacher specs are pure data, so
 * only map TUNING dimensions are read at runtime). Idempotent via disposeGymCoveLighting().
 * Returns the created meshes so the caller can register them for glow.
 */
export function createGymCoveLighting(scene: Scene): Mesh[] {
  disposeGymCoveLighting();

  const { halfWidth, halfLength, wallHeight } = TUNING.map;
  // Ceiling perimeter and wall band use SEPARATE materials so their emissive (and thus bloom) can be
  // calmed independently — the reference showed the ceiling hotter than the wall band.
  const glow = resolvePolishedConfig().glow;
  const warmCeil = emissiveMat(scene, 'decor_cove_ceil_mat', COVE_WARM_WHITE.scale(glow.ceilingSourceScale));
  const warmBand = emissiveMat(scene, 'decor_cove_band_mat', COVE_WARM_WHITE.scale(glow.wallSourceScale));
  const amber = emissiveMat(scene, 'decor_cove_amber_mat', COVE_STEP_AMBER);

  // --- Ceiling perimeter cove: a continuous warm line just below the roof, inset from each wall ---
  const coveY = wallHeight - 0.32;
  const inset = 0.18; // hugs the wall like recessed cove trim
  const t = 0.09; // strip cross-section
  const xLen = (halfWidth - inset) * 2;
  const zLen = (halfLength - inset) * 2;
  strip(scene, `${COVE_PREFIX}ceil_north`, 0, coveY, halfLength - inset, xLen, t, t, warmCeil);
  strip(scene, `${COVE_PREFIX}ceil_south`, 0, coveY, -(halfLength - inset), xLen, t, t, warmCeil);
  strip(scene, `${COVE_PREFIX}ceil_east`, halfWidth - inset, coveY, 0, t, t, zLen, warmCeil);
  strip(scene, `${COVE_PREFIX}ceil_west`, -(halfWidth - inset), coveY, 0, t, t, zLen, warmCeil);

  // --- Wall accent band: a thin glowing line above the wall pads, around all four walls ---
  const bandY = 2.62;
  const bandT = 0.05;
  strip(scene, `${COVE_PREFIX}band_north`, 0, bandY, halfLength - 0.06, xLen, bandT, 0.03, warmBand);
  strip(scene, `${COVE_PREFIX}band_south`, 0, bandY, -(halfLength - 0.06), xLen, bandT, 0.03, warmBand);
  strip(scene, `${COVE_PREFIX}band_east`, halfWidth - 0.06, bandY, 0, 0.03, bandT, zLen, warmBand);
  strip(scene, `${COVE_PREFIX}band_west`, -(halfWidth - 0.06), bandY, 0, 0.03, bandT, zLen, warmBand);

  // --- Bleacher step-nose strips: one amber line along the inner-top edge of every tier ---
  for (const tier of createBleacherTierSpecs()) {
    // Inner (court-facing) edge of this tier's top surface.
    const innerX = tier.center.x - tier.side * (tier.size.width / 2);
    const topY = tier.size.height;
    strip(
      scene,
      `${COVE_PREFIX}step_${tier.side}_${tier.step}`,
      innerX + tier.side * 0.035, // nudge onto the tread so it reads as an inset LED, not floating
      topY + 0.012,
      tier.center.z,
      0.055,
      0.03,
      tier.size.depth,
      amber
    );
  }

  return built.slice();
}

export function disposeGymCoveLighting(): void {
  for (const mesh of built) {
    mesh.material?.dispose();
    mesh.dispose();
  }
  built = [];
}
