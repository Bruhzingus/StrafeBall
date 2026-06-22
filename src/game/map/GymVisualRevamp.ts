import {
  Color3,
  DynamicTexture,
  HDRCubeTexture,
  ImageProcessingConfiguration,
  Material,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  StandardMaterial,
  Texture
} from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { MAT_SPECS, createBleacherTierSpecs } from '../../../shared/simulation/MapGeometry';

type WallSide = 'north' | 'south' | 'east' | 'west';
type BannerShape = 'rectangle' | 'vertical' | 'pennant';
type BannerIcon = 'ball' | 'trophy' | 'stars';
type BannerTemplate = 'rect' | 'verticalTeam' | 'pennant';

interface BannerPalette {
  background: string;
  background2: string;
  border: string;
  accent: string;
  text: string;
  shadow: string;
}

interface BannerSpec {
  name: string;
  side: WallSide;
  offset: number;
  y: number;
  width: number;
  height: number;
  title: string;
  subtitle?: string;
  template: BannerTemplate;
  shape: BannerShape;
  palette: BannerPalette;
  icon?: BannerIcon;
  textureUrl?: string;
  alphaTexture?: boolean;
}

const WALL_DECAL_INSET = 0.048;
const WALL_PAD_DECAL_INSET = 0.085;
const DECOR_META = { decorative: true, noGameplay: true };
const WALL_PAD_HEIGHT = 2.46;
const GYM_TEXTURES = {
  // Floor + walls use downloaded PBR map sets (color + normal). The blue vinyl pad art and cover
  // mats keep their existing tuned stand-ins so the back-wall panels are unchanged. Originals on
  // disk are left untouched. Tunable material values live in GYM_MATERIAL_TUNING below.
  floorColor: '/assets/textures/gym/floor/WoodFloor051_1K-JPG_Color.jpg',
  floorNormal: '/assets/textures/gym/floor/WoodFloor051_1K-JPG_NormalGL.jpg',
  floorAO: '/assets/textures/gym/floor/WoodFloor051_1K-JPG_AmbientOcclusion.jpg',
  // A matching floor roughness map (floor/WoodFloor051_1K-JPG_Roughness.jpg) ships alongside these
  // but is intentionally not wired this pass — the polished floor uses a flat varnish roughness.
  wallColor: '/assets/textures/gym/walls/Bricks064_2K-JPG_Color.jpg',
  wallNormal: '/assets/textures/gym/walls/Bricks064_2K-JPG_NormalGL.jpg',
  wallAO: '/assets/textures/gym/walls/Bricks064_2K-JPG_AmbientOcclusion.jpg',
  wallPad: '/assets/textures/gym/walls/WallMat.png',
  coverMat: '/assets/textures/gym/Obstacles/gym_cover_mat_blue_tuned.png',
  banners: {
    championshipCourt: '/assets/textures/gym/banners/ChampionshipCourt.png',
    homeOfChamps: '/assets/textures/gym/banners/HomeOfChamps.png',
    mvp: '/assets/textures/gym/banners/MVP.png',
    noBoundaries: '/assets/textures/gym/banners/NoBoundaries.png',
    privateDuel: '/assets/textures/gym/banners/PrivateDuel.png',
    sponsor1: '/assets/textures/gym/banners/SponsorBanner1.png',
    sponsor2: '/assets/textures/gym/banners/SponsorBanner2.png',
    strafeBallLeague: '/assets/textures/gym/banners/StrafeBallLeage.png'
  }
} as const;

type Rgb = [number, number, number];

/**
 * Central tunables for every gym surface this client-only visual pass recolors/tunes. Texture paths
 * live in GYM_TEXTURES above; all the floor/wall/ceiling/fixture/navy material knobs live here so
 * there are no scattered magic numbers. Never imported by server or shared code, and never read for
 * collision/gameplay. "Bright School Gym Correction" — no new assets, no new effects.
 */
const GYM_MATERIAL_TUNING = {
  floor: {
    // ~2.6-2.7 m maple plank repeat across the 26x36 m court (10x13 tiles): realistic, not stretched.
    uScale: 10,
    vScale: 13,
    // Bright but lightly-desaturated warm maple — clean maintained court, not orange house flooring.
    albedoTint: [1.55, 1.34, 0.92] as Rgb,
    metallic: 0,
    // Recovery baseline: waxed-maple roughness raised into the 0.40-0.44 band while the environment
    // pipeline is disabled/verified, so the floor reads as a polished court (soft broad sheen) rather
    // than a wet mirror. Drop back toward ~0.36 only once HDR reflections are re-enabled and verified.
    roughness: 0.42,
    // Scales how strongly the environment texture (the cheap generated gradient by default — the HDR
    // cafeteria env is disabled, see GYM_HDR_ENVIRONMENT_ENABLED) shows up as a broad soft overhead
    // sheen on the floor. Kept low so the floor never mirrors players and never washes out to gray.
    environmentIntensity: 0.3,
    // Soft, broad sheen — restrained so the floor never reads wet/mirror-like.
    specularIntensity: 0.45,
    // Soft plank seams on a polished floor — restrained, not embossed.
    normalLevel: 0.6,
    // Floor color (and its normal) filtered at 4x max — soft highlights, cheap filtering.
    colorAnisotropy: 4,
    // Subtle plank-seam depth only — the bright maple floor must not read darker/dirtier overall.
    aoStrength: 0.1
  },
  wall: {
    // World metres covered by one block course repeat. Per-wall uScale/vScale are derived from these
    // so courses run horizontally at the same physical size on the long and short walls alike.
    tileMetersHorizontal: 5.0,
    tileMetersVertical: 3.9,
    // Lighter warm-neutral off-white painted block — clearly above the navy pads, not pure white.
    albedoTint: [2.98, 2.83, 2.58] as Rgb,
    metallic: 0,
    roughness: 0.78,
    // Walls get the faintest reflection response of any reflective surface (spec range 0.02-0.06) —
    // just enough that painted block isn't completely flat once the static capture is attached.
    environmentIntensity: 0.04,
    // Dropped further so the block seams stay subtle, not deep/rough/dominant.
    normalLevel: 0.32,
    // Cinder-block seam depth only — must not darken the painted block toward the navy pads' tone.
    aoStrength: 0.15
  },
  // Ceiling is recolored only (no texture added, layout untouched). Panels become soft warm
  // light-gray/cream to lift room brightness; the grid stays medium charcoal blue-gray for contrast.
  // These are StandardMaterials, so the "high roughness / metallic 0" intent is expressed as a
  // near-matte, very-low specular response.
  ceiling: {
    slab: { diffuse: [0.7, 0.69, 0.64] as Rgb, emissive: [0.075, 0.073, 0.066] as Rgb },
    panel: { diffuse: [0.82, 0.81, 0.75] as Rgb, emissive: [0.11, 0.107, 0.097] as Rgb },
    // Grid stays dark charcoal navy-gray — nudged darker so contrast holds as panels brighten.
    beam: { diffuse: [0.24, 0.26, 0.31] as Rgb, emissive: [0.004, 0.005, 0.007] as Rgb },
    seam: { diffuse: [0.21, 0.23, 0.28] as Rgb },
    matteSpecular: [0.02, 0.02, 0.018] as Rgb,
    mattePower: 10,
    gridSpecular: [0.05, 0.05, 0.05] as Rgb,
    gridPower: 24,
    // Fixture housings: bright but restrained emissive so they read as fluorescent/LED gym lights,
    // not sci-fi glow strips — they complement the hemi/key lights, they don't light the room alone.
    fixture: { diffuse: [0.95, 0.94, 0.88] as Rgb, emissive: [0.66, 0.65, 0.58] as Rgb }
  },
  // Three distinct navy categories. Brightness order: cover mats > back-wall pads > bleachers.
  navy: {
    // Back-wall pads (StandardMaterial vinyl): deep, less-saturated navy satin. Tint pulled down from
    // the brighter [0.42,0.45,0.56] so the royal-blue pad texture reads as DARK NAVY rather than shiny
    // royal-blue plastic (recovery target). Same asset, just a deeper multiplier. Roughness ~0.56-0.60
    // intent realized as a satin (mid-low specular) StandardMaterial response.
    backPad: { tint: [0.28, 0.32, 0.46] as Rgb, emissive: [0.003, 0.009, 0.032] as Rgb, specular: [0.04, 0.06, 0.09] as Rgb, specularPower: 26 },
    // Movable cover mats (PBR): slightly brighter, readable navy — less royal saturation. Reflection
    // target 0.16-0.22 per spec (movable mats get a touch more sheen than bleachers/walls).
    coverMat: { albedoColor: [0.48, 0.53, 0.66] as Rgb, emissive: [0.003, 0.01, 0.035] as Rgb, metallic: 0, roughness: 0.54, environmentIntensity: 0.19 },
    // Bleachers (PBR): darkest, least-saturated navy with a rougher painted metal/plastic response.
    // environmentIntensity explicit (PBR default is 1.0) so the static reflection capture only ever
    // gives a faint response here, never the brightest of the three navy categories.
    bleacher: { albedoColor: [0.24, 0.28, 0.36] as Rgb, metallic: 0.06, roughness: 0.7, environmentIntensity: 0.1 }
  },
  // PBR back-wall pad values, applied only if a wallPad_material PBR exists (the visible raised pads
  // are the clamped single-panel StandardMaterials in createRaisedWallPadPanels).
  bluePadPanel: {
    metallic: 0,
    roughness: 0.58
  }
} as const;

/**
 * PBR surfaces that reflect the hidden HDR environment (scene.environmentTexture, applied in
 * applyGymEnvironment), and the target `environmentIntensity` for each. These materials leave
 * `reflectionTexture` unset, so the PBR shader samples scene.environmentTexture directly — no
 * reflection probe and no per-frame reflection render. The numbers are centralized here alongside
 * every other gym material tunable; ArenaScene re-applies them once after gym build (after every
 * material exists) as the single authoritative wiring point. Intentionally PBR-only:
 * StandardMaterials (back-wall pads, ceiling, bleacher trim) use a different reflection model and
 * are left untouched this pass rather than guessed at.
 */
export const GYM_REFLECTION_TARGETS: readonly { materialName: string; environmentIntensity: number }[] = [
  { materialName: 'floor_material', environmentIntensity: GYM_MATERIAL_TUNING.floor.environmentIntensity },
  { materialName: 'north_wall_brick_mat', environmentIntensity: GYM_MATERIAL_TUNING.wall.environmentIntensity },
  { materialName: 'south_wall_brick_mat', environmentIntensity: GYM_MATERIAL_TUNING.wall.environmentIntensity },
  { materialName: 'east_wall_brick_mat', environmentIntensity: GYM_MATERIAL_TUNING.wall.environmentIntensity },
  { materialName: 'west_wall_brick_mat', environmentIntensity: GYM_MATERIAL_TUNING.wall.environmentIntensity },
  { materialName: 'mat_material', environmentIntensity: GYM_MATERIAL_TUNING.navy.coverMat.environmentIntensity },
  { materialName: 'bleacher_material', environmentIntensity: GYM_MATERIAL_TUNING.navy.bleacher.environmentIntensity }
];

const PALETTES = {
  navy: {
    background: '#13294b',
    background2: '#0a1830',
    border: '#f2c94c',
    accent: '#d97706',
    text: '#fff7dc',
    shadow: '#071225'
  },
  blue: {
    background: '#2e5fa7',
    background2: '#13294b',
    border: '#f2c94c',
    accent: '#fff4bf',
    text: '#f9fbff',
    shadow: '#06133a'
  },
  gold: {
    background: '#d97706',
    background2: '#8d3d16',
    border: '#19325f',
    accent: '#f2c94c',
    text: '#fff8e5',
    shadow: '#371205'
  },
  red: {
    background: '#b91c1c',
    background2: '#5b121c',
    border: '#f2c94c',
    accent: '#fff4bf',
    text: '#fff8e6',
    shadow: '#2f0610'
  },
  white: {
    background: '#eee9dd',
    background2: '#d7d1c5',
    border: '#13294b',
    accent: '#d97706',
    text: '#17315f',
    shadow: '#fff7e5'
  }
} satisfies Record<string, BannerPalette>;

/**
 * Build a single visual-only "padded panel" mesh: a core box with a slightly inset, slightly raised
 * cushion on each broad (±Z) face, merged into ONE mesh sharing ONE material (one draw call). The
 * recessed border + raised-cushion step give an otherwise flat primitive box believable depth and a
 * soft edge that catches the key light — no extra material, no transparent overlay, no subdivision.
 *
 * Geometry is built only from axis-aligned boxes (guaranteed-correct normals/winding) and the cushion
 * protrudes slightly in front of the core face, so there is no coplanar z-fighting. The merged mesh is
 * centred on its own origin exactly like MeshBuilder.CreateBox, so callers position/rotate it the same
 * way they did the original box. Always non-pickable. This NEVER derives or alters collision — gameplay
 * AABBs stay authoritative and are owned entirely by the caller.
 */
export function createBeveledPanelMesh(
  scene: Scene,
  name: string,
  options: { width: number; height: number; depth: number; material: Material; border?: number; raise?: number }
): Mesh {
  const { width, height, depth, material } = options;
  const border = options.border ?? Math.min(width, height) * 0.06;
  const raise = options.raise ?? Math.min(depth * 0.4, 0.015);
  const cushionWidth = Math.max(0.01, width - border * 2);
  const cushionHeight = Math.max(0.01, height - border * 2);

  const parts: Mesh[] = [MeshBuilder.CreateBox(`${name}_core`, { width, height, depth }, scene)];
  for (const sign of [-1, 1] as const) {
    // depth = raise * 2 so the cushion protrudes `raise` past the core face and sinks `raise` inside
    // it (the inner half is hidden), giving a clean raised step with no coplanar faces.
    const cushion = MeshBuilder.CreateBox(`${name}_cushion_${sign}`, { width: cushionWidth, height: cushionHeight, depth: raise * 2 }, scene);
    cushion.position.z = sign * (depth / 2);
    parts.push(cushion);
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false) ?? parts[0];
  merged.name = name;
  merged.material = material;
  merged.isPickable = false;
  return merged;
}

export function applyGymVisualRevamp(scene: Scene): void {
  applyGymEnvironment(scene);
  enhanceExistingMaterials(scene);
  tuneSceneImageProcessing(scene);
  createWallColorBlocking(scene);
  createWallBounceGlow(scene);
  createWallPaddingDetails(scene);
  createRaisedWallPadPanels(scene);
  createScoreboardWallAccents(scene);
  createScoreboardHardware(scene);
  createUpperWallDetails(scene);
  createGymBanners(scene);
  createBannerLightCatches(scene);
  createBleacherAccents(scene);
  createBleacherSeatDetails(scene);
  createBleacherUnderframes(scene);
  createCourtLineShadows(scene);
  createContactDepthDecals(scene);
  createPropContactShadows(scene);
  createCourtAmbientWash(scene);
  createFloorWaxSheen(scene);
  createWideFloorGlints(scene);
  createFloorDetailDecals(scene);
  createFloorLightReflections(scene);
  createFixtureFalloffPools(scene);
  createOverheadLightLenses(scene);
  createOverheadLightFrames(scene);
  createCeilingRimHighlights(scene);
  createCeilingConduits(scene);
}

function enhanceExistingMaterials(scene: Scene): void {
  const floorMaterial = scene.getMaterialByName('floor_material');
  if (floorMaterial instanceof PBRMaterial) {
    const t = GYM_MATERIAL_TUNING.floor;
    // Maple color + normal maps share the same tiling so plank seams line up. Color (and normal)
    // capped at 4x anisotropy per spec; flat varnish roughness keeps it polished, not a mirror.
    const floorColor = createImageTexture(scene, 'gym_floor_maple_color', GYM_TEXTURES.floorColor, t.uScale, t.vScale, false, t.colorAnisotropy);
    const floorNormal = createImageTexture(scene, 'gym_floor_maple_normal', GYM_TEXTURES.floorNormal, t.uScale, t.vScale, false, t.colorAnisotropy);
    const floorAO = createImageTexture(scene, 'gym_floor_maple_ao', GYM_TEXTURES.floorAO, t.uScale, t.vScale, false, t.colorAnisotropy);
    floorNormal.level = t.normalLevel;
    floorMaterial.albedoTexture = floorColor;
    floorMaterial.bumpTexture = floorNormal;
    // Same UV set as albedo/normal (Babylon defaults ambientTexture to UV channel 0), so AO seams
    // line up with the plank seams instead of needing a second baked UV set.
    floorMaterial.ambientTexture = floorAO;
    floorMaterial.ambientTextureStrength = t.aoStrength;
    floorMaterial.albedoColor = new Color3(...t.albedoTint);
    floorMaterial.metallic = t.metallic;
    floorMaterial.roughness = t.roughness;
    floorMaterial.environmentIntensity = t.environmentIntensity;
    floorMaterial.specularIntensity = t.specularIntensity;
  }

  setZoneMaterial(scene, 'zone_player_mat', 'blue');
  setZoneMaterial(scene, 'zone_opp_mat', 'red');

  applyWallStoneTexture(scene);

  // Wall pads (PBR): darker satin vinyl, low gloss (a thick foam-backed pad, not a shiny surface).
  // Single-panel vinyl art, clamped so the stitched border is mapped 1:1 and never tiled. This
  // material is only attached if a wallPad_material PBR is ever created; the visible back-wall
  // panels are the clamped StandardMaterials in createRaisedWallPadPanels.
  const wallPadMaterial = scene.getMaterialByName('wallPad_material');
  if (wallPadMaterial instanceof PBRMaterial) {
    const padTexture = createImageTexture(scene, 'gym_wall_pad_vinyl_png', GYM_TEXTURES.wallPad, 1, 1, true);
    wallPadMaterial.albedoTexture = padTexture;
    wallPadMaterial.albedoColor = new Color3(0.6, 0.66, 0.82);
    wallPadMaterial.emissiveColor = new Color3(0.002, 0.008, 0.03);
    wallPadMaterial.metallic = GYM_MATERIAL_TUNING.bluePadPanel.metallic;
    wallPadMaterial.roughness = GYM_MATERIAL_TUNING.bluePadPanel.roughness;
    wallPadMaterial.environmentIntensity = 0.24;
  }

  // Cover mats/blockers: readable navy vinyl — the brightest of the three navy categories.
  const coverMatMaterial = scene.getMaterialByName('mat_material');
  if (coverMatMaterial instanceof PBRMaterial) {
    const cover = GYM_MATERIAL_TUNING.navy.coverMat;
    const coverTexture = createImageTexture(scene, 'gym_cover_mat_png', GYM_TEXTURES.coverMat, 1, 1);
    coverMatMaterial.albedoTexture = coverTexture;
    coverMatMaterial.albedoColor = new Color3(...cover.albedoColor);
    coverMatMaterial.emissiveColor = new Color3(...cover.emissive);
    coverMatMaterial.metallic = cover.metallic;
    coverMatMaterial.roughness = cover.roughness;
    coverMatMaterial.environmentIntensity = cover.environmentIntensity;
  }

  // Bleachers: darker, less-saturated navy with a rougher painted metal/plastic response.
  const bleacherMaterial = scene.getMaterialByName('bleacher_material');
  if (bleacherMaterial instanceof PBRMaterial) {
    const bleacher = GYM_MATERIAL_TUNING.navy.bleacher;
    bleacherMaterial.albedoColor = new Color3(...bleacher.albedoColor);
    bleacherMaterial.metallic = bleacher.metallic;
    bleacherMaterial.roughness = bleacher.roughness;
    bleacherMaterial.environmentIntensity = bleacher.environmentIntensity;
  }

  const seatMaterial = scene.getMaterialByName('bleacher_seat_mat');
  if (seatMaterial instanceof StandardMaterial) {
    seatMaterial.diffuseColor = new Color3(0.045, 0.15, 0.44);
    seatMaterial.emissiveColor = new Color3(0.003, 0.01, 0.034);
    seatMaterial.specularColor = new Color3(0.16, 0.2, 0.28);
    seatMaterial.specularPower = 52;
  }

  const panelMaterial = scene.getMaterialByName('bleacher_panel_mat');
  if (panelMaterial instanceof StandardMaterial) {
    panelMaterial.diffuseColor = new Color3(0.18, 0.21, 0.27);
    panelMaterial.specularColor = new Color3(0.14, 0.15, 0.17);
  }

  const railMaterial = scene.getMaterialByName('bleacher_rail_mat');
  if (railMaterial instanceof StandardMaterial) {
    railMaterial.diffuseColor = new Color3(0.74, 0.78, 0.83);
    railMaterial.specularColor = new Color3(0.24, 0.26, 0.28);
    railMaterial.specularPower = 48;
  }

  tuneCeilingMaterials(scene);
}

// RECOVERY FLAG (disabled by default). The cafeteria HDR environment (added in the "caf lighting"
// pass) is what washes the maple floor out to a flat gray slab on real GPUs — the floor samples it
// as a broad overhead reflection at environmentIntensity 0.3, and on hardware the prefiltered HDR
// dominates the albedo at grazing angles far more than in software rendering. Until the environment
// pipeline is re-verified, leave this OFF so the floor falls back to the cheap generated gradient
// (the known-good pre-regression behavior) and reads as a clean waxed maple court, not washed gray.
// The HDR code below is left fully intact and cleanly isolated behind this single flag — flip to
// true to re-enable the cafeteria HDR once the environment pass is revisited. No HDR/.env/reflection
// asset is loaded while this is false.
const GYM_HDR_ENVIRONMENT_ENABLED = false;

// Hidden HDR environment used purely as the PBR reflection source for the gym's glossy surfaces
// (mainly the waxed floor). It is NEVER shown as a skybox — the cafeteria panorama is invisible; we
// only sample it for reflection response. The user dropped the file here manually.
const HDR_ENVIRONMENT_URL = '/assets/textures/gym/Lighting/newman_cafeteria_2k.hdr';
const HDR_ENVIRONMENT_NAME = 'gym_hdr_environment';
const FALLBACK_ENVIRONMENT_NAME = 'gym_env_gradient_tex';

/** Debug-only snapshot of which environment is currently driving PBR reflections — never read for gameplay. */
export interface GymEnvironmentDebugInfo {
  kind: 'hdr' | 'gradient' | 'none';
  name: string | null;
  /** Cubemap face size for the HDR; null for the 2D gradient fallback. */
  size: number | null;
  /** False while the HDR is still streaming/prefiltering; true once it (or the fallback) is ready. */
  loaded: boolean;
}

let environmentDebugInfo: GymEnvironmentDebugInfo = { kind: 'none', name: null, size: null, loaded: false };

export function getGymEnvironmentDebugInfo(): GymEnvironmentDebugInfo {
  return environmentDebugInfo;
}

/**
 * Image-based reflection environment for the gym's PBR surfaces. Loads the user-supplied cafeteria
 * HDR exactly once and assigns it as scene.environmentTexture — hidden (no skybox/panorama on
 * screen), used only so the floor (and to a tiny degree the walls / cover mats / bleachers) pick up
 * a broad soft overhead reflection and read as a waxed gym floor rather than flat.
 *
 * Loaded linear (gammaSpace=false) and prefiltered (prefilterOnLoad=true) so PBR specular is correct
 * across roughness. Spherical harmonics are deliberately OFF: the HDR contributes reflection sheen
 * only and adds no diffuse irradiance, so it cannot shift the room's overall brightness — the gym is
 * still lit entirely by the one HemisphericLight + one DirectionalLight. Cheap 128px faces keep the
 * one-time prefilter pass inexpensive and there is no per-frame cost (it never re-renders).
 *
 * Guarded by texture-name lookups so scene rebuilds, reconnects, or room resets can never start a
 * second load or leak a duplicate environment. If the HDR is missing/unreadable we fall back to a
 * tiny generated gradient so the floor still reads glossy rather than flat (no brightness regression).
 */
function applyGymEnvironment(scene: Scene): void {
  if (scene.getTextureByName(HDR_ENVIRONMENT_NAME) || scene.getTextureByName(FALLBACK_ENVIRONMENT_NAME)) return;

  // Recovery default: skip the cafeteria HDR entirely and use the cheap gradient environment so the
  // floor keeps a soft waxed sheen without the washed-out gray HDR reflection. (See flag comment.)
  if (!GYM_HDR_ENVIRONMENT_ENABLED) {
    createGradientEnvironmentFallback(scene);
    return;
  }

  const hdr = new HDRCubeTexture(
    HDR_ENVIRONMENT_URL,
    scene,
    128, // cubemap face size — broad, soft reflections; cheap one-time prefilter, no per-frame cost
    false, // noMipmap
    false, // generateHarmonics — OFF: reflection-only, never alters diffuse/room brightness
    false, // gammaSpace — HDR is linear data for PBR
    true, // prefilterOnLoad — correct PBR specular across the floor's roughness
    () => {
      environmentDebugInfo = { kind: 'hdr', name: HDR_ENVIRONMENT_NAME, size: 128, loaded: true };
    },
    (message) => {
      console.warn(
        `[gym] HDR environment failed to load (${HDR_ENVIRONMENT_URL}): ${message ?? 'unknown error'} — using gradient fallback.`
      );
      if (scene.getTextureByName(HDR_ENVIRONMENT_NAME)) hdr.dispose();
      createGradientEnvironmentFallback(scene);
    }
  );
  hdr.name = HDR_ENVIRONMENT_NAME;
  hdr.gammaSpace = false;
  scene.environmentTexture = hdr;
  environmentDebugInfo = { kind: 'hdr', name: HDR_ENVIRONMENT_NAME, size: 128, loaded: false };
}

/**
 * Cheap stand-in for image-based lighting if the HDR can't load: a tiny generated gradient (dark
 * floor, neutral walls, warm glow up top) set as the scene's environment texture, giving the floor's
 * PBR material a soft reflection so it still reads glossy rather than flat — no cubemap render,
 * reflection probe, or planar pass.
 */
function createGradientEnvironmentFallback(scene: Scene): void {
  if (scene.getTextureByName(FALLBACK_ENVIRONMENT_NAME)) return;

  const texture = new DynamicTexture(FALLBACK_ENVIRONMENT_NAME, { width: 4, height: 64 }, scene, false);
  texture.name = FALLBACK_ENVIRONMENT_NAME;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createLinearGradient(0, 0, 0, 64);
  gradient.addColorStop(0, '#fff6dc');
  gradient.addColorStop(0.28, '#e8edf3');
  gradient.addColorStop(0.58, '#aeb6c0');
  gradient.addColorStop(0.82, '#60666d');
  gradient.addColorStop(1, '#22252a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 64);
  texture.update(false);
  texture.gammaSpace = true;
  // Flat 2D texture, not a cube: SPHERICAL_MODE tells the PBR shader to sample it against the
  // view-reflection vector like a fake sky tint, which is enough for a cheap specular highlight.
  texture.coordinatesMode = Texture.SPHERICAL_MODE;

  scene.environmentTexture = texture;
  environmentDebugInfo = { kind: 'gradient', name: FALLBACK_ENVIRONMENT_NAME, size: null, loaded: true };
}

// World size (metres) covered by one repeat of the wall brick texture. All four walls shared one
// material with a fixed uScale, but they have different lengths AND the walls run along different
// axes (north/south along X, east/west along Z). On a Babylon box the texture U/V axes land on
// different physical dimensions per face, so the long walls showed the brick rotated 90° and at a
// different scale — they read as a completely different texture. We give each wall its own
// material+texture and pick uScale/vScale (with a 90° rotation on the side walls) from that wall's
// real horizontal length so the brick courses run horizontally at the same physical size everywhere.
function applyWallStoneTexture(scene: Scene): void {
  const t = GYM_MATERIAL_TUNING.wall;
  const h = TUNING.map.wallHeight;
  // `length` = the wall's visible horizontal extent; `rotate` = whether the box's visible face maps
  // the texture U along height instead of along the wall length (true for the thin side walls), in
  // which case we rotate the texture 90° and swap which scale feeds U vs V.
  const walls: { name: string; length: number; rotate: boolean }[] = [
    { name: 'north_wall', length: TUNING.map.halfWidth * 2, rotate: false },
    { name: 'south_wall', length: TUNING.map.halfWidth * 2, rotate: false },
    { name: 'east_wall', length: TUNING.map.halfLength * 2, rotate: true },
    { name: 'west_wall', length: TUNING.map.halfLength * 2, rotate: true }
  ];

  const horizontalRepeats = (length: number) => length / t.tileMetersHorizontal;
  const verticalRepeats = h / t.tileMetersVertical;

  for (const wall of walls) {
    const mesh = scene.getMeshByName(wall.name);
    const shared = mesh?.material;
    if (!shared) continue;

    // Clone so each wall can carry its own correctly-scaled texture instance without affecting the
    // others (the meshes start out sharing one `wall_material`).
    const material = shared.clone(`${wall.name}_brick_mat`);
    if (!material) continue;

    // Pick scale so the texture's horizontal axis always covers the wall length and the vertical
    // axis always covers the wall height, regardless of which box-face axis that ends up being.
    const uScale = wall.rotate ? verticalRepeats : horizontalRepeats(wall.length);
    const vScale = wall.rotate ? horizontalRepeats(wall.length) : verticalRepeats;
    const wallColor = createImageTexture(scene, `${wall.name}_block_color`, GYM_TEXTURES.wallColor, uScale, vScale);
    const wallNormal = createImageTexture(scene, `${wall.name}_block_normal`, GYM_TEXTURES.wallNormal, uScale, vScale);
    wallNormal.level = t.normalLevel;
    if (wall.rotate) {
      wallColor.wAng = Math.PI / 2;
      wallNormal.wAng = Math.PI / 2;
    }

    if (material instanceof PBRMaterial) {
      const wallAO = createImageTexture(scene, `${wall.name}_block_ao`, GYM_TEXTURES.wallAO, uScale, vScale);
      if (wall.rotate) wallAO.wAng = Math.PI / 2;
      material.albedoTexture = wallColor;
      material.bumpTexture = wallNormal;
      material.ambientTexture = wallAO;
      material.ambientTextureStrength = t.aoStrength;
      material.albedoColor = new Color3(...t.albedoTint);
      material.metallic = t.metallic;
      material.roughness = t.roughness;
      material.environmentIntensity = t.environmentIntensity;
    } else if (material instanceof StandardMaterial) {
      material.diffuseTexture = wallColor;
      material.bumpTexture = wallNormal;
      material.diffuseColor = new Color3(...t.albedoTint);
      material.specularColor = new Color3(0.06, 0.055, 0.048);
      material.specularPower = 20;
    }

    mesh.material = material;
  }
}

function setZoneMaterial(scene: Scene, name: string, tone: 'blue' | 'red'): void {
  const material = scene.getMaterialByName(name);
  if (!(material instanceof StandardMaterial)) return;

  // These are broad gameplay-read floor halves, but the wood should come from the single base
  // floor mesh so the court does not look like two different surfaces.
  material.diffuseTexture = null;
  material.opacityTexture = null;
  material.diffuseColor = new Color3(0.64, 0.42, 0.2);
  material.emissiveColor = new Color3(0.008, 0.004, 0.001);
  material.specularColor = new Color3(0.42, 0.34, 0.2);
  material.specularPower = 46;
  material.alpha = 0.07;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  void tone;
}

function tuneSceneImageProcessing(scene: Scene): void {
  // Cheap global polish: existing, stable tone mapping + a mild contrast/exposure lift makes flat
  // direct lighting read as more "rendered" without any extra draw calls or render targets. Light
  // setup itself lives in CompetitiveLighting (one hemispheric + one directional); this only touches
  // image processing. Exposure/contrast are deliberately mild — not a crutch for the lighting.
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  scene.imageProcessingConfiguration.exposure = 1.13;
  // Near-neutral contrast lifts mids/shadows so navy + ceiling stop reading crushed and dark.
  scene.imageProcessingConfiguration.contrast = 1.03;
}

function tuneCeilingMaterials(scene: Scene): void {
  const c = GYM_MATERIAL_TUNING.ceiling;

  // Broad ceiling faces → soft warm light-gray / cream, near-matte (high roughness intent on a
  // StandardMaterial). Lifts perceived room brightness without a texture or glow.
  const ceilingMaterial = scene.getMaterialByName('gym_ceiling_mat');
  if (ceilingMaterial instanceof StandardMaterial) {
    ceilingMaterial.diffuseColor = new Color3(...c.slab.diffuse);
    ceilingMaterial.emissiveColor = new Color3(...c.slab.emissive);
    ceilingMaterial.specularColor = new Color3(...c.matteSpecular);
    ceilingMaterial.specularPower = c.mattePower;
  }

  const panelMaterial = scene.getMaterialByName('gym_roof_panel_mat');
  if (panelMaterial instanceof StandardMaterial) {
    panelMaterial.diffuseColor = new Color3(...c.panel.diffuse);
    panelMaterial.emissiveColor = new Color3(...c.panel.emissive);
    panelMaterial.specularColor = new Color3(...c.matteSpecular);
    panelMaterial.specularPower = c.mattePower;
  }

  // Grid / support lines → medium charcoal blue-gray (not pure black, not bright white) so the grid
  // keeps clear contrast against the lifted panels.
  const beamMaterial = scene.getMaterialByName('gym_roof_beam_mat');
  if (beamMaterial instanceof StandardMaterial) {
    beamMaterial.diffuseColor = new Color3(...c.beam.diffuse);
    beamMaterial.emissiveColor = new Color3(...c.beam.emissive);
    beamMaterial.specularColor = new Color3(...c.gridSpecular);
    beamMaterial.specularPower = c.gridPower;
  }

  const seamMaterial = scene.getMaterialByName('gym_roof_seam_mat');
  if (seamMaterial instanceof StandardMaterial) {
    seamMaterial.diffuseColor = new Color3(...c.seam.diffuse);
    seamMaterial.specularColor = new Color3(...c.gridSpecular);
    seamMaterial.specularPower = c.gridPower;
  }

  // Fixture housings: bright but restrained emissive — fluorescent/LED gym lights, not glow strips.
  const fixtureMaterial = scene.getMaterialByName('ceil_fixture_mat');
  if (fixtureMaterial instanceof StandardMaterial) {
    fixtureMaterial.diffuseColor = new Color3(...c.fixture.diffuse);
    fixtureMaterial.emissiveColor = new Color3(...c.fixture.emissive);
  }
}

function createWallColorBlocking(scene: Scene): void {
  const royalBlue = solidMaterial(scene, 'decor_wall_royal_blue_mat', new Color3(0.08, 0.25, 0.68), {
    emissive: new Color3(0.004, 0.012, 0.035)
  });
  const gold = solidMaterial(scene, 'decor_wall_gold_trim_mat', new Color3(1.0, 0.72, 0.18), {
    emissive: new Color3(0.08, 0.04, 0.0),
    specular: new Color3(0.2, 0.16, 0.06)
  });
  const orange = solidMaterial(scene, 'decor_wall_orange_trim_mat', new Color3(0.94, 0.35, 0.12), {
    emissive: new Color3(0.05, 0.012, 0.004)
  });
  const white = solidMaterial(scene, 'decor_wall_white_pinstripe_mat', new Color3(0.97, 0.96, 0.9), {
    emissive: new Color3(0.025, 0.023, 0.018)
  });

  for (const side of wallSides()) {
    const span = wallSpan(side);
    // Keep the color band clearly above the wall pads so it reads like painted trim, not lines
    // tangled through the mats.
    createWallPlane(scene, `decor_wall_blue_band_${side}`, side, span, 0.34, 2.88, 0, royalBlue, WALL_DECAL_INSET);
    createWallPlane(scene, `decor_wall_gold_trim_${side}`, side, span, 0.055, 3.09, 0, gold, WALL_DECAL_INSET + 0.004);
    createWallPlane(scene, `decor_wall_white_pinstripe_${side}`, side, span, 0.03, 2.67, 0, white, WALL_DECAL_INSET + 0.008);
    createWallPlane(scene, `decor_wall_orange_trim_${side}`, side, span, 0.05, 2.58, 0, orange, WALL_DECAL_INSET + 0.012);
  }
}

function createWallBounceGlow(scene: Scene): void {
  const warmBounce = solidMaterial(scene, 'decor_wall_warm_bounce_glow_mat', new Color3(1.0, 0.78, 0.42), {
    alpha: 0.075,
    emissive: new Color3(0.26, 0.16, 0.055),
    specular: new Color3(0.02, 0.015, 0.008)
  });
  const coolCeilingLift = solidMaterial(scene, 'decor_wall_cool_ceiling_lift_mat', new Color3(0.38, 0.52, 0.78), {
    alpha: 0.055,
    emissive: new Color3(0.055, 0.075, 0.12),
    specular: new Color3(0.01, 0.012, 0.016)
  });

  for (const side of wallSides()) {
    const span = wallSpan(side);
    createWallPlane(scene, `decor_wall_floor_bounce_${side}`, side, span, 0.42, 3.38, 0, warmBounce, WALL_DECAL_INSET + 0.02);
    createWallPlane(scene, `decor_wall_ceiling_lift_${side}`, side, span, 0.5, 7.55, 0, coolCeilingLift, WALL_DECAL_INSET + 0.018);
  }
}

function createWallPaddingDetails(scene: Scene): void {
  const seamMaterial = solidMaterial(scene, 'decor_wall_padding_seam_mat', new Color3(0.022, 0.075, 0.22), {
    alpha: 0.62,
    emissive: new Color3(0, 0.005, 0.02)
  });
  const topCapMaterial = solidMaterial(scene, 'decor_wall_padding_top_cap_mat', new Color3(0.045, 0.11, 0.3), {
    emissive: new Color3(0.004, 0.01, 0.032),
    specular: new Color3(0.1, 0.11, 0.13)
  });
  const stitchMaterial = solidMaterial(scene, 'decor_wall_padding_stitch_mat', new Color3(0.22, 0.4, 0.78), {
    alpha: 0.52,
    emissive: new Color3(0.012, 0.032, 0.088)
  });

  for (const side of frontBackWallSides()) {
    const span = wallSpan(side);
    const layout = wallPadLayout(span);
    createWallPlane(scene, `decor_wall_padding_top_${side}`, side, layout.usedWidth, 0.06, WALL_PAD_HEIGHT, 0, topCapMaterial, WALL_PAD_DECAL_INSET - 0.008);

    for (let i = 0; i <= layout.count; i += 1) {
      const offset = layout.start - layout.panelWidth * 0.5 - layout.gap * 0.5 + i * (layout.panelWidth + layout.gap);
      if (i === 0 || i === layout.count) continue;
      createWallPlane(
        scene,
        `decor_wall_padding_seam_${side}_${String(i).padStart(2, '0')}`,
        side,
        0.018,
        WALL_PAD_HEIGHT - 0.08,
        (WALL_PAD_HEIGHT - 0.08) * 0.5,
        offset,
        seamMaterial,
        WALL_PAD_DECAL_INSET - 0.006
      );
    }

    createWallPlane(
      scene,
      `decor_wall_padding_stitch_${side}`,
      side,
      layout.usedWidth - 0.12,
      0.024,
      WALL_PAD_HEIGHT - 0.24,
      0,
      stitchMaterial,
      WALL_PAD_DECAL_INSET - 0.002
    );
  }
}

function createRaisedWallPadPanels(scene: Scene): void {
  // Single-panel vinyl art per pad: clamp U/V so the stitched border + edge lighting map 1:1 to the
  // panel and are never tiled/repeated. Deep, less-saturated navy satin (see GYM_MATERIAL_TUNING.navy).
  const pad = GYM_MATERIAL_TUNING.navy.backPad;
  const cushionA = texturedStandardMaterial(
    scene,
    'decor_wall_pad_cushion_deep_blue_mat',
    GYM_TEXTURES.wallPad,
    { uScale: 1, vScale: 1, clamp: true, diffuse: new Color3(...pad.tint), emissive: new Color3(...pad.emissive), specular: new Color3(...pad.specular), specularPower: pad.specularPower }
  );
  const bevelMat = solidMaterial(scene, 'decor_wall_pad_bevel_highlight_mat', new Color3(0.16, 0.32, 0.78), {
    emissive: new Color3(0.01, 0.026, 0.082),
    specular: new Color3(0.1, 0.13, 0.18)
  });

  for (const side of frontBackWallSides()) {
    const span = wallSpan(side);
    const layout = wallPadLayout(span);
    const panelHeight = WALL_PAD_HEIGHT - 0.02;

    for (let i = 0; i < layout.count; i += 1) {
      const offset = layout.start + i * (layout.panelWidth + layout.gap);
      const mat = cushionA;
      createWallBox(
        scene,
        `decor_wall_pad_raised_panel_${side}_${String(i).padStart(2, '0')}`,
        side,
        layout.panelWidth,
        panelHeight,
        panelHeight / 2,
        offset,
        0.022,
        mat,
        WALL_PAD_DECAL_INSET + 0.004
      );

      createWallBox(
        scene,
        `decor_wall_pad_panel_top_bevel_${side}_${String(i).padStart(2, '0')}`,
        side,
        layout.panelWidth - 0.06,
        0.016,
        panelHeight + 0.03,
        offset,
        0.016,
        bevelMat,
        WALL_PAD_DECAL_INSET + 0.01
      );
    }
  }
}

function wallPadLayout(span: number): { count: number; gap: number; panelWidth: number; start: number; usedWidth: number } {
  const sideInset = 0.24;
  const gap = 0.006;
  const targetPanelWidth = 1.64;
  const usableWidth = span - sideInset * 2;
  const count = Math.max(1, Math.floor((usableWidth + gap) / (targetPanelWidth + gap)));
  const panelWidth = (usableWidth - gap * (count - 1)) / count;
  const usedWidth = panelWidth * count + gap * (count - 1);
  const start = -usedWidth / 2 + panelWidth / 2;
  return { count, gap, panelWidth, start, usedWidth };
}

function createScoreboardWallAccents(scene: Scene): void {
  const backing = solidMaterial(scene, 'decor_scoreboard_surround_mat', new Color3(0.045, 0.075, 0.14), {
    emissive: new Color3(0.006, 0.012, 0.028),
    specular: new Color3(0.08, 0.08, 0.09)
  });
  const gold = solidMaterial(scene, 'decor_scoreboard_surround_gold_mat', new Color3(1, 0.75, 0.14), {
    emissive: new Color3(0.08, 0.04, 0.0)
  });
  const orange = solidMaterial(scene, 'decor_scoreboard_surround_orange_mat', new Color3(0.94, 0.32, 0.12), {
    emissive: new Color3(0.05, 0.012, 0.002)
  });

  for (const side of ['north', 'south'] as WallSide[]) {
    createWallPlane(scene, `decor_scoreboard_back_panel_${side}`, side, 7.35, 2.82, 5.1, 0, backing);
    createWallPlane(scene, `decor_scoreboard_top_trim_${side}`, side, 7.58, 0.085, 6.57, 0, gold);
    createWallPlane(scene, `decor_scoreboard_bottom_trim_${side}`, side, 7.58, 0.075, 3.63, 0, orange);
    createWallPlane(scene, `decor_scoreboard_left_trim_${side}`, side, 0.08, 2.86, 5.1, -3.82, gold);
    createWallPlane(scene, `decor_scoreboard_right_trim_${side}`, side, 0.08, 2.86, 5.1, 3.82, gold);
  }
}

function createScoreboardHardware(scene: Scene): void {
  const bracketMat = solidMaterial(scene, 'decor_scoreboard_bracket_mat', new Color3(0.08, 0.095, 0.12), {
    emissive: new Color3(0.002, 0.003, 0.006),
    specular: new Color3(0.18, 0.17, 0.15)
  });
  const boltMat = solidMaterial(scene, 'decor_scoreboard_bolt_mat', new Color3(0.9, 0.72, 0.24), {
    emissive: new Color3(0.045, 0.028, 0),
    specular: new Color3(0.22, 0.18, 0.08)
  });
  for (const side of ['north', 'south'] as WallSide[]) {
    const plaqueMat = createPlaqueMaterial(scene, `decor_scoreboard_plaque_${side}_tex`, side, 'SCHOOL GYM', 'DODGEBALL NIGHT');
    for (const x of [-2.85, 2.85]) {
      createWallBox(scene, `decor_scoreboard_hanger_${side}_${x}`, side, 0.1, 0.76, 6.93, x, 0.05, bracketMat, WALL_DECAL_INSET + 0.026);
      createWallBolt(scene, `decor_scoreboard_top_bolt_${side}_${x}`, side, x, 7.28, 0.085, boltMat);
      createWallBolt(scene, `decor_scoreboard_bottom_bolt_${side}_${x}`, side, x, 6.62, 0.072, boltMat);
    }

    for (const [x, y] of [[-3.62, 6.4], [3.62, 6.4], [-3.62, 3.82], [3.62, 3.82]] as const) {
      createWallBolt(scene, `decor_scoreboard_corner_bolt_${side}_${x}_${y}`, side, x, y, 0.07, boltMat);
    }

    createWallPlane(scene, `decor_scoreboard_school_plaque_${side}`, side, 2.1, 0.42, 3.17, 0, plaqueMat, WALL_DECAL_INSET + 0.014);
  }
}

function createUpperWallDetails(scene: Scene): void {
  const ventMat = createVentMaterial(scene);
  const clockMat = createClockMaterial(scene);

  for (const side of ['north', 'south'] as WallSide[]) {
    createWallPlane(scene, `decor_wall_clock_${side}`, side, 0.68, 0.68, 6.94, side === 'north' ? -4.42 : 4.42, clockMat, WALL_DECAL_INSET + 0.012);
    createWallPlane(scene, `decor_wall_vent_${side}`, side, 1.15, 0.38, 6.92, side === 'north' ? 4.5 : -4.5, ventMat, WALL_DECAL_INSET + 0.012);
    createGymSign(scene, {
      name: `decor_exit_sign_${side}`,
      side,
      offset: side === 'north' ? -11.95 : 11.95,
      y: 2.55,
      width: 0.88,
      height: 0.34,
      title: 'EXIT',
      palette: PALETTES.navy
    });
  }

}

function createGymBanners(scene: Scene): void {
  createRectBanner(scene, {
    name: 'decor_banner_strafeball_north',
    side: 'north',
    offset: 0,
    y: 7.08,
    width: 5.55,
    height: 1.85,
    title: 'STRAFEBALL',
    subtitle: 'DODGEBALL LEAGUE',
    palette: PALETTES.navy,
    icon: 'ball',
    textureUrl: GYM_TEXTURES.banners.strafeBallLeague,
    alphaTexture: true
  });
  createRectBanner(scene, {
    name: 'decor_banner_home_champs_north',
    side: 'north',
    offset: -7.1,
    y: 5.78,
    width: 3.45,
    height: 1.15,
    title: 'HOME OF THE',
    subtitle: 'CHAMPS',
    palette: PALETTES.navy,
    icon: 'trophy',
    textureUrl: GYM_TEXTURES.banners.homeOfChamps,
    alphaTexture: true
  });
  createRectBanner(scene, {
    name: 'decor_banner_championship_north',
    side: 'north',
    offset: 7.1,
    y: 5.78,
    width: 3.45,
    height: 1.15,
    title: 'CHAMPIONSHIP',
    subtitle: 'COURT',
    palette: PALETTES.blue,
    icon: 'trophy',
    textureUrl: GYM_TEXTURES.banners.championshipCourt,
    alphaTexture: true
  });

  createRectBanner(scene, {
    name: 'decor_banner_private_duel_south',
    side: 'south',
    offset: 0,
    y: 7.25,
    width: 4.95,
    height: 1.65,
    title: 'STRAFEBALL',
    subtitle: 'DODGEBALL LEAGUE',
    palette: PALETTES.navy,
    icon: 'ball',
    textureUrl: GYM_TEXTURES.banners.strafeBallLeague,
    alphaTexture: true
  });
  createRectBanner(scene, {
    name: 'decor_banner_sponsor_one_south',
    side: 'south',
    offset: -7.05,
    y: 5.82,
    width: 2.72,
    height: 1.53,
    title: 'SPONSORED BY',
    subtitle: 'TOMADUSTIN',
    palette: PALETTES.white,
    icon: 'ball',
    textureUrl: GYM_TEXTURES.banners.sponsor1,
    alphaTexture: true
  });
  createRectBanner(scene, {
    name: 'decor_banner_sponsor_two_south',
    side: 'south',
    offset: 7.05,
    y: 5.82,
    width: 2.72,
    height: 1.53,
    title: 'SPONSORED BY',
    subtitle: 'JACYVAL',
    palette: PALETTES.white,
    icon: 'ball',
    textureUrl: GYM_TEXTURES.banners.sponsor2,
    alphaTexture: true
  });
}

function createBannerLightCatches(scene: Scene): void {
  const catchMat = solidMaterial(scene, 'decor_banner_top_light_catch_mat', new Color3(1.0, 0.82, 0.42), {
    alpha: 0.34,
    emissive: new Color3(0.18, 0.105, 0.02),
    specular: new Color3(0.08, 0.055, 0.02)
  });
  const catches = [
    { side: 'north', offset: 0, y: 7.95, width: 5.2 },
    { side: 'south', offset: -4.55, y: 6.18, width: 3.5 },
    { side: 'south', offset: 4.62, y: 6.18, width: 3.5 },
    { side: 'north', offset: -7.95, y: 6.52, width: 1.25 },
    { side: 'north', offset: 7.95, y: 6.52, width: 1.25 },
    { side: 'south', offset: -7.9, y: 6.54, width: 1.15 },
    { side: 'south', offset: 7.9, y: 6.54, width: 1.15 }
  ] as const;

  for (const spec of catches) {
    createWallPlane(
      scene,
      `decor_banner_light_catch_${spec.side}_${spec.offset}`,
      spec.side,
      spec.width,
      0.035,
      spec.y,
      spec.offset,
      catchMat,
      WALL_DECAL_INSET + 0.024
    );
  }
}

function createRectBanner(scene: Scene, spec: Omit<BannerSpec, 'template' | 'shape'>): void {
  placeBanner(scene, { ...spec, template: 'rect', shape: 'rectangle' });
}

function placeBanner(scene: Scene, spec: BannerSpec): void {
  if (!spec.textureUrl) {
    createDecorBackingPanel(scene, {
      name: `${spec.name}_backing`,
      side: spec.side,
      width: spec.width,
      height: spec.height,
      y: bannerVisualY(spec),
      offset: spec.offset,
      variant: 'banner'
    });
  }
  const material = createBannerMaterial(scene, spec);
  createWallPlane(scene, spec.name, spec.side, spec.width, spec.height, bannerVisualY(spec), spec.offset, material);
  createBannerRod(scene, spec);
}

function bannerVisualY(spec: BannerSpec): number {
  if (!spec.textureUrl) return spec.y;
  return spec.y + Math.min(0.42, Math.max(0.24, spec.height * 0.24));
}

function createBannerRod(scene: Scene, spec: BannerSpec): void {
  const rodMat = solidMaterial(scene, 'decor_banner_rod_mat', new Color3(0.12, 0.14, 0.18), {
    emissive: new Color3(0.004, 0.004, 0.006),
    specular: new Color3(0.2, 0.18, 0.13)
  });
  const pinMat = solidMaterial(scene, 'decor_banner_pin_mat', new Color3(1.0, 0.78, 0.18), {
    emissive: new Color3(0.05, 0.03, 0),
    specular: new Color3(0.24, 0.2, 0.08)
  });

  const rodY = spec.y + spec.height * 0.5 + 0.055;
  const rodWidth = spec.width + (spec.template === 'pennant' ? 0.16 : 0.28);
  createWallBox(scene, `decor_banner_rod_${spec.name}`, spec.side, rodWidth, 0.042, rodY, spec.offset, 0.035, rodMat, WALL_DECAL_INSET + 0.028);
  createWallBolt(scene, `decor_banner_left_pin_${spec.name}`, spec.side, spec.offset - rodWidth * 0.47, rodY, 0.052, pinMat);
  createWallBolt(scene, `decor_banner_right_pin_${spec.name}`, spec.side, spec.offset + rodWidth * 0.47, rodY, 0.052, pinMat);
}

function createBleacherAccents(scene: Scene): void {
  const blueLip = solidMaterial(scene, 'decor_bleacher_blue_lip_mat', new Color3(0.035, 0.15, 0.46), {
    emissive: new Color3(0.002, 0.01, 0.038),
    specular: new Color3(0.15, 0.18, 0.22)
  });
  const goldLip = solidMaterial(scene, 'decor_bleacher_gold_endcap_mat', new Color3(0.22, 0.28, 0.36), {
    emissive: new Color3(0.004, 0.006, 0.01),
    specular: new Color3(0.12, 0.13, 0.14)
  });

  for (const tier of createBleacherTierSpecs()) {
    const innerX = tier.center.x - tier.side * tier.size.width * 0.5;
    const lipX = innerX - tier.side * 0.02;
    const lipY = tier.center.y + tier.size.height * 0.5 + 0.05;
    const lip = MeshBuilder.CreateBox(`decor_bleacher_blue_trim_${tier.side}_${tier.step}`, {
      width: 0.04,
      height: 0.075,
      depth: tier.size.depth - 0.16
    }, scene);
    lip.position.set(lipX, lipY, tier.center.z);
    lip.material = blueLip;
    markDecorative(lip);

    for (const zSign of [-1, 1] as const) {
      const cap = MeshBuilder.CreateBox(`decor_bleacher_gold_cap_${tier.side}_${tier.step}_${zSign}`, {
        width: 0.052,
        height: 0.09,
        depth: 0.16
      }, scene);
      cap.position.set(lipX, lipY + 0.006, zSign * (tier.size.depth * 0.5 - 0.14));
      cap.material = goldLip;
      markDecorative(cap);
    }
  }
}

function createBleacherSeatDetails(scene: Scene): void {
  for (const mesh of scene.meshes.slice()) {
    if (mesh.name.startsWith('decor_bleacher_riser_face_') || mesh.name.startsWith('decor_bleacher_plank_gap_')) {
      mesh.dispose(false, true);
    }
  }

  const seatTopMat = solidMaterial(scene, 'decor_bleacher_satin_seat_top_mat', new Color3(0.045, 0.17, 0.52), {
    emissive: new Color3(0.002, 0.012, 0.042),
    specular: new Color3(0.16, 0.2, 0.27)
  });
  const frontRollMat = solidMaterial(scene, 'decor_bleacher_front_roll_mat', new Color3(0.026, 0.105, 0.34), {
    emissive: new Color3(0.001, 0.008, 0.03),
    specular: new Color3(0.13, 0.16, 0.22)
  });
  const edgeHighlightMat = solidMaterial(scene, 'decor_bleacher_soft_edge_highlight_mat', new Color3(0.2, 0.36, 0.68), {
    alpha: 0.18,
    emissive: new Color3(0.012, 0.026, 0.055),
    specular: new Color3(0.12, 0.16, 0.22)
  });
  const endTrimMat = solidMaterial(scene, 'decor_bleacher_end_trim_blue_mat', new Color3(0.14, 0.2, 0.29), {
    emissive: new Color3(0.002, 0.004, 0.008),
    specular: new Color3(0.1, 0.12, 0.15)
  });

  for (const tier of createBleacherTierSpecs()) {
    const topY = tier.center.y + tier.size.height * 0.5;
    const innerX = tier.center.x - tier.side * tier.size.width * 0.5;
    const outerX = tier.center.x + tier.side * tier.size.width * 0.5;
    const seatDepth = tier.size.depth - 0.34;

    const seatTop = MeshBuilder.CreateBox(`decor_bleacher_seat_top_${tier.side}_${tier.step}`, {
      width: tier.size.width - 0.1,
      height: 0.018,
      depth: seatDepth
    }, scene);
    seatTop.position.set(tier.center.x, topY + 0.058, tier.center.z);
    seatTop.material = seatTopMat;
    markDecorative(seatTop);

    const frontRoll = MeshBuilder.CreateBox(`decor_bleacher_front_roll_${tier.side}_${tier.step}`, {
      width: 0.09,
      height: 0.082,
      depth: seatDepth
    }, scene);
    frontRoll.position.set(innerX - tier.side * 0.026, topY + 0.028, tier.center.z);
    frontRoll.material = frontRollMat;
    markDecorative(frontRoll);

    const frontHighlight = MeshBuilder.CreateBox(`decor_bleacher_front_soft_highlight_${tier.side}_${tier.step}`, {
      width: 0.016,
      height: 0.02,
      depth: seatDepth - 0.08
    }, scene);
    frontHighlight.position.set(innerX - tier.side * 0.071, topY + 0.076, tier.center.z);
    frontHighlight.material = edgeHighlightMat;
    markDecorative(frontHighlight);

    const rearHighlight = MeshBuilder.CreateBox(`decor_bleacher_rear_soft_highlight_${tier.side}_${tier.step}`, {
      width: 0.014,
      height: 0.014,
      depth: seatDepth - 0.16
    }, scene);
    rearHighlight.position.set(outerX - tier.side * 0.08, topY + 0.071, tier.center.z);
    rearHighlight.material = edgeHighlightMat;
    markDecorative(rearHighlight);

    for (const zSign of [-1, 1] as const) {
      const endTrim = MeshBuilder.CreateBox(`decor_bleacher_seat_end_trim_${tier.side}_${tier.step}_${zSign}`, {
        width: tier.size.width - 0.08,
        height: 0.026,
        depth: 0.038
      }, scene);
      endTrim.position.set(tier.center.x, topY + 0.064, zSign * (tier.size.depth * 0.5 - 0.17));
      endTrim.material = endTrimMat;
      markDecorative(endTrim);
    }
  }
}

function createBleacherUnderframes(scene: Scene): void {
  const supportMat = solidMaterial(scene, 'decor_bleacher_support_frame_mat', new Color3(0.22, 0.25, 0.28), {
    emissive: new Color3(0.004, 0.005, 0.006),
    specular: new Color3(0.16, 0.17, 0.17)
  });
  const aisleStripeMat = solidMaterial(scene, 'decor_bleacher_aisle_stripe_mat', new Color3(0.98, 0.78, 0.18), {
    emissive: new Color3(0.055, 0.034, 0),
    specular: new Color3(0.16, 0.13, 0.04)
  });

  for (const tier of createBleacherTierSpecs()) {
    const frontX = tier.center.x - tier.side * tier.size.width * 0.5;
    const rearX = tier.center.x + tier.side * tier.size.width * 0.42;
    const y = Math.max(0.1, tier.center.y + tier.size.height * 0.12);

    for (const z of [-9.6, -4.8, 0, 4.8, 9.6]) {
      const strut = MeshBuilder.CreateBox(`decor_bleacher_diagonal_strut_${tier.side}_${tier.step}_${z}`, {
        width: 0.055,
        height: 0.055,
        depth: 0.72
      }, scene);
      strut.position.set((frontX + rearX) * 0.5, y, z);
      strut.rotation.z = tier.side * 0.54;
      strut.rotation.y = Math.PI / 2;
      strut.material = supportMat;
      markDecorative(strut);
    }

    for (const z of [-6.6, 6.6]) {
      const stripe = MeshBuilder.CreateBox(`decor_bleacher_aisle_edge_${tier.side}_${tier.step}_${z}`, {
        width: tier.size.width * 0.86,
        height: 0.026,
        depth: 0.06
      }, scene);
      stripe.position.set(tier.center.x, tier.center.y + tier.size.height * 0.5 + 0.071, z);
      stripe.material = aisleStripeMat;
      markDecorative(stripe);
    }
  }
}

function createCourtLineShadows(scene: Scene): void {
  const shadowMat = solidMaterial(scene, 'decor_court_line_recess_shadow_mat', new Color3(0.22, 0.12, 0.045), {
    alpha: 0.38,
    emissive: new Color3(0.008, 0.004, 0.001),
    specular: new Color3(0.02, 0.015, 0.008)
  });
  const highlightMat = solidMaterial(scene, 'decor_court_line_varnish_edge_mat', new Color3(1.0, 0.82, 0.46), {
    alpha: 0.22,
    emissive: new Color3(0.05, 0.032, 0.008),
    specular: new Color3(0.1, 0.08, 0.04)
  });
  const halfW = TUNING.map.halfWidth;
  const y = 0.018;

  const zLines = [
    { name: 'center', z: 0, depth: 0.26 }
  ];

  for (const line of zLines) {
    const shadow = MeshBuilder.CreateBox(`decor_court_line_shadow_${line.name}`, {
      width: halfW * 2,
      height: 0.004,
      depth: line.depth
    }, scene);
    shadow.position.set(0.035, y, line.z - 0.032);
    shadow.material = shadowMat;
    markDecorative(shadow);

    const shine = MeshBuilder.CreateBox(`decor_court_line_varnish_${line.name}`, {
      width: halfW * 2 - 0.35,
      height: 0.003,
      depth: 0.018
    }, scene);
    shine.position.set(0, y + 0.002, line.z + line.depth * 0.36);
    shine.material = highlightMat;
    markDecorative(shine);
  }
}

function createContactDepthDecals(scene: Scene): void {
  const contactMat = createSoftFloorDecalMaterial(scene, 'decor_floor_contact_depth_mat', {
    color: '#1a1209',
    alpha: 0.2,
    width: 256,
    height: 128
  });
  const y = 0.021;
  const decals = [
    { name: 'bleacher_west', x: -11.45, z: 0, width: 2.0, depth: 28.5 },
    { name: 'bleacher_east', x: 11.45, z: 0, width: 2.0, depth: 28.5 },
    { name: 'bleacher_inner_west', x: -9.9, z: 0, width: 1.2, depth: 24.0 },
    { name: 'bleacher_inner_east', x: 9.9, z: 0, width: 1.2, depth: 24.0 },
    { name: 'wall_pad_north', x: 0, z: TUNING.map.halfLength - 0.42, width: 25.3, depth: 0.72 },
    { name: 'wall_pad_south', x: 0, z: -TUNING.map.halfLength + 0.42, width: 25.3, depth: 0.72 }
  ];

  for (const decal of decals) {
    const plane = MeshBuilder.CreatePlane(`decor_contact_depth_${decal.name}`, { width: decal.width, height: decal.depth }, scene);
    plane.position.set(decal.x, y, decal.z);
    plane.rotation.x = Math.PI / 2;
    plane.material = contactMat;
    markDecorative(plane);
  }
}

function createPropContactShadows(scene: Scene): void {
  const matShadow = createSoftFloorDecalMaterial(scene, 'decor_floor_mat_contact_shadow_mat', {
    color: '#130b05',
    alpha: 0.28,
    width: 256,
    height: 128
  });
  const dummyShadow = createSoftFloorDecalMaterial(scene, 'decor_floor_dummy_contact_shadow_mat', {
    color: '#160c05',
    alpha: 0.22,
    width: 160,
    height: 128
  });
  const coneShadow = createSoftFloorDecalMaterial(scene, 'decor_floor_cone_contact_shadow_mat', {
    color: '#1a0f07',
    alpha: 0.16,
    width: 128,
    height: 96
  });

  for (const spec of MAT_SPECS) {
    createFloorDecalPlane(scene, `decor_contact_mat_${spec.id}`, spec.x, spec.z, 3.1, 0.72, 0.041, matShadow, spec.yawRadians);
  }

  for (const [index, x, z] of [
    [0, -3, 8],
    [1, 0, 9.5],
    [2, 3, 8],
    [3, 0, 7.5]
  ] as const) {
    createFloorDecalPlane(scene, `decor_contact_dummy_${index}`, x, z, 0.95, 0.72, 0.042, dummyShadow, 0);
  }

  const coneXs = [-11.2, -8.4, -5.6, -2.8, 0, 2.8, 5.6, 8.4, 11.2];
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < coneXs.length; i += 1) {
      createFloorDecalPlane(scene, `decor_contact_cone_${side}_${i}`, coneXs[i], side * 0.62, 0.52, 0.42, 0.043, coneShadow, 0);
    }
  }
}

function createCourtAmbientWash(scene: Scene): void {
  const material = createCourtAmbientWashMaterial(scene);
  createFloorDecalPlane(
    scene,
    'decor_floor_full_court_ambient_wash',
    0,
    0,
    TUNING.map.halfWidth * 2 - 0.18,
    TUNING.map.halfLength * 2 - 0.22,
    0.025,
    material,
    0
  );
}

function createFloorDetailDecals(scene: Scene): void {
  const blueLogoMat = createFloorLogoMaterial(scene, 'decor_floor_blue_crest_tex', '#174baf', '#ffd24a', 'BLUE COURT');
  const redLogoMat = createFloorLogoMaterial(scene, 'decor_floor_red_crest_tex', '#b82d2a', '#ffe27a', 'RED COURT');
  createFloorLogo(scene, 'decor_floor_blue_crest', -5.9, -2.65, blueLogoMat);
  createFloorLogo(scene, 'decor_floor_red_crest', 5.9, 2.65, redLogoMat);
}

function createFloorWaxSheen(scene: Scene): void {
  const material = createWaxSheenMaterial(scene);
  const sheen = MeshBuilder.CreatePlane('decor_floor_waxed_clearcoat_sheen', {
    width: TUNING.map.halfWidth * 2 - 0.35,
    height: TUNING.map.halfLength * 2 - 0.5
  }, scene);
  sheen.position.set(0, 0.034, 0);
  sheen.rotation.x = Math.PI / 2;
  sheen.material = material;
  markDecorative(sheen);
}

function createWideFloorGlints(scene: Scene): void {
  const glintMat = createSoftFloorDecalMaterial(scene, 'decor_floor_wide_glint_mat', {
    color: '#fff8df',
    alpha: 0.15,
    width: 512,
    height: 192
  });
  const glints = [
    { name: 'near', x: -2.8, z: -8.6, width: 21.0, depth: 3.2, yaw: 0.18 },
    { name: 'mid', x: 2.4, z: -0.6, width: 22.5, depth: 2.8, yaw: -0.12 },
    { name: 'far', x: -1.5, z: 8.0, width: 20.0, depth: 3.0, yaw: 0.14 },
    { name: 'left_sweep', x: -6.8, z: -1.5, width: 14.0, depth: 2.4, yaw: -0.28 },
    { name: 'right_sweep', x: 7.2, z: 3.5, width: 14.5, depth: 2.4, yaw: 0.24 }
  ];

  for (const glint of glints) {
    const plane = MeshBuilder.CreatePlane(`decor_floor_wide_glint_${glint.name}`, { width: glint.width, height: glint.depth }, scene);
    plane.position.set(glint.x, 0.037, glint.z);
    plane.rotation.x = Math.PI / 2;
    plane.rotation.y = glint.yaw;
    plane.material = glintMat;
    markDecorative(plane);
  }
}

function createFloorLightReflections(scene: Scene): void {
  const reflectionMat = createSoftFloorDecalMaterial(scene, 'decor_floor_light_reflection_mat', {
    color: '#fff4cf',
    alpha: 0.26,
    width: 384,
    height: 512
  });
  const positions: [number, number][] = [
    [-5, -8], [5, -8],
    [-5, 0], [5, 0],
    [-5, 8], [5, 8]
  ];

  positions.forEach(([x, z], index) => {
    const glow = MeshBuilder.CreatePlane(`decor_floor_light_reflection_${index}`, { width: 1.45, height: 9.2 }, scene);
    glow.position.set(x, 0.039, z);
    glow.rotation.x = Math.PI / 2;
    glow.rotation.y = index % 2 === 0 ? 0.035 : -0.035;
    glow.material = reflectionMat;
    markDecorative(glow);
  });
}

function createFixtureFalloffPools(scene: Scene): void {
  const poolMat = createSoftFloorDecalMaterial(scene, 'decor_fixture_warm_falloff_pool_mat', {
    color: '#ffe6aa',
    alpha: 0.12,
    width: 256,
    height: 384
  });
  const positions: [number, number][] = [
    [-5, -8], [5, -8],
    [-5, 0], [5, 0],
    [-5, 8], [5, 8]
  ];

  positions.forEach(([x, z], index) => {
    const pool = MeshBuilder.CreatePlane(`decor_fixture_falloff_pool_${index}`, { width: 5.4, height: 8.6 }, scene);
    pool.position.set(x, 0.028, z);
    pool.rotation.x = Math.PI / 2;
    pool.rotation.y = index % 2 === 0 ? 0.08 : -0.08;
    pool.material = poolMat;
    markDecorative(pool);
  });
}

function createOverheadLightLenses(scene: Scene): void {
  const lensMat = solidMaterial(scene, 'decor_overhead_light_lens_mat', new Color3(1.0, 0.96, 0.82), {
    emissive: new Color3(0.96, 0.88, 0.62),
    specular: new Color3(0.22, 0.21, 0.18)
  });
  const glowMat = solidMaterial(scene, 'decor_overhead_light_soft_glow_mat', new Color3(1.0, 0.9, 0.58), {
    alpha: 0.16,
    emissive: new Color3(0.7, 0.56, 0.32)
  });

  const fixtureY = TUNING.map.wallHeight - 0.19;
  const glowY = TUNING.map.wallHeight - 0.24;
  const positions: [number, number][] = [
    [-5, -8], [5, -8],
    [-5, 0], [5, 0],
    [-5, 8], [5, 8]
  ];

  positions.forEach(([x, z], index) => {
    const lens = MeshBuilder.CreateBox(`decor_overhead_light_lens_${index}`, {
      width: 0.28,
      height: 0.018,
      depth: 1.14
    }, scene);
    lens.position.set(x, fixtureY, z);
    lens.material = lensMat;
    markDecorative(lens);

    const glow = MeshBuilder.CreatePlane(`decor_overhead_light_glow_${index}`, { width: 1.35, height: 2.1 }, scene);
    glow.position.set(x, glowY, z);
    glow.rotation.x = Math.PI / 2;
    glow.material = glowMat;
    markDecorative(glow);
  });
}

function createOverheadLightFrames(scene: Scene): void {
  const frameMat = solidMaterial(scene, 'decor_overhead_light_frame_mat', new Color3(0.12, 0.13, 0.14), {
    emissive: new Color3(0.004, 0.004, 0.004),
    specular: new Color3(0.18, 0.18, 0.16)
  });
  const positions: [number, number][] = [
    [-5, -8], [5, -8],
    [-5, 0], [5, 0],
    [-5, 8], [5, 8]
  ];

  positions.forEach(([x, z], index) => {
    for (const side of [-1, 1] as const) {
      const longRail = MeshBuilder.CreateBox(`decor_overhead_light_side_rail_${index}_${side}`, {
        width: 0.035,
        height: 0.045,
        depth: 1.1
      }, scene);
      longRail.position.set(x + side * 0.16, TUNING.map.wallHeight - 0.19, z);
      longRail.material = frameMat;
      markDecorative(longRail);

      const endCap = MeshBuilder.CreateBox(`decor_overhead_light_end_cap_${index}_${side}`, {
        width: 0.32,
        height: 0.045,
        depth: 0.035
      }, scene);
      endCap.position.set(x, TUNING.map.wallHeight - 0.19, z + side * 0.56);
      endCap.material = frameMat;
      markDecorative(endCap);
    }
  });
}

function createCeilingRimHighlights(scene: Scene): void {
  const rimMat = solidMaterial(scene, 'decor_ceiling_beam_rim_light_mat', new Color3(0.2, 0.34, 0.58), {
    alpha: 0.46,
    emissive: new Color3(0.035, 0.055, 0.09),
    specular: new Color3(0.08, 0.09, 0.1)
  });
  const y = TUNING.map.wallHeight - 0.34;

  for (const z of [-15, -9, -3, 3, 9, 15]) {
    const rim = MeshBuilder.CreateBox(`decor_ceiling_rafter_rim_${z}`, {
      width: TUNING.map.halfWidth * 2 - 0.8,
      height: 0.018,
      depth: 0.026
    }, scene);
    rim.position.set(0, y, z - 0.092);
    rim.material = rimMat;
    markDecorative(rim);
  }

  for (const x of [-9, -4.5, 0, 4.5, 9]) {
    const rim = MeshBuilder.CreateBox(`decor_ceiling_purlin_rim_${x}`, {
      width: 0.026,
      height: 0.018,
      depth: TUNING.map.halfLength * 2 - 1.0
    }, scene);
    rim.position.set(x - 0.072, y + 0.08, 0);
    rim.material = rimMat;
    markDecorative(rim);
  }
}

function createCeilingConduits(scene: Scene): void {
  const conduitMat = solidMaterial(scene, 'decor_ceiling_conduit_mat', new Color3(0.18, 0.2, 0.22), {
    emissive: new Color3(0.001, 0.001, 0.0015),
    specular: new Color3(0.015, 0.015, 0.015)
  });
  const junctionMat = solidMaterial(scene, 'decor_ceiling_junction_box_mat', new Color3(0.1, 0.115, 0.13), {
    emissive: new Color3(0.001, 0.001, 0.0015),
    specular: new Color3(0.02, 0.02, 0.018)
  });
  const y = TUNING.map.wallHeight - 0.315;

  for (const x of [-7.2, -2.4, 2.4, 7.2]) {
    const conduit = MeshBuilder.CreateBox(`decor_ceiling_long_conduit_${x}`, {
      width: 0.045,
      height: 0.035,
      depth: TUNING.map.halfLength * 2 - 2.1
    }, scene);
    conduit.position.set(x, y, 0);
    conduit.material = conduitMat;
    markDecorative(conduit);
  }

  for (const z of [-12, -4, 4, 12]) {
    const cross = MeshBuilder.CreateBox(`decor_ceiling_cross_conduit_${z}`, {
      width: TUNING.map.halfWidth * 2 - 3.2,
      height: 0.032,
      depth: 0.04
    }, scene);
    cross.position.set(0, y - 0.01, z);
    cross.material = conduitMat;
    markDecorative(cross);
  }

  let index = 0;
  for (const x of [-7.2, -2.4, 2.4, 7.2]) {
    for (const z of [-12, -4, 4, 12]) {
      const box = MeshBuilder.CreateBox(`decor_ceiling_junction_box_${index}`, {
        width: 0.24,
        height: 0.055,
        depth: 0.24
      }, scene);
      box.position.set(x, y - 0.024, z);
      box.material = junctionMat;
      markDecorative(box);
      index += 1;
    }
  }
}

function createImageTexture(
  scene: Scene,
  name: string,
  url: string,
  uScale = 1,
  vScale = 1,
  clamp = false,
  anisotropy = 8
): Texture {
  const texture = new Texture(url, scene);
  texture.name = name;
  texture.wrapU = clamp ? Texture.CLAMP_ADDRESSMODE : Texture.WRAP_ADDRESSMODE;
  texture.wrapV = clamp ? Texture.CLAMP_ADDRESSMODE : Texture.WRAP_ADDRESSMODE;
  texture.uScale = uScale;
  texture.vScale = vScale;
  texture.anisotropicFilteringLevel = anisotropy;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  return texture;
}

function texturedStandardMaterial(
  scene: Scene,
  name: string,
  url: string,
  options: {
    uScale?: number;
    vScale?: number;
    alpha?: boolean;
    diffuse?: Color3;
    emissive?: Color3;
    specular?: Color3;
    specularPower?: number;
    clamp?: boolean;
  } = {}
): StandardMaterial {
  const existing = scene.getMaterialByName(name);
  if (existing instanceof StandardMaterial) return existing;

  const texture = createImageTexture(scene, `${name}_tex`, url, options.uScale ?? 1, options.vScale ?? 1, options.clamp ?? false);
  texture.hasAlpha = options.alpha ?? false;

  const material = new StandardMaterial(name, scene);
  material.diffuseTexture = texture;
  material.diffuseColor = options.diffuse ?? new Color3(1, 1, 1);
  material.emissiveTexture = options.emissive ? texture : null;
  material.emissiveColor = options.emissive ?? new Color3(0, 0, 0);
  material.specularColor = options.specular ?? new Color3(0.06, 0.06, 0.055);
  material.specularPower = options.specularPower ?? 42;
  material.backFaceCulling = false;
  if (options.alpha) {
    material.opacityTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
  }
  return material;
}

function createFloorDecalPlane(
  scene: Scene,
  name: string,
  x: number,
  z: number,
  width: number,
  depth: number,
  y: number,
  material: StandardMaterial,
  yaw = 0
): Mesh {
  const plane = MeshBuilder.CreatePlane(name, { width, height: depth }, scene);
  plane.position.set(x, y, z);
  plane.rotation.x = Math.PI / 2;
  plane.rotation.y = yaw;
  plane.material = material;
  markDecorative(plane);
  return plane;
}

function createSoftFloorDecalMaterial(
  scene: Scene,
  name: string,
  options: { color: string; alpha: number; width: number; height: number }
): StandardMaterial {
  const existing = scene.getMaterialByName(name);
  if (existing instanceof StandardMaterial) return existing;

  const texture = new DynamicTexture(`${name}_tex`, { width: options.width, height: options.height }, scene, false);
  texture.hasAlpha = true;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, options.width, options.height);
  ctx.fillStyle = options.color;

  for (let y = 0; y < options.height; y += 1) {
    const ny = Math.abs((y + 0.5) / options.height - 0.5) * 2;
    for (let x = 0; x < options.width; x += 1) {
      const nx = Math.abs((x + 0.5) / options.width - 0.5) * 2;
      const falloff = Math.max(nx, ny);
      const alpha = options.alpha * Math.max(0, 1 - Math.pow(falloff, 2.4));
      if (alpha <= 0.002) continue;
      ctx.globalAlpha = alpha;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
  texture.update(false);
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);

  const material = new StandardMaterial(name, scene);
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.diffuseColor = new Color3(1, 1, 1);
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(1, 1, 1);
  material.specularColor = new Color3(0, 0, 0);
  material.alpha = 1;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.backFaceCulling = false;
  return material;
}

function createCourtAmbientWashMaterial(scene: Scene): StandardMaterial {
  const existing = scene.getMaterialByName('decor_floor_full_court_ambient_wash_mat');
  if (existing instanceof StandardMaterial) return existing;

  const width = 512;
  const height = 512;
  const texture = new DynamicTexture('decor_floor_full_court_ambient_wash_tex', { width, height }, scene, false);
  texture.hasAlpha = true;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, width, height);

  for (let y = 0; y < height; y += 1) {
    const py = y / height;
    for (let x = 0; x < width; x += 1) {
      const px = x / width;
      const dx = Math.abs(px - 0.5) * 2;
      const dy = Math.abs(py - 0.5) * 2;
      const vignette = Math.max(dx, dy);
      const centerLift = Math.max(0, 1 - Math.hypot(px - 0.5, py - 0.45) / 0.62);
      const sidelineWarmth = Math.max(0, 1 - Math.abs(py - 0.52) / 0.48);
      ctx.globalAlpha = 0.035 + centerLift * 0.085 + sidelineWarmth * 0.03;
      ctx.fillStyle = '#ffd186';
      ctx.fillRect(x, y, 1, 1);

      const edgeAlpha = Math.max(0, (vignette - 0.72) / 0.28) * 0.11;
      if (edgeAlpha > 0.002) {
        ctx.globalAlpha = edgeAlpha;
        ctx.fillStyle = '#241006';
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  ctx.globalAlpha = 1;
  texture.update(false);

  const material = new StandardMaterial('decor_floor_full_court_ambient_wash_mat', scene);
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  material.emissiveTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.diffuseColor = new Color3(1, 0.86, 0.58);
  material.emissiveColor = new Color3(0.5, 0.32, 0.12);
  material.specularColor = new Color3(0, 0, 0);
  material.alpha = 1;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.backFaceCulling = false;
  return material;
}

function createWaxSheenMaterial(scene: Scene): StandardMaterial {
  const existing = scene.getMaterialByName('decor_floor_waxed_clearcoat_mat');
  if (existing instanceof StandardMaterial) return existing;

  const width = 512;
  const height = 512;
  const texture = new DynamicTexture('decor_floor_waxed_clearcoat_tex', { width, height }, scene, false);
  texture.hasAlpha = true;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = 2.2;
  texture.vScale = 3.0;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);

  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, width, height);

  for (let y = 0; y < height; y += 1) {
    const py = y / height;
    for (let x = 0; x < width; x += 1) {
      const px = x / width;
      const diagonal = (px * 0.58 + py * 0.42) % 1;
      const broadSweep = Math.max(0, 1 - Math.abs(diagonal - 0.54) / 0.16);
      const secondarySweep = Math.max(0, 1 - Math.abs(((px * 0.7 + py * 0.3 + 0.38) % 1) - 0.52) / 0.24);
      const lengthFade = 0.72 + 0.28 * Math.sin((px * 2.1 + py * 1.2) * Math.PI * 2);
      const alpha = 0.028 + broadSweep * 0.095 * lengthFade + secondarySweep * 0.045;
      ctx.globalAlpha = Math.min(0.16, alpha);
      ctx.fillStyle = '#fff6d8';
      ctx.fillRect(x, y, 1, 1);
    }
  }

  const softGradient = ctx.createLinearGradient(0, 0, width, height);
  softGradient.addColorStop(0, 'rgba(255, 255, 255, 0.018)');
  softGradient.addColorStop(0.5, 'rgba(255, 243, 205, 0.05)');
  softGradient.addColorStop(1, 'rgba(255, 255, 255, 0.015)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = softGradient;
  ctx.fillRect(0, 0, width, height);
  texture.update(false);

  const material = new StandardMaterial('decor_floor_waxed_clearcoat_mat', scene);
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  material.emissiveTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.diffuseColor = new Color3(1, 0.96, 0.82);
  material.emissiveColor = new Color3(0.38, 0.32, 0.18);
  material.specularColor = new Color3(0, 0, 0);
  material.alpha = 1;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.backFaceCulling = false;
  return material;
}

function createBannerMaterial(scene: Scene, spec: BannerSpec): StandardMaterial {
  if (spec.textureUrl) {
    return createMaskedBannerImageMaterial(scene, spec);
  }

  const texture = createSignageDynamicTexture(scene, `${spec.name}_tex`, 768, 384, {
    hasAlpha: spec.shape !== 'rectangle',
    side: spec.side
  });

  const ctx = texture.getContext() as CanvasRenderingContext2D;
  drawBannerTexture(ctx, 768, 384, spec);
  texture.update(true);

  const material = new StandardMaterial(`${spec.name}_mat`, scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.32, 0.32, 0.32);
  material.specularColor = new Color3(0.08, 0.08, 0.075);
  material.specularPower = 34;
  material.backFaceCulling = false;
  if (spec.shape !== 'rectangle') {
    material.opacityTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
  }
  return material;
}

function createMaskedBannerImageMaterial(scene: Scene, spec: BannerSpec): StandardMaterial {
  const aspect = Math.max(0.25, spec.width / Math.max(0.001, spec.height));
  const textureWidth = aspect >= 1 ? 1024 : Math.max(256, Math.round(1024 * aspect));
  const textureHeight = aspect >= 1 ? Math.max(256, Math.round(1024 / aspect)) : 1024;
  const texture = createSignageDynamicTexture(scene, `${spec.name}_masked_tex`, textureWidth, textureHeight, {
    hasAlpha: true
  });

  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, textureWidth, textureHeight);
  texture.update(true);

  const material = new StandardMaterial(`${spec.name}_mat`, scene);
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  material.emissiveTexture = texture;
  material.diffuseColor = new Color3(1, 1, 1);
  material.emissiveColor = new Color3(0.24, 0.24, 0.24);
  material.specularColor = new Color3(0.08, 0.08, 0.075);
  material.specularPower = 34;
  material.backFaceCulling = false;
  material.useAlphaFromDiffuseTexture = true;
  material.transparencyMode = Material.MATERIAL_ALPHATEST;
  material.alphaCutOff = 0.38;

  const image = new Image();
  image.onload = () => {
    drawMaskedBannerImage(texture, image, textureWidth, textureHeight);
  };
  image.src = spec.textureUrl ?? '';

  return material;
}

function createSignageDynamicTexture(
  scene: Scene,
  name: string,
  width: number,
  height: number,
  options: { hasAlpha: boolean; side?: WallSide }
): DynamicTexture {
  const texture = new DynamicTexture(name, { width, height }, scene, true);
  texture.hasAlpha = options.hasAlpha;
  texture.anisotropicFilteringLevel = 16;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  if (options.side) {
    applyWallTextTextureOrientation(texture, options.side);
  }
  return texture;
}

function drawMaskedBannerImage(texture: DynamicTexture, image: HTMLImageElement, textureWidth: number, textureHeight: number): void {
  const source = document.createElement('canvas');
  source.width = image.naturalWidth || image.width;
  source.height = image.naturalHeight || image.height;
  const sourceCtx = source.getContext('2d', { willReadFrequently: true });
  if (!sourceCtx) return;
  sourceCtx.drawImage(image, 0, 0, source.width, source.height);
  const imageData = sourceCtx.getImageData(0, 0, source.width, source.height);
  maskConnectedLightBackground(imageData, source.width, source.height);
  dilateOpaqueEdges(imageData, source.width, source.height, 3);
  sourceCtx.putImageData(imageData, 0, 0);

  const bounds = findOpaqueBounds(imageData, source.width, source.height);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, textureWidth, textureHeight);
  if (bounds) {
    const srcW = bounds.maxX - bounds.minX + 1;
    const srcH = bounds.maxY - bounds.minY + 1;
    const pad = Math.max(6, Math.round(Math.min(textureWidth, textureHeight) * 0.012));
    const scale = Math.min((textureWidth - pad * 2) / srcW, (textureHeight - pad * 2) / srcH);
    const dstW = srcW * scale;
    const dstH = srcH * scale;
    const dstX = (textureWidth - dstW) * 0.5;
    const dstY = (textureHeight - dstH) * 0.5;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, bounds.minX, bounds.minY, srcW, srcH, dstX, dstY, dstW, dstH);
  }
  texture.update(true);
}

function maskConnectedLightBackground(imageData: ImageData, width: number, height: number): void {
  const data = imageData.data;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    const i = p * 4;
    if (!isLightBackgroundPixel(data[i], data[i + 1], data[i + 2], data[i + 3])) return;
    visited[p] = 1;
    queue[tail] = p;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const p = queue[head];
    head += 1;
    const i = p * 4;
    data[i + 3] = 0;
    const x = p % width;
    const y = Math.floor(p / width);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }
}

function isLightBackgroundPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 16) return true;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return r > 186 && g > 186 && b > 186 && max - min < 42;
}

function dilateOpaqueEdges(imageData: ImageData, width: number, height: number, passes: number): void {
  const data = imageData.data;
  const scratch = new Uint8ClampedArray(data.length);
  const neighbors = [-1, 0, 1];

  for (let pass = 0; pass < passes; pass += 1) {
    scratch.set(data);
    let changed = false;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (scratch[index + 3] > 0) continue;

        let sourceIndex = -1;
        let strongestAlpha = 0;

        for (const dy of neighbors) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (const dx of neighbors) {
            const nx = x + dx;
            if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
            const neighborIndex = (ny * width + nx) * 4;
            const neighborAlpha = scratch[neighborIndex + 3];
            if (neighborAlpha <= strongestAlpha) continue;
            strongestAlpha = neighborAlpha;
            sourceIndex = neighborIndex;
          }
        }

        if (sourceIndex < 0 || strongestAlpha <= 0) continue;
        data[index] = scratch[sourceIndex];
        data[index + 1] = scratch[sourceIndex + 1];
        data[index + 2] = scratch[sourceIndex + 2];
        data[index + 3] = 0;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }
  }
}

function findOpaqueBounds(imageData: ImageData, width: number, height: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const data = imageData.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= 16) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX >= minX && maxY >= minY ? { minX, minY, maxX, maxY } : null;
}

function drawBannerTexture(ctx: CanvasRenderingContext2D, width: number, height: number, spec: BannerSpec): void {
  ctx.clearRect(0, 0, width, height);

  ctx.save();
  drawBannerPath(ctx, width, height, spec.shape);
  ctx.clip();

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, spec.palette.background);
  gradient.addColorStop(1, spec.palette.background2);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(0, 0, width, Math.max(18, height * 0.12));
  ctx.fillStyle = spec.palette.accent;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(0, height * 0.78, width, Math.max(12, height * 0.06));
  ctx.globalAlpha = 1;

  for (let x = -width; x < width * 1.4; x += 112) {
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 34, 0);
    ctx.lineTo(x + width * 0.55, height);
    ctx.lineTo(x + width * 0.55 - 34, height);
    ctx.closePath();
    ctx.fill();
  }

  if (spec.icon) {
    drawBannerIcon(ctx, spec.icon, width, height, spec);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const titleY = spec.template === 'verticalTeam' ? height * 0.45 : spec.subtitle ? height * 0.46 : height * 0.54;
  const subtitleY = spec.template === 'verticalTeam' ? height * 0.66 : height * 0.67;
  const iconRoom = spec.icon && spec.template === 'rect' && spec.width > 1.8;
  const textCenter = iconRoom ? width * 0.58 : spec.shape === 'pennant' ? width * 0.36 : width * 0.5;
  const maxTitleWidth = iconRoom ? width * 0.62 : spec.shape === 'pennant' ? width * 0.45 : width * 0.84;
  const maxSubtitleWidth = iconRoom ? width * 0.56 : width * 0.78;
  const titleSize = spec.template === 'verticalTeam'
    ? height * 0.15
    : spec.shape === 'pennant'
      ? height * 0.18
      : spec.subtitle
        ? height * 0.19
        : height * 0.26;

  drawFittedText(ctx, spec.title, textCenter, titleY, maxTitleWidth, titleSize, spec.palette.text, spec.palette.shadow);
  if (spec.subtitle) {
    drawFittedText(ctx, spec.subtitle, textCenter, subtitleY, maxSubtitleWidth, spec.template === 'verticalTeam' ? height * 0.13 : height * 0.15, spec.palette.accent, spec.palette.shadow);
  }

  ctx.restore();

  ctx.save();
  drawBannerPath(ctx, width, height, spec.shape);
  ctx.strokeStyle = spec.palette.border;
  ctx.lineWidth = Math.max(12, height * 0.045);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = Math.max(4, height * 0.018);
  ctx.stroke();
  ctx.restore();
}

function drawBannerPath(ctx: CanvasRenderingContext2D, width: number, height: number, shape: BannerShape): void {
  const notch = Math.min(width * 0.18, height * 0.22);
  ctx.beginPath();
  if (shape === 'vertical') {
    ctx.moveTo(0, 0);
    ctx.lineTo(width, 0);
    ctx.lineTo(width, height - notch);
    ctx.lineTo(width * 0.5, height);
    ctx.lineTo(0, height - notch);
    ctx.closePath();
    return;
  }
  if (shape === 'pennant') {
    ctx.moveTo(0, 0);
    ctx.lineTo(width, height * 0.5);
    ctx.lineTo(0, height);
    ctx.closePath();
    return;
  }
  ctx.rect(0, 0, width, height);
}

function drawBannerIcon(
  ctx: CanvasRenderingContext2D,
  icon: BannerIcon,
  width: number,
  height: number,
  spec: BannerSpec
): void {
  const cx = spec.shape === 'pennant' ? width * 0.2 : spec.template === 'verticalTeam' ? width * 0.5 : width * 0.17;
  const cy = spec.shape === 'pennant' ? height * 0.5 : spec.template === 'verticalTeam' ? height * 0.22 : height * 0.5;
  const size = Math.min(width, height) * (spec.shape === 'pennant' ? 0.18 : spec.template === 'verticalTeam' ? 0.18 : 0.24);

  if (icon === 'ball') {
    drawDodgeballIcon(ctx, cx, cy, size, spec.palette.accent, spec.palette.border);
    return;
  }
  if (icon === 'trophy') {
    drawTrophyIcon(ctx, cx, cy, size, spec.palette.accent, spec.palette.border);
    return;
  }
  drawStarsIcon(ctx, cx, cy, size, spec.palette.accent, spec.palette.border);
}

function drawDodgeballIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, line: string): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = line;
  ctx.lineWidth = Math.max(6, r * 0.16);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.76)';
  ctx.lineWidth = Math.max(4, r * 0.11);
  ctx.beginPath();
  ctx.arc(cx - r * 0.25, cy - r * 0.05, r * 0.58, -1.25, 1.08);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + r * 0.26, cy + r * 0.06, r * 0.58, 1.9, 4.2);
  ctx.stroke();
  ctx.restore();
}

function drawTrophyIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, line: string): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = line;
  ctx.lineWidth = Math.max(5, r * 0.12);
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.52, cy - r * 0.58);
  ctx.lineTo(cx + r * 0.52, cy - r * 0.58);
  ctx.lineTo(cx + r * 0.34, cy + r * 0.12);
  ctx.quadraticCurveTo(cx, cy + r * 0.42, cx - r * 0.34, cy + r * 0.12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx - r * 0.58, cy - r * 0.24, r * 0.28, -1.45, 1.1, true);
  ctx.arc(cx + r * 0.58, cy - r * 0.24, r * 0.28, 2.04, 4.58, true);
  ctx.stroke();

  ctx.fillRect(cx - r * 0.12, cy + r * 0.34, r * 0.24, r * 0.36);
  ctx.fillRect(cx - r * 0.42, cy + r * 0.72, r * 0.84, r * 0.16);
  ctx.restore();
}

function drawStarsIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, line: string): void {
  ctx.save();
  for (const [dx, dy, scale] of [[0, 0, 1], [-0.7, -0.55, 0.5], [0.68, -0.48, 0.45], [0.58, 0.58, 0.42]] as const) {
    drawStar(ctx, cx + dx * r, cy + dy * r, r * 0.42 * scale, fill, line);
  }
  ctx.restore();
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, line: string): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? r : r * 0.42;
    const angle = -Math.PI / 2 + i * Math.PI / 5;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = line;
  ctx.lineWidth = Math.max(3, r * 0.12);
  ctx.fill();
  ctx.stroke();
}

function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  baseSize: number,
  color: string,
  shadow: string
): void {
  let size = baseSize;
  do {
    ctx.font = `900 ${Math.round(size)}px "Arial Black", Impact, Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 4;
  } while (size > 22);

  ctx.lineJoin = 'round';
  ctx.strokeStyle = shadow;
  ctx.lineWidth = Math.max(6, size * 0.16);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function solidMaterial(
  scene: Scene,
  name: string,
  diffuse: Color3,
  options: { emissive?: Color3; specular?: Color3; alpha?: number } = {}
): StandardMaterial {
  const existing = scene.getMaterialByName(name);
  if (existing instanceof StandardMaterial) return existing;

  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse;
  material.emissiveColor = options.emissive ?? new Color3(0, 0, 0);
  material.specularColor = options.specular ?? new Color3(0.06, 0.06, 0.055);
  material.specularPower = 42;
  if (options.alpha !== undefined) material.alpha = options.alpha;
  return material;
}

function applyWallTextTextureOrientation(texture: DynamicTexture, side: WallSide): void {
  // Wall decals are created as front-facing planes and then rotated into place, so their texture
  // coordinates already read left-to-right from the court on every wall. Keep this as an audit hook
  // for text-bearing wall art; do not flip U here or the south/spawn wall reads backwards.
  void texture;
  void side;
}

function createWallPlane(
  scene: Scene,
  name: string,
  side: WallSide,
  width: number,
  height: number,
  y: number,
  offset: number,
  material: StandardMaterial,
  inset = WALL_DECAL_INSET
): Mesh {
  const plane = MeshBuilder.CreatePlane(name, { width, height }, scene);
  const halfW = TUNING.map.halfWidth;
  const halfL = TUNING.map.halfLength;
  switch (side) {
    case 'north':
      plane.position.set(offset, y, halfL - inset);
      plane.rotation.y = 0;
      break;
    case 'south':
      plane.position.set(offset, y, -halfL + inset);
      plane.rotation.y = Math.PI;
      break;
    case 'east':
      plane.position.set(halfW - inset, y, offset);
      plane.rotation.y = Math.PI / 2;
      break;
    case 'west':
      plane.position.set(-halfW + inset, y, offset);
      plane.rotation.y = -Math.PI / 2;
      break;
  }
  plane.material = material;
  markDecorative(plane);
  return plane;
}

function createWallBox(
  scene: Scene,
  name: string,
  side: WallSide,
  width: number,
  height: number,
  y: number,
  offset: number,
  thickness: number,
  material: StandardMaterial,
  inset = WALL_DECAL_INSET
): Mesh {
  const halfW = TUNING.map.halfWidth;
  const halfL = TUNING.map.halfLength;
  const size = side === 'north' || side === 'south'
    ? { width, height, depth: thickness }
    : { width: thickness, height, depth: width };
  const box = MeshBuilder.CreateBox(name, size, scene);

  switch (side) {
    case 'north':
      box.position.set(offset, y, halfL - inset);
      break;
    case 'south':
      box.position.set(offset, y, -halfL + inset);
      break;
    case 'east':
      box.position.set(halfW - inset, y, offset);
      break;
    case 'west':
      box.position.set(-halfW + inset, y, offset);
      break;
  }

  box.material = material;
  markDecorative(box);
  return box;
}

function createWallBolt(
  scene: Scene,
  name: string,
  side: WallSide,
  offset: number,
  y: number,
  diameter: number,
  material: StandardMaterial
): Mesh {
  const halfW = TUNING.map.halfWidth;
  const halfL = TUNING.map.halfLength;
  const bolt = MeshBuilder.CreateCylinder(name, {
    height: 0.018,
    diameter,
    tessellation: 14
  }, scene);

  switch (side) {
    case 'north':
      bolt.position.set(offset, y, halfL - WALL_DECAL_INSET - 0.046);
      bolt.rotation.x = Math.PI / 2;
      break;
    case 'south':
      bolt.position.set(offset, y, -halfL + WALL_DECAL_INSET + 0.046);
      bolt.rotation.x = Math.PI / 2;
      break;
    case 'east':
      bolt.position.set(halfW - WALL_DECAL_INSET - 0.046, y, offset);
      bolt.rotation.z = Math.PI / 2;
      break;
    case 'west':
      bolt.position.set(-halfW + WALL_DECAL_INSET + 0.046, y, offset);
      bolt.rotation.z = Math.PI / 2;
      break;
  }

  bolt.material = material;
  markDecorative(bolt);
  return bolt;
}

function createFloorLogo(scene: Scene, name: string, x: number, z: number, material: StandardMaterial): Mesh {
  const logo = MeshBuilder.CreatePlane(name, { width: 3.2, height: 1.22 }, scene);
  logo.position.set(x, 0.012, z);
  logo.rotation.x = Math.PI / 2;
  logo.material = material;
  markDecorative(logo);
  return logo;
}

function createFloorLogoMaterial(scene: Scene, name: string, primary: string, accent: string, label: string): StandardMaterial {
  const texture = new DynamicTexture(name, { width: 768, height: 320 }, scene, false);
  texture.hasAlpha = true;
  texture.anisotropicFilteringLevel = 8;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = texture.getContext() as CanvasRenderingContext2D;

  ctx.clearRect(0, 0, 768, 320);
  ctx.globalAlpha = 0.76;
  ctx.fillStyle = primary;
  ctx.beginPath();
  ctx.ellipse(384, 160, 330, 118, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = accent;
  ctx.lineWidth = 20;
  ctx.beginPath();
  ctx.ellipse(384, 160, 314, 102, 0, 0, Math.PI * 2);
  ctx.stroke();

  drawDodgeballIcon(ctx, 306, 160, 64, '#f04a36', '#fff3d0');
  drawStar(ctx, 452, 108, 24, accent, '#13294b');
  drawStar(ctx, 470, 180, 17, '#fff8dc', '#13294b');
  drawStar(ctx, 164, 184, 20, '#fff8dc', '#13294b');
  ctx.fillStyle = label.includes('BLUE') ? 'rgba(46,95,167,0.42)' : 'rgba(185,28,28,0.38)';
  ctx.fillRect(142, 122, 84, 18);
  ctx.fillStyle = accent;
  ctx.fillRect(142, 152, 120, 15);
  ctx.fillStyle = 'rgba(255,248,220,0.86)';
  ctx.fillRect(142, 180, 74, 12);
  texture.update(true);

  const material = new StandardMaterial(`${name}_mat`, scene);
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.18, 0.16, 0.12);
  material.useAlphaFromDiffuseTexture = true;
  material.disableLighting = false;
  material.backFaceCulling = false;
  material.specularColor = new Color3(0.08, 0.07, 0.05);
  return material;
}

function createGymSign(
  scene: Scene,
  spec: {
    name: string;
    side: WallSide;
    offset: number;
    y: number;
    width: number;
    height: number;
    title: string;
    subtitle?: string;
    palette: BannerPalette;
  }
): void {
  createDecorBackingPanel(scene, {
    name: `${spec.name}_backing`,
    side: spec.side,
    width: spec.width,
    height: spec.height,
    y: spec.y,
    offset: spec.offset,
    variant: 'sign'
  });
  const material = createGymSignMaterial(scene, spec);
  createWallPlane(scene, spec.name, spec.side, spec.width, spec.height, spec.y, spec.offset, material, WALL_DECAL_INSET + 0.016);
}

function createDecorBackingPanel(
  scene: Scene,
  spec: {
    name: string;
    side: WallSide;
    width: number;
    height: number;
    y: number;
    offset: number;
    variant: 'banner' | 'bannerImage' | 'sign';
  }
): void {
  const backing = solidMaterial(scene, 'decor_sign_backing_mat', new Color3(0.075, 0.095, 0.13), {
    emissive: new Color3(0.004, 0.006, 0.01),
    specular: new Color3(0.1, 0.11, 0.12)
  });
  const bevel = solidMaterial(scene, 'decor_sign_bevel_mat', new Color3(0.16, 0.19, 0.24), {
    emissive: new Color3(0.008, 0.012, 0.016),
    specular: new Color3(0.14, 0.15, 0.16)
  });
  const trim = solidMaterial(scene, 'decor_sign_trim_mat', new Color3(0.94, 0.74, 0.2), {
    emissive: new Color3(0.05, 0.03, 0.002),
    specular: new Color3(0.2, 0.16, 0.06)
  });

  const pad = spec.variant === 'sign' ? 0.04 : spec.variant === 'bannerImage' ? 0.07 : 0.05;
  const trimInset = spec.variant === 'sign' ? 0.05 : 0.07;
  const backingThickness = spec.variant === 'sign' ? 0.024 : 0.028;
  const bevelThickness = 0.012;
  const trimThickness = 0.014;
  // Wall boxes are positioned by center, so their front face sits `thickness / 2` closer to the
  // camera than the inset value. Keep every layer fully behind the image plane.
  const backingInset = WALL_DECAL_INSET + backingThickness * 0.5 + 0.008;
  const bevelInset = WALL_DECAL_INSET + bevelThickness * 0.5 + 0.006;
  const trimInsetDepth = WALL_DECAL_INSET + trimThickness * 0.5 + 0.004;

  createWallBox(
    scene,
    `${spec.name}_core`,
    spec.side,
    spec.width + pad * 2,
    spec.height + pad * 2,
    spec.y,
    spec.offset,
    backingThickness,
    backing,
    backingInset
  );

  createWallBox(
    scene,
    `${spec.name}_bevel`,
    spec.side,
    spec.width + pad * 2 - 0.028,
    spec.height + pad * 2 - 0.028,
    spec.y,
    spec.offset,
    bevelThickness,
    bevel,
    bevelInset
  );

  const outerW = spec.width + pad * 2;
  const outerH = spec.height + pad * 2;
  createWallBox(scene, `${spec.name}_trim_top`, spec.side, outerW, trimInset, spec.y + outerH * 0.5 - trimInset * 0.5, spec.offset, trimThickness, trim, trimInsetDepth);
  createWallBox(scene, `${spec.name}_trim_bottom`, spec.side, outerW, trimInset, spec.y - outerH * 0.5 + trimInset * 0.5, spec.offset, trimThickness, trim, trimInsetDepth);
  createWallBox(scene, `${spec.name}_trim_left`, spec.side, trimInset, outerH - trimInset * 2, spec.y, spec.offset - outerW * 0.5 + trimInset * 0.5, trimThickness, trim, trimInsetDepth);
  createWallBox(scene, `${spec.name}_trim_right`, spec.side, trimInset, outerH - trimInset * 2, spec.y, spec.offset + outerW * 0.5 - trimInset * 0.5, trimThickness, trim, trimInsetDepth);
}

function createGymSignMaterial(
  scene: Scene,
  spec: {
    name: string;
    side: WallSide;
    title: string;
    subtitle?: string;
    palette: BannerPalette;
  }
): StandardMaterial {
  const texture = createSignageDynamicTexture(scene, `${spec.name}_tex`, 512, 192, {
    hasAlpha: false,
    side: spec.side
  });

  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createLinearGradient(0, 0, 512, 192);
  gradient.addColorStop(0, spec.palette.background);
  gradient.addColorStop(1, spec.palette.background2);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 192);
  ctx.strokeStyle = spec.palette.border;
  ctx.lineWidth = 14;
  ctx.strokeRect(12, 12, 488, 168);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 3;
  ctx.strokeRect(30, 30, 452, 132);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawFittedText(ctx, spec.title, 256, spec.subtitle ? 78 : 96, 390, spec.subtitle ? 58 : 86, spec.palette.text, spec.palette.shadow);
  if (spec.subtitle) {
    drawFittedText(ctx, spec.subtitle, 256, 130, 350, 34, spec.palette.accent, spec.palette.shadow);
  }
  texture.update(true);

  const material = new StandardMaterial(`${spec.name}_mat`, scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.22, 0.22, 0.2);
  material.specularColor = new Color3(0.05, 0.05, 0.045);
  material.backFaceCulling = false;
  return material;
}

function createVentMaterial(scene: Scene): StandardMaterial {
  const texture = new DynamicTexture('decor_wall_vent_tex', { width: 512, height: 180 }, scene, false);
  texture.hasAlpha = false;
  texture.anisotropicFilteringLevel = 4;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#d7d1c5';
  ctx.fillRect(0, 0, 512, 180);
  ctx.strokeStyle = '#13294b';
  ctx.lineWidth = 12;
  ctx.strokeRect(10, 10, 492, 160);

  ctx.fillStyle = '#aeb3b7';
  for (let y = 38; y <= 138; y += 20) {
    ctx.fillRect(48, y, 416, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.36)';
    ctx.fillRect(48, y, 416, 2);
    ctx.fillStyle = '#aeb3b7';
  }

  ctx.strokeStyle = 'rgba(19,41,75,0.28)';
  ctx.lineWidth = 3;
  for (let x = 88; x <= 424; x += 56) {
    ctx.beginPath();
    ctx.moveTo(x, 34);
    ctx.lineTo(x, 146);
    ctx.stroke();
  }
  texture.update(true);

  const material = new StandardMaterial('decor_wall_vent_mat', scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.08, 0.08, 0.075);
  material.specularColor = new Color3(0.08, 0.08, 0.075);
  material.backFaceCulling = false;
  return material;
}

function createClockMaterial(scene: Scene): StandardMaterial {
  const texture = new DynamicTexture('decor_wall_clock_tex', { width: 384, height: 384 }, scene, false);
  texture.hasAlpha = true;
  texture.anisotropicFilteringLevel = 8;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 384, 384);
  ctx.fillStyle = '#fff8e7';
  ctx.beginPath();
  ctx.arc(192, 192, 168, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#132b5a';
  ctx.lineWidth = 22;
  ctx.stroke();
  ctx.strokeStyle = '#ff9b35';
  ctx.lineWidth = 6;
  ctx.stroke();

  ctx.fillStyle = '#132b5a';
  for (let i = 0; i < 12; i += 1) {
    const angle = -Math.PI / 2 + i * Math.PI / 6;
    const inner = i % 3 === 0 ? 126 : 138;
    const outer = 148;
    ctx.lineWidth = i % 3 === 0 ? 8 : 5;
    ctx.strokeStyle = '#132b5a';
    ctx.beginPath();
    ctx.moveTo(192 + Math.cos(angle) * inner, 192 + Math.sin(angle) * inner);
    ctx.lineTo(192 + Math.cos(angle) * outer, 192 + Math.sin(angle) * outer);
    ctx.stroke();
  }

  ctx.strokeStyle = '#132b5a';
  ctx.lineCap = 'round';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(192, 192);
  ctx.lineTo(192, 104);
  ctx.stroke();
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(192, 192);
  ctx.lineTo(254, 214);
  ctx.stroke();
  ctx.fillStyle = '#ff9b35';
  ctx.beginPath();
  ctx.arc(192, 192, 12, 0, Math.PI * 2);
  ctx.fill();
  texture.update(true);

  const material = new StandardMaterial('decor_wall_clock_mat', scene);
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.16, 0.14, 0.1);
  material.specularColor = new Color3(0.08, 0.08, 0.06);
  material.backFaceCulling = false;
  return material;
}

function createPlaqueMaterial(scene: Scene, name: string, side: WallSide, title: string, subtitle: string): StandardMaterial {
  const texture = createSignageDynamicTexture(scene, name, 640, 180, {
    hasAlpha: false,
    side
  });
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createLinearGradient(0, 0, 640, 180);
  gradient.addColorStop(0, '#0b1c3a');
  gradient.addColorStop(1, '#061025');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 640, 180);
  ctx.strokeStyle = '#ffd24a';
  ctx.lineWidth = 12;
  ctx.strokeRect(12, 12, 616, 156);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 3;
  ctx.strokeRect(30, 30, 580, 120);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawFittedText(ctx, title, 320, 76, 500, 42, '#fff8dc', '#061025');
  drawFittedText(ctx, subtitle, 320, 122, 460, 30, '#ff9b35', '#061025');
  texture.update(true);

  const material = new StandardMaterial(`${name}_mat`, scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.24, 0.22, 0.16);
  material.specularColor = new Color3(0.06, 0.06, 0.05);
  material.backFaceCulling = false;
  return material;
}

function markDecorative(mesh: Mesh): void {
  mesh.checkCollisions = false;
  mesh.isPickable = false;
  mesh.metadata = { ...DECOR_META };
}

function wallSides(): WallSide[] {
  return ['north', 'south', 'east', 'west'];
}

/** Front/back walls only — mats stood against the wall live here, never on the side walls. */
function frontBackWallSides(): WallSide[] {
  return ['north', 'south'];
}

function wallSpan(side: WallSide): number {
  return side === 'north' || side === 'south'
    ? TUNING.map.halfWidth * 2
    : TUNING.map.halfLength * 2;
}
