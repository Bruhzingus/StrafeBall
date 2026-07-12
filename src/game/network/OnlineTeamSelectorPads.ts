import {
  Color3,
  DynamicTexture,
  Material,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3
} from '@babylonjs/core';
import type { RoomState } from '../../../shared/types';
import { addPolishedGlowMesh } from '../effects/PolishedPostFX';

type TeamPadId = 'blue' | 'red' | 'start';

interface PadDef {
  id: TeamPadId;
  kind: 'team' | 'start';
  teamId?: string;
  title: string;
  subtitle: string;
  helper: string;
  position: Vector3;
  main: Color3;
  accent: Color3;
  gold: Color3;
  width: number;
}

interface Pad extends PadDef {
  padMaterial: StandardMaterial;
  trimMaterial: StandardMaterial;
  promptFillMaterial: StandardMaterial;
  promptFill: Mesh;
  promptFillWidth: number;
  meshes: Mesh[];
}

interface PromptCopy {
  title: string;
  subtitle: string;
  hint: string;
  actionable: boolean;
}

const HOLD_SECONDS = 0.65;
const ACTIVATE_RADIUS = 2.05;
const PROMPT_FILL_WIDTH = 0.72;

const DARK = new Color3(0.025, 0.045, 0.085);
const NEUTRAL_DARK = new Color3(0.055, 0.055, 0.07);

const PAD_DEFS: PadDef[] = [
  {
    id: 'blue',
    kind: 'team',
    teamId: 'blue',
    title: 'BLUE TEAM',
    subtitle: 'Join / confirm',
    helper: 'Choose this side',
    position: new Vector3(-4.3, 0, 0),
    main: new Color3(0.06, 0.28, 0.64),
    accent: new Color3(0.32, 0.9, 1.0),
    gold: new Color3(1.0, 0.75, 0.16),
    width: 2.0
  },
  {
    id: 'red',
    kind: 'team',
    teamId: 'red',
    title: 'RED TEAM',
    subtitle: 'Join / confirm',
    helper: 'Choose this side',
    position: new Vector3(4.3, 0, 0),
    main: new Color3(0.58, 0.065, 0.075),
    accent: new Color3(1.0, 0.42, 0.34),
    gold: new Color3(1.0, 0.75, 0.16),
    width: 2.0
  },
  {
    id: 'start',
    kind: 'start',
    title: 'START VOTE',
    subtitle: 'Ready check',
    helper: 'Begin when teams are locked',
    position: new Vector3(0, 0, 2.85),
    main: new Color3(0.45, 0.32, 0.055),
    accent: new Color3(1.0, 0.86, 0.22),
    gold: new Color3(1.0, 0.86, 0.22),
    width: 2.25
  }
];

export class OnlineTeamSelectorPads {
  private readonly pads: Pad[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly prompt: HTMLDivElement;
  private readonly promptTitle: HTMLDivElement;
  private readonly promptSubtitle: HTMLDivElement;
  private readonly promptHint: HTMLDivElement;
  private readonly promptFill: HTMLDivElement;
  private enabled = true;
  private promptVisible = false;
  private activePadId: TeamPadId | null = null;
  private lastGlowKey = '';
  private lastPromptKey = '';
  private holdSeconds = 0;
  private activatedThisHold = false;

  constructor(private readonly scene: Scene) {
    for (const def of PAD_DEFS) this.createPad(def);
    this.setEnabled(false);

    this.prompt = document.createElement('div');
    this.prompt.className = 'lobby-mode-prompt online-team-prompt';
    this.prompt.innerHTML = `
      <div class="lobby-mode-prompt__eyebrow">2v2 Pregame</div>
      <div class="lobby-mode-prompt__title"></div>
      <div class="lobby-mode-prompt__subtitle"></div>
      <div class="lobby-mode-prompt__hint"></div>
      <div class="lobby-mode-prompt__bar"><div></div></div>
    `;
    document.getElementById('hud-root')?.appendChild(this.prompt);
    this.promptTitle = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__title');
    this.promptSubtitle = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__subtitle');
    this.promptHint = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__hint');
    this.promptFill = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__bar > div');
    this.setPromptVisible(false);
  }

  update(
    dt: number,
    playerPosition: Vector3,
    interactHeld: boolean,
    room: RoomState | null,
    localPlayerId: string,
    actions: {
      chooseTeam: (teamId: string) => void;
      voteStart: () => void;
    }
  ): boolean {
    const shouldEnable = isSelectorVisible(room);
    this.setEnabled(shouldEnable);
    if (!shouldEnable || !room) return false;

    const nearest = this.nearestPad(playerPosition, room);
    this.updateGlow(nearest?.id ?? null, room, localPlayerId);

    if (!nearest) {
      this.activePadId = null;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
      this.setPromptVisible(false);
      this.updateWorldProgress(null, 0);
      return false;
    }

    if (this.activePadId !== nearest.id) {
      this.activePadId = nearest.id;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
    }

    const copy = this.promptCopy(nearest, room, localPlayerId);
    this.updatePrompt(nearest.id, copy);

    if (!copy.actionable || !interactHeld) {
      if (!interactHeld) this.activatedThisHold = false;
      this.holdSeconds = 0;
      this.updatePromptProgress(0);
      this.updateWorldProgress(nearest.id, 0);
      return false;
    }

    if (!this.activatedThisHold) {
      this.holdSeconds = Math.min(HOLD_SECONDS, this.holdSeconds + dt);
      this.updatePromptProgress(this.holdSeconds / HOLD_SECONDS);
      this.updateWorldProgress(nearest.id, this.holdSeconds / HOLD_SECONDS);
      if (this.holdSeconds >= HOLD_SECONDS) {
        this.activatedThisHold = true;
        if (nearest.kind === 'team' && nearest.teamId) actions.chooseTeam(nearest.teamId);
        else if (nearest.kind === 'start') actions.voteStart();
      }
    }

    return true;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const pad of this.pads) {
      for (const mesh of pad.meshes) mesh.setEnabled(enabled);
    }
    if (!enabled) {
      this.activePadId = null;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
      this.setPromptVisible(false);
      this.updateWorldProgress(null, 0);
    }
  }

  dispose(): void {
    this.prompt.remove();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private createPad(def: PadDef): void {
    const panelHeight = def.kind === 'start' ? 0.94 : 0.86;
    const stationZ = def.position.z + 0.54;
    const platformDepth = def.kind === 'start' ? 1.65 : 1.48;
    const bodyColor = def.kind === 'start' ? NEUTRAL_DARK : DARK;

    const padMaterial = this.createSolidMaterial(`online_team_${def.id}_pad_mat`, def.main.scale(0.58), def.accent.scale(0.08));
    const trimMaterial = this.createSolidMaterial(`online_team_${def.id}_trim_mat`, def.gold.scale(0.86), def.gold.scale(0.18));
    const bodyMaterial = this.createSolidMaterial(`online_team_${def.id}_body_mat`, bodyColor, def.main.scale(0.035));
    const fillMaterial = this.createSolidMaterial(`online_team_${def.id}_fill_mat`, def.accent, def.accent.scale(0.48));
    this.disposables.push(padMaterial, trimMaterial, bodyMaterial, fillMaterial);

    const meshes: Mesh[] = [];
    const add = (mesh: Mesh, freeze = true): Mesh => {
      mesh.isPickable = false;
      meshes.push(mesh);
      this.disposables.push(mesh);
      if (freeze) mesh.freezeWorldMatrix();
      return mesh;
    };

    const platform = MeshBuilder.CreateCylinder(
      `online_team_${def.id}_platform`,
      { diameter: 1, height: 0.055, tessellation: 56 },
      this.scene
    );
    platform.scaling.set(def.width * 0.48, 1, platformDepth * 0.45);
    platform.position.set(def.position.x, 0.028, def.position.z);
    platform.material = bodyMaterial;
    add(platform);

    const inset = MeshBuilder.CreateCylinder(
      `online_team_${def.id}_platform_inset`,
      { diameter: 1, height: 0.022, tessellation: 56 },
      this.scene
    );
    inset.scaling.set(def.width * 0.38, 1, platformDepth * 0.33);
    inset.position.set(def.position.x, 0.073, def.position.z);
    inset.material = padMaterial;
    add(inset);

    const frontTrim = MeshBuilder.CreateBox(
      `online_team_${def.id}_front_trim`,
      { width: def.width * 0.62, height: 0.016, depth: 0.052 },
      this.scene
    );
    frontTrim.position.set(def.position.x, 0.098, def.position.z - platformDepth * 0.31);
    frontTrim.material = trimMaterial;
    add(frontTrim);

    for (const side of [-1, 1] as const) {
      const sideTrim = MeshBuilder.CreateBox(
        `online_team_${def.id}_side_trim_${side}`,
        { width: 0.05, height: 0.016, depth: platformDepth * 0.52 },
        this.scene
      );
      sideTrim.position.set(def.position.x + side * (def.width * 0.37), 0.096, def.position.z - 0.02);
      sideTrim.material = trimMaterial;
      add(sideTrim);
    }

    const pedestal = MeshBuilder.CreateBox(
      `online_team_${def.id}_pedestal`,
      { width: def.width * 0.22, height: 0.32, depth: 0.28 },
      this.scene
    );
    pedestal.position.set(def.position.x, 0.25, stationZ + 0.1);
    pedestal.material = bodyMaterial;
    add(pedestal);

    const neck = MeshBuilder.CreateBox(
      `online_team_${def.id}_neck`,
      { width: def.width * 0.32, height: 0.11, depth: 0.15 },
      this.scene
    );
    neck.position.set(def.position.x, 0.49, stationZ + 0.07);
    neck.material = trimMaterial;
    add(neck);

    const panelBack = MeshBuilder.CreateBox(
      `online_team_${def.id}_panel_back`,
      { width: def.width, height: panelHeight, depth: 0.095 },
      this.scene
    );
    panelBack.position.set(def.position.x, 0.98, stationZ + 0.025);
    panelBack.material = bodyMaterial;
    add(panelBack);

    const tex = this.createLabelTexture(`online_team_${def.id}_label_tex`, def);
    const labelMat = new StandardMaterial(`online_team_${def.id}_label_mat`, this.scene);
    labelMat.diffuseTexture = tex;
    labelMat.emissiveTexture = tex;
    labelMat.emissiveColor = new Color3(1, 1, 1);
    labelMat.disableLighting = true;
    labelMat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(tex, labelMat);

    const label = MeshBuilder.CreatePlane(
      `online_team_${def.id}_label`,
      { width: def.width - 0.18, height: panelHeight - 0.16 },
      this.scene
    );
    label.position.set(def.position.x, 0.98, stationZ - 0.045);
    label.material = labelMat;
    add(label);

    for (const side of [-1, 1] as const) {
      const sideCap = MeshBuilder.CreateBox(
        `online_team_${def.id}_panel_side_${side}`,
        { width: 0.05, height: panelHeight + 0.08, depth: 0.11 },
        this.scene
      );
      sideCap.position.set(def.position.x + side * (def.width * 0.5 + 0.023), 0.98, stationZ - 0.012);
      sideCap.material = trimMaterial;
      add(sideCap);
    }

    const topCap = MeshBuilder.CreateBox(
      `online_team_${def.id}_panel_top`,
      { width: def.width + 0.08, height: 0.05, depth: 0.11 },
      this.scene
    );
    topCap.position.set(def.position.x, 0.98 + panelHeight * 0.5 + 0.027, stationZ - 0.012);
    topCap.material = trimMaterial;
    add(topCap);

    const bottomCap = MeshBuilder.CreateBox(
      `online_team_${def.id}_panel_bottom`,
      { width: def.width + 0.08, height: 0.05, depth: 0.11 },
      this.scene
    );
    bottomCap.position.set(def.position.x, 0.98 - panelHeight * 0.5 - 0.027, stationZ - 0.012);
    bottomCap.material = trimMaterial;
    add(bottomCap);

    const promptTex = this.createPromptTexture(`online_team_${def.id}_prompt_tex`, def);
    const promptMat = new StandardMaterial(`online_team_${def.id}_prompt_mat`, this.scene);
    promptMat.diffuseTexture = promptTex;
    promptMat.emissiveTexture = promptTex;
    promptMat.emissiveColor = new Color3(1, 1, 1);
    promptMat.disableLighting = true;
    promptMat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(promptTex, promptMat);

    const prompt = MeshBuilder.CreatePlane(`online_team_${def.id}_prompt`, { width: 0.98, height: 0.25 }, this.scene);
    prompt.position.set(def.position.x, 0.35, def.position.z + 0.02);
    prompt.material = promptMat;
    add(prompt);

    const promptFill = MeshBuilder.CreatePlane(
      `online_team_${def.id}_progress`,
      { width: PROMPT_FILL_WIDTH, height: 0.024 },
      this.scene
    );
    promptFill.position.set(def.position.x - PROMPT_FILL_WIDTH * 0.5, 0.255, def.position.z - 0.065);
    promptFill.scaling.x = 0;
    promptFill.material = fillMaterial;
    add(promptFill, false);

    // Register the physical emissive accents, never the label/prompt text planes. This happens in
    // the constructor because these stations are built after ArenaScene's initial gym glow scan.
    for (const mesh of meshes) {
      if (mesh.material === padMaterial || mesh.material === trimMaterial || mesh.material === fillMaterial) {
        addPolishedGlowMesh(mesh);
      }
    }

    this.pads.push({
      ...def,
      padMaterial,
      trimMaterial,
      promptFillMaterial: fillMaterial,
      promptFill,
      promptFillWidth: PROMPT_FILL_WIDTH,
      meshes
    });
  }

  private createLabelTexture(name: string, def: PadDef): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 760, height: 360 }, this.scene, true);
    tex.hasAlpha = false;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 760, 360);

    ctx.fillStyle = colorToHex(def.kind === 'start' ? NEUTRAL_DARK : DARK);
    ctx.fillRect(0, 0, 760, 360);

    const gradient = ctx.createLinearGradient(0, 0, 760, 360);
    gradient.addColorStop(0, colorToRgba(def.main, 0.28));
    gradient.addColorStop(0.55, colorToRgba(def.kind === 'start' ? NEUTRAL_DARK : DARK, 0.98));
    gradient.addColorStop(1, colorToRgba(def.main, 0.16));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 760, 360);

    ctx.fillStyle = colorToRgba(def.gold, 0.88);
    ctx.fillRect(0, 0, 760, 10);
    ctx.fillRect(0, 350, 760, 10);
    ctx.fillStyle = colorToRgba(def.accent, 0.4);
    ctx.fillRect(38, 44, 684, 4);
    ctx.fillRect(38, 314, 684, 4);

    drawCentered(ctx, def.kind === 'start' ? 'GAME START' : 'TEAM SELECT', 68, '800 24px Arial', '#fff4ce', 380);
    drawCentered(ctx, def.title, 162, '900 66px Arial', colorToHex(def.accent), 380);
    drawCentered(ctx, def.subtitle.toUpperCase(), 224, '800 30px Arial', '#fff8dc', 380);
    drawCentered(ctx, def.helper.toUpperCase(), 270, '700 21px Arial', '#d8e7ff', 380);
    tex.update(true);
    return tex;
  }

  private createPromptTexture(name: string, def: PadDef): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 320, height: 96 }, this.scene, true);
    tex.hasAlpha = false;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 320, 96);
    ctx.fillStyle = colorToHex(def.kind === 'start' ? NEUTRAL_DARK : DARK);
    ctx.fillRect(0, 0, 320, 96);
    ctx.fillStyle = colorToRgba(def.gold, 0.9);
    ctx.fillRect(0, 0, 320, 8);
    ctx.fillRect(0, 88, 320, 8);
    drawCentered(ctx, def.kind === 'start' ? 'START' : def.teamId?.toUpperCase() ?? 'TEAM', 35, '800 22px Arial', colorToHex(def.accent), 160);
    drawCentered(ctx, 'HOLD  E', 68, '900 30px Arial', '#ffffff', 160);
    tex.update(true);
    return tex;
  }

  private createSolidMaterial(name: string, diffuse: Color3, emissive: Color3, alpha?: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = diffuse;
    material.emissiveColor = emissive;
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    if (alpha !== undefined) {
      material.alpha = alpha;
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      material.backFaceCulling = false;
      material.specularColor = new Color3(0, 0, 0);
    }
    return material;
  }

  private nearestPad(playerPosition: Vector3, room: RoomState): Pad | null {
    let best: Pad | null = null;
    let bestDistSq = ACTIVATE_RADIUS * ACTIVATE_RADIUS;
    const availableTeams = new Set(room.match.teamIds);
    for (const pad of this.pads) {
      if (pad.kind === 'team' && (!pad.teamId || !availableTeams.has(pad.teamId))) continue;
      const dx = playerPosition.x - pad.position.x;
      const dz = playerPosition.z - pad.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > bestDistSq) continue;
      bestDistSq = distSq;
      best = pad;
    }
    return best;
  }

  private promptCopy(pad: Pad, room: RoomState, localPlayerId: string): PromptCopy {
    const local = room.players[localPlayerId] ?? null;
    if (pad.kind === 'start') {
      const ready = canVoteStart(room);
      return {
        title: ready ? 'VOTE START' : 'TEAMS FIRST',
        subtitle: ready
          ? `Start vote ${room.startVote.voteCount}/${room.startVote.requiredVotes}`
          : `Teams chosen ${room.startVote.teamChoiceCount}/${room.startVote.requiredTeamChoices}`,
        hint: ready ? '<span class="key">E</span> hold to vote' : 'Choose teams to unlock start',
        actionable: ready
      };
    }

    const teamId = pad.teamId ?? '';
    const teamName = teamId.toUpperCase();
    const localChoice = local ? room.startVote.teamChoicesByPlayerId[local.id] === true : false;
    const onThisTeam = local?.teamId === teamId;
    const teamCount = Object.values(room.players).filter((player) => player.connected !== false && player.teamId === teamId).length;
    return {
      title: onThisTeam && localChoice ? `${teamName} READY` : onThisTeam ? `CONFIRM ${teamName}` : `JOIN ${teamName}`,
      subtitle: `${teamName} players ${teamCount}/${room.match.playersPerTeam}`,
      hint: '<span class="key">E</span> hold to choose',
      actionable: true
    };
  }

  private updatePrompt(padId: TeamPadId, copy: PromptCopy): void {
    const key = `${padId}:${copy.title}:${copy.subtitle}:${copy.hint}:${Number(copy.actionable)}`;
    if (this.lastPromptKey !== key) {
      this.lastPromptKey = key;
      this.prompt.dataset.pad = padId;
      this.promptTitle.textContent = copy.title;
      this.promptSubtitle.textContent = copy.subtitle;
      this.promptHint.innerHTML = copy.hint;
    }
    this.setPromptVisible(true);
  }

  private updatePromptProgress(percent01: number): void {
    const pct = Math.round(Math.max(0, Math.min(1, percent01)) * 100);
    this.promptFill.style.width = `${pct}%`;
  }

  private updateWorldProgress(activePadId: TeamPadId | null, percent01: number): void {
    const progress = Math.max(0, Math.min(1, percent01));
    for (const pad of this.pads) {
      const active = pad.id === activePadId;
      const value = active ? progress : 0;
      pad.promptFill.scaling.x = value;
      pad.promptFill.position.x = pad.position.x - pad.promptFillWidth * (1 - value) * 0.5;
      pad.promptFillMaterial.emissiveColor.copyFrom(pad.accent.scale(active ? 0.46 + value * 0.5 : 0.25));
    }
  }

  private updateGlow(activePadId: TeamPadId | null, room: RoomState, localPlayerId: string): void {
    const local = room.players[localPlayerId] ?? null;
    const localChoice = local ? room.startVote.teamChoicesByPlayerId[local.id] === true : false;
    const key = [
      activePadId ?? 'none',
      local?.teamId ?? 'none',
      Number(localChoice),
      room.startVote.teamChoiceCount,
      room.startVote.requiredTeamChoices,
      room.startVote.voteCount,
      room.startVote.requiredVotes
    ].join(':');
    if (key === this.lastGlowKey) return;
    this.lastGlowKey = key;

    const voteReady = canVoteStart(room);
    for (const pad of this.pads) {
      const selectedTeam = pad.kind === 'team' && localChoice && local?.teamId === pad.teamId;
      const selectedStart = pad.kind === 'start' && voteReady;
      const active = pad.id === activePadId;
      const padScale = active ? 0.24 : selectedTeam || selectedStart ? 0.2 : 0.08;
      const trimScale = active ? 0.46 : selectedTeam || selectedStart ? 0.38 : 0.18;
      pad.padMaterial.emissiveColor.copyFrom(pad.accent.scale(padScale));
      pad.trimMaterial.emissiveColor.copyFrom(pad.gold.scale(trimScale));
    }
  }

  private setPromptVisible(visible: boolean): void {
    if (this.promptVisible === visible) return;
    this.promptVisible = visible;
    this.prompt.classList.toggle('lobby-mode-prompt--visible', visible);
    if (!visible) this.updatePromptProgress(0);
  }

  private mustPromptElement<T extends Element>(selector: string): T {
    const element = this.prompt.querySelector<T>(selector);
    if (!element) throw new Error(`Missing online team prompt element: ${selector}`);
    return element;
  }
}

function isSelectorVisible(room: RoomState | null): boolean {
  return room?.match.mode === '2v2' && room.match.status === 'warmup';
}

function canVoteStart(room: RoomState): boolean {
  return room.startVote.requiredVotes > 0 &&
    room.startVote.requiredTeamChoices > 0 &&
    room.startVote.teamChoiceCount >= room.startVote.requiredTeamChoices;
}

function drawCentered(
  ctx: ReturnType<DynamicTexture['getContext']>,
  text: string,
  y: number,
  font: string,
  color: string,
  centerX: number
): void {
  const textCtx = ctx as ReturnType<DynamicTexture['getContext']> & {
    textAlign: CanvasTextAlign;
    textBaseline: CanvasTextBaseline;
  };
  ctx.font = font;
  ctx.fillStyle = color;
  textCtx.textAlign = 'center';
  textCtx.textBaseline = 'middle';
  ctx.fillText(text, centerX, y);
}

function colorToHex(color: Color3): string {
  const r = channelToHex(color.r);
  const g = channelToHex(color.g);
  const b = channelToHex(color.b);
  return `#${r}${g}${b}`;
}

function colorToRgba(color: Color3, alpha: number): string {
  const r = Math.max(0, Math.min(255, Math.round(color.r * 255)));
  const g = Math.max(0, Math.min(255, Math.round(color.g * 255)));
  const b = Math.max(0, Math.min(255, Math.round(color.b * 255)));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function channelToHex(value: number): string {
  const n = Math.max(0, Math.min(255, Math.round(value * 255)));
  return n.toString(16).padStart(2, '0');
}
