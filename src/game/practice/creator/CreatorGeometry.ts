/**
 * Creator Sandbox — visual geometry builder.
 *
 * Turns a CreatorLayout into Babylon meshes: solid terrain modules (grid-textured boxes, parented to
 * a per-object TransformNode so a single gizmo can move/rotate/scale them), and course markers
 * (pads, gates, signs, arrows, portals). It also owns the editor-only overlays — ground grid,
 * selection highlight box, trigger volumes and collision-bound boxes — which are hidden in Playtest.
 *
 * Visuals are derived from the same sub-box math the collision/world use, so what you see matches
 * what you collide with. Everything is created locally and disposed on exit; no per-frame allocation.
 */

import {
  Color3,
  DynamicTexture,
  Material,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector4
} from '@babylonjs/core';
import {
  CreatorLayout,
  CreatorLayoutObject,
  materialDef,
  moduleDef,
  moduleLocalBoxes,
  objectCollisionBoxes,
  objectWorldAabb,
  orientedBoxAabb
} from './CreatorLayout';
import { layoutWorldBounds } from './CreatorWorld';
import { SANDBOX_CENTER } from '../MovementSandboxLayout';

const OBJECT_ID_KEY = 'creatorObjectId';
const GRID_CELL_METRES = 5;
const DEG2RAD = Math.PI / 180;

export class CreatorGeometry {
  private readonly root: TransformNode;
  private readonly cachedMaterials = new Map<string, StandardMaterial>();
  // Textures owned by the CACHED materials (grid floor + terrain) — they must outlive a rebuild, so
  // they are disposed only on full teardown (NOT in disposePerBuild, which runs every edit).
  private readonly cachedTextures: Array<{ dispose(): void }> = [];
  private readonly perBuild: Array<{ dispose(): void }> = [];
  private readonly objectRoots = new Map<string, TransformNode>();

  private gridMesh: Mesh | null = null;
  private selectionBox: Mesh | null = null;
  private readonly triggerMeshes: Mesh[] = [];
  private readonly collisionMeshes: Mesh[] = [];

  private gridVisible = true;
  private triggersVisible = true;
  private collisionVisible = false;
  private overlaysEnabled = true;

  constructor(private readonly scene: Scene) {
    this.root = new TransformNode('creator_geometry_root', scene);
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  // ---------------------------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------------------------

  rebuild(layout: CreatorLayout): void {
    this.disposePerBuild();
    this.objectRoots.clear();
    this.triggerMeshes.length = 0;
    this.collisionMeshes.length = 0;

    this.ensureGrid();
    this.ensureSelectionBox();
    this.positionGrid(layout);

    for (const obj of layout.objects) {
      if (obj.visible === false) continue;
      this.buildObject(obj);
    }

    this.buildOverlays(layout);
    this.applyOverlayVisibility();
  }

  private buildObject(obj: CreatorLayoutObject): void {
    const def = moduleDef(obj.type);
    if (!def) return;
    const node = new TransformNode(`creator_obj_${obj.id}`, this.scene);
    node.parent = this.root;
    node.position.set(obj.position[0], obj.position[1], obj.position[2]);
    node.rotation.set(0, (obj.rotation[1] ?? 0) * DEG2RAD, 0);
    node.scaling.set(obj.scale[0], obj.scale[1], obj.scale[2]);
    this.objectRoots.set(obj.id, node);
    this.perBuild.push(node);

    if (def.category === 'terrain') {
      this.buildSolid(obj, node);
    } else {
      this.buildMarker(obj, node);
    }
  }

  private buildSolid(obj: CreatorLayoutObject, node: TransformNode): void {
    const mat = this.terrainMaterial(obj.material ?? 'concrete');
    const boxes = moduleLocalBoxes(obj.type);
    boxes.forEach((b, i) => {
      const mesh = this.gridBox(`creator_${obj.id}_${i}`, b.s[0], b.s[1], b.s[2], mat);
      mesh.position.set(b.o[0], b.o[1], b.o[2]);
      mesh.parent = node;
      this.tagPickable(mesh, obj.id);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Markers
  // ---------------------------------------------------------------------------------------------

  private buildMarker(obj: CreatorLayoutObject, node: TransformNode): void {
    const def = moduleDef(obj.type)!;
    const [w, h, d] = def.baseSize;
    const mat = this.solidMaterial(obj.material ?? 'marker_blue');
    switch (def.shape) {
      case 'pad':
        this.buildPad(obj, node, w, h, d, mat);
        break;
      case 'gate':
        this.buildGate(obj, node, w, h, d, mat);
        break;
      case 'arrow':
        this.buildArrow(obj, node, w, d, mat);
        break;
      case 'sign':
        this.buildSignboard(obj, node, w, h);
        break;
      case 'portal':
        this.buildPortal(obj, node, w, h, mat);
        break;
      default:
        this.buildPad(obj, node, w, Math.max(0.1, h), d, mat);
    }
  }

  private buildPad(obj: CreatorLayoutObject, node: TransformNode, w: number, h: number, d: number, mat: StandardMaterial): void {
    const pad = MeshBuilder.CreateBox(`creator_${obj.id}_pad`, { width: w, height: Math.max(0.08, h), depth: d }, this.scene);
    pad.position.set(0, Math.max(0.04, h / 2), 0);
    pad.material = mat;
    pad.parent = node;
    this.tagPickable(pad, obj.id);

    const label = this.markerLabel(obj);
    if (label) this.attachLabel(obj, node, label, 1.6, Math.max(2.4, w * 0.6));

    // Facing chevron so spawn / pad orientation is readable (points +Z = the node's facing).
    const chevron = MeshBuilder.CreateCylinder(`creator_${obj.id}_dir`, { diameter: Math.min(w, d) * 0.5, height: 0.12, tessellation: 3 }, this.scene);
    chevron.rotation.x = Math.PI / 2;
    chevron.position.set(0, 0.14, d * 0.25);
    chevron.material = this.solidMaterial('marker_gold');
    chevron.parent = node;
    chevron.isPickable = false;
    this.perBuild.push(chevron);
  }

  private buildGate(obj: CreatorLayoutObject, node: TransformNode, w: number, h: number, d: number, mat: StandardMaterial): void {
    const postT = Math.max(0.18, w * 0.06);
    for (const sx of [-1, 1]) {
      const post = MeshBuilder.CreateBox(`creator_${obj.id}_post${sx}`, { width: postT, height: h, depth: Math.max(0.2, d) }, this.scene);
      post.position.set((sx * (w - postT)) / 2, h / 2, 0);
      post.material = mat;
      post.parent = node;
      this.tagPickable(post, obj.id);
    }
    const beam = MeshBuilder.CreateBox(`creator_${obj.id}_beam`, { width: w, height: postT, depth: Math.max(0.2, d) }, this.scene);
    beam.position.set(0, h - postT / 2, 0);
    beam.material = mat;
    beam.parent = node;
    this.tagPickable(beam, obj.id);

    const order = obj.metadata?.checkpointOrder;
    const text = obj.type === 'finish_gate' ? 'FINISH' : order != null ? `CP ${order}` : 'GATE';
    this.attachLabel(obj, node, obj.metadata?.label ? `${text}\n${obj.metadata.label}` : text, h + 0.5, Math.min(w, 4));
  }

  private buildArrow(obj: CreatorLayoutObject, node: TransformNode, w: number, d: number, mat: StandardMaterial): void {
    // A flat ground arrow pointing +Z (node facing). Shaft + head built from boxes.
    const shaft = MeshBuilder.CreateBox(`creator_${obj.id}_shaft`, { width: w * 0.35, height: 0.06, depth: d * 0.6 }, this.scene);
    shaft.position.set(0, 0.06, -d * 0.1);
    shaft.material = mat;
    shaft.parent = node;
    this.tagPickable(shaft, obj.id);
    const head = MeshBuilder.CreateCylinder(`creator_${obj.id}_head`, { diameter: w, height: 0.06, tessellation: 3 }, this.scene);
    head.rotation.x = Math.PI / 2;
    head.position.set(0, 0.06, d * 0.35);
    head.material = mat;
    head.parent = node;
    this.tagPickable(head, obj.id);
    if (obj.metadata?.label) this.attachLabel(obj, node, obj.metadata.label, 1.4, Math.max(2, w));
  }

  private buildSignboard(obj: CreatorLayoutObject, node: TransformNode, w: number, h: number): void {
    const postH = Math.max(0.6, h * 0.8);
    const post = MeshBuilder.CreateBox(`creator_${obj.id}_post`, { width: 0.16, height: postH, depth: 0.16 }, this.scene);
    post.position.set(0, postH / 2, 0);
    post.material = this.solidMaterial('marker_gold');
    post.parent = node;
    this.tagPickable(post, obj.id);
    const text = obj.metadata?.label || obj.name || 'SIGN';
    this.attachLabel(obj, node, text, postH + h / 2, w);
  }

  private buildPortal(obj: CreatorLayoutObject, node: TransformNode, w: number, h: number, mat: StandardMaterial): void {
    for (const sx of [-1, 1]) {
      const post = MeshBuilder.CreateBox(`creator_${obj.id}_ppost${sx}`, { width: 0.18, height: h, depth: 0.18 }, this.scene);
      post.position.set((sx * w) / 2, h / 2, 0);
      post.material = mat;
      post.parent = node;
      this.tagPickable(post, obj.id);
    }
    const beam = MeshBuilder.CreateBox(`creator_${obj.id}_pbeam`, { width: w + 0.18, height: 0.2, depth: 0.18 }, this.scene);
    beam.position.set(0, h, 0);
    beam.material = this.solidMaterial('marker_gold');
    beam.parent = node;
    this.tagPickable(beam, obj.id);
    this.attachLabel(obj, node, obj.metadata?.label || 'LEAVE', h + 0.6, w + 0.5);
  }

  private markerLabel(obj: CreatorLayoutObject): string {
    if (obj.metadata?.label) return obj.metadata.label;
    if (obj.name) return obj.name;
    return moduleDef(obj.type)?.label ?? '';
  }

  private attachLabel(obj: CreatorLayoutObject, node: TransformNode, text: string, y: number, width: number): void {
    const mesh = this.signPlane(`creator_${obj.id}_label`, text, Math.max(1.4, width), Math.max(0.6, width * 0.32));
    mesh.position.set(0, y, 0);
    mesh.parent = node;
    mesh.isPickable = false;
  }

  // ---------------------------------------------------------------------------------------------
  // Editor overlays: grid, selection highlight, trigger volumes, collision bounds
  // ---------------------------------------------------------------------------------------------

  private buildOverlays(layout: CreatorLayout): void {
    const triggerMat = this.translucentMaterial('creator_trigger_mat', new Color3(0.25, 0.7, 1.0), 0.18);
    const collisionMat = this.translucentMaterial('creator_collision_mat', new Color3(1.0, 0.55, 0.2), 0.14);

    for (const obj of layout.objects) {
      // Trigger volumes for gates / start pads.
      const trig = obj.metadata?.trigger;
      if (trig && (obj.metadata?.triggerType ?? 'none') !== 'none') {
        const box = MeshBuilder.CreateBox(`creator_trig_${obj.id}`, { width: trig.width, height: trig.height, depth: trig.depth }, this.scene);
        box.position.set(obj.position[0], obj.position[1] + trig.height / 2, obj.position[2]);
        box.rotation.y = (obj.rotation[1] ?? 0) * DEG2RAD;
        box.material = triggerMat;
        box.isPickable = false;
        box.parent = this.root;
        this.triggerMeshes.push(box);
        this.perBuild.push(box);
      }
      // Collision-bound debug boxes.
      for (const sub of objectCollisionBoxes(obj)) {
        const a = orientedBoxAabb(sub);
        const box = MeshBuilder.CreateBox(`creator_col_${obj.id}`, { width: a.maxX - a.minX, height: a.maxY - a.minY, depth: a.maxZ - a.minZ }, this.scene);
        box.position.set((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, (a.minZ + a.maxZ) / 2);
        box.material = collisionMat;
        box.isPickable = false;
        box.parent = this.root;
        this.collisionMeshes.push(box);
        this.perBuild.push(box);
      }
    }
  }

  private ensureGrid(): void {
    if (this.gridMesh) return;
    // A bright, LIT grid-textured floor (not a dark emissive overlay) so the yard reads clearly in both
    // Build and Playtest instead of looking black / leaving objects floating in the sky.
    const mat = new StandardMaterial('creator_grid_mat', this.scene);
    mat.diffuseTexture = this.gridTexture('creator_grid_tex', new Color3(0.40, 0.43, 0.47), new Color3(0.62, 0.66, 0.72));
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.emissiveColor = new Color3(0.06, 0.065, 0.07);
    mat.specularColor = new Color3(0.02, 0.02, 0.025);
    mat.backFaceCulling = false;
    this.cachedMaterials.set('__grid', mat);
    const grid = MeshBuilder.CreateGround('creator_grid', { width: 1, height: 1 }, this.scene);
    grid.material = mat;
    grid.isPickable = false;
    grid.parent = this.root;
    this.gridMesh = grid;
  }

  private positionGrid(layout: CreatorLayout): void {
    if (!this.gridMesh) return;
    const b = layoutWorldBounds(layout);
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    this.gridMesh.scaling.set(w, 1, d);
    this.gridMesh.position.set(SANDBOX_CENTER.x, (layout.ground.bounds.y ?? 0) - 0.02, SANDBOX_CENTER.z);
    const tex = (this.gridMesh.material as StandardMaterial).diffuseTexture as Texture | null;
    if (tex) {
      tex.uScale = Math.max(1, w / GRID_CELL_METRES);
      tex.vScale = Math.max(1, d / GRID_CELL_METRES);
    }
  }

  private ensureSelectionBox(): void {
    if (this.selectionBox) return;
    const mat = new StandardMaterial('creator_selection_mat', this.scene);
    mat.emissiveColor = new Color3(1.0, 0.86, 0.2);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.wireframe = true;
    this.cachedMaterials.set('__selection', mat);
    const box = MeshBuilder.CreateBox('creator_selection', { size: 1 }, this.scene);
    box.material = mat;
    box.isPickable = false;
    box.setEnabled(false);
    box.parent = this.root;
    this.selectionBox = box;
  }

  setSelection(obj: CreatorLayoutObject | null): void {
    if (!this.selectionBox) return;
    if (!obj || !this.overlaysEnabled) {
      this.selectionBox.setEnabled(false);
      return;
    }
    const a = objectWorldAabb(obj);
    const pad = 0.3;
    this.selectionBox.scaling.set(a.maxX - a.minX + pad, a.maxY - a.minY + pad, a.maxZ - a.minZ + pad);
    this.selectionBox.position.set((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, (a.minZ + a.maxZ) / 2);
    this.selectionBox.setEnabled(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Overlay visibility
  // ---------------------------------------------------------------------------------------------

  setOverlaysEnabled(enabled: boolean): void {
    this.overlaysEnabled = enabled;
    this.applyOverlayVisibility();
    if (!enabled && this.selectionBox) this.selectionBox.setEnabled(false);
  }

  setGridVisible(v: boolean): void {
    this.gridVisible = v;
    this.applyOverlayVisibility();
  }
  setTriggersVisible(v: boolean): void {
    this.triggersVisible = v;
    this.applyOverlayVisibility();
  }
  setCollisionVisible(v: boolean): void {
    this.collisionVisible = v;
    this.applyOverlayVisibility();
  }
  isGridVisible(): boolean { return this.gridVisible; }
  isTriggersVisible(): boolean { return this.triggersVisible; }
  isCollisionVisible(): boolean { return this.collisionVisible; }

  private applyOverlayVisibility(): void {
    const on = this.overlaysEnabled;
    // The ground floor shows in BOTH Build and Playtest (it's the floor, not a build-only gizmo); only
    // the "show grid" toggle hides it. Trigger/collision debug volumes are Build-only.
    if (this.gridMesh) this.gridMesh.setEnabled(this.gridVisible);
    for (const m of this.triggerMeshes) m.setEnabled(on && this.triggersVisible);
    for (const m of this.collisionMeshes) m.setEnabled(on && this.collisionVisible);
  }

  // ---------------------------------------------------------------------------------------------
  // Selection picking
  // ---------------------------------------------------------------------------------------------

  objectIdForMesh(mesh: { metadata?: unknown } | null | undefined): string | null {
    const meta = mesh?.metadata as Record<string, unknown> | undefined;
    const id = meta?.[OBJECT_ID_KEY];
    return typeof id === 'string' ? id : null;
  }

  isPickableObjectMesh(mesh: { metadata?: unknown } | null | undefined): boolean {
    return this.objectIdForMesh(mesh) !== null;
  }

  getObjectRoot(id: string): TransformNode | undefined {
    return this.objectRoots.get(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Materials + texture helpers (ported from the sandbox grid look)
  // ---------------------------------------------------------------------------------------------

  private tagPickable(mesh: Mesh, objectId: string): void {
    mesh.isPickable = true;
    mesh.metadata = { ...(mesh.metadata ?? {}), [OBJECT_ID_KEY]: objectId };
    this.perBuild.push(mesh);
  }

  private terrainMaterial(id: string): StandardMaterial {
    const key = `terrain_${id}`;
    const cached = this.cachedMaterials.get(key);
    if (cached) return cached;
    const def = materialDef(id);
    const base = new Color3(def.rgb[0], def.rgb[1], def.rgb[2]);
    const mat = new StandardMaterial(`creator_mat_${key}`, this.scene);
    mat.diffuseTexture = this.gridTexture(`creator_grid_${id}`, base, lighten(base, 0.26));
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.emissiveColor = base.scale(0.06);
    mat.specularColor = new Color3(0.04, 0.04, 0.045);
    this.cachedMaterials.set(key, mat);
    return mat;
  }

  private solidMaterial(id: string): StandardMaterial {
    const key = `solid_${id}`;
    const cached = this.cachedMaterials.get(key);
    if (cached) return cached;
    const def = materialDef(id);
    const base = new Color3(def.rgb[0], def.rgb[1], def.rgb[2]);
    const mat = new StandardMaterial(`creator_solid_${key}`, this.scene);
    mat.diffuseColor = base;
    mat.emissiveColor = base.scale(0.3);
    mat.specularColor = new Color3(0.05, 0.05, 0.06);
    this.cachedMaterials.set(key, mat);
    return mat;
  }

  private translucentMaterial(name: string, color: Color3, alpha: number): StandardMaterial {
    const cached = this.cachedMaterials.get(name);
    if (cached) return cached;
    const mat = new StandardMaterial(name, this.scene);
    mat.diffuseColor = color;
    mat.emissiveColor = color.scale(0.6);
    mat.specularColor = new Color3(0, 0, 0);
    mat.alpha = alpha;
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    this.cachedMaterials.set(name, mat);
    return mat;
  }

  private gridBox(name: string, w: number, h: number, d: number, material: StandardMaterial): Mesh {
    const c = GRID_CELL_METRES;
    const uv = (a: number, b: number) => new Vector4(0, 0, Math.max(1, a / c), Math.max(1, b / c));
    const faceUV = [uv(w, h), uv(w, h), uv(d, h), uv(d, h), uv(w, d), uv(w, d)];
    const mesh = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d, wrap: true, faceUV }, this.scene);
    mesh.material = material;
    return mesh;
  }

  private gridTexture(name: string, base: Color3, line: Color3): DynamicTexture {
    const size = 256;
    const lineW = 6;
    const tex = new DynamicTexture(name, { width: size, height: size }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = toCss(base);
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = toCss(line);
    ctx.fillRect(0, 0, size, lineW);
    ctx.fillRect(0, 0, lineW, size);
    tex.update(true);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    // Persistent: this texture backs a cached material, so it must survive rebuilds (an edit calls
    // disposePerBuild every time — disposing it there is what made the floor/walls go black on place).
    this.cachedTextures.push(tex);
    return tex;
  }

  private signPlane(name: string, text: string, width: number, height: number): Mesh {
    const tex = new DynamicTexture(`${name}_tex`, { width: 512, height: 256 }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 256);
    ctx.fillStyle = 'rgba(12, 20, 42, 0.86)';
    roundRect(ctx, 12, 12, 488, 232, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
    ctx.lineWidth = 4;
    roundRect(ctx, 12, 12, 488, 232, 22);
    ctx.stroke();
    ctx.fillStyle = '#eef4ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = text.split('\n').slice(0, 3);
    const fontSize = lines.length > 1 ? 52 : 64;
    ctx.font = `900 ${fontSize}px Arial`;
    const lineH = fontSize + 12;
    const startY = 128 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) => ctx.fillText(line, 256, startY + i * lineH));
    tex.update(true);

    const mat = new StandardMaterial(`${name}_mat`, this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.emissiveColor = new Color3(0.9, 0.94, 1.0);
    mat.disableLighting = true;
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND;

    const mesh = MeshBuilder.CreatePlane(name, { width, height }, this.scene);
    mesh.material = mat;
    this.perBuild.push(tex, mat);
    return mesh;
  }

  // ---------------------------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------------------------

  private disposePerBuild(): void {
    for (const d of this.perBuild) {
      try {
        d.dispose();
      } catch {
        /* ignore double-dispose */
      }
    }
    this.perBuild.length = 0;
  }

  dispose(): void {
    this.disposePerBuild();
    this.selectionBox?.dispose();
    this.gridMesh?.dispose();
    for (const mat of this.cachedMaterials.values()) mat.dispose();
    this.cachedMaterials.clear();
    for (const t of this.cachedTextures) t.dispose();
    this.cachedTextures.length = 0;
    this.objectRoots.clear();
    this.root.dispose();
  }
}

function lighten(c: Color3, amount: number): Color3 {
  return new Color3(Math.min(1, c.r + amount), Math.min(1, c.g + amount), Math.min(1, c.b + amount));
}

function toCss(c: Color3): string {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
