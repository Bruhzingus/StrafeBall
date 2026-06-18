import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  StandardMaterial,
  Texture
} from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { createBleacherTierSpecs } from '../../../shared/simulation/MapGeometry';

type WallSide = 'north' | 'south' | 'east' | 'west';
type BannerShape = 'rectangle' | 'notched' | 'pennant';
type BannerIcon = 'ball' | 'trophy' | 'stars';

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
  shape: BannerShape;
  palette: BannerPalette;
  icon?: BannerIcon;
}

const WALL_DECAL_INSET = 0.048;
const WALL_PAD_DECAL_INSET = 0.085;
const DECOR_META = { decorative: true, noGameplay: true };

const PALETTES = {
  navy: {
    background: '#142d5e',
    background2: '#07162f',
    border: '#ffd34f',
    accent: '#ff8a32',
    text: '#fff7dc',
    shadow: '#071225'
  },
  blue: {
    background: '#174baf',
    background2: '#0a225e',
    border: '#f4f7ff',
    accent: '#ffd24a',
    text: '#f9fbff',
    shadow: '#06133a'
  },
  gold: {
    background: '#ef9a2f',
    background2: '#8d3d16',
    border: '#19325f',
    accent: '#ffe27a',
    text: '#fff8e5',
    shadow: '#371205'
  },
  red: {
    background: '#b82d2a',
    background2: '#5b121c',
    border: '#fff3d0',
    accent: '#ffb145',
    text: '#fff8e6',
    shadow: '#2f0610'
  },
  white: {
    background: '#f4efe3',
    background2: '#d7d1c5',
    border: '#1c3f83',
    accent: '#e9622f',
    text: '#17315f',
    shadow: '#fff7e5'
  }
} satisfies Record<string, BannerPalette>;

export function applyGymVisualRevamp(scene: Scene): void {
  enhanceExistingMaterials(scene);
  brightenExistingLighting(scene);
  createWallColorBlocking(scene);
  createWallPaddingDetails(scene);
  createRaisedWallPadPanels(scene);
  createScoreboardWallAccents(scene);
  createScoreboardHardware(scene);
  createUpperWallDetails(scene);
  createGymBanners(scene);
  createBannerHardware(scene);
  createBleacherAccents(scene);
  createBleacherUnderframes(scene);
  createCourtLineShadows(scene);
  createFloorDetailDecals(scene);
  createFloorGloss(scene);
  createOverheadLightLenses(scene);
  createOverheadLightFrames(scene);
  createCeilingConduits(scene);
}

function enhanceExistingMaterials(scene: Scene): void {
  const floorMaterial = scene.getMaterialByName('floor_material');
  if (floorMaterial instanceof PBRMaterial) {
    const floorTexture = createWoodTexture(scene, 'gym_floor_polished_maple_tex', 'natural');
    floorTexture.uScale = 5;
    floorTexture.vScale = 12;
    floorMaterial.albedoTexture = floorTexture;
    floorMaterial.albedoColor = new Color3(1, 1, 1);
    floorMaterial.metallic = 0;
    floorMaterial.roughness = 0.24;
    floorMaterial.environmentIntensity = 0.78;
  }

  setZoneMaterial(scene, 'zone_player_mat', 'blue');
  setZoneMaterial(scene, 'zone_opp_mat', 'red');

  const wallMaterial = scene.getMaterialByName('wall_material');
  if (wallMaterial instanceof PBRMaterial) {
    const wallTexture = createCinderblockTexture(scene);
    wallTexture.uScale = 5.2;
    wallTexture.vScale = 2.2;
    wallMaterial.albedoTexture = wallTexture;
    wallMaterial.albedoColor = new Color3(0.98, 0.96, 0.9);
    wallMaterial.roughness = 0.68;
  }

  const wallPadMaterial = scene.getMaterialByName('wallPad_material');
  if (wallPadMaterial instanceof PBRMaterial) {
    wallPadMaterial.albedoColor = new Color3(0.06, 0.22, 0.62);
    wallPadMaterial.emissiveColor = new Color3(0.006, 0.018, 0.055);
    wallPadMaterial.roughness = 0.42;
  }

  const bleacherMaterial = scene.getMaterialByName('bleacher_material');
  if (bleacherMaterial instanceof PBRMaterial) {
    bleacherMaterial.albedoColor = new Color3(0.56, 0.6, 0.64);
    bleacherMaterial.metallic = 0.16;
    bleacherMaterial.roughness = 0.36;
  }

  const seatMaterial = scene.getMaterialByName('bleacher_seat_mat');
  if (seatMaterial instanceof StandardMaterial) {
    seatMaterial.diffuseColor = new Color3(0.12, 0.3, 0.72);
    seatMaterial.emissiveColor = new Color3(0.008, 0.022, 0.07);
    seatMaterial.specularColor = new Color3(0.18, 0.2, 0.23);
    seatMaterial.specularPower = 54;
  }

  const panelMaterial = scene.getMaterialByName('bleacher_panel_mat');
  if (panelMaterial instanceof StandardMaterial) {
    panelMaterial.diffuseColor = new Color3(0.25, 0.29, 0.34);
    panelMaterial.specularColor = new Color3(0.11, 0.12, 0.13);
  }

  const railMaterial = scene.getMaterialByName('bleacher_rail_mat');
  if (railMaterial instanceof StandardMaterial) {
    railMaterial.diffuseColor = new Color3(0.82, 0.86, 0.9);
    railMaterial.specularColor = new Color3(0.22, 0.24, 0.25);
    railMaterial.specularPower = 48;
  }
}

function setZoneMaterial(scene: Scene, name: string, tone: 'blue' | 'red'): void {
  const material = scene.getMaterialByName(name);
  if (!(material instanceof StandardMaterial)) return;

  const texture = createWoodTexture(scene, `${name}_polished_court_tex`, tone);
  texture.uScale = 4;
  texture.vScale = 8;
  material.diffuseTexture = texture;
  material.diffuseColor = new Color3(1, 1, 1);
  material.specularColor = tone === 'blue' ? new Color3(0.42, 0.5, 0.65) : new Color3(0.62, 0.4, 0.28);
  material.specularPower = 92;
}

function brightenExistingLighting(scene: Scene): void {
  for (const light of scene.lights) {
    if (light.name === 'gym_hemi_light') {
      light.intensity = Math.max(light.intensity, 1.22);
    }
    if (light.name.startsWith('ceil_pt_')) {
      light.intensity = 0.5;
      light.range = 14.5;
    }
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
    createWallPlane(scene, `decor_wall_blue_band_${side}`, side, span, 0.28, 2.04, 0, royalBlue);
    createWallPlane(scene, `decor_wall_orange_trim_${side}`, side, span, 0.055, 1.82, 0, orange);
    createWallPlane(scene, `decor_wall_gold_trim_${side}`, side, span, 0.052, 2.24, 0, gold);
    createWallPlane(scene, `decor_wall_white_pinstripe_${side}`, side, span, 0.032, 1.93, 0, white);
  }
}

function createWallPaddingDetails(scene: Scene): void {
  const seamMaterial = solidMaterial(scene, 'decor_wall_padding_seam_mat', new Color3(0.025, 0.09, 0.28), {
    alpha: 0.62,
    emissive: new Color3(0, 0.006, 0.025)
  });
  const topCapMaterial = solidMaterial(scene, 'decor_wall_padding_top_cap_mat', new Color3(0.05, 0.13, 0.38), {
    emissive: new Color3(0.004, 0.012, 0.04),
    specular: new Color3(0.12, 0.14, 0.16)
  });
  const stitchMaterial = solidMaterial(scene, 'decor_wall_padding_stitch_mat', new Color3(0.26, 0.48, 0.98), {
    alpha: 0.52,
    emissive: new Color3(0.016, 0.04, 0.11)
  });

  for (const side of wallSides()) {
    const span = wallSpan(side);
    createWallPlane(scene, `decor_wall_padding_top_${side}`, side, span, 0.085, 1.52, 0, topCapMaterial, WALL_PAD_DECAL_INSET);

    const start = -span / 2 + 1.4;
    const end = span / 2 - 1.4;
    let index = 0;
    for (let offset = start; offset <= end + 0.001; offset += 2.3) {
      createWallPlane(
        scene,
        `decor_wall_padding_blue_${side}_${String(index).padStart(2, '0')}`,
        side,
        0.035,
        1.32,
        0.76,
        offset,
        seamMaterial,
        WALL_PAD_DECAL_INSET
      );
      index += 1;
    }

    for (const y of [0.38, 1.1]) {
      createWallPlane(
        scene,
        `decor_wall_padding_stitch_${side}_${Math.round(y * 100)}`,
        side,
        span - 1.0,
        0.028,
        y,
        0,
        stitchMaterial,
        WALL_PAD_DECAL_INSET + 0.004
      );
    }
  }
}

function createRaisedWallPadPanels(scene: Scene): void {
  const cushionA = solidMaterial(scene, 'decor_wall_pad_cushion_deep_blue_mat', new Color3(0.045, 0.18, 0.54), {
    emissive: new Color3(0.004, 0.014, 0.048),
    specular: new Color3(0.08, 0.12, 0.18)
  });
  const cushionB = solidMaterial(scene, 'decor_wall_pad_cushion_royal_blue_mat', new Color3(0.06, 0.24, 0.68), {
    emissive: new Color3(0.006, 0.018, 0.06),
    specular: new Color3(0.1, 0.15, 0.22)
  });
  const bevelMat = solidMaterial(scene, 'decor_wall_pad_bevel_highlight_mat', new Color3(0.18, 0.38, 0.95), {
    emissive: new Color3(0.012, 0.032, 0.1),
    specular: new Color3(0.12, 0.16, 0.22)
  });

  for (const side of wallSides()) {
    const span = wallSpan(side);
    const panelWidth = 1.78;
    const gap = 0.08;
    const count = Math.floor((span - 1.0) / (panelWidth + gap));
    const used = count * panelWidth + (count - 1) * gap;
    const start = -used / 2 + panelWidth / 2;

    for (let i = 0; i < count; i += 1) {
      const offset = start + i * (panelWidth + gap);
      const mat = i % 2 === 0 ? cushionA : cushionB;
      createWallBox(
        scene,
        `decor_wall_pad_raised_panel_${side}_${String(i).padStart(2, '0')}`,
        side,
        panelWidth,
        1.18,
        0.76,
        offset,
        0.026,
        mat,
        WALL_PAD_DECAL_INSET + 0.016
      );

      createWallBox(
        scene,
        `decor_wall_pad_panel_top_bevel_${side}_${String(i).padStart(2, '0')}`,
        side,
        panelWidth - 0.12,
        0.026,
        1.31,
        offset,
        0.032,
        bevelMat,
        WALL_PAD_DECAL_INSET + 0.026
      );
    }
  }
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
  const plaqueMat = createPlaqueMaterial(scene, 'decor_scoreboard_plaque_tex', 'SCHOOL GYM', 'DODGEBALL NIGHT');

  for (const side of ['north', 'south'] as WallSide[]) {
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
  const acousticMat = createAcousticPanelMaterial(scene);
  const speakerMat = solidMaterial(scene, 'decor_wall_speaker_mat', new Color3(0.025, 0.03, 0.04), {
    emissive: new Color3(0.002, 0.002, 0.003),
    specular: new Color3(0.08, 0.08, 0.08)
  });
  const speakerGrilleMat = createSpeakerGrilleMaterial(scene);
  const hornMat = solidMaterial(scene, 'decor_wall_horn_mat', new Color3(0.86, 0.86, 0.78), {
    emissive: new Color3(0.018, 0.016, 0.012),
    specular: new Color3(0.14, 0.13, 0.1)
  });
  const clockMat = createClockMaterial(scene);
  const exitMat = createExitSignMaterial(scene);

  for (const side of ['north', 'south'] as WallSide[]) {
    for (const x of [-10.2, -5.1, 5.1, 10.2]) {
      createWallPlane(scene, `decor_acoustic_panel_${side}_${x}`, side, 1.34, 0.48, 7.72, x, acousticMat, WALL_DECAL_INSET + 0.004);
    }

    for (const x of [-11.95, 11.95]) {
      createWallBox(scene, `decor_wall_speaker_body_${side}_${x}`, side, 0.48, 0.64, 6.9, x, 0.18, speakerMat, WALL_DECAL_INSET + 0.09);
      createWallPlane(scene, `decor_wall_speaker_grille_${side}_${x}`, side, 0.36, 0.48, 6.9, x, speakerGrilleMat, WALL_DECAL_INSET + 0.19);
    }

    createWallPlane(scene, `decor_wall_clock_${side}`, side, 0.72, 0.72, 6.92, side === 'north' ? -4.35 : 4.35, clockMat, WALL_DECAL_INSET + 0.012);
    createWallBox(scene, `decor_wall_buzzer_horn_${side}`, side, 0.52, 0.28, 6.92, side === 'north' ? 4.36 : -4.36, 0.14, hornMat, WALL_DECAL_INSET + 0.08);
    createWallPlane(scene, `decor_exit_sign_${side}`, side, 0.88, 0.34, 2.55, side === 'north' ? -11.95 : 11.95, exitMat, WALL_DECAL_INSET + 0.016);
  }

  for (const side of ['east', 'west'] as WallSide[]) {
    for (const z of [-16.4, 16.4]) {
      createWallPlane(scene, `decor_side_acoustic_panel_${side}_${z}_a`, side, 1.15, 0.42, 7.62, z, acousticMat, WALL_DECAL_INSET + 0.004);
      createWallBox(scene, `decor_side_speaker_body_${side}_${z}`, side, 0.42, 0.54, 6.86, z, 0.16, speakerMat, WALL_DECAL_INSET + 0.09);
      createWallPlane(scene, `decor_side_speaker_grille_${side}_${z}`, side, 0.3, 0.4, 6.86, z, speakerGrilleMat, WALL_DECAL_INSET + 0.19);
    }
  }
}

function createGymBanners(scene: Scene): void {
  const banners: BannerSpec[] = [
    {
      name: 'decor_banner_strafeball_north',
      side: 'north',
      offset: 0,
      y: 7.32,
      width: 6.2,
      height: 0.92,
      title: 'STRAFEBALL',
      subtitle: 'DODGEBALL LEAGUE',
      shape: 'rectangle',
      palette: PALETTES.navy,
      icon: 'ball'
    },
    {
      name: 'decor_banner_home_of_champs_north',
      side: 'north',
      offset: -7.1,
      y: 5.76,
      width: 4.45,
      height: 1.18,
      title: 'HOME OF THE',
      subtitle: 'CHAMPS',
      shape: 'notched',
      palette: PALETTES.gold,
      icon: 'trophy'
    },
    {
      name: 'decor_banner_dodgeball_league_north',
      side: 'north',
      offset: 7.25,
      y: 5.78,
      width: 4.5,
      height: 1.1,
      title: 'DODGEBALL',
      subtitle: 'LEAGUE',
      shape: 'notched',
      palette: PALETTES.blue,
      icon: 'ball'
    },
    {
      name: 'decor_banner_no_boundaries_south',
      side: 'south',
      offset: -7.2,
      y: 5.8,
      width: 4.4,
      height: 1.08,
      title: 'NO',
      subtitle: 'BOUNDARIES',
      shape: 'rectangle',
      palette: PALETTES.red,
      icon: 'stars'
    },
    {
      name: 'decor_banner_private_duel_south',
      side: 'south',
      offset: 0,
      y: 7.25,
      width: 5.1,
      height: 0.9,
      title: 'PRIVATE DUEL',
      subtitle: 'BLUE VS RED',
      shape: 'rectangle',
      palette: PALETTES.navy,
      icon: 'stars'
    },
    {
      name: 'decor_banner_championship_south',
      side: 'south',
      offset: 7.2,
      y: 5.8,
      width: 4.4,
      height: 1.08,
      title: 'CHAMPIONSHIP',
      subtitle: 'COURT',
      shape: 'notched',
      palette: PALETTES.white,
      icon: 'trophy'
    },
    {
      name: 'decor_flag_blue_wins_north',
      side: 'north',
      offset: -11.25,
      y: 5.72,
      width: 1.24,
      height: 1.84,
      title: 'BLUE',
      subtitle: 'WINS',
      shape: 'notched',
      palette: PALETTES.blue,
      icon: 'stars'
    },
    {
      name: 'decor_flag_red_wins_north',
      side: 'north',
      offset: 11.25,
      y: 5.72,
      width: 1.24,
      height: 1.84,
      title: 'RED',
      subtitle: 'WINS',
      shape: 'notched',
      palette: PALETTES.red,
      icon: 'stars'
    },
    {
      name: 'decor_flag_blue_wins_south',
      side: 'south',
      offset: -11.25,
      y: 5.72,
      width: 1.24,
      height: 1.84,
      title: 'BLUE',
      subtitle: 'WINS',
      shape: 'notched',
      palette: PALETTES.blue,
      icon: 'stars'
    },
    {
      name: 'decor_flag_red_wins_south',
      side: 'south',
      offset: 11.25,
      y: 5.72,
      width: 1.24,
      height: 1.84,
      title: 'RED',
      subtitle: 'WINS',
      shape: 'notched',
      palette: PALETTES.red,
      icon: 'stars'
    },
    {
      name: 'decor_pennant_west_south_blue',
      side: 'west',
      offset: -15.7,
      y: 6.05,
      width: 1.06,
      height: 1.65,
      title: 'SB',
      shape: 'pennant',
      palette: PALETTES.blue,
      icon: 'ball'
    },
    {
      name: 'decor_pennant_west_south_gold',
      side: 'west',
      offset: -13.9,
      y: 6.12,
      width: 1.0,
      height: 1.5,
      title: '24',
      shape: 'pennant',
      palette: PALETTES.gold,
      icon: 'stars'
    },
    {
      name: 'decor_pennant_west_north_red',
      side: 'west',
      offset: 15.7,
      y: 6.05,
      width: 1.06,
      height: 1.65,
      title: 'SB',
      shape: 'pennant',
      palette: PALETTES.red,
      icon: 'ball'
    },
    {
      name: 'decor_pennant_west_north_white',
      side: 'west',
      offset: 13.9,
      y: 6.12,
      width: 1.0,
      height: 1.5,
      title: 'MVP',
      shape: 'pennant',
      palette: PALETTES.white,
      icon: 'stars'
    },
    {
      name: 'decor_pennant_east_south_blue',
      side: 'east',
      offset: -15.7,
      y: 6.05,
      width: 1.06,
      height: 1.65,
      title: 'SB',
      shape: 'pennant',
      palette: PALETTES.blue,
      icon: 'ball'
    },
    {
      name: 'decor_pennant_east_south_gold',
      side: 'east',
      offset: -13.9,
      y: 6.12,
      width: 1.0,
      height: 1.5,
      title: 'ACE',
      shape: 'pennant',
      palette: PALETTES.gold,
      icon: 'stars'
    },
    {
      name: 'decor_pennant_east_north_red',
      side: 'east',
      offset: 15.7,
      y: 6.05,
      width: 1.06,
      height: 1.65,
      title: 'SB',
      shape: 'pennant',
      palette: PALETTES.red,
      icon: 'ball'
    },
    {
      name: 'decor_pennant_east_north_white',
      side: 'east',
      offset: 13.9,
      y: 6.12,
      width: 1.0,
      height: 1.5,
      title: 'VARS',
      shape: 'pennant',
      palette: PALETTES.white,
      icon: 'stars'
    }
  ];

  for (const banner of banners) {
    const material = createBannerMaterial(scene, banner);
    createWallPlane(scene, banner.name, banner.side, banner.width, banner.height, banner.y, banner.offset, material);
  }
}

function createBannerHardware(scene: Scene): void {
  const rodMat = solidMaterial(scene, 'decor_banner_rod_mat', new Color3(0.12, 0.14, 0.18), {
    emissive: new Color3(0.004, 0.004, 0.006),
    specular: new Color3(0.2, 0.18, 0.13)
  });
  const pinMat = solidMaterial(scene, 'decor_banner_pin_mat', new Color3(1.0, 0.78, 0.18), {
    emissive: new Color3(0.05, 0.03, 0),
    specular: new Color3(0.24, 0.2, 0.08)
  });

  const specs = [
    { side: 'north', offset: 0, y: 7.86, width: 6.55 },
    { side: 'north', offset: -7.1, y: 6.43, width: 4.75 },
    { side: 'north', offset: 7.25, y: 6.38, width: 4.78 },
    { side: 'south', offset: 0, y: 7.78, width: 5.45 },
    { side: 'south', offset: -7.2, y: 6.38, width: 4.7 },
    { side: 'south', offset: 7.2, y: 6.38, width: 4.7 },
    { side: 'north', offset: -11.25, y: 6.72, width: 1.45 },
    { side: 'north', offset: 11.25, y: 6.72, width: 1.45 },
    { side: 'south', offset: -11.25, y: 6.72, width: 1.45 },
    { side: 'south', offset: 11.25, y: 6.72, width: 1.45 }
  ] satisfies Array<{ side: WallSide; offset: number; y: number; width: number }>;

  for (const spec of specs) {
    createWallBox(scene, `decor_banner_rod_${spec.side}_${spec.offset}_${spec.y}`, spec.side, spec.width, 0.045, spec.y, spec.offset, 0.035, rodMat, WALL_DECAL_INSET + 0.028);
    createWallBolt(scene, `decor_banner_left_pin_${spec.side}_${spec.offset}_${spec.y}`, spec.side, spec.offset - spec.width * 0.47, spec.y, 0.052, pinMat);
    createWallBolt(scene, `decor_banner_right_pin_${spec.side}_${spec.offset}_${spec.y}`, spec.side, spec.offset + spec.width * 0.47, spec.y, 0.052, pinMat);
  }
}

function createBleacherAccents(scene: Scene): void {
  const blueLip = solidMaterial(scene, 'decor_bleacher_blue_lip_mat', new Color3(0.06, 0.22, 0.62), {
    emissive: new Color3(0.004, 0.016, 0.06),
    specular: new Color3(0.15, 0.18, 0.22)
  });
  const goldLip = solidMaterial(scene, 'decor_bleacher_gold_endcap_mat', new Color3(1.0, 0.72, 0.15), {
    emissive: new Color3(0.07, 0.04, 0.0)
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
  const halfL = TUNING.map.halfLength;
  const y = 0.018;

  const zLines = [
    { name: 'center', z: 0, depth: 0.26 },
    { name: 'attack_neg', z: -4.5, depth: 0.1 },
    { name: 'attack_pos', z: 4.5, depth: 0.1 },
    { name: 'warning_neg', z: -8.5, depth: 0.1 },
    { name: 'warning_pos', z: 8.5, depth: 0.1 }
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

  for (const x of [-(halfW - 0.08), halfW - 0.08]) {
    const shadow = MeshBuilder.CreateBox(`decor_side_line_shadow_${x > 0 ? 'r' : 'l'}`, {
      width: 0.12,
      height: 0.004,
      depth: halfL * 2
    }, scene);
    shadow.position.set(x + (x > 0 ? -0.032 : 0.032), y, 0.035);
    shadow.material = shadowMat;
    markDecorative(shadow);
  }
}

function createFloorDetailDecals(scene: Scene): void {
  const seamMat = solidMaterial(scene, 'decor_floor_plank_seam_mat', new Color3(0.42, 0.22, 0.09), {
    emissive: new Color3(0.018, 0.008, 0.002),
    specular: new Color3(0.05, 0.035, 0.018)
  });
  const nailMat = solidMaterial(scene, 'decor_floor_nail_dot_mat', new Color3(0.18, 0.12, 0.07), {
    emissive: new Color3(0.006, 0.004, 0.002),
    specular: new Color3(0.08, 0.06, 0.04)
  });

  const halfW = TUNING.map.halfWidth;
  const halfL = TUNING.map.halfLength;
  for (let i = 1; i < 13; i += 1) {
    const x = -halfW + i * ((halfW * 2) / 13);
    const seam = MeshBuilder.CreateBox(`decor_floor_plank_long_seam_${i}`, {
      width: 0.014,
      height: 0.003,
      depth: halfL * 2 - 0.6
    }, scene);
    seam.position.set(x, 0.0075, 0);
    seam.material = seamMat;
    markDecorative(seam);
  }

  for (let row = 0; row < 7; row += 1) {
    const z = -halfL + 2.4 + row * 5.0;
    for (const x of [-9.6, -6.4, -3.2, 3.2, 6.4, 9.6]) {
      const nail = MeshBuilder.CreateCylinder(`decor_floor_nail_${row}_${x}`, {
        height: 0.004,
        diameter: 0.045,
        tessellation: 12
      }, scene);
      nail.position.set(x, 0.0105, z);
      nail.material = nailMat;
      markDecorative(nail);
    }
  }

  const blueLogoMat = createFloorLogoMaterial(scene, 'decor_floor_blue_crest_tex', '#174baf', '#ffd24a', 'BLUE COURT');
  const redLogoMat = createFloorLogoMaterial(scene, 'decor_floor_red_crest_tex', '#b82d2a', '#ffe27a', 'RED COURT');
  createFloorLogo(scene, 'decor_floor_blue_crest', -5.9, -2.65, blueLogoMat);
  createFloorLogo(scene, 'decor_floor_red_crest', 5.9, 2.65, redLogoMat);
}

function createFloorGloss(scene: Scene): void {
  const glossTexture = new DynamicTexture('decor_floor_gloss_texture', { width: 512, height: 512 }, scene, false);
  glossTexture.hasAlpha = true;
  const ctx = glossTexture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 512, 512);
  const gradient = ctx.createLinearGradient(0, 0, 512, 0);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.42, 'rgba(255,255,255,0.11)');
  gradient.addColorStop(0.5, 'rgba(255,242,202,0.18)');
  gradient.addColorStop(0.58, 'rgba(255,255,255,0.11)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 512);
  glossTexture.update(true);

  const glossMat = new StandardMaterial('decor_floor_gloss_overlay_mat', scene);
  glossMat.diffuseTexture = glossTexture;
  glossMat.opacityTexture = glossTexture;
  glossMat.useAlphaFromDiffuseTexture = true;
  glossMat.emissiveTexture = glossTexture;
  glossMat.emissiveColor = new Color3(0.45, 0.38, 0.28);
  glossMat.disableLighting = true;
  glossMat.backFaceCulling = false;
  glossMat.specularColor = new Color3(0, 0, 0);

  const highlights = [
    { name: 'decor_floor_gloss_overlay_0', x: -7.8, z: -2.0, width: 2.4, depth: 30.0 },
    { name: 'decor_floor_gloss_overlay_1', x: -2.8, z: 1.3, width: 1.8, depth: 27.0 },
    { name: 'decor_floor_gloss_overlay_2', x: 3.4, z: -1.0, width: 2.0, depth: 29.0 },
    { name: 'decor_floor_gloss_overlay_3', x: 8.1, z: 2.0, width: 1.6, depth: 24.0 }
  ];

  for (const highlight of highlights) {
    const mesh = MeshBuilder.CreatePlane(highlight.name, { width: highlight.width, height: highlight.depth }, scene);
    mesh.position.set(highlight.x, 0.026, highlight.z);
    mesh.rotation.x = Math.PI / 2;
    mesh.material = glossMat;
    markDecorative(mesh);
  }
}

function createOverheadLightLenses(scene: Scene): void {
  const lensMat = solidMaterial(scene, 'decor_overhead_light_lens_mat', new Color3(1.0, 0.96, 0.82), {
    emissive: new Color3(0.78, 0.72, 0.52),
    specular: new Color3(0.16, 0.16, 0.14)
  });
  const glowMat = solidMaterial(scene, 'decor_overhead_light_soft_glow_mat', new Color3(1.0, 0.9, 0.58), {
    alpha: 0.12,
    emissive: new Color3(0.52, 0.42, 0.24)
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
      width: 0.22,
      height: 0.018,
      depth: 0.98
    }, scene);
    lens.position.set(x, fixtureY, z);
    lens.material = lensMat;
    markDecorative(lens);

    const glow = MeshBuilder.CreatePlane(`decor_overhead_light_glow_${index}`, { width: 1.15, height: 1.85 }, scene);
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

function createCeilingConduits(scene: Scene): void {
  const conduitMat = solidMaterial(scene, 'decor_ceiling_conduit_mat', new Color3(0.18, 0.2, 0.22), {
    emissive: new Color3(0.004, 0.004, 0.005),
    specular: new Color3(0.12, 0.12, 0.12)
  });
  const junctionMat = solidMaterial(scene, 'decor_ceiling_junction_box_mat', new Color3(0.1, 0.115, 0.13), {
    emissive: new Color3(0.002, 0.002, 0.003),
    specular: new Color3(0.16, 0.15, 0.14)
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

function createWoodTexture(scene: Scene, name: string, tone: 'natural' | 'blue' | 'red'): DynamicTexture {
  const texture = new DynamicTexture(name, { width: 1024, height: 1024 }, scene, false);
  texture.hasAlpha = false;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  texture.anisotropicFilteringLevel = 8;

  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const palette = tone === 'blue'
    ? { base: '#d59a55', plank: '#e4aa64', line: '#8a4b21', tint: 'rgba(42, 92, 190, 0.26)', glow: 'rgba(255,255,255,0.085)' }
    : tone === 'red'
      ? { base: '#d98d45', plank: '#eba157', line: '#854018', tint: 'rgba(220, 76, 38, 0.25)', glow: 'rgba(255,244,218,0.08)' }
      : { base: '#d99a4d', plank: '#efb56b', line: '#8a4a20', tint: 'rgba(255,190,94,0.05)', glow: 'rgba(255,255,255,0.08)' };

  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, 1024, 1024);

  const plankWidth = 64;
  for (let x = 0; x < 1024; x += plankWidth) {
    ctx.fillStyle = (Math.floor(x / plankWidth) % 2 === 0) ? palette.plank : palette.base;
    ctx.globalAlpha = 0.34;
    ctx.fillRect(x, 0, plankWidth - 3, 1024);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = 'rgba(83, 39, 14, 0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + plankWidth - 2, 0);
    ctx.lineTo(x + plankWidth - 2, 1024);
    ctx.stroke();

    for (let y = 0; y < 1024; y += 128) {
      const seamY = y + ((x / plankWidth) % 3) * 22;
      ctx.strokeStyle = 'rgba(96, 48, 18, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 4, seamY);
      ctx.lineTo(x + plankWidth - 8, seamY + 8);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = palette.line;
  ctx.globalAlpha = 0.16;
  for (let y = 18; y < 1024; y += 31) {
    ctx.beginPath();
    for (let x = 0; x <= 1024; x += 24) {
      const wave = Math.sin((x + y) * 0.018) * 4 + Math.sin(x * 0.041) * 2;
      if (x === 0) ctx.moveTo(x, y + wave);
      else ctx.lineTo(x, y + wave);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let i = 0; i < 42; i += 1) {
    const x = (i * 151 + 73) % 1010 + 7;
    const y = (i * 89 + 211) % 980 + 22;
    const rx = 12 + (i % 5) * 3;
    const ry = 5 + (i % 4) * 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(((i * 37) % 120 - 60) * Math.PI / 180);
    const knot = ctx.createRadialGradient(0, 0, 1, 0, 0, rx);
    knot.addColorStop(0, 'rgba(97,43,15,0.26)');
    knot.addColorStop(0.48, 'rgba(118,55,19,0.16)');
    knot.addColorStop(1, 'rgba(255,210,136,0)');
    ctx.fillStyle = knot;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(82,36,12,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.65, ry * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = 'rgba(74,36,13,0.16)';
  for (let i = 0; i < 110; i += 1) {
    const x = (i * 97 + 31) % 1024;
    const y = (i * 193 + 17) % 1024;
    ctx.fillRect(x, y, 2, 2);
  }

  const shine = ctx.createLinearGradient(0, 0, 1024, 1024);
  shine.addColorStop(0, 'rgba(255,255,255,0.18)');
  shine.addColorStop(0.45, palette.glow);
  shine.addColorStop(1, 'rgba(98,45,14,0.12)');
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, 1024, 1024);

  ctx.fillStyle = palette.tint;
  ctx.fillRect(0, 0, 1024, 1024);

  texture.update(true);
  return texture;
}

function createCinderblockTexture(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture('decor_cinderblock_wall_tex', { width: 1024, height: 512 }, scene, false);
  texture.hasAlpha = false;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  texture.anisotropicFilteringLevel = 4;

  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#eee9df';
  ctx.fillRect(0, 0, 1024, 512);

  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fillRect(0, 0, 1024, 190);

  ctx.strokeStyle = 'rgba(124,117,105,0.22)';
  ctx.lineWidth = 2;
  const blockW = 128;
  const blockH = 56;
  for (let y = 0; y <= 512; y += blockH) {
    for (let x = -((Math.floor(y / blockH) % 2) * (blockW / 2)); x <= 1024; x += blockW) {
      const shade = ((x + y) / blockW) % 3;
      ctx.fillStyle = shade < 1 ? 'rgba(255,255,255,0.045)' : shade < 2 ? 'rgba(75,68,58,0.035)' : 'rgba(255,246,228,0.025)';
      ctx.fillRect(x + 3, y + 3, blockW - 7, blockH - 7);
    }

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(1024, y);
    ctx.stroke();

    const rowOffset = (Math.floor(y / blockH) % 2) * (blockW / 2);
    for (let x = -rowOffset; x <= 1024; x += blockW) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + blockH);
      ctx.stroke();
    }
  }

  ctx.fillStyle = 'rgba(70,64,56,0.16)';
  for (let i = 0; i < 360; i += 1) {
    const x = (i * 53 + 19) % 1024;
    const y = (i * 97 + 41) % 512;
    ctx.fillRect(x, y, 1, 1);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 130; i += 1) {
    const x = (i * 127 + 23) % 1024;
    const y = (i * 43 + 9) % 512;
    ctx.fillRect(x, y, 1, 1);
  }

  const vignette = ctx.createLinearGradient(0, 512, 0, 0);
  vignette.addColorStop(0, 'rgba(42,55,88,0.12)');
  vignette.addColorStop(1, 'rgba(255,255,255,0.04)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, 1024, 512);

  texture.update(true);
  return texture;
}

function createBannerMaterial(scene: Scene, spec: BannerSpec): StandardMaterial {
  const texture = new DynamicTexture(`${spec.name}_tex`, { width: 768, height: 384 }, scene, false);
  texture.hasAlpha = spec.shape !== 'rectangle';
  texture.anisotropicFilteringLevel = 8;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  if (spec.side === 'south') {
    texture.uScale = -1;
    texture.uOffset = 1;
  }

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
  const titleY = spec.subtitle ? height * 0.46 : height * 0.54;
  const subtitleY = height * 0.67;
  const textCenter = spec.icon && spec.width > 1.8 ? width * 0.57 : width * 0.5;
  const maxTitleWidth = spec.icon && spec.width > 1.8 ? width * 0.68 : width * 0.84;
  const maxSubtitleWidth = spec.icon && spec.width > 1.8 ? width * 0.62 : width * 0.78;

  drawFittedText(ctx, spec.title, textCenter, titleY, maxTitleWidth, spec.subtitle ? height * 0.19 : height * 0.26, spec.palette.text, spec.palette.shadow);
  if (spec.subtitle) {
    drawFittedText(ctx, spec.subtitle, textCenter, subtitleY, maxSubtitleWidth, height * 0.15, spec.palette.accent, spec.palette.shadow);
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
  if (shape === 'notched') {
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
  const cx = spec.shape === 'pennant' ? width * 0.28 : width * 0.17;
  const cy = spec.shape === 'pennant' ? height * 0.5 : height * 0.5;
  const size = Math.min(width, height) * (spec.shape === 'pennant' ? 0.22 : 0.24);

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

  drawDodgeballIcon(ctx, 214, 160, 52, '#f04a36', '#fff3d0');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawFittedText(ctx, 'STRAFEBALL', 432, 132, 320, 58, '#fff8dc', '#071225');
  drawFittedText(ctx, label, 432, 192, 260, 32, accent, '#071225');
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

function createAcousticPanelMaterial(scene: Scene): StandardMaterial {
  const texture = new DynamicTexture('decor_acoustic_panel_tex', { width: 512, height: 192 }, scene, false);
  texture.hasAlpha = false;
  texture.anisotropicFilteringLevel = 8;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#1b376f';
  ctx.fillRect(0, 0, 512, 192);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (let x = 18; x < 512; x += 22) {
    ctx.fillRect(x, 16, 3, 160);
  }
  ctx.strokeStyle = '#ffd24a';
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, 496, 176);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, 464, 144);
  texture.update(true);

  const material = new StandardMaterial('decor_acoustic_panel_mat', scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.12, 0.14, 0.18);
  material.specularColor = new Color3(0.04, 0.04, 0.04);
  material.backFaceCulling = false;
  return material;
}

function createSpeakerGrilleMaterial(scene: Scene): StandardMaterial {
  const texture = new DynamicTexture('decor_speaker_grille_tex', { width: 256, height: 320 }, scene, false);
  texture.hasAlpha = false;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, 256, 320);
  ctx.fillStyle = '#31343a';
  for (let y = 18; y < 306; y += 18) {
    for (let x = 18; x < 240; x += 18) {
      ctx.beginPath();
      ctx.arc(x, y, 3.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = '#151923';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, 242, 306);
  texture.update(true);

  const material = new StandardMaterial('decor_speaker_grille_mat', scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.04, 0.04, 0.045);
  material.specularColor = new Color3(0.02, 0.02, 0.02);
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

function createExitSignMaterial(scene: Scene): StandardMaterial {
  const texture = new DynamicTexture('decor_exit_sign_tex', { width: 384, height: 160 }, scene, false);
  texture.hasAlpha = false;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#083420';
  ctx.fillRect(0, 0, 384, 160);
  ctx.strokeStyle = '#d8ffe7';
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, 364, 140);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawFittedText(ctx, 'EXIT', 192, 83, 290, 82, '#d8ffe7', '#062114');
  texture.update(true);

  const material = new StandardMaterial('decor_exit_sign_mat', scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = new Color3(0.24, 0.62, 0.34);
  material.specularColor = new Color3(0.03, 0.04, 0.03);
  material.backFaceCulling = false;
  return material;
}

function createPlaqueMaterial(scene: Scene, name: string, title: string, subtitle: string): StandardMaterial {
  const texture = new DynamicTexture(name, { width: 640, height: 180 }, scene, false);
  texture.hasAlpha = false;
  texture.anisotropicFilteringLevel = 8;
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

function wallSpan(side: WallSide): number {
  return side === 'north' || side === 'south'
    ? TUNING.map.halfWidth * 2
    : TUNING.map.halfLength * 2;
}
