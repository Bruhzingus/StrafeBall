import { Color3, DynamicTexture, Material, Mesh, MeshBuilder, Scene, StandardMaterial, Texture, Vector3 } from '@babylonjs/core';

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

interface SurfaceLayer {
  mat: StandardMaterial;
  tex: Texture;
  baseEmissive: Color3;
  vSpeed: number;
  uSpeed: number;
  uAmplitude: number;
}

interface ModeZone extends ModeZoneDef {
  surfaceLayers: SurfaceLayer[];
  edgeMaterial: StandardMaterial;
  edgeBaseEmissive: Color3;
  statusMaterial: StandardMaterial;
  statusBaseEmissive: Color3;
}

const HOLD_SECONDS = 0.65;
const ACTIVATE_RADIUS = 2.7;
const SURFACE_TEXTURE_URL = '/assets/textures/portal/portal_surface.svg';

// Restrained school-gym magical-portal palette. Navy-charcoal frame metal, brushed cool-gray inner
// trim, electric-blue edge energy, deep midnight-indigo surface. No yellow/gold, no cyan tubes.
const PORTAL = {
  frame: new Color3(0.12, 0.135, 0.2),
  trim: new Color3(0.56, 0.59, 0.64),
  plinth: new Color3(0.1, 0.11, 0.16),
  edge: new Color3(0.3, 0.55, 1.0),
  status: new Color3(0.18, 0.4, 0.8),
  // Kept deliberately unsaturated-but-NOT-equal-channel: R well below G/B so the ACES tonemap + scene
  // exposure can't clip this toward white the way a near-equal-RGB bright value would. surfaceBack is
  // the deeper "blue" base layer; surfaceFront is the lighter "light blue" highlight layer on top.
  surfaceBack: new Color3(0.1, 0.32, 0.82),
  surfaceFront: new Color3(0.22, 0.5, 0.95)
} as const;

// A single unified private-match portal. Format (1v1 / 2v2) is a host setting chosen inside the
// match menu when CREATING a room. `mode` here is just the default format the menu opens on.
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
      <div class="lobby-mode-prompt__hint"><span class="key">E</span> hold to enter</div>
      <div class="lobby-mode-prompt__bar"><div></div></div>
    `;
    document.getElementById('hud-root')?.appendChild(this.prompt);
    this.promptTitle = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__title');
    this.promptSubtitle = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__subtitle');
    this.promptFill = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__bar > div');
    this.setPromptVisible(false);
  }

  /**
   * `menuOpen` is true while the match menu (the portal flow) is up. While it is, the hold is latched
   * shut: the portal shows only idle motion and a still-held interact key cannot re-open the menu the
   * instant it closes — re-arming requires a genuine release first (see the latch handling below).
   */
  update(dt: number, playerPosition: Vector3, interactHeld: boolean, menuOpen: boolean, onActivate: (mode: LobbyMode) => void): void {
    this.elapsed += dt;

    if (!this.enabled) {
      this.setPromptVisible(false);
      this.updateStationVisuals(null, 0);
      return;
    }

    if (menuOpen) {
      // The portal flow owns input right now. Keep the activation latched and hold timer drained so a
      // held interact key can't immediately re-trigger when the menu closes; only idle motion plays.
      this.activatedThisHold = true;
      this.holdSeconds = 0;
      this.setPromptVisible(false);
      this.updateStationVisuals(this.activeMode, 0);
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
    const cx = def.position.x;
    const cz = def.position.z;

    // The portal faces the court (+Z). Layers from back to front along Z: surface (deepest), edge
    // energy, frame plane, inner trim, with the plinth/sign as solid props.
    const zFrame = cz;
    const zTrim = cz + 0.012;
    const zEdge = cz - 0.01;
    const zSurfaceFront = cz - 0.03;
    const zSurfaceBack = cz - 0.06;
    const zSign = cz + 0.02;

    const baseY = 0.2;        // opening sits on the plinth top
    const openingWidth = 1.15;
    const straightHeight = 1.5;
    const archRadius = openingWidth / 2;
    const openingTopY = baseY + straightHeight + archRadius;

    // --- Materials ---
    const frameMat = this.solidLit('portal_frame_mat', PORTAL.frame, new Color3(0.16, 0.17, 0.19), 26);
    const trimMat = this.solidLit('portal_trim_mat', PORTAL.trim, new Color3(0.4, 0.42, 0.46), 64);
    trimMat.emissiveColor = new Color3(0.05, 0.055, 0.07);
    const plinthMat = this.solidLit('portal_plinth_mat', PORTAL.plinth, new Color3(0.12, 0.13, 0.15), 22);

    const edgeMat = this.emissiveMaterial('portal_edge_mat', PORTAL.edge.scale(0.6));
    const statusMat = this.emissiveMaterial('portal_status_mat', PORTAL.status.scale(0.45));

    // --- Plinth (small navy-charcoal block) + cap ---
    const plinth = MeshBuilder.CreateBox(`portal_${def.mode}_plinth`, { width: 1.5, height: baseY, depth: 0.56 }, this.scene);
    plinth.position.set(cx, baseY / 2, cz);
    plinth.material = plinthMat;
    this.addMesh(plinth, true);

    const cap = MeshBuilder.CreateBox(`portal_${def.mode}_plinth_cap`, { width: 1.58, height: 0.05, depth: 0.62 }, this.scene);
    cap.position.set(cx, baseY + 0.01, cz);
    cap.material = trimMat;
    this.addMesh(cap, true);

    // One subtle status panel on the plinth front face.
    const statusPanel = MeshBuilder.CreatePlane(`portal_${def.mode}_status`, { width: 0.66, height: 0.08 }, this.scene);
    statusPanel.position.set(cx, baseY * 0.5, cz + 0.29);
    statusPanel.material = statusMat;
    this.addMesh(statusPanel, true);

    // --- Portal surface: two scrolling indigo layers (rect body + arched top), behind the frame ---
    const surfaceLayers: SurfaceLayer[] = [];
    for (const [name, z, alpha, base, vSpeed, uSpeed, uAmp] of [
      ['back', zSurfaceBack, 0.95, PORTAL.surfaceBack, 0.05, 0.21, 0.03],
      ['front', zSurfaceFront, 0.5, PORTAL.surfaceFront, -0.085, 0.33, 0.05]
    ] as const) {
      const tex = new Texture(SURFACE_TEXTURE_URL, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
      tex.hasAlpha = false;
      const mat = new StandardMaterial(`portal_${def.mode}_surface_${name}_mat`, this.scene);
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.emissiveTexture = tex;
      mat.emissiveColor = base.clone();
      mat.disableLighting = true;
      mat.specularColor = new Color3(0, 0, 0);
      mat.alpha = alpha;
      mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
      mat.backFaceCulling = false;
      this.disposables.push(tex, mat);

      const surface = this.buildArchedSurface(`portal_${def.mode}_surface_${name}`, cx, z, baseY, openingWidth, straightHeight);
      surface.material = mat;
      this.addMesh(surface, true);

      surfaceLayers.push({ mat, tex, baseEmissive: base.clone(), vSpeed, uSpeed, uAmplitude: uAmp });
    }

    // --- Thin electric-blue edge energy hugging the opening (brightens on proximity) ---
    const edgeTube = MeshBuilder.CreateTube(`portal_${def.mode}_edge`, {
      path: archPath(cx, zEdge, baseY, openingWidth - 0.02, straightHeight),
      radius: 0.022,
      tessellation: 8,
      cap: Mesh.CAP_ALL
    }, this.scene);
    edgeTube.material = edgeMat;
    this.addMesh(edgeTube, true);

    // --- Inner trim (brushed cool gray) ---
    const trimTube = MeshBuilder.CreateTube(`portal_${def.mode}_trim`, {
      path: archPath(cx, zTrim, baseY, openingWidth - 0.05, straightHeight - 0.02),
      radius: 0.03,
      tessellation: 8,
      cap: Mesh.CAP_ALL
    }, this.scene);
    trimTube.material = trimMat;
    this.addMesh(trimTube, true);

    // --- Main arched frame (navy-charcoal metal) ---
    const frameTube = MeshBuilder.CreateTube(`portal_${def.mode}_frame`, {
      path: archPath(cx, zFrame, baseY, openingWidth, straightHeight),
      radius: 0.08,
      tessellation: 10,
      cap: Mesh.CAP_ALL
    }, this.scene);
    frameTube.material = frameMat;
    this.addMesh(frameTube, true);

    // --- "PRIVATE MATCH" sign above the arch (painted once, never per-frame) ---
    const signTexture = this.createSignTexture(`portal_${def.mode}_sign_tex`, def.title);
    const signMat = new StandardMaterial(`portal_${def.mode}_sign_mat`, this.scene);
    signMat.diffuseTexture = signTexture;
    signMat.emissiveTexture = signTexture;
    signMat.emissiveColor = new Color3(0.92, 0.95, 1.0);
    signMat.opacityTexture = signTexture;
    signMat.disableLighting = true;
    signMat.specularColor = new Color3(0, 0, 0);
    signMat.backFaceCulling = false;
    signMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.disposables.push(signTexture, signMat);

    const sign = MeshBuilder.CreatePlane(`portal_${def.mode}_sign`, { width: 1.12, height: 0.27 }, this.scene);
    sign.position.set(cx, openingTopY + 0.2, zSign);
    sign.material = signMat;
    this.addMesh(sign, true);

    this.zones.push({
      ...def,
      surfaceLayers,
      edgeMaterial: edgeMat,
      edgeBaseEmissive: PORTAL.edge.clone(),
      statusMaterial: statusMat,
      statusBaseEmissive: PORTAL.status.clone()
    });
  }

  /** Flat arched surface = a rectangle body + a half-disc top, merged into one mesh (faces +Z). */
  private buildArchedSurface(name: string, cx: number, cz: number, baseY: number, width: number, straightHeight: number): Mesh {
    const radius = width / 2;
    const body = MeshBuilder.CreatePlane(`${name}_body`, { width, height: straightHeight }, this.scene);
    body.position.set(cx, baseY + straightHeight / 2, cz);

    const dome = MeshBuilder.CreateDisc(`${name}_dome`, { radius, tessellation: 28, arc: 0.5 }, this.scene);
    dome.position.set(cx, baseY + straightHeight, cz);

    const merged = Mesh.MergeMeshes([body, dome], true, true, undefined, false, false);
    if (!merged) {
      body.name = name;
      return body;
    }
    merged.name = name;
    return merged;
  }

  private createSignTexture(name: string, title: string): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 512, height: 128 }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 128);

    // Restrained navy plate with a soft blue accent underline — white text, no arcade gold.
    ctx.fillStyle = 'rgba(10, 16, 38, 0.92)';
    roundedRect(ctx, 14, 22, 484, 84, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 160, 255, 0.55)';
    ctx.lineWidth = 3;
    roundedRect(ctx, 14, 22, 484, 84, 16);
    ctx.stroke();

    drawCentered(ctx, title, 60, '900 40px Arial', '#eef3ff');
    ctx.fillStyle = 'rgba(90, 140, 255, 0.85)';
    ctx.fillRect(176, 86, 160, 5);

    tex.update(true);
    return tex;
  }

  private solidLit(name: string, diffuse: Color3, specular: Color3, specularPower: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = diffuse.clone();
    material.specularColor = specular.clone();
    material.specularPower = specularPower;
    material.emissiveColor = new Color3(0, 0, 0);
    this.disposables.push(material);
    return material;
  }

  private emissiveMaterial(name: string, emissive: Color3): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = new Color3(0, 0, 0);
    material.emissiveColor = emissive.clone();
    material.specularColor = new Color3(0, 0, 0);
    material.disableLighting = true;
    this.disposables.push(material);
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

  /**
   * Idle: slow interior scroll only. Player nearby: the thin blue edge brightens slightly. Holding E:
   * a small extra edge lift (the clear progress feedback lives in the HTML prompt bar). The portal never
   * flashes or out-glows the ceiling fixtures / scoreboard.
   */
  private updateStationVisuals(activeMode: LobbyMode | null, activeProgress: number): void {
    const slow = 0.5 + 0.5 * Math.sin(this.elapsed * 1.3);
    for (const zone of this.zones) {
      const active = zone.mode === activeMode;
      const proximity = active ? 1 : 0;
      const progress = active ? Math.max(0, Math.min(1, activeProgress)) : 0;

      for (const layer of zone.surfaceLayers) {
        layer.tex.vOffset = (this.elapsed * layer.vSpeed) % 1;
        layer.tex.uOffset = Math.sin(this.elapsed * layer.uSpeed) * layer.uAmplitude;
        // Capped well under 1.0: pushed near-1.0 across all three channels, the scene's ACES tonemap +
        // exposure lift clips it toward flat white instead of a readable blue.
        const glow = 0.55 + slow * 0.08 + proximity * 0.08;
        layer.mat.emissiveColor.copyFrom(layer.baseEmissive.scale(glow));
      }

      const edgeGlow = 0.5 + slow * 0.12 + proximity * 0.4 + progress * 0.2;
      zone.edgeMaterial.emissiveColor.copyFrom(zone.edgeBaseEmissive.scale(edgeGlow));

      const statusGlow = 0.4 + slow * 0.1 + proximity * 0.45;
      zone.statusMaterial.emissiveColor.copyFrom(zone.statusBaseEmissive.scale(statusGlow));
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

/**
 * Vertical-plane path tracing a tall arched doorway opening: up the left side, over a semicircular top,
 * down the right side. Returned bottom-open (the plinth caps it). Tangents are continuous at the spring
 * line so a tube swept along it has no kink.
 */
function archPath(cx: number, cz: number, baseY: number, openingWidth: number, straightHeight: number): Vector3[] {
  const r = openingWidth / 2;
  const springY = baseY + straightHeight;
  const segments = 12;
  const path: Vector3[] = [new Vector3(cx - r, baseY, cz)];
  for (let i = 0; i <= segments; i += 1) {
    const a = Math.PI - (i / segments) * Math.PI; // π (left) → 0 (right), over the top
    path.push(new Vector3(cx + Math.cos(a) * r, springY + Math.sin(a) * r, cz));
  }
  path.push(new Vector3(cx + r, baseY, cz));
  return path;
}

function drawCentered(ctx: CanvasRenderingContext2D, text: string, y: number, font: string, color: string): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, y);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
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
