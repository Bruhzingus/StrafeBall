/**
 * Creator Sandbox — layout schema, module catalog, and pure geometry derivation.
 *
 * This file is the data + rules core of the developer-only movement-course editor. It is
 * deliberately Babylon-free: it only describes layouts (plain JSON), the catalog of safe modules,
 * and the math that turns a placed object into the oriented collision/visual boxes the renderer and
 * the movement world both consume. Nothing here is read by the server, shared simulation, prediction
 * or networking — it is local/offline only.
 *
 * A layout is fully data-driven: every editor-created structure can be rebuilt from `CreatorLayout`,
 * unknown module types are ignored, and absurd dimensions/coordinates are clamped on import.
 */

import {
  SANDBOX_CENTER,
  SANDBOX_HALF_X,
  SANDBOX_HALF_Z,
  SANDBOX_CEILING_Y,
  SANDBOX_WALLS,
  SANDBOX_SPAWN_LOCAL,
  SANDBOX_LEAVE_LOCAL,
  BOUNDARY_HEIGHT,
  type WallStyle
} from '../MovementSandboxLayout';
// The committed course layout — the single source of truth the editor opens on AND the live
// Movement Sandbox renders. Edited locally, then promoted into this file (see committedCourseLayout).
import committedCourseJson from './layouts/movementCourseLayout.json';

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

export const CREATOR_SCHEMA_VERSION = 1;

export type Vec3Tuple = [number, number, number];

export interface CreatorLayout {
  version: number;
  name: string;
  updatedAt: string;
  ground: {
    bounds: { width: number; depth: number; y: number };
    material: string;
  };
  objects: CreatorLayoutObject[];
  /** Optional prefab library carried by Export File / Import so saved assemblies survive a browser
   *  wipe. Object positions are RELATIVE to the prefab origin (selection center XZ, lowest Y). */
  prefabs?: CreatorPrefab[];
}

export interface CreatorPrefab {
  name: string;
  objects: CreatorLayoutObject[];
}

export interface CreatorLayoutObject {
  id: string;
  type: CreatorModuleType;
  name?: string;
  /** World position; Y is the BASE (floor) of the object, not its centre. */
  position: Vec3Tuple;
  /** Rotation in DEGREES [x, y, z]. Only Y affects collision/wall-run; X/Z tilt visuals only. */
  rotation: Vec3Tuple;
  /** Multiplies the module's base size. Editing width/height/depth writes here. */
  scale: Vec3Tuple;
  material?: string;
  /** Optional real in-game image texture id (see CREATOR_TEXTURES). Overrides the flat material look
   *  on solid terrain modules. Local/offline only — never read by the server or shared sim. */
  texture?: string;
  color?: string;
  collision?: boolean;
  /** Visual alpha, 0=invisible and 1=fully opaque. Does not affect collision or triggers. */
  opacity?: number;
  /** Back-compat only: old layouts used this for visual hiding. New saves use opacity. */
  visible?: boolean;
  /** Whether this collidable solid contributes wall-run faces. Missing = enabled for old layouts. */
  wallrunEnabled?: boolean;
  metadata?: CreatorObjectMetadata;
}

export const CREATOR_LABEL_SIZES = ['small', 'medium', 'large'] as const;
export type CreatorLabelSize = typeof CREATOR_LABEL_SIZES[number];
export const CREATOR_LABEL_COLORS = ['white', 'gold', 'blue', 'green', 'red'] as const;
export type CreatorLabelColor = typeof CREATOR_LABEL_COLORS[number];

/** Restricted, well-known metadata fields (no arbitrary scripting / URLs). */
export interface CreatorObjectMetadata {
  /** Marker facing (spawn / leave / arrow), degrees. */
  yawDeg?: number;
  /** Spawn: only one default spawn is active at a time. */
  defaultSpawn?: boolean;
  /** Gate / pad trigger volume, metres. */
  trigger?: { width: number; height: number; depth: number };
  triggerType?: 'start' | 'checkpoint' | 'finish' | 'none';
  /** Checkpoint ordering. */
  checkpointOrder?: number;
  /** One-way direction for a gate, degrees (heading the player must pass through). */
  oneWayYawDeg?: number;
  /** Route label / sign text (plain text, sanitised + length-capped on apply). */
  label?: string;
  /** Editor label display controls. Empty text hides the label instead of rendering a placeholder. */
  labelVisible?: boolean;
  labelSize?: CreatorLabelSize;
  labelColor?: CreatorLabelColor;
  labelOffsetY?: number;
  enabled?: boolean;
  /** Ability-pad strength multiplier (bounce launch / speed boost). 1 = default; clamped on apply. */
  padStrength?: number;
  /**
   * Moving platform (solid terrain only): a deterministic linear ping-pong between the placed
   * position and position+(dx,dy,dz), at `speed` m/s with `pauseSeconds` dwell at each end.
   * Offline-only runtime (CreatorMovers); translation only — the object's yaw never animates.
   */
  mover?: { dx: number; dy: number; dz: number; speed: number; pauseSeconds: number };
}

// ---------------------------------------------------------------------------------------------
// Safety limits (clamped on every edit + import — never crash on bad data)
// ---------------------------------------------------------------------------------------------

export const CREATOR_LIMITS = {
  maxObjects: 400,
  // Size/scale are effectively unlimited by request — only tiny floors (to avoid degenerate/zero or
  // non-finite geometry) and an astronomically high ceiling remain, purely as crash guards.
  minDimension: 0.01,
  maxDimension: 100000,
  minScale: 0.001,
  maxScale: 100000,
  /** Allowed distance of an object's base from the yard centre. Generous so big pieces aren't reined in. */
  maxRadiusFromCenter: Math.max(SANDBOX_HALF_X, SANDBOX_HALF_Z) + 100000,
  minY: -100000,
  maxY: SANDBOX_CEILING_Y + 100000,
  maxLabelLength: 64,
  maxNameLength: 48,
  maxTriggerDimension: 100000,
  minLabelOffsetY: -10,
  maxLabelOffsetY: 30,
  // Ability-pad strength multiplier bounds (bounce launch / speed boost).
  minPadStrength: 0.1,
  maxPadStrength: 20
} as const;

/** Modern visual alpha for a Creator object. Old `visible:false` layouts migrate to 0 opacity. */
export function objectOpacity(obj: { opacity?: unknown; visible?: unknown }): number {
  if (typeof obj.opacity === 'number' && Number.isFinite(obj.opacity)) return clampNumber(obj.opacity, 0, 1, 1);
  if (typeof obj.visible === 'boolean') return obj.visible ? 1 : 0;
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Material palette (restricted, from the existing safe sandbox styles)
// ---------------------------------------------------------------------------------------------

export interface CreatorMaterialDef {
  id: string;
  label: string;
  /** Base colour as [r, g, b] in 0..1. */
  rgb: Vec3Tuple;
  /** Solid (marker) vs gridded terrain look. */
  solid?: boolean;
}

export const CREATOR_MATERIALS: readonly CreatorMaterialDef[] = [
  { id: 'ground', label: 'Ground', rgb: [0.4, 0.43, 0.47] },
  { id: 'concrete', label: 'Concrete', rgb: [0.52, 0.54, 0.57] },
  { id: 'pad', label: 'Blue Deck', rgb: [0.14, 0.27, 0.52] },
  { id: 'accent', label: 'Teal Accent', rgb: [0.1, 0.4, 0.52] },
  { id: 'recovery', label: 'Recovery Green', rgb: [0.16, 0.42, 0.24] },
  { id: 'orange_box_prototype', label: 'Orange Box Prototype', rgb: [0.96, 0.42, 0.08] },
  { id: 'yellow_box_prototype', label: 'Yellow Box Prototype', rgb: [0.95, 0.76, 0.08] },
  { id: 'purple_box_prototype', label: 'Purple Box Prototype', rgb: [0.5, 0.28, 0.86] },
  { id: 'boundary', label: 'Boundary', rgb: [0.3, 0.33, 0.38] },
  { id: 'marker_blue', label: 'Marker Blue', rgb: [0.2, 0.45, 0.95], solid: true },
  { id: 'marker_green', label: 'Marker Green', rgb: [0.2, 0.8, 0.4], solid: true },
  { id: 'marker_red', label: 'Marker Red', rgb: [0.92, 0.3, 0.32], solid: true },
  { id: 'marker_gold', label: 'Marker Gold', rgb: [0.96, 0.78, 0.25], solid: true },
  { id: 'marker_cyan', label: 'Marker Cyan', rgb: [0.16, 0.86, 0.92], solid: true },
  // Ability-pad colours (bright, distinct so each pad type reads at a glance).
  { id: 'pad_stamina', label: 'Pad · Stamina', rgb: [0.16, 0.78, 0.42], solid: true },
  { id: 'pad_backflip', label: 'Pad · Backflip', rgb: [0.64, 0.34, 0.95], solid: true },
  { id: 'pad_speed', label: 'Pad · Speed', rgb: [0.98, 0.62, 0.12], solid: true },
  { id: 'pad_bounce', label: 'Pad · Bounce', rgb: [0.18, 0.66, 0.98], solid: true }
];

export const CREATOR_MATERIAL_IDS = CREATOR_MATERIALS.map((m) => m.id);

export function materialDef(id: string | undefined): CreatorMaterialDef {
  return CREATOR_MATERIALS.find((m) => m.id === id) ?? CREATOR_MATERIALS[0];
}

// ---------------------------------------------------------------------------------------------
// Real in-game image textures (the actual surfaces used by the gym/arena), selectable per object.
// These are static assets served from /public; applying one to a solid module renders that real
// texture (tiled) instead of the flat grid material. Local/offline only.
// ---------------------------------------------------------------------------------------------

export interface CreatorTextureDef {
  id: string;
  label: string;
  /** Public asset URL of the colour/albedo map (served from /public). */
  url: string;
  /** World metres covered by one texture repeat (drives tiling on terrain). */
  tile: number;
}

export const CREATOR_TEXTURES: readonly CreatorTextureDef[] = [
  { id: 'cinder_block', label: 'Painted Cinder Block', url: '/assets/textures/gym/walls/NewWalls/StrafeBall_PaintedCinderBlock_Imperfect_Color_2K.png', tile: 4 },
  { id: 'brick', label: 'Brick Wall', url: '/assets/textures/gym/walls/Bricks064_2K-JPG_Color.jpg', tile: 3 },
  { id: 'stone', label: 'Stone Wall', url: '/assets/textures/gym/walls/Wall_Stones.png', tile: 4 },
  { id: 'navy_vinyl', label: 'Navy Vinyl Pad', url: '/assets/textures/gym/walls/NewWallMat/NavyVinyl_Color.png', tile: 4 },
  { id: 'wall_pad', label: 'Wall Pad', url: '/assets/textures/gym/walls/WallMat.png', tile: 4 },
  { id: 'cover_mat', label: 'Blue Cover Mat', url: '/assets/textures/gym/Obstacles/gym_cover_mat_blue_tuned.png', tile: 3 },
  { id: 'laminate_floor', label: 'Laminate Floor', url: '/assets/textures/gym/floor/textures/laminate_floor_03_diff_2k.png', tile: 5 },
  { id: 'wood_floor', label: 'Wood Floor', url: '/assets/textures/gym/floor/WoodFloor051_1K-JPG_Color.jpg', tile: 4 }
];

export const CREATOR_TEXTURE_IDS = CREATOR_TEXTURES.map((t) => t.id);

export function textureDef(id: string | undefined): CreatorTextureDef | undefined {
  if (!id) return undefined;
  return CREATOR_TEXTURES.find((t) => t.id === id);
}

const wallStyleToMaterial: Record<WallStyle, string> = {
  pad: 'pad',
  concrete: 'concrete',
  accent: 'accent'
};

// ---------------------------------------------------------------------------------------------
// Module catalog
// ---------------------------------------------------------------------------------------------

export type CreatorModuleCategory = 'terrain' | 'pad' | 'marker' | 'optional';
export type CreatorShapeKind =
  | 'box'
  | 'lshape'
  | 'ushape'
  | 'ramp'
  | 'tunnel'
  | 'pad'
  | 'gate'
  | 'arrow'
  | 'sign'
  | 'portal';

export interface CreatorModuleDef {
  type: CreatorModuleType;
  label: string;
  category: CreatorModuleCategory;
  shape: CreatorShapeKind;
  /** Overall bounding size at scale 1, metres [w, h, d]. */
  baseSize: Vec3Tuple;
  material: string;
  /** Solid terrain modules default collision on; markers default off. */
  collision: boolean;
  defaultRotationY?: number;
  defaultMetadata?: CreatorObjectMetadata;
}

export type CreatorModuleType =
  | 'flat_ground'
  | 'raised_platform'
  | 'moving_platform'
  | 'long_wall'
  | 'tall_wall'
  | 'wallrun_wall'
  | 'angled_wall'
  | 'l_wall'
  | 'u_wall'
  | 'ramp'
  | 'wide_ramp'
  | 'slide_tunnel'
  | 'recovery_floor'
  | 'boundary_wall'
  | 'spawn_point'
  | 'test_spawn'
  | 'leave_portal'
  | 'start_pad'
  | 'checkpoint_gate'
  | 'finish_gate'
  | 'route_arrow'
  | 'signboard'
  | 'marker_pad'
  | 'stamina_pad'
  | 'backflip_pad'
  | 'speed_pad'
  | 'bounce_pad'
  | 'kill_block'
  | 'bot_spawn'
  | 'target_dummy'
  | 'ball_spawn';

export const CREATOR_MODULES: readonly CreatorModuleDef[] = [
  // --- Terrain / structure ---
  { type: 'flat_ground', label: 'Flat Ground Tile', category: 'terrain', shape: 'box', baseSize: [20, 0.3, 20], material: 'ground', collision: true },
  { type: 'raised_platform', label: 'Raised Platform', category: 'terrain', shape: 'box', baseSize: [8, 3, 8], material: 'concrete', collision: true },
  // Deterministic linear ping-pong mover (offline-only runtime). Accent material so it reads as a
  // distinct "this one moves" piece; the travel path previews in Build (line + far-end ghost).
  { type: 'moving_platform', label: 'Moving Platform', category: 'terrain', shape: 'box', baseSize: [6, 1, 6], material: 'accent', collision: true, defaultMetadata: { mover: { dx: 10, dy: 0, dz: 0, speed: 4, pauseSeconds: 0.5 } } },
  { type: 'long_wall', label: 'Long Wall', category: 'terrain', shape: 'box', baseSize: [40, 8, 1.5], material: 'concrete', collision: true },
  { type: 'tall_wall', label: 'Tall Wall', category: 'terrain', shape: 'box', baseSize: [10, 18, 1.5], material: 'pad', collision: true },
  { type: 'wallrun_wall', label: 'Wall-run Wall', category: 'terrain', shape: 'box', baseSize: [3, 14, 90], material: 'pad', collision: true },
  { type: 'angled_wall', label: 'Angled Wall', category: 'terrain', shape: 'box', baseSize: [3, 12, 40], material: 'accent', collision: true, defaultRotationY: 30 },
  { type: 'l_wall', label: 'L-shaped Wall', category: 'terrain', shape: 'lshape', baseSize: [30, 14, 30], material: 'accent', collision: true },
  { type: 'u_wall', label: 'U-shaped Wall', category: 'terrain', shape: 'ushape', baseSize: [40, 15, 40], material: 'pad', collision: true },
  { type: 'ramp', label: 'Ramp', category: 'terrain', shape: 'ramp', baseSize: [16, 4, 6], material: 'concrete', collision: true },
  { type: 'wide_ramp', label: 'Wide Ramp', category: 'terrain', shape: 'ramp', baseSize: [16, 4, 16], material: 'concrete', collision: true },
  { type: 'slide_tunnel', label: 'Low Slide Tunnel', category: 'terrain', shape: 'tunnel', baseSize: [10, 2.2, 9], material: 'accent', collision: true },
  { type: 'recovery_floor', label: 'Recovery Floor', category: 'terrain', shape: 'box', baseSize: [16, 0.3, 16], material: 'recovery', collision: true },
  { type: 'boundary_wall', label: 'Outer Boundary Wall', category: 'terrain', shape: 'box', baseSize: [60, 22, 3], material: 'boundary', collision: true },

  // --- Course markers ---
  { type: 'spawn_point', label: 'Spawn Point', category: 'marker', shape: 'pad', baseSize: [6, 0.12, 6], material: 'marker_green', collision: false, defaultMetadata: { yawDeg: 90, defaultSpawn: false } },
  // Test Spawn: a playtest-debug override of the main spawn. Place as many as you like; a playtest
  // starts at the MOST-RECENTLY-PLACED one (see layoutSpawn). "Destroy All" in its inspector clears them.
  { type: 'test_spawn', label: 'Test Spawn', category: 'marker', shape: 'pad', baseSize: [6, 0.12, 6], material: 'marker_cyan', collision: false, defaultMetadata: { label: 'TEST SPAWN' } },
  { type: 'leave_portal', label: 'Leave Portal', category: 'marker', shape: 'portal', baseSize: [1.8, 3, 0.4], material: 'marker_blue', collision: false, defaultMetadata: { yawDeg: 0, label: 'LEAVE' } },
  { type: 'start_pad', label: 'Start Pad', category: 'marker', shape: 'pad', baseSize: [6, 0.12, 6], material: 'marker_gold', collision: false, defaultMetadata: { triggerType: 'start', trigger: { width: 6, height: 4, depth: 6 } } },
  { type: 'checkpoint_gate', label: 'Checkpoint Gate', category: 'marker', shape: 'gate', baseSize: [6, 5, 0.4], material: 'marker_blue', collision: false, defaultMetadata: { triggerType: 'checkpoint', checkpointOrder: 1, trigger: { width: 6, height: 5, depth: 2 } } },
  { type: 'finish_gate', label: 'Finish Gate', category: 'marker', shape: 'gate', baseSize: [6, 5, 0.4], material: 'marker_gold', collision: false, defaultMetadata: { triggerType: 'finish', trigger: { width: 6, height: 5, depth: 2 } } },
  { type: 'route_arrow', label: 'Route Arrow', category: 'marker', shape: 'arrow', baseSize: [2.2, 0.1, 2.6], material: 'marker_gold', collision: false, defaultMetadata: { yawDeg: 0, label: '' } },
  { type: 'signboard', label: 'Signboard', category: 'marker', shape: 'sign', baseSize: [3.2, 1.4, 0.2], material: 'marker_blue', collision: false, defaultMetadata: { yawDeg: 0, label: 'SIGN' } },
  { type: 'marker_pad', label: 'Marker Pad', category: 'marker', shape: 'pad', baseSize: [4, 0.1, 4], material: 'marker_blue', collision: false },

  // --- Ability pads (functional in Playtest: step on them to trigger the effect). Scalable; the
  //     footprint you resize IS the trigger area. padStrength scales bounce/speed power. ---
  { type: 'stamina_pad', label: 'Stamina Pad', category: 'pad', shape: 'pad', baseSize: [4, 0.2, 4], material: 'pad_stamina', collision: false, defaultMetadata: { label: 'STAMINA' } },
  { type: 'backflip_pad', label: 'Backflip Pad', category: 'pad', shape: 'pad', baseSize: [4, 0.2, 4], material: 'pad_backflip', collision: false, defaultMetadata: { label: 'BACKFLIP' } },
  { type: 'speed_pad', label: 'Speed Boost Pad', category: 'pad', shape: 'pad', baseSize: [4, 0.2, 6], material: 'pad_speed', collision: false, defaultMetadata: { label: 'SPEED', padStrength: 1 } },
  { type: 'bounce_pad', label: 'Bounce Pad', category: 'pad', shape: 'pad', baseSize: [4, 0.35, 4], material: 'pad_bounce', collision: false, defaultMetadata: { label: 'BOUNCE', padStrength: 1 } },
  // Kill block: a walk-through hazard VOLUME (no collision) that resets the player to their last
  // checkpoint (or spawn) on touch in Playtest. Scale it to cover pits / out-of-bounds / hazards.
  { type: 'kill_block', label: 'Kill Block', category: 'pad', shape: 'box', baseSize: [4, 4, 4], material: 'marker_red', collision: false, defaultMetadata: { label: 'KILL' } },

  // --- Optional future-ready markers (metadata only; ignored by the normal sandbox) ---
  { type: 'bot_spawn', label: 'Bot Spawn Marker', category: 'optional', shape: 'pad', baseSize: [2, 0.1, 2], material: 'marker_red', collision: false, defaultMetadata: { yawDeg: 0, label: 'BOT' } },
  { type: 'target_dummy', label: 'Target Dummy Marker', category: 'optional', shape: 'pad', baseSize: [2, 0.1, 2], material: 'marker_red', collision: false, defaultMetadata: { label: 'DUMMY' } },
  { type: 'ball_spawn', label: 'Ball Spawn Marker', category: 'optional', shape: 'pad', baseSize: [1.6, 0.1, 1.6], material: 'marker_gold', collision: false, defaultMetadata: { label: 'BALL' } }
];

const MODULE_BY_TYPE = new Map<string, CreatorModuleDef>(CREATOR_MODULES.map((m) => [m.type, m]));

export function moduleDef(type: string): CreatorModuleDef | undefined {
  return MODULE_BY_TYPE.get(type);
}

export function isKnownModuleType(type: string): type is CreatorModuleType {
  return MODULE_BY_TYPE.has(type);
}

/** Solid modules participate in collision + wall-run; markers are visual + metadata only. */
export function isSolidModule(type: string): boolean {
  const def = MODULE_BY_TYPE.get(type);
  if (!def) return false;
  return def.category === 'terrain';
}

// ---------------------------------------------------------------------------------------------
// Oriented sub-box derivation (shared by visuals, collision, and the movement world)
// ---------------------------------------------------------------------------------------------

/** A single axis-of-Y-rotation box in world space. */
export interface OrientedBox {
  cx: number;
  cy: number;
  cz: number;
  w: number;
  h: number;
  d: number;
  /** Y rotation in radians. */
  ry: number;
}

/** Smooth wedge ramp prism in world space. Local +X is uphill, then rotated by ry. */
export interface RampPrism {
  cx: number;
  baseY: number;
  cz: number;
  w: number;
  h: number;
  d: number;
  /** Y rotation in radians. */
  ry: number;
  /** Up-facing sloped surface normal in world space. */
  normal: Vec3Tuple;
}

interface LocalBox {
  /** Offset of the box centre from the object base, in base-frame metres (pre-scale). */
  o: Vec3Tuple;
  /** Box size in base-frame metres (pre-scale). */
  s: Vec3Tuple;
}

const DEG2RAD = Math.PI / 180;

/**
 * The solid sub-boxes of an object in its LOCAL base frame (object base at origin, +Y up). Markers
 * return []. Composite shapes (L/U/ramp/tunnel) are several boxes; a plain box is one. Sizes/offsets
 * are pre-scale; the world transform applies position, Y-rotation and scale.
 */
function localBoxes(def: CreatorModuleDef): LocalBox[] {
  const [w, h, d] = def.baseSize;
  switch (def.shape) {
    case 'box':
      return [{ o: [0, h / 2, 0], s: [w, h, d] }];

    case 'lshape': {
      // Two perpendicular arms meeting at the -X / -Z corner.
      const t = Math.max(1.5, Math.min(w, d) * 0.1);
      return [
        { o: [-w / 2 + t / 2, h / 2, 0], s: [t, h, d] }, // arm along Z (west edge)
        { o: [0, h / 2, -d / 2 + t / 2], s: [w, h, t] } // arm along X (south edge)
      ];
    }

    case 'ushape': {
      const t = Math.max(1.5, Math.min(w, d) * 0.08);
      return [
        { o: [-w / 2 + t / 2, h / 2, 0], s: [t, h, d] }, // back (west)
        { o: [0, h / 2, -d / 2 + t / 2], s: [w, h, t] }, // south arm
        { o: [0, h / 2, d / 2 - t / 2], s: [w, h, t] } // north arm
      ];
    }

    case 'ramp': {
      // Ramps are smooth wedge prisms, not box stacks. They are returned by objectRampPrisms().
      return [];
    }

    case 'tunnel': {
      // Two side walls + an overhead slab leaving a low gap that forces a slide to pass through.
      const wallT = Math.max(0.6, w * 0.12);
      const clear = Math.max(0.9, h - 1.0); // bottom of the roof slab — under standing height
      const roofH = Math.max(0.4, h - clear);
      const innerHalf = w / 2 - wallT;
      return [
        { o: [-(innerHalf + wallT / 2), h / 2, 0], s: [wallT, h, d] },
        { o: [innerHalf + wallT / 2, h / 2, 0], s: [wallT, h, d] },
        { o: [0, clear + roofH / 2, 0], s: [w, roofH, d] }
      ];
    }

    default:
      return [];
  }
}

/** Solid oriented sub-boxes of an object in WORLD space (empty for markers / no-collision). */
export function objectCollisionBoxes(obj: CreatorLayoutObject): OrientedBox[] {
  const def = MODULE_BY_TYPE.get(obj.type);
  if (!def || !isSolidModule(obj.type)) return [];
  if (obj.collision === false) return [];
  return objectSolidBoxes(obj);
}

/** Smooth ramp prisms of an object in WORLD space, regardless of collision/opacity flags. */
export function objectRampPrisms(obj: CreatorLayoutObject): RampPrism[] {
  const def = MODULE_BY_TYPE.get(obj.type);
  if (!def || def.shape !== 'ramp') return [];
  const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
  const [sx, sy, sz] = obj.scale;
  const [px, py, pz] = obj.position;
  const [w, h, d] = def.baseSize;
  const width = w * sx;
  const height = h * sy;
  const depth = d * sz;
  const slope = height / Math.max(0.0001, width);
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  const nLen = Math.hypot(slope, 1);
  return [{
    cx: px,
    baseY: py,
    cz: pz,
    w: width,
    h: height,
    d: depth,
    ry,
    normal: [(-slope * cos) / nLen, 1 / nLen, (slope * sin) / nLen]
  }];
}

/** Smooth ramp prisms that should collide with the player. */
export function objectCollisionRamps(obj: CreatorLayoutObject): RampPrism[] {
  const def = MODULE_BY_TYPE.get(obj.type);
  if (!def || !isSolidModule(obj.type)) return [];
  if (obj.collision === false) return [];
  return objectRampPrisms(obj);
}

/**
 * Local (pre-scale, base-frame) solid sub-boxes for a module type — used to build parented visual
 * meshes whose object-root TransformNode then carries position / Y-rotation / scale. Empty for markers.
 */
export function moduleLocalBoxes(type: string): Array<{ o: Vec3Tuple; s: Vec3Tuple }> {
  const def = MODULE_BY_TYPE.get(type);
  if (!def || def.category !== 'terrain') return [];
  return localBoxes(def).map((b) => ({ o: [...b.o] as Vec3Tuple, s: [...b.s] as Vec3Tuple }));
}

/** Enclosing world AABB of any object (solid boxes, or the marker footprint) — for selection highlight. */
export function objectWorldAabb(obj: CreatorLayoutObject): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const solids = objectSolidBoxes(obj);
  const ramps = objectRampPrisms(obj);
  if (solids.length > 0 || ramps.length > 0) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const box of solids) {
      const a = orientedBoxAabb(box);
      minX = Math.min(minX, a.minX); minY = Math.min(minY, a.minY); minZ = Math.min(minZ, a.minZ);
      maxX = Math.max(maxX, a.maxX); maxY = Math.max(maxY, a.maxY); maxZ = Math.max(maxZ, a.maxZ);
    }
    for (const ramp of ramps) {
      const a = rampPrismAabb(ramp);
      minX = Math.min(minX, a.minX); minY = Math.min(minY, a.minY); minZ = Math.min(minZ, a.minZ);
      maxX = Math.max(maxX, a.maxX); maxY = Math.max(maxY, a.maxY); maxZ = Math.max(maxZ, a.maxZ);
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }
  // Marker: footprint from base size × scale, a little taller so the highlight reads.
  const [w, h, d] = objectDimensions(obj);
  const [px, py, pz] = obj.position;
  const hx = Math.max(0.6, w / 2);
  const hz = Math.max(0.6, d / 2);
  const top = Math.max(1.2, h);
  return { minX: px - hx, maxX: px + hx, minY: py, maxY: py + top, minZ: pz - hz, maxZ: pz + hz };
}

/** Solid oriented sub-boxes regardless of the collision flag (used for visuals + selection). */
export function objectSolidBoxes(obj: CreatorLayoutObject): OrientedBox[] {
  const def = MODULE_BY_TYPE.get(obj.type);
  if (!def) return [];
  const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  const [sx, sy, sz] = obj.scale;
  const [px, py, pz] = obj.position;
  return localBoxes(def).map((b) => {
    const ox = b.o[0] * sx;
    const oy = b.o[1] * sy;
    const oz = b.o[2] * sz;
    // Rotate the offset about Y, then translate by the object base position.
    const rx = ox * cos + oz * sin;
    const rz = -ox * sin + oz * cos;
    return {
      cx: px + rx,
      cy: py + oy,
      cz: pz + rz,
      w: b.s[0] * sx,
      h: b.s[1] * sy,
      d: b.s[2] * sz,
      ry
    };
  });
}

export interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Axis-aligned enclosing AABB of an oriented box (exact when ry≈0; enclosing otherwise). */
export function orientedBoxAabb(box: OrientedBox): Aabb {
  const c = Math.abs(Math.cos(box.ry));
  const s = Math.abs(Math.sin(box.ry));
  const hx = (box.w / 2) * c + (box.d / 2) * s;
  const hz = (box.w / 2) * s + (box.d / 2) * c;
  return {
    minX: box.cx - hx,
    maxX: box.cx + hx,
    minY: box.cy - box.h / 2,
    maxY: box.cy + box.h / 2,
    minZ: box.cz - hz,
    maxZ: box.cz + hz
  };
}

export function rampPrismAabb(ramp: RampPrism): Aabb {
  const c = Math.abs(Math.cos(ramp.ry));
  const s = Math.abs(Math.sin(ramp.ry));
  const hx = (ramp.w / 2) * c + (ramp.d / 2) * s;
  const hz = (ramp.w / 2) * s + (ramp.d / 2) * c;
  return {
    minX: ramp.cx - hx,
    maxX: ramp.cx + hx,
    minY: ramp.baseY,
    maxY: ramp.baseY + ramp.h,
    minZ: ramp.cz - hz,
    maxZ: ramp.cz + hz
  };
}

// Rotated collision is resolved EXACTLY as oriented boxes by the offline MovementController (see
// buildCreatorCollisionBoxes → orientedAabb), so no AABB slicing/approximation is needed here.

// ---------------------------------------------------------------------------------------------
// Editable dimensions helper (UI shows width/height/depth derived from base size × scale)
// ---------------------------------------------------------------------------------------------

export function objectDimensions(obj: CreatorLayoutObject): Vec3Tuple {
  const def = MODULE_BY_TYPE.get(obj.type);
  const base = def ? def.baseSize : [1, 1, 1];
  return [base[0] * obj.scale[0], base[1] * obj.scale[1], base[2] * obj.scale[2]];
}

export function scaleForDimensions(type: string, dims: Vec3Tuple): Vec3Tuple {
  const def = MODULE_BY_TYPE.get(type);
  const base = def ? def.baseSize : [1, 1, 1];
  return [
    clampScale(dims[0] / Math.max(1e-4, base[0])),
    clampScale(dims[1] / Math.max(1e-4, base[1])),
    clampScale(dims[2] / Math.max(1e-4, base[2]))
  ];
}

// ---------------------------------------------------------------------------------------------
// Validation + clamping (never trust imported / stored data)
// ---------------------------------------------------------------------------------------------

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, n));
}

function clampScale(v: number): number {
  return clampNumber(v, CREATOR_LIMITS.minScale, CREATOR_LIMITS.maxScale, 1);
}

function clampTuple(v: unknown, min: number, max: number, fallback: Vec3Tuple): Vec3Tuple {
  const a = Array.isArray(v) ? v : [];
  return [
    clampNumber(a[0], min, max, fallback[0]),
    clampNumber(a[1], min, max, fallback[1]),
    clampNumber(a[2], min, max, fallback[2])
  ];
}

function sanitizeText(v: unknown, maxLen: number): string {
  if (typeof v !== 'string') return '';
  // Strip control characters; cap length. No HTML is ever interpreted (we set textContent only).
  return Array.from(v).filter((c) => c >= ' ' || c === String.fromCharCode(9)).join('').slice(0, maxLen);
}

function clampPositionToYard(pos: Vec3Tuple): Vec3Tuple {
  const r = CREATOR_LIMITS.maxRadiusFromCenter;
  return [
    clampNumber(pos[0], SANDBOX_CENTER.x - r, SANDBOX_CENTER.x + r, SANDBOX_CENTER.x),
    clampNumber(pos[1], CREATOR_LIMITS.minY, CREATOR_LIMITS.maxY, 0),
    clampNumber(pos[2], SANDBOX_CENTER.z - r, SANDBOX_CENTER.z + r, SANDBOX_CENTER.z)
  ];
}

let idCounter = 0;

/** Stable-ish unique id for a new object. */
export function createObjectId(type: string): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 7);
  return `obj_${type}_${Date.now().toString(36)}_${idCounter}_${rand}`;
}

/** Clamp + sanitise one object in place-safe fashion, returning a fresh clamped copy, or null if unusable. */
export function sanitizeObject(raw: unknown): CreatorLayoutObject | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : '';
  if (!isKnownModuleType(type)) return null; // ignore unknown module types safely
  const def = MODULE_BY_TYPE.get(type)!;

  // Pre-clamp must cover the full allowed build range (maxRadiusFromCenter around the yard centre),
  // otherwise an export → import round trip of a far-out build would silently squash its coordinates.
  const posLimit = CREATOR_LIMITS.maxRadiusFromCenter + Math.max(Math.abs(SANDBOX_CENTER.x), Math.abs(SANDBOX_CENTER.z));
  const obj: CreatorLayoutObject = {
    id: typeof o.id === 'string' && o.id.length > 0 ? o.id.slice(0, 80) : createObjectId(type),
    type,
    position: clampPositionToYard(clampTuple(o.position, -posLimit, posLimit, [SANDBOX_CENTER.x, 0, SANDBOX_CENTER.z])),
    rotation: clampTuple(o.rotation, -360, 360, [0, def.defaultRotationY ?? 0, 0]),
    scale: [
      clampScale(asNumber(asArray(o.scale)[0], 1)),
      clampScale(asNumber(asArray(o.scale)[1], 1)),
      clampScale(asNumber(asArray(o.scale)[2], 1))
    ],
    material: CREATOR_MATERIAL_IDS.includes(String(o.material)) ? String(o.material) : def.material,
    collision: typeof o.collision === 'boolean' ? o.collision : def.collision,
    opacity: objectOpacity(o),
    wallrunEnabled: typeof o.wallrunEnabled === 'boolean' ? o.wallrunEnabled : true
  };
  if (typeof o.name === 'string') obj.name = sanitizeText(o.name, CREATOR_LIMITS.maxNameLength);
  if (typeof o.color === 'string') obj.color = sanitizeText(o.color, 16);
  if (typeof o.texture === 'string' && CREATOR_TEXTURE_IDS.includes(o.texture)) obj.texture = o.texture;

  const meta = sanitizeMetadata(o.metadata, def);
  if (meta) obj.metadata = meta;
  return obj;
}

function sanitizeMetadata(raw: unknown, def: CreatorModuleDef): CreatorObjectMetadata | undefined {
  const base = def.defaultMetadata ? { ...def.defaultMetadata } : undefined;
  if (!raw || typeof raw !== 'object') return base;
  const m = raw as Record<string, unknown>;
  const out: CreatorObjectMetadata = base ? { ...base } : {};
  if (typeof m.yawDeg === 'number' && Number.isFinite(m.yawDeg)) out.yawDeg = clampNumber(m.yawDeg, -360, 360, 0);
  if (typeof m.defaultSpawn === 'boolean') out.defaultSpawn = m.defaultSpawn;
  if (typeof m.checkpointOrder === 'number') out.checkpointOrder = clampNumber(m.checkpointOrder, 0, 999, 1);
  if (typeof m.oneWayYawDeg === 'number') out.oneWayYawDeg = clampNumber(m.oneWayYawDeg, -360, 360, 0);
  if (typeof m.label === 'string') out.label = sanitizeText(m.label, CREATOR_LIMITS.maxLabelLength);
  if (typeof m.labelVisible === 'boolean') out.labelVisible = m.labelVisible;
  if ((CREATOR_LABEL_SIZES as readonly string[]).includes(String(m.labelSize))) out.labelSize = m.labelSize as CreatorLabelSize;
  if ((CREATOR_LABEL_COLORS as readonly string[]).includes(String(m.labelColor))) out.labelColor = m.labelColor as CreatorLabelColor;
  if (typeof m.labelOffsetY === 'number' && Number.isFinite(m.labelOffsetY)) {
    out.labelOffsetY = clampNumber(m.labelOffsetY, CREATOR_LIMITS.minLabelOffsetY, CREATOR_LIMITS.maxLabelOffsetY, 0);
  }
  if (typeof m.enabled === 'boolean') out.enabled = m.enabled;
  if (typeof m.padStrength === 'number' && Number.isFinite(m.padStrength)) {
    out.padStrength = clampNumber(m.padStrength, CREATOR_LIMITS.minPadStrength, CREATOR_LIMITS.maxPadStrength, 1);
  }
  if (m.triggerType === 'start' || m.triggerType === 'checkpoint' || m.triggerType === 'finish' || m.triggerType === 'none') {
    out.triggerType = m.triggerType;
  }
  if (m.trigger && typeof m.trigger === 'object') {
    const t = m.trigger as Record<string, unknown>;
    out.trigger = {
      width: clampNumber(t.width, CREATOR_LIMITS.minDimension, CREATOR_LIMITS.maxTriggerDimension, 4),
      height: clampNumber(t.height, CREATOR_LIMITS.minDimension, CREATOR_LIMITS.maxTriggerDimension, 4),
      depth: clampNumber(t.depth, CREATOR_LIMITS.minDimension, CREATOR_LIMITS.maxTriggerDimension, 4)
    };
  }
  if (m.mover && typeof m.mover === 'object') {
    const mv = m.mover as Record<string, unknown>;
    out.mover = {
      dx: clampNumber(mv.dx, -2000, 2000, 0),
      dy: clampNumber(mv.dy, -2000, 2000, 0),
      dz: clampNumber(mv.dz, -2000, 2000, 0),
      speed: clampNumber(mv.speed, 0.1, 100, 4),
      pauseSeconds: clampNumber(mv.pauseSeconds, 0, 30, 0.5)
    };
  }
  return out;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Validate + clamp an arbitrary value into a safe CreatorLayout. Always returns a usable layout
 * (falling back to the default) so malformed imports/storage never crash the game. Returns the list
 * of human-readable problems found, for surfacing a non-sensitive error to the user.
 */
export function validateLayout(raw: unknown): { layout: CreatorLayout; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') {
    problems.push('Layout is not an object.');
    return { layout: defaultCreatorLayout(), problems };
  }
  const r = raw as Record<string, unknown>;
  const objectsIn = asArray(r.objects);
  const objects: CreatorLayoutObject[] = [];
  for (const item of objectsIn) {
    if (objects.length >= CREATOR_LIMITS.maxObjects) {
      problems.push(`Object count exceeds ${CREATOR_LIMITS.maxObjects}; extra objects dropped.`);
      break;
    }
    const obj = sanitizeObject(item);
    if (obj) objects.push(obj);
    else problems.push('Dropped one invalid/unknown object.');
  }

  const groundRaw = (r.ground && typeof r.ground === 'object' ? r.ground : {}) as Record<string, unknown>;
  const boundsRaw = (groundRaw.bounds && typeof groundRaw.bounds === 'object' ? groundRaw.bounds : {}) as Record<string, unknown>;
  const layout: CreatorLayout = {
    version: CREATOR_SCHEMA_VERSION,
    name: sanitizeText(r.name, CREATOR_LIMITS.maxNameLength) || 'Untitled Course',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt.slice(0, 40) : new Date().toISOString(),
    ground: {
      bounds: {
        width: clampNumber(boundsRaw.width, 20, 4000, SANDBOX_HALF_X * 2),
        depth: clampNumber(boundsRaw.depth, 20, 4000, SANDBOX_HALF_Z * 2),
        y: clampNumber(boundsRaw.y, -50, 50, 0)
      },
      material: CREATOR_MATERIAL_IDS.includes(String(groundRaw.material)) ? String(groundRaw.material) : 'ground'
    },
    objects
  };

  // Optional prefab library (carried by Export File / Import). Sanitized like any other input;
  // absent/invalid ⇒ simply no prefabs on this layout.
  const prefabs = sanitizePrefabs(r.prefabs);
  if (prefabs.length > 0) layout.prefabs = prefabs;

  enforceSingleDefaultSpawn(layout);
  return { layout, problems };
}

/** Keep at most one active default spawn (the first one wins). */
export function enforceSingleDefaultSpawn(layout: CreatorLayout): void {
  let seen = false;
  for (const obj of layout.objects) {
    if (obj.type !== 'spawn_point') continue;
    if (!obj.metadata) obj.metadata = {};
    if (obj.metadata.defaultSpawn) {
      if (seen) obj.metadata.defaultSpawn = false;
      else seen = true;
    }
  }
  if (!seen) {
    const first = layout.objects.find((o) => o.type === 'spawn_point');
    if (first) {
      if (!first.metadata) first.metadata = {};
      first.metadata.defaultSpawn = true;
    }
  }
}

/** Make one spawn point the active default and clear the flag from every other spawn. */
export function setExclusiveDefaultSpawn(layout: CreatorLayout, spawnId: string): void {
  let matched = false;
  for (const obj of layout.objects) {
    if (obj.type !== 'spawn_point') continue;
    if (!obj.metadata) obj.metadata = {};
    const isTarget = obj.id === spawnId;
    obj.metadata.defaultSpawn = isTarget;
    if (isTarget) matched = true;
  }
  if (!matched) enforceSingleDefaultSpawn(layout);
}

/** Deep clone (structuredClone where available, JSON fallback) — used for history snapshots. */
export function cloneLayout(layout: CreatorLayout): CreatorLayout {
  if (typeof structuredClone === 'function') return structuredClone(layout);
  return JSON.parse(JSON.stringify(layout)) as CreatorLayout;
}

export function isLayoutValid(layout: CreatorLayout): { valid: boolean; reason?: string } {
  const hasSpawn = layout.objects.some((o) => o.type === 'spawn_point');
  if (!hasSpawn) return { valid: false, reason: 'Layout needs at least one Spawn Point.' };
  return { valid: true };
}

// ---------------------------------------------------------------------------------------------
// Default layout — the current outdoor Movement Sandbox, converted to the editor schema
// ---------------------------------------------------------------------------------------------

/**
 * Build the default editor layout from the live sandbox descriptors so the editor opens on exactly
 * the current sandbox. Reads the sandbox layout (never mutates it).
 */
export function defaultCreatorLayout(): CreatorLayout {
  const objects: CreatorLayoutObject[] = [];

  // Standalone walls → wallrun/long walls (each becomes a single box object sized to match).
  for (const wall of SANDBOX_WALLS) {
    objects.push({
      id: createObjectId('wallrun_wall'),
      type: 'wallrun_wall',
      name: wall.id,
      position: [SANDBOX_CENTER.x + wall.center.x, 0, SANDBOX_CENTER.z + wall.center.z],
      rotation: [0, (wall.rotationY * 180) / Math.PI, 0],
      scale: scaleForDimensions('wallrun_wall', [wall.size.width, wall.size.height, wall.size.depth]),
      material: wallStyleToMaterial[wall.style],
      collision: true,
      opacity: 1
    });
  }

  // Four boundary walls (visual reference; the bounds clamp is the real barrier in playtest).
  const bx = SANDBOX_HALF_X;
  const bz = SANDBOX_HALF_Z;
  const boundary: Array<{ name: string; pos: Vec3Tuple; dims: Vec3Tuple; ry: number }> = [
    { name: 'bound_w', pos: [SANDBOX_CENTER.x - bx, 0, SANDBOX_CENTER.z], dims: [3, BOUNDARY_HEIGHT, bz * 2], ry: 0 },
    { name: 'bound_e', pos: [SANDBOX_CENTER.x + bx, 0, SANDBOX_CENTER.z], dims: [3, BOUNDARY_HEIGHT, bz * 2], ry: 0 },
    { name: 'bound_s', pos: [SANDBOX_CENTER.x, 0, SANDBOX_CENTER.z - bz], dims: [bx * 2, BOUNDARY_HEIGHT, 3], ry: 0 },
    { name: 'bound_n', pos: [SANDBOX_CENTER.x, 0, SANDBOX_CENTER.z + bz], dims: [bx * 2, BOUNDARY_HEIGHT, 3], ry: 0 }
  ];
  for (const b of boundary) {
    objects.push({
      id: createObjectId('boundary_wall'),
      type: 'boundary_wall',
      name: b.name,
      position: b.pos,
      rotation: [0, b.ry, 0],
      scale: scaleForDimensions('boundary_wall', b.dims),
      material: 'boundary',
      collision: true,
      opacity: 1
    });
  }

  // Spawn point (default) + leave portal beside it, matching the sandbox spawn.
  objects.push({
    id: createObjectId('spawn_point'),
    type: 'spawn_point',
    name: 'spawn',
    position: [SANDBOX_CENTER.x + SANDBOX_SPAWN_LOCAL.x, 0, SANDBOX_CENTER.z + SANDBOX_SPAWN_LOCAL.z],
    rotation: [0, (SANDBOX_SPAWN_LOCAL.yaw * 180) / Math.PI, 0],
    scale: [1, 1, 1],
    material: 'marker_green',
    collision: false,
    opacity: 1,
    metadata: { defaultSpawn: true }
  });
  objects.push({
    id: createObjectId('leave_portal'),
    type: 'leave_portal',
    name: 'leave',
    position: [SANDBOX_CENTER.x + SANDBOX_LEAVE_LOCAL.x, 0, SANDBOX_CENTER.z + SANDBOX_LEAVE_LOCAL.z],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: 'marker_blue',
    collision: false,
    opacity: 1,
    metadata: { yawDeg: 0, label: 'LEAVE' }
  });

  for (const obj of objects) obj.wallrunEnabled = true;

  return {
    version: CREATOR_SCHEMA_VERSION,
    name: 'Movement Sandbox (default)',
    updatedAt: new Date().toISOString(),
    ground: {
      bounds: { width: SANDBOX_HALF_X * 2, depth: SANDBOX_HALF_Z * 2, y: 0 },
      material: 'ground'
    },
    objects
  };
}

/**
 * The committed course layout: the single source of truth both the editor (its default + Reset) and
 * the live Movement Sandbox build from. Validated on load; when it has no objects yet (the initial
 * placeholder) we fall back to the built-in default sandbox, so the world is never empty. To "ship" a
 * layout you designed in the editor, its JSON is written into layouts/movementCourseLayout.json.
 */
export function committedCourseLayout(): CreatorLayout {
  const { layout } = validateLayout(committedCourseJson);
  if (layout.objects.length === 0) return defaultCreatorLayout();
  return layout;
}

/** World spawn (position + yaw radians) for playtest, from the active default spawn (or yard centre). */
export function layoutSpawn(layout: CreatorLayout): { x: number; y: number; z: number; yaw: number } {
  // A Test Spawn overrides the main spawn. Several can exist; the most-recently-placed one (last in
  // layout order) wins, so you always start a playtest from the newest one you dropped.
  let testSpawn: CreatorLayoutObject | undefined;
  for (const o of layout.objects) if (o.type === 'test_spawn') testSpawn = o;
  const spawn = testSpawn
    ?? layout.objects.find((o) => o.type === 'spawn_point' && o.metadata?.defaultSpawn)
    ?? layout.objects.find((o) => o.type === 'spawn_point');
  // Never spawn below the layout's floor (which may itself be below 0 — ground.y goes to -50).
  const floorY = layout.ground.bounds.y ?? 0;
  if (spawn) {
    return {
      x: spawn.position[0],
      y: Math.max(floorY, spawn.position[1]),
      z: spawn.position[2],
      yaw: (spawn.rotation[1] ?? 0) * DEG2RAD
    };
  }
  return { x: SANDBOX_CENTER.x, y: Math.max(floorY, 0), z: SANDBOX_CENTER.z, yaw: 0 };
}

/** World-space positions of a layout's functional spawner markers (balls / bots / target dummies).
 *  Pure + Babylon-free — shared by the Creator editor's Playtest AND the live Movement Sandbox so a
 *  published course spawns exactly the same actors as a playtest run. */
export interface CreatorSpawnerMarkers {
  balls: Array<{ x: number; y: number; z: number }>;
  bots: Array<{ x: number; y: number; z: number; charge: boolean }>;
  dummies: Array<{ x: number; y: number; z: number }>;
}

export function collectSpawnerMarkers(layout: CreatorLayout): CreatorSpawnerMarkers {
  const markers: CreatorSpawnerMarkers = { balls: [], bots: [], dummies: [] };
  for (const o of layout.objects) {
    const [x, y, z] = o.position;
    if (o.type === 'ball_spawn') markers.balls.push({ x, y, z });
    else if (o.type === 'bot_spawn') markers.bots.push({ x, y, z, charge: /charge/i.test(o.metadata?.label ?? '') });
    else if (o.type === 'target_dummy') markers.dummies.push({ x, y, z });
  }
  return markers;
}

// --- Multi-select group math + prefabs (pure; unit-tested) ---------------------------------------

/** Max prefabs kept in the library (oldest dropped beyond this — mirrors the named-slot bound). */
export const MAX_PREFABS = 16;

/** XZ centroid + lowest Y of a set of objects — the shared pivot for group rotate and the prefab origin. */
export function objectsGroupOrigin(objects: readonly CreatorLayoutObject[]): { x: number; y: number; z: number } {
  if (objects.length === 0) return { x: 0, y: 0, z: 0 };
  let sx = 0;
  let sz = 0;
  let minY = Infinity;
  for (const o of objects) {
    sx += o.position[0];
    sz += o.position[2];
    minY = Math.min(minY, o.position[1]);
  }
  return { x: sx / objects.length, y: minY, z: sz / objects.length };
}

/**
 * Rotate objects IN PLACE around a shared (cx,cz) pivot by deltaDeg of yaw: each object's position
 * orbits the pivot and its own yaw advances by the same delta — the group turns as one rigid unit.
 * Yaw only, matching the single-object rotation rules (X/Z tilt is never authored).
 */
export function rotateObjectsAroundCenterYaw(objects: CreatorLayoutObject[], cx: number, cz: number, deltaDeg: number): void {
  const rad = -deltaDeg * DEG2RAD; // world yaw is clockwise-positive around +Y (matches node.rotation.y)
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (const o of objects) {
    const dx = o.position[0] - cx;
    const dz = o.position[2] - cz;
    o.position = [cx + dx * cos - dz * sin, o.position[1], cz + dx * sin + dz * cos];
    o.rotation = [o.rotation[0], normalizeLayoutDegrees((o.rotation[1] ?? 0) + deltaDeg), o.rotation[2]];
  }
}

function normalizeLayoutDegrees(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Capture objects as a prefab: deep-cloned, positions made RELATIVE to the group origin
 *  (centroid XZ, lowest Y — so stamping at a ground point sits the assembly ON the ground). */
export function makePrefabFromObjects(name: string, objects: readonly CreatorLayoutObject[]): CreatorPrefab {
  const origin = objectsGroupOrigin(objects);
  const cloned = objects.map((o) => {
    const copy = JSON.parse(JSON.stringify(o)) as CreatorLayoutObject;
    copy.position = [o.position[0] - origin.x, o.position[1] - origin.y, o.position[2] - origin.z];
    return copy;
  });
  return { name: name.trim().slice(0, 48) || 'Prefab', objects: cloned };
}

/** Instantiate a prefab at a world point: fresh ids, absolute positions (origin + relative offset). */
export function instantiatePrefab(prefab: CreatorPrefab, at: { x: number; y: number; z: number }): CreatorLayoutObject[] {
  return prefab.objects.map((o) => {
    const copy = JSON.parse(JSON.stringify(o)) as CreatorLayoutObject;
    copy.id = createObjectId(o.type);
    copy.position = [at.x + o.position[0], at.y + o.position[1], at.z + o.position[2]];
    return copy;
  });
}

/** World-space AABB of a prefab stamped at `at` — drives the placement ghost box. */
export function prefabWorldBounds(prefab: CreatorPrefab, at: { x: number; y: number; z: number }): {
  minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const o of prefab.objects) {
    const world: CreatorLayoutObject = { ...o, position: [at.x + o.position[0], at.y + o.position[1], at.z + o.position[2]] };
    const a = objectWorldAabb(world);
    minX = Math.min(minX, a.minX); minY = Math.min(minY, a.minY); minZ = Math.min(minZ, a.minZ);
    maxX = Math.max(maxX, a.maxX); maxY = Math.max(maxY, a.maxY); maxZ = Math.max(maxZ, a.maxZ);
  }
  if (!Number.isFinite(minX)) return { minX: at.x, minY: at.y, minZ: at.z, maxX: at.x, maxY: at.y, maxZ: at.z };
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** Sanitize an untrusted prefab list (import / storage): names trimmed, objects re-validated through
 *  the standard object sanitizer, bounded to MAX_PREFABS, empty prefabs dropped. */
export function sanitizePrefabs(raw: unknown): CreatorPrefab[] {
  if (!Array.isArray(raw)) return [];
  const out: CreatorPrefab[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PREFABS) break;
    if (!item || typeof item !== 'object') continue;
    const p = item as { name?: unknown; objects?: unknown };
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, 48) : '';
    if (!name || !Array.isArray(p.objects)) continue;
    // Reuse the layout validator for the object list (types, sizes, metadata all sanitized). Prefab
    // positions are relative offsets — small by construction — so the world clamps are harmless.
    const objects = validateLayout({ objects: p.objects }).layout.objects;
    if (objects.length > 0) out.push({ name, objects });
  }
  return out;
}
