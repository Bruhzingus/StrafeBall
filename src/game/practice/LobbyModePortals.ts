import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';

export type LobbyMode = '1v1' | '2v2';

interface ModeZone {
  mode: LobbyMode;
  title: string;
  subtitle: string;
  position: Vector3;
  material: StandardMaterial;
  idleEmissive: Color3;
  activeEmissive: Color3;
}

type ModeZoneDef = Omit<ModeZone, 'material' | 'idleEmissive' | 'activeEmissive'>;

const HOLD_SECONDS = 0.65;
const ACTIVATE_RADIUS = 2.25;

const ZONES: ModeZoneDef[] = [
  {
    mode: '1v1',
    title: '1v1 DUEL',
    subtitle: 'Private match code',
    position: new Vector3(-3.4, 0, -11.15)
  },
  {
    mode: '2v2',
    title: '2v2 TEAMS',
    subtitle: 'Team lobby setup',
    position: new Vector3(3.4, 0, -11.15)
  }
];

export class LobbyModePortals {
  private readonly zones: ModeZone[] = [];
  private readonly meshes: Mesh[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly prompt: HTMLDivElement;
  private readonly promptTitle: HTMLDivElement;
  private readonly promptSubtitle: HTMLDivElement;
  private readonly promptFill: HTMLDivElement;
  private activeMode: LobbyMode | null = null;
  private lastGlowMode: LobbyMode | null = null;
  private lastPromptMode: LobbyMode | null = null;
  private lastPromptPercent = -1;
  private promptVisible = false;
  private holdSeconds = 0;
  private activatedThisHold = false;
  private enabled = true;

  constructor(private readonly scene: Scene) {
    for (const def of ZONES) this.createZone(def);

    this.prompt = document.createElement('div');
    this.prompt.className = 'lobby-mode-prompt';
    this.prompt.innerHTML = `
      <div class="lobby-mode-prompt__eyebrow">Match Lobby</div>
      <div class="lobby-mode-prompt__title"></div>
      <div class="lobby-mode-prompt__subtitle"></div>
      <div class="lobby-mode-prompt__hint"><span class="key">E</span> hold to open</div>
      <div class="lobby-mode-prompt__bar"><div></div></div>
    `;
    document.getElementById('hud-root')?.appendChild(this.prompt);
    this.promptTitle = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__title');
    this.promptSubtitle = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__subtitle');
    this.promptFill = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__bar > div');
    this.setPromptVisible(false);
  }

  update(dt: number, playerPosition: Vector3, interactHeld: boolean, onActivate: (mode: LobbyMode) => void): void {
    if (!this.enabled) {
      this.setPromptVisible(false);
      return;
    }

    const nearest = this.nearestZone(playerPosition);
    if (!nearest) {
      this.activeMode = null;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
      this.setPromptVisible(false);
      this.updateGlow(null);
      return;
    }

    this.activeMode = nearest.mode;
    this.updateGlow(nearest.mode);

    if (!interactHeld) {
      this.holdSeconds = 0;
      this.activatedThisHold = false;
    } else if (!this.activatedThisHold) {
      this.holdSeconds = Math.min(HOLD_SECONDS, this.holdSeconds + dt);
      if (this.holdSeconds >= HOLD_SECONDS) {
        this.activatedThisHold = true;
        onActivate(nearest.mode);
      }
    }

    this.updatePrompt(nearest);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const mesh of this.meshes) mesh.setEnabled(enabled);
    if (!enabled) this.setPromptVisible(false);
  }

  dispose(): void {
    this.prompt.remove();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private createZone(def: ModeZoneDef): void {
    const isDuel = def.mode === '1v1';
    const main = isDuel ? new Color3(0.12, 0.58, 0.95) : new Color3(1.0, 0.58, 0.14);
    const accent = isDuel ? new Color3(0.04, 0.92, 1.0) : new Color3(1.0, 0.88, 0.16);

    const padMat = new StandardMaterial(`lobby_${def.mode}_pad_mat`, this.scene);
    padMat.diffuseColor = main;
    padMat.emissiveColor = accent.scale(0.16);
    padMat.specularColor = new Color3(0.12, 0.12, 0.12);
    this.disposables.push(padMat);

    const pad = MeshBuilder.CreateBox(`lobby_${def.mode}_pad`, { width: 2.55, height: 0.035, depth: 2.0 }, this.scene);
    pad.position.set(def.position.x, 0.028, def.position.z);
    pad.material = padMat;
    pad.isPickable = false;
    this.meshes.push(pad);
    this.disposables.push(pad);

    const rimMat = new StandardMaterial(`lobby_${def.mode}_rim_mat`, this.scene);
    rimMat.diffuseColor = accent;
    rimMat.emissiveColor = accent.scale(0.26);
    rimMat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(rimMat);

    const rim = MeshBuilder.CreateBox(`lobby_${def.mode}_rim`, { width: 2.72, height: 0.04, depth: 2.18 }, this.scene);
    rim.position.set(def.position.x, 0.02, def.position.z);
    rim.material = rimMat;
    rim.isPickable = false;
    this.meshes.push(rim);
    this.disposables.push(rim);

    const signBackMat = new StandardMaterial(`lobby_${def.mode}_sign_back_mat`, this.scene);
    signBackMat.diffuseColor = new Color3(0.04, 0.07, 0.13);
    signBackMat.emissiveColor = main.scale(0.04);
    this.disposables.push(signBackMat);

    const signZ = def.position.z + 1.32;
    const signBack = MeshBuilder.CreateBox(`lobby_${def.mode}_sign_back`, { width: 2.75, height: 1.35, depth: 0.08 }, this.scene);
    signBack.position.set(def.position.x, 1.22, signZ + 0.025);
    signBack.rotation.y = 0;
    signBack.material = signBackMat;
    signBack.isPickable = false;
    this.meshes.push(signBack);
    this.disposables.push(signBack);

    const tex = this.createSignTexture(`lobby_${def.mode}_sign_tex`, def.title, def.subtitle, isDuel);
    const labelMat = new StandardMaterial(`lobby_${def.mode}_label_mat`, this.scene);
    labelMat.diffuseTexture = tex;
    labelMat.emissiveTexture = tex;
    labelMat.emissiveColor = new Color3(1, 1, 1);
    labelMat.disableLighting = true;
    labelMat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(tex, labelMat);

    const label = MeshBuilder.CreatePlane(`lobby_${def.mode}_label_front`, { width: 2.58, height: 1.18 }, this.scene);
    label.position.set(def.position.x, 1.22, signZ - 0.025);
    // These signs sit NORTH of the spawn lane and must face back SOUTH toward the player.
    // The guide walls use PI because they sit on the south wall facing north; the portal signs are
    // the opposite orientation, so leaving them at 0 matches the actual viewing side.
    label.rotation.y = 0;
    label.material = labelMat;
    label.isPickable = false;
    this.meshes.push(label);
    this.disposables.push(label);

    const backLabel = MeshBuilder.CreatePlane(`lobby_${def.mode}_label_back`, { width: 2.58, height: 1.18 }, this.scene);
    backLabel.position.set(def.position.x, 1.22, signZ + 0.075);
    backLabel.rotation.y = Math.PI;
    backLabel.material = labelMat;
    backLabel.isPickable = false;
    this.meshes.push(backLabel);
    this.disposables.push(backLabel);

    pad.freezeWorldMatrix();
    rim.freezeWorldMatrix();
    signBack.freezeWorldMatrix();
    label.freezeWorldMatrix();
    backLabel.freezeWorldMatrix();
    this.zones.push({
      ...def,
      material: padMat,
      idleEmissive: accent.scale(0.16),
      activeEmissive: accent.scale(0.36)
    });
  }

  private createSignTexture(name: string, title: string, subtitle: string, isDuel: boolean): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 768, height: 360 }, this.scene, false);
    tex.hasAlpha = false;
    tex.drawText('', 0, 0, '1px Arial', '#000', isDuel ? '#071a2f' : '#2a1407', false, false);
    tex.drawText(title, null, 130, 'bold 72px Arial', isDuel ? '#5ce8ff' : '#ffcf2e', 'transparent', false, false);
    tex.drawText(subtitle, null, 205, 'bold 34px Arial', '#fff6d8', 'transparent', false, false);
    tex.drawText('HOLD E', null, 292, 'bold 44px Arial', '#ffffff', 'transparent', false, false);
    tex.update(true);
    return tex;
  }

  private nearestZone(playerPosition: Vector3): ModeZone | null {
    let best: ModeZone | null = null;
    let bestDistSq = ACTIVATE_RADIUS * ACTIVATE_RADIUS;
    for (const zone of this.zones) {
      const dx = playerPosition.x - zone.position.x;
      const dz = playerPosition.z - zone.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > bestDistSq) continue;
      bestDistSq = distSq;
      best = zone;
    }
    return best;
  }

  private updatePrompt(zone: ModeZone): void {
    if (this.lastPromptMode !== zone.mode) {
      this.lastPromptMode = zone.mode;
      this.promptTitle.textContent = zone.title;
      this.promptSubtitle.textContent = zone.subtitle;
      this.prompt.dataset.mode = zone.mode;
    }
    const percent = Math.round((this.holdSeconds / HOLD_SECONDS) * 100);
    if (percent !== this.lastPromptPercent) {
      this.lastPromptPercent = percent;
      this.promptFill.style.width = `${percent}%`;
    }
    this.setPromptVisible(true);
  }

  private updateGlow(mode: LobbyMode | null): void {
    if (this.lastGlowMode === mode) return;
    this.lastGlowMode = mode;
    for (const zone of this.zones) {
      zone.material.emissiveColor.copyFrom(zone.mode === mode ? zone.activeEmissive : zone.idleEmissive);
    }
  }

  private setPromptVisible(visible: boolean): void {
    if (this.promptVisible === visible) return;
    this.promptVisible = visible;
    this.prompt.classList.toggle('lobby-mode-prompt--visible', visible);
  }

  private mustPromptElement<T extends Element>(selector: string): T {
    const element = this.prompt.querySelector<T>(selector);
    if (!element) throw new Error(`Missing lobby mode prompt element: ${selector}`);
    return element;
  }
}
