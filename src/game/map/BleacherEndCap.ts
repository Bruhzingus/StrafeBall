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
const FRAME_SET_BACK = 0.06; // truss sits slightly toward the court, behind the fascia
const RAIL_STAND_OFF = 0.07; // guard rail stands slightly proud, in front of the fascia

const FASCIA_THICKNESS = 0.06;
const FASCIA_GAP = 0.02; // small reveal between steps so the stepped silhouette reads, not a solid blob

const TRUSS_HEIGHT = 1.0;
const FRAME_POST_SIZE = 0.06;
const FRAME_BEAM_SIZE = 0.05;
const FRAME_BRACE_SIZE = 0.045;
const FRAME_BAY_SIZE = TIER_RUN; // one bay per tier step, posts at every tier boundary

const RAIL_HEIGHT_ABOVE_NOSING = 0.9;
const RAIL_MID_HEIGHT = RAIL_HEIGHT_ABOVE_NOSING * 0.5;
const RAIL_TOP_RADIUS = 0.024;
const RAIL_POST_RADIUS = 0.022;
const BALUSTER_RADIUS = 0.016;
const BALUSTER_SPACING = 0.13;
const BALUSTER_CLEARANCE = 0.045; // keep balusters from overlapping the (slightly thicker) posts

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

  // Galvanized/aluminum guard rail + support frame — neutral gray (never pure white), moderately rough
  // metal, no emissive, restrained environment response so it never clips cyan/white under the rig.
  const galvanized = new PBRMaterial('bleacher_endcap_galvanized_mat', scene);
  galvanized.albedoColor = new Color3(0.58, 0.585, 0.59);
  galvanized.metallic = 0.55;
  galvanized.roughness = 0.46;
  galvanized.environmentIntensity = 0.1;

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
  const railZ = panelZ + zSign * RAIL_STAND_OFF;

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

  // Stepped fascia: a solid stringer wedge — each tier's slot fills from the floor up to that tier's own
  // tread height, exactly mirroring the real seat-tier silhouette (just thin, at the end-cap z-plane).
  // The result is a continuous stepped panel under the shorter/closer tiers and a tall solid mass under
  // the tallest tier, matching a real grandstand stringer — the truss only shows through near the short
  // end of the run, where each slot's fill height is short.
  for (const tier of tiers) {
    const fillHeight = tier.size.height;
    const riser = MeshBuilder.CreateBox(`bleacher_endcap_fascia_part_${tier.step}`, {
      width: TIER_RUN - FASCIA_GAP,
      height: fillHeight,
      depth: FASCIA_THICKNESS
    }, scene);
    riser.position.set(tier.center.x, fillHeight / 2, fasciaZ);
    riser.material = materials.fascia;
    parts.push(riser);
  }

  // Open support truss: fixed-height posts at every tier boundary, top/bottom chords, and X-braces in
  // each bay — the simplified visible lower frame called for in the spec.
  const postCount = TIER_COUNT + 1;
  for (let k = 0; k < postCount; k += 1) {
    const x = innerX + side * k * FRAME_BAY_SIZE;
    const post = MeshBuilder.CreateBox(`bleacher_endcap_frame_post_${k}`, {
      width: FRAME_POST_SIZE,
      height: TRUSS_HEIGHT,
      depth: FRAME_POST_SIZE
    }, scene);
    post.position.set(x, TRUSS_HEIGHT / 2, frameZ);
    post.material = materials.galvanized;
    parts.push(post);
  }

  for (const [chordName, y] of [['bottom', FRAME_BEAM_SIZE / 2 + 0.02], ['top', TRUSS_HEIGHT - FRAME_BEAM_SIZE / 2]] as const) {
    const chord = MeshBuilder.CreateBox(`bleacher_endcap_frame_chord_${chordName}`, {
      width: TOTAL_RUN,
      height: FRAME_BEAM_SIZE,
      depth: FRAME_BEAM_SIZE
    }, scene);
    chord.position.set(innerX + side * TOTAL_RUN / 2, y, frameZ);
    chord.material = materials.galvanized;
    parts.push(chord);
  }

  const braceLength = Math.hypot(FRAME_BAY_SIZE, TRUSS_HEIGHT);
  const braceAngle = Math.atan2(TRUSS_HEIGHT, FRAME_BAY_SIZE);
  for (let bay = 0; bay < TIER_COUNT; bay += 1) {
    const x0 = innerX + side * bay * FRAME_BAY_SIZE;
    const x1 = innerX + side * (bay + 1) * FRAME_BAY_SIZE;
    const midX = (x0 + x1) / 2;

    for (const sign of [1, -1] as const) {
      const brace = MeshBuilder.CreateBox(`bleacher_endcap_frame_brace_${bay}_${sign}`, {
        width: braceLength,
        height: FRAME_BRACE_SIZE,
        depth: FRAME_BRACE_SIZE
      }, scene);
      brace.position.set(midX, TRUSS_HEIGHT / 2, frameZ);
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

  // Sloped stair rail (top + mid bar), tracing the nosing line offset upward.
  for (const offsetY of [RAIL_HEIGHT_ABOVE_NOSING, RAIL_MID_HEIGHT]) {
    const radius = offsetY === RAIL_HEIGHT_ABOVE_NOSING ? RAIL_TOP_RADIUS : RAIL_TOP_RADIUS * 0.8;
    const rail = MeshBuilder.CreateCylinder(`bleacher_endcap_rail_bar_${offsetY}`, {
      height: railLength,
      diameter: radius * 2,
      tessellation: 8
    }, scene);
    rail.rotation.z = railAngleZ;
    rail.position.set(midX, midRunHeight + offsetY, railZ);
    rail.material = material;
    parts.push(rail);
  }

  // Vertical posts at every tier boundary (newel + 5 tier corners), thicker than the balusters.
  const postXs: number[] = [];
  for (let k = 0; k <= TIER_COUNT; k += 1) {
    const run = k * TIER_RUN;
    const x = innerX + side * run;
    const y = run * SLOPE;
    postXs.push(run);
    const post = MeshBuilder.CreateCylinder(`bleacher_endcap_rail_post_${k}`, {
      height: RAIL_HEIGHT_ABOVE_NOSING,
      diameter: RAIL_POST_RADIUS * 2,
      tessellation: 10
    }, scene);
    post.position.set(x, y + RAIL_HEIGHT_ABOVE_NOSING / 2, railZ);
    post.material = material;
    parts.push(post);
  }

  // Evenly spaced balusters along the slope, skipping anywhere a (thicker) post already stands.
  const balusterCount = Math.floor(TOTAL_RUN / BALUSTER_SPACING);
  for (let i = 1; i < balusterCount; i += 1) {
    const run = i * BALUSTER_SPACING;
    if (postXs.some((postRun) => Math.abs(postRun - run) < BALUSTER_CLEARANCE)) continue;
    const x = innerX + side * run;
    const y = run * SLOPE;
    const baluster = MeshBuilder.CreateCylinder(`bleacher_endcap_rail_baluster_${i}`, {
      height: RAIL_HEIGHT_ABOVE_NOSING,
      diameter: BALUSTER_RADIUS * 2,
      tessellation: 6
    }, scene);
    baluster.position.set(x, y + RAIL_HEIGHT_ABOVE_NOSING / 2, railZ);
    baluster.material = material;
    parts.push(baluster);
  }

  return Mesh.MergeMeshes(parts, true, true, undefined, false, false) ?? parts[0];
}
