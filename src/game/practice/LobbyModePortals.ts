import { Color3, DynamicTexture, Material, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';

export type LobbyMode = '1v1' | '2v2';

interface ModeZoneDef {
  mode: LobbyMode;
  title: string;
  subtitle: string;
  helper: string;
  queueLabel: string;
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
  archMaterial: StandardMaterial;
  energyMaterial: StandardMaterial;
  energyMesh: Mesh;
  promptFillMaterial: StandardMaterial;
  promptFill: Mesh;
  promptFillWidth: number;
}

const HOLD_SECONDS = 0.65;
const ACTIVATE_RADIUS = 2.7;
const PROMPT_FILL_WIDTH = 0.84;

// A single unified private-match portal. Format (1v1 / 2v2) is a host setting chosen inside the
// match menu when CREATING a room — there is no longer a separate portal per format. `mode` here is
// just the default format the menu opens on; joining a room ignores it (code + name only).
const ZONES: ModeZoneDef[] = [
  {
    mode: '1v1',
    title: 'PRIVATE MATCH',
    subtitle: 'Create or join with a code',
    helper: 'Set up a 1v1 or 2v2 room',
    queueLabel: 'PRIVATE MATCH',
    position: new Vector3(0, 0, -11.15),
    stationWidth: 2.5
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
    const cx = def.position.x;
    const cz = def.position.z;
    // The portal is a free-standing glowing gateway: a base platform, a tall ring arch with an
    // animated energy field, and a DOUBLE-SIDED info sign at eye level so it reads from either side.
    const ringDiameter = 3.35;
    const ringCenterY = 1.62;
    const platformRadiusX = 2.0;
    const platformDepth = 2.0;
    const signWidth = 2.0;
    const signHeight = 1.06;

    const padMaterial = this.createSolidMaterial(`lobby_${def.mode}_pad_mat`, theme.main.scale(0.52), theme.accent.scale(0.08));
    const trimMaterial = this.createSolidMaterial(`lobby_${def.mode}_trim_mat`, theme.gold.scale(0.86), theme.gold.scale(0.2));
    const darkMaterial = this.createSolidMaterial(`lobby_${def.mode}_body_mat`, theme.dark, theme.main.scale(0.04));
    const archMaterial = this.createSolidMaterial(`lobby_${def.mode}_arch_mat`, theme.main.scale(0.34), theme.accent.scale(0.55));
    const promptFillMaterial = this.createSolidMaterial(`lobby_${def.mode}_prompt_fill_mat`, theme.accent, theme.accent.scale(0.55));
    this.disposables.push(padMaterial, trimMaterial, darkMaterial, archMaterial, promptFillMaterial);

    // --- Floor platform pad ---
    const platform = MeshBuilder.CreateCylinder(`lobby_${def.mode}_platform`, { diameter: 1, height: 0.07, tessellation: 64 }, this.scene);
    platform.scaling.set(platformRadiusX, 1, platformDepth * 0.55);
    platform.position.set(cx, 0.035, cz);
    platform.material = darkMaterial;
    this.addMesh(platform, true);

    const inset = MeshBuilder.CreateCylinder(`lobby_${def.mode}_platform_inset`, { diameter: 1, height: 0.03, tessellation: 64 }, this.scene);
    inset.scaling.set(platformRadiusX * 0.82, 1, platformDepth * 0.46);
    inset.position.set(cx, 0.085, cz);
    inset.material = padMaterial;
    this.addMesh(inset, true);

    const padRing = MeshBuilder.CreateTorus(`lobby_${def.mode}_pad_ring`, { diameter: platformRadiusX * 1.78, thickness: 0.055, tessellation: 72 }, this.scene);
    padRing.position.set(cx, 0.1, cz);
    padRing.scaling.z = (platformDepth * 0.92) / (platformRadiusX * 1.78);
    padRing.material = trimMaterial;
    this.addMesh(padRing, true);

    // --- Portal arch ring (the glowing gateway frame), stood vertical to face the player ---
    const arch = MeshBuilder.CreateTorus(`lobby_${def.mode}_arch`, { diameter: ringDiameter, thickness: 0.22, tessellation: 64 }, this.scene);
    arch.rotation.x = Math.PI / 2;
    arch.position.set(cx, ringCenterY, cz);
    arch.material = archMaterial;
    this.addMesh(arch, true);

    const archInner = MeshBuilder.CreateTorus(`lobby_${def.mode}_arch_inner`, { diameter: ringDiameter - 0.32, thickness: 0.05, tessellation: 64 }, this.scene);
    archInner.rotation.x = Math.PI / 2;
    archInner.position.set(cx, ringCenterY, cz);
    archInner.material = trimMaterial;
    this.addMesh(archInner, true);

    // Two grounded feet where the ring meets the platform, so the gateway reads as anchored.
    for (const side of [-1, 1] as const) {
      const foot = MeshBuilder.CreateBox(`lobby_${def.mode}_foot_${side}`, { width: 0.4, height: 0.5, depth: 0.46 }, this.scene);
      foot.position.set(cx + side * (ringDiameter * 0.46), 0.25, cz);
      foot.material = darkMaterial;
      this.addMesh(foot, true);
      const footCap = MeshBuilder.CreateBox(`lobby_${def.mode}_foot_cap_${side}`, { width: 0.48, height: 0.06, depth: 0.54 }, this.scene);
      footCap.position.set(cx + side * (ringDiameter * 0.46), 0.51, cz);
      footCap.material = trimMaterial;
      this.addMesh(footCap, true);
    }

    // --- Animated energy field that fills the ring behind the sign (translucent swirl) ---
    const energyTexture = this.createEnergyTexture(`lobby_${def.mode}_energy_tex`, theme);
    const energyMaterial = new StandardMaterial(`lobby_${def.mode}_energy_mat`, this.scene);
    energyMaterial.diffuseTexture = energyTexture;
    energyMaterial.emissiveTexture = energyTexture;
    energyMaterial.emissiveColor = new Color3(1, 1, 1);
    energyMaterial.useAlphaFromDiffuseTexture = true;
    energyMaterial.disableLighting = true;
    energyMaterial.specularColor = new Color3(0, 0, 0);
    energyMaterial.alpha = 0.62;
    energyMaterial.transparencyMode = Material.MATERIAL_ALPHABLEND;
    energyMaterial.backFaceCulling = false;
    this.disposables.push(energyTexture, energyMaterial);

    const energy = MeshBuilder.CreateDisc(`lobby_${def.mode}_energy`, { radius: (ringDiameter - 0.34) * 0.5, tessellation: 64 }, this.scene);
    energy.position.set(cx, ringCenterY, cz);
    energy.material = energyMaterial;
    energy.isPickable = false;
    this.addMesh(energy, false); // not frozen — it spins for the portal effect

    // --- Double-sided info sign (the same explainer texture on both faces) ---
    const faceTexture = this.createStationTexture(`lobby_${def.mode}_station_tex`, def, theme);
    const faceMaterial = new StandardMaterial(`lobby_${def.mode}_face_mat`, this.scene);
    faceMaterial.diffuseTexture = faceTexture;
    faceMaterial.emissiveTexture = faceTexture;
    faceMaterial.emissiveColor = new Color3(1, 1, 1);
    faceMaterial.disableLighting = true;
    faceMaterial.specularColor = new Color3(0, 0, 0);
    this.disposables.push(faceTexture, faceMaterial);

    const frameThickness = 0.05;
    for (const [name, side] of [['front', 1], ['back', -1]] as const) {
      const face = MeshBuilder.CreatePlane(`lobby_${def.mode}_face_${name}`, { width: signWidth, height: signHeight }, this.scene);
      face.position.set(cx, ringCenterY, cz + side * 0.07);
      if (side < 0) face.rotation.y = Math.PI; // flip so the back reads correctly, not mirrored
      face.material = faceMaterial;
      face.isPickable = false;
      this.addMesh(face, true);

      // A slim glowing frame around each face.
      const horiz = [signHeight * 0.5 + frameThickness, -(signHeight * 0.5 + frameThickness)];
      for (const y of horiz) {
        const bar = MeshBuilder.CreateBox(`lobby_${def.mode}_frame_${name}_h_${y > 0 ? 'top' : 'bot'}`, { width: signWidth + frameThickness * 2, height: frameThickness, depth: 0.04 }, this.scene);
        bar.position.set(cx, ringCenterY + y, cz + side * 0.07);
        bar.material = trimMaterial;
        this.addMesh(bar, true);
      }
      for (const xSide of [-1, 1] as const) {
        const bar = MeshBuilder.CreateBox(`lobby_${def.mode}_frame_${name}_v_${xSide}`, { width: frameThickness, height: signHeight + frameThickness * 2, depth: 0.04 }, this.scene);
        bar.position.set(cx + xSide * (signWidth * 0.5 + frameThickness), ringCenterY, cz + side * 0.07);
        bar.material = trimMaterial;
        this.addMesh(bar, true);
      }
    }

    // --- Floor "HOLD E" prompt + progress fill (kept from before) ---
    const promptTexture = this.createPromptTexture(`lobby_${def.mode}_prompt_tex`, def.queueLabel, theme);
    const promptMaterial = new StandardMaterial(`lobby_${def.mode}_prompt_mat`, this.scene);
    promptMaterial.diffuseTexture = promptTexture;
    promptMaterial.emissiveTexture = promptTexture;
    promptMaterial.emissiveColor = new Color3(1, 1, 1);
    promptMaterial.disableLighting = true;
    promptMaterial.specularColor = new Color3(0, 0, 0);
    promptMaterial.backFaceCulling = false;
    this.disposables.push(promptTexture, promptMaterial);

    const prompt = MeshBuilder.CreatePlane(`lobby_${def.mode}_prompt`, { width: 1.12, height: 0.3 }, this.scene);
    prompt.rotation.x = Math.PI / 2.35; // lay it toward the floor so an approaching player reads it
    prompt.position.set(cx, 0.16, cz + platformDepth * 0.5);
    prompt.material = promptMaterial;
    prompt.isPickable = false;
    this.addMesh(prompt, true);

    const promptFill = MeshBuilder.CreatePlane(`lobby_${def.mode}_prompt_progress`, { width: PROMPT_FILL_WIDTH, height: 0.03 }, this.scene);
    promptFill.rotation.x = Math.PI / 2.35;
    promptFill.position.set(cx - PROMPT_FILL_WIDTH * 0.5, 0.116, cz + platformDepth * 0.5 + 0.12);
    promptFill.scaling.x = 0;
    promptFill.material = promptFillMaterial;
    promptFill.isPickable = false;
    this.addMesh(promptFill, false);

    this.zones.push({
      ...def,
      theme,
      padMaterial,
      trimMaterial,
      archMaterial,
      energyMaterial,
      energyMesh: energy,
      promptFillMaterial,
      promptFill,
      promptFillWidth: PROMPT_FILL_WIDTH
    });
  }

  /** Radial energy texture (glow + curved spokes) so the spinning portal field reads as motion. */
  private createEnergyTexture(name: string, theme: ModeTheme): DynamicTexture {
    const size = 256;
    const tex = new DynamicTexture(name, { width: size, height: size }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, size, size);
    const c = size / 2;

    const grad = ctx.createRadialGradient(c, c, 6, c, c, c);
    grad.addColorStop(0, colorToRgba(theme.accent.scale(1.5), 0.95));
    grad.addColorStop(0.45, colorToRgba(theme.accent, 0.55));
    grad.addColorStop(0.82, colorToRgba(theme.main.scale(1.3), 0.24));
    grad.addColorStop(1, colorToRgba(theme.main, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = colorToRgba(theme.gold, 0.3);
    ctx.lineWidth = 3;
    for (let i = 0; i < 7; i += 1) {
      const a = (i / 7) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.quadraticCurveTo(
        c + Math.cos(a + 0.6) * size * 0.26,
        c + Math.sin(a + 0.6) * size * 0.26,
        c + Math.cos(a) * size * 0.46,
        c + Math.sin(a) * size * 0.46
      );
      ctx.stroke();
    }
    tex.update(true);
    return tex;
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

  private createPromptTexture(name: string, queueLabel: string, theme: ModeTheme): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 384, height: 128 }, this.scene, true);
    tex.hasAlpha = false;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 384, 128);
    ctx.fillStyle = colorToHex(theme.dark);
    ctx.fillRect(0, 0, 384, 128);
    ctx.fillStyle = colorToRgba(theme.gold, 0.92);
    ctx.fillRect(0, 0, 384, 10);
    ctx.fillRect(0, 118, 384, 10);
    drawCentered(ctx, queueLabel, 42, '800 24px Arial', colorToHex(theme.accent), 192);
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
    const slowPulse = 0.5 + 0.5 * Math.sin(this.elapsed * 1.5);
    for (const zone of this.zones) {
      const active = zone.mode === activeMode;
      const proximity = active ? 1 : 0;
      const progress = active ? Math.max(0, Math.min(1, activeProgress)) : 0;
      const padGlow = 0.12 + proximity * (0.12 + pulse * 0.08) + progress * 0.18;
      const trimGlow = 0.28 + proximity * (0.18 + pulse * 0.14) + progress * 0.38;

      zone.padMaterial.emissiveColor.copyFrom(zone.theme.accent.scale(padGlow));
      zone.trimMaterial.emissiveColor.copyFrom(zone.theme.gold.scale(trimGlow));
      zone.promptFillMaterial.emissiveColor.copyFrom(zone.theme.accent.scale(active ? 0.55 + progress * 0.45 : 0.25));

      // The gateway ring breathes with a slow ambient pulse and brightens as the player engages it.
      const archGlow = 0.42 + slowPulse * 0.16 + proximity * (0.2 + pulse * 0.12) + progress * 0.4;
      zone.archMaterial.emissiveColor.copyFrom(zone.theme.accent.scale(archGlow));

      // The energy field slowly swirls (faster while activating) and glows brighter up close.
      zone.energyMesh.rotation.z = this.elapsed * (0.5 + progress * 1.4);
      const energyGlow = 0.7 + slowPulse * 0.2 + proximity * 0.25 + progress * 0.5;
      zone.energyMaterial.emissiveColor.copyFrom(zone.theme.accent.scale(energyGlow));
      zone.energyMaterial.alpha = 0.5 + slowPulse * 0.12 + proximity * 0.15;

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
