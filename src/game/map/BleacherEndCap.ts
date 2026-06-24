import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene } from '@babylonjs/core';
import { BLEACHER_LAYOUT, BleacherTierSpec } from '../../../shared/simulation/MapGeometry';

/**
 * Visual-only "retractable grandstand" end-cap for the exposed sides of the gym bleachers (the
 * `south_side`/`north_side` panel slots from createBleacherPanelSpecs). Replaces the old flat opaque
 * panel with a stepped fascia + galvanized guard rail + open support truss, built entirely from boxes
 * and cylinders (no GLB, no high-poly detail). The panel's collision AABB (createBleacherCollisionBoxes,
 * unchanged) is still the full solid wall — only the rendered look changes from solid to see-through.
 *
 * One builder function is called once per (side, zSign) corner rather than mirrored via GPU instances:
 * the geometry is cheap (a few dozen primitives) and per-corner merged meshes avoid any multi-material
 * instancing edge cases, while still sharing one code path and one pair of materials across all 4 corners.
 */

const TIER_RUN = BLEACHER_LAYOUT.tierRun;
const TIER_RISE = BLEACHER_LAYOUT.tierRise;
const TIER_COUNT = BLEACHER_LAYOUT.tierCount;
const TOTAL_RUN = TIER_COUNT * TIER_RUN;
const SLOPE = TIER_RISE / TIER_RUN;

// Layering offsets (metres) from the original flat panel's z plane. The old panel was `sideThickness`
// (0.18) thick, so keeping every new layer within +-0.09 of that plane stays clear of the solid seat-tier
// boxes behind it (which end at the court's halfLength) while reading as one thin end-cap assembly.
const FRAME_SET_BACK = 0.05; // truss sits slightly toward the court, behind the fascia
const RAIL_STAND_OFF = 0.06; // guard rail stands slightly proud on the court-facing side of the fascia

// Stepped fascia: a thin medium-gray BOARD that hugs the seat-tier silhouette's top edge and steps up
// with the seats — NOT a solid floor-to-top fill (that read as a giant gray slab / barricade) and NOT a
// new opaque backing wall. The board is FASCIA_BAND_HEIGHT tall, capping the upper portion of each tier;
// the lower portion stays open so the support truss reads as retractable-bleacher structure.
const FASCIA_THICKNESS = 0.06;
const FASCIA_BAND_HEIGHT = 0.6;
const FASCIA_GAP = 0.02; // small reveal at each step edge so the staircase silhouette reads cleanly

// Simplified support truss: a small number of readable bays (vertical posts + one floor chord + one
// X-brace per bay) that suggest gym-bleacher under-structure, not real engineering detail.
const SUPPORT_BAYS = 3;
const FRAME_POST_SIZE = 0.07;
const FRAME_BEAM_SIZE = 0.06;
const FRAME_BRACE_SIZE = 0.05;
const BAY_WIDTH = TOTAL_RUN / SUPPORT_BAYS;

// Simplified guard rail: one top handrail up the stair slope, three newel posts, and a small number of
// evenly spaced balusters. Tubes kept thick enough that they don't shimmer at gameplay distance.
const RAIL_HEIGHT_ABOVE_NOSING = 1.1;
const RAIL_TOP_RADIUS = 0.026;
const RAIL_POST_RADIUS = 0.03;
const BALUSTER_RADIUS = 0.018;
const BALUSTER_SPACING = 0.34;
const BALUSTER_CLEARANCE = 0.06; // skip a baluster wherever a (thicker) newel post already stands
const RAIL_NEWEL_RUNS = [0, TOTAL_RUN / 2, TOTAL_RUN]; // front, middle, back

/** Stepped seat-tier silhouette height (metres) at a horizontal distance `run` from the front edge. */
function tierTopHeightAtRun(run: number): number {
  const idx = Math.min(TIER_COUNT - 1, Math.max(0, Math.floor(run / TIER_RUN - 1e-6)));
  return (idx + 1) * TIER_RISE;
}

export interface BleacherEndCapMaterials {
  readonly fascia: PBRMaterial;
  readonly galvanized: PBRMaterial;
}

/** Builds (and caches by name) the two end-cap materials shared by all 4 corners. */
export function createBleacherEndCapMaterials(scene: Scene): BleacherEndCapMaterials {
  const existingFascia = scene.getMaterialByName('bleacher_endcap_fascia_mat');
  const existingRail = scene.getMaterialByName('bleacher_endcap_galvanized_mat');
  if (existingFascia instanceof PBRMaterial && existingRail instanceof PBRMaterial) {
    return { fascia: existingFascia, galvanized: existingRail };
  }

  // Medium neutral gray, matte/rough painted metal — not chrome, not near-black.
  const fascia = new PBRMaterial('bleacher_endcap_fascia_mat', scene);
  fascia.albedoColor = new Color3(0.34, 0.345, 0.35);
  fascia.metallic = 0;
  fascia.roughness = 0.78;
  fascia.environmentIntensity = 0.05;

  // Galvanized guard rail + support frame — MUTED gray (never bright silver/chrome, never pure white):
  // low metallic + high roughness gives a dull diffuse pewter response, no emissive, restrained
  // environment so it never blows out to white or clips cyan/blue under the current lights.
  const galvanized = new PBRMaterial('bleacher_endcap_galvanized_mat', scene);
  galvanized.albedoColor = new Color3(0.5, 0.51, 0.52);
  galvanized.metallic = 0.25;
  galvanized.roughness = 0.62;
  galvanized.environmentIntensity = 0.06;

  return { fascia, galvanized };
}

/**
 * Builds one end-cap corner assembly: a merged multi-material "structure" mesh (stepped fascia + open
 * support truss, named with the `bleacher_` prefix so it picks up the existing Showcase-only static
 * shadow caster/receiver wildcard automatically — no ArenaScene changes needed) and a separate merged
 * "rail" mesh (guard rail posts/top rail/balusters, named `decor_bleacher_endcap_*` so it never casts).
 *
 * `tiers` must be this side's 5 tier specs in ascending step order. `panelZ` is the original flat
 * panel's center.z for this (side, zSign) — already signed, taken straight from createBleacherPanelSpecs.
 */
export function buildBleacherEndCapCorner(
  scene: Scene,
  materials: BleacherEndCapMaterials,
  side: -1 | 1,
  zSign: -1 | 1,
  tiers: readonly BleacherTierSpec[],
  panelZ: number
): { structure: Mesh; rails: Mesh } {
  const innerX = tiers[0].center.x - side * (TIER_RUN / 2);
  const frameZ = panelZ - zSign * FRAME_SET_BACK;
  const fasciaZ = panelZ;
  const railZ = panelZ - zSign * RAIL_STAND_OFF;

  const structure = buildStructure(scene, materials, side, tiers, innerX, fasciaZ, frameZ);
  structure.name = `bleacher_endcap_structure_${side}_${zSign}`;
  structure.isPickable = false;
  structure.checkCollisions = false;

  const rails = buildRails(scene, materials.galvanized, side, innerX, railZ);
  rails.name = `decor_bleacher_endcap_rail_${side}_${zSign}`;
  rails.isPickable = false;
  rails.checkCollisions = false;

  return { structure, rails };
}

function buildStructure(
  scene: Scene,
  materials: BleacherEndCapMaterials,
  side: -1 | 1,
  tiers: readonly BleacherTierSpec[],
  innerX: number,
  fasciaZ: number,
  frameZ: number
): Mesh {
  const parts: Mesh[] = [];

  // Stepped fascia board: a thin medium-gray strip per tier, its TOP aligned to that tier's tread height
  // and only FASCIA_BAND_HEIGHT tall, so the merged outline traces the staircase top edge and visibly
  // steps up with the seats. The lower portion of each tier stays open (truss shows through) — this is a
  // restrained fascia, not the old floor-to-top solid wedge that read as a giant gray slab.
  for (const tier of tiers) {
    const top = tier.size.height; // tier tread height = (step+1)*TIER_RISE
    const bandHeight = Math.min(FASCIA_BAND_HEIGHT, top); // front tiers shorter than the band clamp to floor
    const board = MeshBuilder.CreateBox(`bleacher_endcap_fascia_part_${tier.step}`, {
      width: TIER_RUN - FASCIA_GAP,
      height: bandHeight,
      depth: FASCIA_THICKNESS
    }, scene);
    board.position.set(tier.center.x, top - bandHeight / 2, fasciaZ);
    board.material = materials.fascia;
    parts.push(board);
  }

  // Support truss: SUPPORT_BAYS bays of galvanized frame. Vertical posts rise to the seat-tier top above
  // them so the structure tucks under the seats; one floor chord ties the feet together; one X-brace per
  // bay. A small, readable frame — gym-bleacher under-structure, not real engineering detail.
  for (let k = 0; k <= SUPPORT_BAYS; k += 1) {
    const run = k * BAY_WIDTH;
    const postHeight = tierTopHeightAtRun(run);
    const post = MeshBuilder.CreateBox(`bleacher_endcap_frame_post_${k}`, {
      width: FRAME_POST_SIZE,
      height: postHeight,
      depth: FRAME_POST_SIZE
    }, scene);
    post.position.set(innerX + side * run, postHeight / 2, frameZ);
    post.material = materials.galvanized;
    parts.push(post);
  }

  const chord = MeshBuilder.CreateBox('bleacher_endcap_frame_chord_bottom', {
    width: TOTAL_RUN,
    height: FRAME_BEAM_SIZE,
    depth: FRAME_BEAM_SIZE
  }, scene);
  chord.position.set(innerX + side * TOTAL_RUN / 2, FRAME_BEAM_SIZE / 2, frameZ);
  chord.material = materials.galvanized;
  parts.push(chord);

  for (let bay = 0; bay < SUPPORT_BAYS; bay += 1) {
    const runL = bay * BAY_WIDTH;
    const runR = (bay + 1) * BAY_WIDTH;
    const bayHeight = tierTopHeightAtRun(runR); // brace fills up to the taller (back) post of the bay
    const midX = innerX + side * (runL + runR) / 2;
    const braceLength = Math.hypot(BAY_WIDTH, bayHeight);
    const braceAngle = Math.atan2(bayHeight, BAY_WIDTH);

    for (const sign of [1, -1] as const) {
      const brace = MeshBuilder.CreateBox(`bleacher_endcap_frame_brace_${bay}_${sign}`, {
        width: braceLength,
        height: FRAME_BRACE_SIZE,
        depth: FRAME_BRACE_SIZE
      }, scene);
      brace.position.set(midX, bayHeight / 2, frameZ);
      brace.rotation.z = side * sign * braceAngle;
      brace.material = materials.galvanized;
      parts.push(brace);
    }
  }

  return Mesh.MergeMeshes(parts, true, true, undefined, false, true) ?? parts[0];
}

function buildRails(scene: Scene, material: PBRMaterial, side: -1 | 1, innerX: number, railZ: number): Mesh {
  const parts: Mesh[] = [];
  const dx = side * TOTAL_RUN;
  const dy = TOTAL_RUN * SLOPE;
  const railLength = Math.hypot(dx, dy);
  // Cylinders extrude along local Y by default; this is the rotation about Z that swings that axis
  // onto the (dx, dy) nosing direction (atan2(-dx, dy), not atan2(dy, dx) — Y is the reference axis here).
  const railAngleZ = Math.atan2(-dx, dy);
  const midX = innerX + side * TOTAL_RUN / 2;
  const midRunHeight = dy / 2;

  // ONE top handrail tracing the stair nosing line, offset up by the rail height.
  const rail = MeshBuilder.CreateCylinder('bleacher_endcap_rail_top', {
    height: railLength,
    diameter: RAIL_TOP_RADIUS * 2,
    tessellation: 8
  }, scene);
  rail.rotation.z = railAngleZ;
  rail.position.set(midX, midRunHeight + RAIL_HEIGHT_ABOVE_NOSING, railZ);
  rail.material = material;
  parts.push(rail);

  // Three newel posts (front / middle / back), thicker than the balusters.
  for (let k = 0; k < RAIL_NEWEL_RUNS.length; k += 1) {
    const run = RAIL_NEWEL_RUNS[k];
    const y = run * SLOPE;
    const post = MeshBuilder.CreateCylinder(`bleacher_endcap_rail_post_${k}`, {
      height: RAIL_HEIGHT_ABOVE_NOSING,
      diameter: RAIL_POST_RADIUS * 2,
      tessellation: 10
    }, scene);
    post.position.set(innerX + side * run, y + RAIL_HEIGHT_ABOVE_NOSING / 2, railZ);
    post.material = material;
    parts.push(post);
  }

  // A small number of evenly spaced balusters along the slope, skipping anywhere a newel already stands.
  const balusterCount = Math.floor(TOTAL_RUN / BALUSTER_SPACING);
  for (let i = 1; i < balusterCount; i += 1) {
    const run = i * BALUSTER_SPACING;
    if (RAIL_NEWEL_RUNS.some((newelRun) => Math.abs(newelRun - run) < BALUSTER_CLEARANCE)) continue;
    const y = run * SLOPE;
    const baluster = MeshBuilder.CreateCylinder(`bleacher_endcap_rail_baluster_${i}`, {
      height: RAIL_HEIGHT_ABOVE_NOSING,
      diameter: BALUSTER_RADIUS * 2,
      tessellation: 6
    }, scene);
    baluster.position.set(innerX + side * run, y + RAIL_HEIGHT_ABOVE_NOSING / 2, railZ);
    baluster.material = material;
    parts.push(baluster);
  }

  return Mesh.MergeMeshes(parts, true, true, undefined, false, false) ?? parts[0];
}
