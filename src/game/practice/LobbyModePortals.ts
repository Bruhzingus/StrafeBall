import { Color3, DynamicTexture, Material, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';

export type LobbyMode = '1v1' | '2v2';

interface ModeZoneDef {
  mode: LobbyMode;
  title: string;
  subtitle: string;
  helper: string;
  position: Vector3;
  stationWidth: number;
}

interface ModeTheme {
  main: Color3;
  accent: Color3;
  gold: Color3;
  dark: Color3;
}

interface ModeZone extends ModeZoneDef {
  theme: ModeTheme;
  padMaterial: StandardMaterial;
  trimMaterial: StandardMaterial;
  promptFillMaterial: StandardMaterial;
  promptFill: Mesh;
  promptFillWidth: number;
}

const HOLD_SECONDS = 0.65;
const ACTIVATE_RADIUS = 2.25;
const PROMPT_FILL_WIDTH = 0.84;

const ZONES: ModeZoneDef[] = [
  {
    mode: '1v1',
    title: '1v1 DUEL',
    subtitle: 'Private match code',
    helper: 'Create or join a focused duel',
    position: new Vector3(-3.4, 0, -11.15),
    stationWidth: 2.05
  },
  {
    mode: '2v2',
    title: '2v2 TEAMS',
    subtitle: 'Team lobby setup',
    helper: 'Squad up and pick sides',
    position: new Vector3(3.4, 0, -11.15),
    stationWidth: 2.35
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
  private lastPromptMode: LobbyMode | null = null;
  private lastPromptPercent = -1;
  private promptVisible = false;
  private holdSeconds = 0;
  private activatedThisHold = false;
  private enabled = true;
  private elapsed = 0;

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
    this.elapsed += dt;

    if (!this.enabled) {
      this.setPromptVisible(false);
      this.updateStationVisuals(null, 0);
      return;
    }

    const nearest = this.nearestZone(playerPosition);
    if (!nearest) {
      this.activeMode = null;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
      this.setPromptVisible(false);
      this.updateStationVisuals(null, 0);
      return;
    }

    if (this.activeMode !== nearest.mode) {
      this.activeMode = nearest.mode;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
    }

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

    const progress = this.holdSeconds / HOLD_SECONDS;
    this.updateStationVisuals(nearest.mode, progress);
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
    const theme = createTheme(def.mode);
    const panelWidth = def.stationWidth;
    const panelHeight = def.mode === '2v2' ? 1.02 : 0.96;
    const signZ = def.position.z + 0.72;
    const platformDepth = def.mode === '2v2' ? 1.82 : 1.62;

    const padMaterial = this.createSolidMaterial(`lobby_${def.mode}_pad_mat`, theme.main.scale(0.56), theme.accent.scale(0.08));
    const trimMaterial = this.createSolidMaterial(`lobby_${def.mode}_trim_mat`, theme.gold.scale(0.86), theme.gold.scale(0.18));
    const darkMaterial = this.createSolidMaterial(`lobby_${def.mode}_body_mat`, theme.dark, theme.main.scale(0.035));
    const sideMaterial = this.createSolidMaterial(`lobby_${def.mode}_side_mat`, new Color3(0.055, 0.074, 0.1), theme.accent.scale(0.03));
    const promptFillMaterial = this.createSolidMaterial(`lobby_${def.mode}_prompt_fill_mat`, theme.accent, theme.accent.scale(0.55));
    this.disposables.push(padMaterial, trimMaterial, darkMaterial, sideMaterial, promptFillMaterial);

    const platform = MeshBuilder.CreateCylinder(
      `lobby_${def.mode}_platform`,
      { diameter: 1, height: 0.06, tessellation: 56 },
      this.scene
    );
    platform.scaling.set(panelWidth * 0.5, 1, platformDepth * 0.47);
    platform.position.set(def.position.x, 0.03, def.position.z);
    platform.material = darkMaterial;
    this.addMesh(platform, true);

    const inset = MeshBuilder.CreateCylinder(
      `lobby_${def.mode}_platform_inset`,
      { diameter: 1, height: 0.024, tessellation: 56 },
      this.scene
    );
    inset.scaling.set(panelWidth * 0.4, 1, platformDepth * 0.35);
    inset.position.set(def.position.x, 0.078, def.position.z);
    inset.material = padMaterial;
    this.addMesh(inset, true);

    for (const side of [-1, 1] as const) {
      const sideStripe = MeshBuilder.CreateBox(
        `lobby_${def.mode}_floor_side_trim_${side}`,
        { width: 0.055, height: 0.018, depth: platformDepth * 0.58 },
        this.scene
      );
      sideStripe.position.set(def.position.x + side * (panelWidth * 0.39), 0.1, def.position.z - 0.03);
      sideStripe.material = trimMaterial;
      this.addMesh(sideStripe, true);
    }

    const frontStripe = MeshBuilder.CreateBox(
      `lobby_${def.mode}_floor_front_trim`,
      { width: panelWidth * 0.64, height: 0.018, depth: 0.055 },
      this.scene
    );
    frontStripe.position.set(def.position.x, 0.102, def.position.z - platformDepth * 0.33);
    frontStripe.material = trimMaterial;
    this.addMesh(frontStripe, true);

    const body = MeshBuilder.CreateBox(
      `lobby_${def.mode}_kiosk_body`,
      { width: panelWidth * 0.24, height: 0.34, depth: 0.3 },
      this.scene
    );
    body.position.set(def.position.x, 0.26, signZ + 0.11);
    body.material = sideMaterial;
    this.addMesh(body, true);

    const neck = MeshBuilder.CreateBox(
      `lobby_${def.mode}_kiosk_neck`,
      { width: panelWidth * 0.34, height: 0.12, depth: 0.16 },
      this.scene
    );
    neck.position.set(def.position.x, 0.52, signZ + 0.07);
    neck.material = trimMaterial;
    this.addMesh(neck, true);

    const faceTexture = this.createStationTexture(`lobby_${def.mode}_station_tex`, def, theme);
    const faceMaterial = new StandardMaterial(`lobby_${def.mode}_face_mat`, this.scene);
    faceMaterial.diffuseTexture = faceTexture;
    faceMaterial.emissiveTexture = faceTexture;
    faceMaterial.emissiveColor = new Color3(1, 1, 1);
    faceMaterial.disableLighting = true;
    faceMaterial.specularColor = new Color3(0, 0, 0);
    this.disposables.push(faceTexture, faceMaterial);

    const face = MeshBuilder.CreatePlane(
      `lobby_${def.mode}_face`,
      { width: panelWidth - 0.22, height: panelHeight - 0.18 },
      this.scene
    );
    face.position.set(def.position.x, 1.08, signZ - 0.045);
    face.material = faceMaterial;
    face.isPickable = false;
    this.addMesh(face, true);

    const panelBack = MeshBuilder.CreateBox(
      `lobby_${def.mode}_panel_back`,
      { width: panelWidth, height: panelHeight, depth: 0.105 },
      this.scene
    );
    panelBack.position.set(def.position.x, 1.08, signZ + 0.025);
    panelBack.material = darkMaterial;
    this.addMesh(panelBack, true);

    const topCap = MeshBuilder.CreateBox(
      `lobby_${def.mode}_panel_top_trim`,
      { width: panelWidth + 0.1, height: 0.055, depth: 0.13 },
      this.scene
    );
    topCap.position.set(def.position.x, 1.08 + panelHeight * 0.5 + 0.03, signZ - 0.015);
    topCap.material = trimMaterial;
    this.addMesh(topCap, true);

    const bottomCap = MeshBuilder.CreateBox(
      `lobby_${def.mode}_panel_bottom_trim`,
      { width: panelWidth + 0.1, height: 0.055, depth: 0.13 },
      this.scene
    );
    bottomCap.position.set(def.position.x, 1.08 - panelHeight * 0.5 - 0.03, signZ - 0.015);
    bottomCap.material = trimMaterial;
    this.addMesh(bottomCap, true);

    for (const side of [-1, 1] as const) {
      const sideCap = MeshBuilder.CreateBox(
        `lobby_${def.mode}_panel_side_trim_${side}`,
        { width: 0.055, height: panelHeight + 0.08, depth: 0.13 },
        this.scene
      );
      sideCap.position.set(def.position.x + side * (panelWidth * 0.5 + 0.025), 1.08, signZ - 0.015);
      sideCap.material = trimMaterial;
      this.addMesh(sideCap, true);
    }

    const promptTexture = this.createPromptTexture(`lobby_${def.mode}_prompt_tex`, def.mode, theme);
    const promptMaterial = new StandardMaterial(`lobby_${def.mode}_prompt_mat`, this.scene);
    promptMaterial.diffuseTexture = promptTexture;
    promptMaterial.emissiveTexture = promptTexture;
    promptMaterial.emissiveColor = new Color3(1, 1, 1);
    promptMaterial.disableLighting = true;
    promptMaterial.specularColor = new Color3(0, 0, 0);
    promptMaterial.backFaceCulling = false;
    this.disposables.push(promptTexture, promptMaterial);

    const prompt = MeshBuilder.CreatePlane(`lobby_${def.mode}_prompt`, { width: 1.08, height: 0.28 }, this.scene);
    prompt.position.set(def.position.x, 0.38, def.position.z + 0.05);
    prompt.material = promptMaterial;
    prompt.isPickable = false;
    this.addMesh(prompt, true);

    const promptBack = MeshBuilder.CreateBox(`lobby_${def.mode}_prompt_back`, { width: 1.16, height: 0.34, depth: 0.045 }, this.scene);
    promptBack.position.set(def.position.x, 0.38, def.position.z + 0.075);
    promptBack.material = darkMaterial;
    this.addMesh(promptBack, true);

    const promptFill = MeshBuilder.CreatePlane(
      `lobby_${def.mode}_prompt_progress`,
      { width: PROMPT_FILL_WIDTH, height: 0.026 },
      this.scene
    );
    promptFill.position.set(def.position.x - PROMPT_FILL_WIDTH * 0.5, 0.265, def.position.z - 0.065);
    promptFill.scaling.x = 0;
    promptFill.material = promptFillMaterial;
    promptFill.isPickable = false;
    this.addMesh(promptFill, false);

    this.zones.push({
      ...def,
      theme,
      padMaterial,
      trimMaterial,
      promptFillMaterial,
      promptFill,
      promptFillWidth: PROMPT_FILL_WIDTH
    });
  }

  private createStationTexture(name: string, def: ModeZoneDef, theme: ModeTheme): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 900, height: 520 }, this.scene, true);
    tex.hasAlpha = false;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 900, 520);

    ctx.fillStyle = colorToHex(theme.dark);
    ctx.fillRect(0, 0, 900, 520);

    const panelGradient = ctx.createLinearGradient(0, 0, 900, 520);
    panelGradient.addColorStop(0, colorToRgba(theme.main, 0.28));
    panelGradient.addColorStop(0.54, colorToRgba(theme.dark, 0.98));
    panelGradient.addColorStop(1, colorToRgba(theme.main, 0.18));
    ctx.fillStyle = panelGradient;
    ctx.fillRect(0, 0, 900, 520);

    ctx.fillStyle = colorToRgba(theme.gold, 0.88);
    ctx.fillRect(0, 0, 900, 12);
    ctx.fillRect(0, 508, 900, 12);
    ctx.fillStyle = colorToRgba(theme.accent, 0.42);
    ctx.fillRect(46, 52, 808, 4);
    ctx.fillRect(46, 462, 808, 4);

    ctx.fillStyle = colorToRgba(theme.accent, 0.08);
    for (let i = 0; i < 9; i += 1) {
      ctx.fillRect(60 + i * 30, 88, 14, 54);
      ctx.fillRect(826 - i * 30, 376, 14, 54);
    }

    drawCentered(ctx, 'STRAFEBALL MATCH', 82, '800 26px Arial', '#fff4ce');
    drawCentered(ctx, def.title, 206, '900 82px Arial', colorToHex(theme.accent));
    drawCentered(ctx, def.subtitle.toUpperCase(), 288, '800 36px Arial', '#fff8dc');
    drawCentered(ctx, def.helper.toUpperCase(), 342, '700 24px Arial', '#d8e7ff');

    ctx.fillStyle = colorToRgba(theme.gold, 0.9);
    roundedRect(ctx, 318, 392, 264, 58, 9);
    ctx.fill();
    drawCentered(ctx, 'HOLD  E', 429, '900 36px Arial', '#07111d');

    tex.update(true);
    return tex;
  }

  private createPromptTexture(name: string, mode: LobbyMode, theme: ModeTheme): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 384, height: 128 }, this.scene, true);
    tex.hasAlpha = false;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 384, 128);
    ctx.fillStyle = colorToHex(theme.dark);
    ctx.fillRect(0, 0, 384, 128);
    ctx.fillStyle = colorToRgba(theme.gold, 0.92);
    ctx.fillRect(0, 0, 384, 10);
    ctx.fillRect(0, 118, 384, 10);
    drawCentered(ctx, mode === '1v1' ? 'DUEL QUEUE' : 'TEAM QUEUE', 42, '800 24px Arial', colorToHex(theme.accent), 192);
    drawCentered(ctx, 'HOLD  E', 90, '900 42px Arial', '#ffffff', 192);
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

  private addMesh(mesh: Mesh, freeze: boolean): void {
    mesh.isPickable = false;
    this.meshes.push(mesh);
    this.disposables.push(mesh);
    if (freeze) mesh.freezeWorldMatrix();
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

  private updateStationVisuals(activeMode: LobbyMode | null, activeProgress: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 4.2);
    for (const zone of this.zones) {
      const active = zone.mode === activeMode;
      const proximity = active ? 1 : 0;
      const progress = active ? Math.max(0, Math.min(1, activeProgress)) : 0;
      const padGlow = 0.12 + proximity * (0.12 + pulse * 0.08) + progress * 0.18;
      const trimGlow = 0.28 + proximity * (0.18 + pulse * 0.14) + progress * 0.38;

      zone.padMaterial.emissiveColor.copyFrom(zone.theme.accent.scale(padGlow));
      zone.trimMaterial.emissiveColor.copyFrom(zone.theme.gold.scale(trimGlow));
      zone.promptFillMaterial.emissiveColor.copyFrom(zone.theme.accent.scale(active ? 0.55 + progress * 0.45 : 0.25));

      zone.promptFill.scaling.x = progress;
      zone.promptFill.position.x = zone.position.x - zone.promptFillWidth * (1 - progress) * 0.5;
    }
  }

  private setPromptVisible(visible: boolean): void {
    if (this.promptVisible === visible) return;
    this.promptVisible = visible;
    this.prompt.classList.toggle('lobby-mode-prompt--visible', visible);
    if (!visible) {
      this.lastPromptPercent = -1;
      this.promptFill.style.width = '0%';
    }
  }

  private mustPromptElement<T extends Element>(selector: string): T {
    const element = this.prompt.querySelector<T>(selector);
    if (!element) throw new Error(`Missing lobby mode prompt element: ${selector}`);
    return element;
  }
}

function createTheme(mode: LobbyMode): ModeTheme {
  if (mode === '1v1') {
    return {
      main: new Color3(0.06, 0.28, 0.64),
      accent: new Color3(0.32, 0.9, 1.0),
      gold: new Color3(1.0, 0.75, 0.16),
      dark: new Color3(0.025, 0.055, 0.11)
    };
  }
  return {
    main: new Color3(0.45, 0.18, 0.045),
    accent: new Color3(1.0, 0.58, 0.15),
    gold: new Color3(1.0, 0.83, 0.24),
    dark: new Color3(0.055, 0.055, 0.07)
  };
}

function drawCentered(
  ctx: ReturnType<DynamicTexture['getContext']>,
  text: string,
  y: number,
  font: string,
  color: string,
  centerX = 450
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

function roundedRect(
  ctx: ReturnType<DynamicTexture['getContext']>,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
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
