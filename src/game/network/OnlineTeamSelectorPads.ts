import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3
} from '@babylonjs/core';
import type { RoomState } from '../../../shared/types';

type TeamPadId = 'blue' | 'red' | 'start';

interface PadDef {
  id: TeamPadId;
  kind: 'team' | 'start';
  teamId?: string;
  title: string;
  subtitle: string;
  position: Vector3;
  main: Color3;
  accent: Color3;
}

interface Pad extends PadDef {
  material: StandardMaterial;
  idleEmissive: Color3;
  activeEmissive: Color3;
  chosenEmissive: Color3;
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

const PAD_DEFS: PadDef[] = [
  {
    id: 'blue',
    kind: 'team',
    teamId: 'blue',
    title: 'BLUE',
    subtitle: 'TEAM CIRCLE',
    position: new Vector3(-4.3, 0, 0),
    main: new Color3(0.08, 0.4, 1.0),
    accent: new Color3(0.35, 0.86, 1.0)
  },
  {
    id: 'red',
    kind: 'team',
    teamId: 'red',
    title: 'RED',
    subtitle: 'TEAM CIRCLE',
    position: new Vector3(4.3, 0, 0),
    main: new Color3(0.95, 0.12, 0.16),
    accent: new Color3(1.0, 0.58, 0.38)
  },
  {
    id: 'start',
    kind: 'start',
    title: 'START',
    subtitle: 'VOTE CIRCLE',
    position: new Vector3(0, 0, 2.85),
    main: new Color3(1.0, 0.72, 0.12),
    accent: new Color3(1.0, 0.92, 0.24)
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

    const local = room.players[localPlayerId] ?? null;
    const nearest = this.nearestPad(playerPosition, room);
    this.updateGlow(nearest?.id ?? null, room, localPlayerId);

    if (!nearest) {
      this.activePadId = null;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
      this.setPromptVisible(false);
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
      return false;
    }

    if (!this.activatedThisHold) {
      this.holdSeconds = Math.min(HOLD_SECONDS, this.holdSeconds + dt);
      this.updatePromptProgress(this.holdSeconds / HOLD_SECONDS);
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
    }
  }

  dispose(): void {
    this.prompt.remove();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private createPad(def: PadDef): void {
    const padMat = new StandardMaterial(`online_team_${def.id}_pad_mat`, this.scene);
    padMat.diffuseColor = def.main;
    padMat.emissiveColor = def.accent.scale(0.18);
    padMat.specularColor = new Color3(0.1, 0.1, 0.1);
    padMat.alpha = 0.86;
    this.disposables.push(padMat);

    const pad = MeshBuilder.CreateCylinder(
      `online_team_${def.id}_pad`,
      { diameter: def.kind === 'start' ? 2.45 : 2.9, height: 0.045, tessellation: 72 },
      this.scene
    );
    pad.position.set(def.position.x, 0.035, def.position.z);
    pad.material = padMat;
    pad.isPickable = false;
    this.disposables.push(pad);

    const rimMat = new StandardMaterial(`online_team_${def.id}_rim_mat`, this.scene);
    rimMat.diffuseColor = def.accent;
    rimMat.emissiveColor = def.accent.scale(0.42);
    rimMat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(rimMat);

    const rim = MeshBuilder.CreateTorus(
      `online_team_${def.id}_rim`,
      { diameter: def.kind === 'start' ? 2.52 : 2.98, thickness: 0.075, tessellation: 80 },
      this.scene
    );
    rim.position.set(def.position.x, 0.07, def.position.z);
    rim.rotation.x = Math.PI / 2;
    rim.material = rimMat;
    rim.isPickable = false;
    this.disposables.push(rim);

    const tex = this.createLabelTexture(`online_team_${def.id}_label_tex`, def.title, def.subtitle, def.main, def.accent);
    const labelMat = new StandardMaterial(`online_team_${def.id}_label_mat`, this.scene);
    labelMat.diffuseTexture = tex;
    labelMat.emissiveTexture = tex;
    labelMat.emissiveColor = new Color3(1, 1, 1);
    labelMat.disableLighting = true;
    labelMat.specularColor = new Color3(0, 0, 0);
    labelMat.backFaceCulling = false;
    this.disposables.push(tex, labelMat);

    const label = MeshBuilder.CreatePlane(
      `online_team_${def.id}_label`,
      { width: def.kind === 'start' ? 2.1 : 2.45, height: 0.92 },
      this.scene
    );
    label.position.set(def.position.x, 1.08, def.position.z + 0.05);
    label.billboardMode = Mesh.BILLBOARDMODE_Y;
    label.material = labelMat;
    label.isPickable = false;
    this.disposables.push(label);

    this.pads.push({
      ...def,
      material: padMat,
      idleEmissive: def.accent.scale(0.18),
      activeEmissive: def.accent.scale(0.5),
      chosenEmissive: def.accent.scale(0.75),
      meshes: [pad, rim, label]
    });
  }

  private createLabelTexture(name: string, title: string, subtitle: string, main: Color3, accent: Color3): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 640, height: 300 }, this.scene, false);
    tex.hasAlpha = false;
    const bg = colorToHex(main.scale(0.22));
    const fg = colorToHex(accent);
    tex.drawText('', 0, 0, '1px Arial', '#000000', bg, false, false);
    tex.drawText(title, null, 118, 'bold 78px Arial', fg, 'transparent', false, false);
    tex.drawText(subtitle, null, 190, 'bold 32px Arial', '#fff6d8', 'transparent', false, false);
    tex.update(true);
    return tex;
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
      const color = pad.id === activePadId
        ? pad.activeEmissive
        : selectedTeam || selectedStart
          ? pad.chosenEmissive
          : pad.idleEmissive;
      pad.material.emissiveColor.copyFrom(color);
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

function colorToHex(color: Color3): string {
  const r = channelToHex(color.r);
  const g = channelToHex(color.g);
  const b = channelToHex(color.b);
  return `#${r}${g}${b}`;
}

function channelToHex(value: number): string {
  const n = Math.max(0, Math.min(255, Math.round(value * 255)));
  return n.toString(16).padStart(2, '0');
}
