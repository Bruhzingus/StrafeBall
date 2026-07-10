/**
 * Reusable arched "magic portal" prop — the same geometry/material recipe as the practice-lobby
 * mode portals (originally built inline in LobbyModePortals), generalized to an arbitrary world
 * position + facing yaw and an arbitrary color palette so every hold-E entry point in the game
 * (Private Match, Movement Course, Course Creator, Race Online, Back to Lobby) reads as one visual
 * language instead of a mix of portals and plain signs.
 *
 * All geometry is built in LOCAL space (the readable/open face points local +Z) and parented to a
 * single TransformNode, which is positioned/rotated ONCE at construction — Babylon's own transform
 * hierarchy handles placement, so the arch/tube/surface math never has to special-case rotation.
 * The yaw convention matches the game's player-facing convention exactly (forward = sin(yaw),
 * cos(yaw); see PlayerController.root.rotation.y = yaw), so a portal's yaw can be computed with the
 * same atan2(dx, dz) callers already use for aiming/facing.
 *
 * Purely visual: this class owns no interaction/hold-timer state. The caller drives proximity
 * (0/1) and hold progress (0..1) into update() every frame; activation radius, hold latching, and
 * onActivate all remain the caller's existing hold-E logic.
 */

import { Color3, DynamicTexture, Material, Mesh, MeshBuilder, Scene, StandardMaterial, Texture, TransformNode, Vector3, Vector4 } from '@babylonjs/core';

export interface PortalPalette {
  edge: Color3;
  status: Color3;
  surfaceBack: Color3;
  surfaceFront: Color3;
}

export interface PortalArchOptions {
  id: string;
  scene: Scene;
  position: Vector3;
  /** Facing yaw in radians (forward = sin(yaw), cos(yaw)) — same convention as player yaw. */
  yaw: number;
  title: string;
  palette: PortalPalette;
  openingWidth?: number;
  straightHeight?: number;
}

interface SurfaceLayer {
  mat: StandardMaterial;
  tex: Texture;
  baseEmissive: Color3;
  vSpeed: number;
  uSpeed: number;
  uAmplitude: number;
}

const SURFACE_TEXTURE_URL = '/assets/textures/portal/portal_surface.svg';

// Shared navy-charcoal frame metal / brushed cool-gray trim / dark plinth — identical across every
// portal regardless of its energy palette, matching the restrained school-gym look.
const PORTAL_FRAME = new Color3(0.12, 0.135, 0.2);
const PORTAL_TRIM = new Color3(0.56, 0.59, 0.64);
const PORTAL_PLINTH = new Color3(0.1, 0.11, 0.16);

export class PortalArch {
  readonly root: TransformNode;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly surfaceLayers: SurfaceLayer[] = [];
  private readonly edgeMaterial: StandardMaterial;
  private readonly edgeBaseEmissive: Color3;
  private readonly statusMaterial: StandardMaterial;
  private readonly statusBaseEmissive: Color3;

  constructor(options: PortalArchOptions) {
    const { id, scene, position, yaw, title, palette } = options;
    const openingWidth = options.openingWidth ?? 1.15;
    const straightHeight = options.straightHeight ?? 1.5;
    const archRadius = openingWidth / 2;

    this.root = new TransformNode(`portal_arch_${id}`, scene);
    this.root.position.copyFrom(position);
    this.root.rotation.y = yaw;

    // Local depth layering along +Z (front, toward the approaching player): surface (deepest,
    // -Z), edge energy, frame plane (z=0), inner trim, sign/status props (+Z).
    const zFrame = 0;
    const zTrim = 0.012;
    const zEdge = -0.01;
    const zSurfaceFront = -0.03;
    const zSurfaceBack = -0.06;
    const zSign = 0.02;
    const baseY = 0.2; // opening sits on the plinth top

    const openingTopY = baseY + straightHeight + archRadius;

    const frameMat = solidLit(scene, `${id}_frame_mat`, PORTAL_FRAME, new Color3(0.16, 0.17, 0.19), 26, this.disposables);
    const trimMat = solidLit(scene, `${id}_trim_mat`, PORTAL_TRIM, new Color3(0.4, 0.42, 0.46), 64, this.disposables);
    trimMat.emissiveColor = new Color3(0.05, 0.055, 0.07);
    const plinthMat = solidLit(scene, `${id}_plinth_mat`, PORTAL_PLINTH, new Color3(0.12, 0.13, 0.15), 22, this.disposables);

    this.edgeMaterial = emissiveMaterial(scene, `${id}_edge_mat`, palette.edge.scale(0.6), this.disposables);
    this.edgeBaseEmissive = palette.edge.clone();
    this.statusMaterial = emissiveMaterial(scene, `${id}_status_mat`, palette.status.scale(0.45), this.disposables);
    this.statusBaseEmissive = palette.status.clone();

    // --- Plinth (small navy-charcoal block) + cap ---
    const plinth = MeshBuilder.CreateBox(`${id}_plinth`, { width: 1.5, height: baseY, depth: 0.56 }, scene);
    plinth.position.set(0, baseY / 2, 0);
    plinth.material = plinthMat;
    this.addMesh(plinth);

    const cap = MeshBuilder.CreateBox(`${id}_plinth_cap`, { width: 1.58, height: 0.05, depth: 0.62 }, scene);
    cap.position.set(0, baseY + 0.01, 0);
    cap.material = trimMat;
    this.addMesh(cap);

    // One subtle status panel on the plinth front face.
    const statusPanel = MeshBuilder.CreatePlane(`${id}_status`, { width: 0.66, height: 0.08 }, scene);
    statusPanel.position.set(0, baseY * 0.5, 0.29);
    statusPanel.material = this.statusMaterial;
    this.addMesh(statusPanel);

    // --- Portal surface: two scrolling energy layers (rect body + arched top), behind the frame ---
    for (const [name, z, alpha, base, vSpeed, uSpeed, uAmp] of [
      ['back', zSurfaceBack, 0.95, palette.surfaceBack, 0.05, 0.21, 0.03],
      ['front', zSurfaceFront, 0.5, palette.surfaceFront, -0.085, 0.33, 0.05]
    ] as const) {
      const tex = new Texture(SURFACE_TEXTURE_URL, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
      tex.hasAlpha = false;
      const mat = new StandardMaterial(`${id}_surface_${name}_mat`, scene);
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.emissiveTexture = tex;
      mat.emissiveColor = base.clone();
      mat.disableLighting = true;
      mat.specularColor = new Color3(0, 0, 0);
      mat.alpha = alpha;
      mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
      mat.backFaceCulling = false;
      this.disposables.push(tex, mat);

      const surface = buildArchedSurface(scene, `${id}_surface_${name}`, 0, z, baseY, openingWidth, straightHeight);
      surface.material = mat;
      this.addMesh(surface);

      this.surfaceLayers.push({ mat, tex, baseEmissive: base.clone(), vSpeed, uSpeed, uAmplitude: uAmp });
    }

    // --- Thin electric edge energy hugging the opening (brightens on proximity) ---
    const edgeTube = MeshBuilder.CreateTube(`${id}_edge`, {
      path: archPath(0, zEdge, baseY, openingWidth - 0.02, straightHeight),
      radius: 0.022,
      tessellation: 8,
      cap: Mesh.CAP_ALL
    }, scene);
    edgeTube.material = this.edgeMaterial;
    this.addMesh(edgeTube);

    // --- Inner trim (brushed cool gray) ---
    const trimTube = MeshBuilder.CreateTube(`${id}_trim`, {
      path: archPath(0, zTrim, baseY, openingWidth - 0.05, straightHeight - 0.02),
      radius: 0.03,
      tessellation: 8,
      cap: Mesh.CAP_ALL
    }, scene);
    trimTube.material = trimMat;
    this.addMesh(trimTube);

    // --- Main arched frame (navy-charcoal metal) ---
    const frameTube = MeshBuilder.CreateTube(`${id}_frame`, {
      path: archPath(0, zFrame, baseY, openingWidth, straightHeight),
      radius: 0.08,
      tessellation: 10,
      cap: Mesh.CAP_ALL
    }, scene);
    frameTube.material = frameMat;
    this.addMesh(frameTube);

    // --- Title sign above the arch (painted once, never per-frame) ---
    const signTexture = createSignTexture(scene, `${id}_sign_tex`, title);
    const signMat = new StandardMaterial(`${id}_sign_mat`, scene);
    signMat.diffuseTexture = signTexture;
    signMat.emissiveTexture = signTexture;
    signMat.emissiveColor = new Color3(0.92, 0.95, 1.0);
    signMat.opacityTexture = signTexture;
    signMat.disableLighting = true;
    signMat.specularColor = new Color3(0, 0, 0);
    // Double-sided geometry (below) supplies a real back face, so cull each face's back — otherwise
    // the front face bleeds through and z-fights the (mirror-corrected) back face.
    signMat.backFaceCulling = true;
    signMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.disposables.push(signTexture, signMat);

    // DOUBLESIDE + horizontally-flipped backUVs: the sign reads correctly from BOTH sides (the plain
    // back face would otherwise show the title mirrored, e.g. "BACK TO LOBBY" as "YBBOL OT KCAB").
    const sign = MeshBuilder.CreatePlane(`${id}_sign`, {
      width: 1.12,
      height: 0.27,
      sideOrientation: Mesh.DOUBLESIDE,
      frontUVs: new Vector4(0, 0, 1, 1),
      backUVs: new Vector4(1, 0, 0, 1)
    }, scene);
    sign.position.set(0, openingTopY + 0.2, zSign);
    sign.material = signMat;
    this.addMesh(sign);
  }

  /**
   * Per-frame idle/proximity/hold-progress glow — same feel as the original lobby portals. The
   * caller supplies a monotonic elapsed-seconds clock (not necessarily this frame's dt — a shared
   * running clock keeps every portal's idle motion in sync), whether the player is in range (0/1),
   * and hold progress (0..1, only meaningful while in range).
   */
  update(elapsedSeconds: number, proximity: number, holdProgress: number): void {
    const slow = 0.5 + 0.5 * Math.sin(elapsedSeconds * 1.3);
    const progress = Math.max(0, Math.min(1, holdProgress));
    for (const layer of this.surfaceLayers) {
      layer.tex.vOffset = (elapsedSeconds * layer.vSpeed) % 1;
      layer.tex.uOffset = Math.sin(elapsedSeconds * layer.uSpeed) * layer.uAmplitude;
      // Capped well under 1.0: pushed near-1.0 across all three channels, the scene's ACES tonemap +
      // exposure lift clips it toward flat white instead of a readable color.
      const glow = 0.55 + slow * 0.08 + proximity * 0.08;
      layer.mat.emissiveColor.copyFrom(layer.baseEmissive.scale(glow));
    }

    const edgeGlow = 0.5 + slow * 0.12 + proximity * 0.4 + progress * 0.2;
    this.edgeMaterial.emissiveColor.copyFrom(this.edgeBaseEmissive.scale(edgeGlow));

    const statusGlow = 0.4 + slow * 0.1 + proximity * 0.45;
    this.statusMaterial.emissiveColor.copyFrom(this.statusBaseEmissive.scale(statusGlow));
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.root.dispose();
  }

  private addMesh(mesh: Mesh): void {
    mesh.isPickable = false;
    mesh.parent = this.root;
    this.disposables.push(mesh);
    mesh.freezeWorldMatrix();
  }
}

function solidLit(
  scene: Scene,
  name: string,
  diffuse: Color3,
  specular: Color3,
  specularPower: number,
  disposables: Array<{ dispose(): void }>
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse.clone();
  material.specularColor = specular.clone();
  material.specularPower = specularPower;
  material.emissiveColor = new Color3(0, 0, 0);
  disposables.push(material);
  return material;
}

function emissiveMaterial(scene: Scene, name: string, emissive: Color3, disposables: Array<{ dispose(): void }>): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = new Color3(0, 0, 0);
  material.emissiveColor = emissive.clone();
  material.specularColor = new Color3(0, 0, 0);
  material.disableLighting = true;
  disposables.push(material);
  return material;
}

/** Flat arched surface = a rectangle body + a half-disc top, merged into one mesh (faces local +Z). */
function buildArchedSurface(scene: Scene, name: string, cx: number, cz: number, baseY: number, width: number, straightHeight: number): Mesh {
  const radius = width / 2;
  const body = MeshBuilder.CreatePlane(`${name}_body`, { width, height: straightHeight }, scene);
  body.position.set(cx, baseY + straightHeight / 2, cz);

  const dome = MeshBuilder.CreateDisc(`${name}_dome`, { radius, tessellation: 28, arc: 0.5 }, scene);
  dome.position.set(cx, baseY + straightHeight, cz);

  const merged = Mesh.MergeMeshes([body, dome], true, true, undefined, false, false);
  if (!merged) {
    body.name = name;
    return body;
  }
  merged.name = name;
  return merged;
}

function createSignTexture(scene: Scene, name: string, title: string): DynamicTexture {
  const tex = new DynamicTexture(name, { width: 512, height: 128 }, scene, true);
  tex.hasAlpha = true;
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 512, 128);

  // Restrained navy plate with a soft accent underline — white text, no arcade gold.
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

/**
 * Vertical-plane path tracing a tall arched doorway opening, in LOCAL space (up the left side, over
 * a semicircular top, down the right side; bottom-open, the plinth caps it). Tangents are
 * continuous at the spring line so a tube swept along it has no kink.
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
