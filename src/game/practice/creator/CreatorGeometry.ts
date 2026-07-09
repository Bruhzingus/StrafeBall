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
  Vector3,
  Vector4,
  VertexData
} from '@babylonjs/core';
import {
  CreatorLayout,
  CreatorLayoutObject,
  CreatorModuleDef,
  materialDef,
  moduleDef,
  moduleLocalBoxes,
  objectCollisionBoxes,
  objectCollisionRamps,
  objectOpacity,
  objectRampPrisms,
  objectWorldAabb,
  textureDef,
  type CreatorLabelColor,
  type CreatorLabelSize,
  type Vec3Tuple
} from './CreatorLayout';
import { layoutWorldBounds } from './CreatorWorld';
import { SANDBOX_CENTER } from '../MovementSandboxLayout';

const OBJECT_ID_KEY = 'creatorObjectId';
const GRID_CELL_METRES = 5;
const DEG2RAD = Math.PI / 180;
const LABEL_SIZE_WORLD_PER_PX: Record<CreatorLabelSize, number> = {
  small: 0.0085,
  medium: 0.011,
  large: 0.014
};
const LABEL_COLOR_STYLES: Record<CreatorLabelColor, { text: string; border: string }> = {
  white: { text: '#eef4ff', border: 'rgba(120, 200, 255, 0.6)' },
  gold: { text: '#ffdf74', border: 'rgba(255, 210, 90, 0.72)' },
  blue: { text: '#83d8ff', border: 'rgba(95, 190, 255, 0.72)' },
  green: { text: '#90f7ae', border: 'rgba(120, 245, 165, 0.72)' },
  red: { text: '#ff9da8', border: 'rgba(255, 130, 145, 0.72)' }
};

interface LabelRenderOptions {
  color: CreatorLabelColor;
  size: CreatorLabelSize;
  placeholder: boolean;
}

interface ResolvedLabelText {
  text: string;
  placeholder: boolean;
}

export class CreatorGeometry {
  private readonly root: TransformNode;
  private readonly previewRoot: TransformNode;
  private readonly cachedMaterials = new Map<string, StandardMaterial>();
  // Textures owned by the CACHED materials (grid floor + terrain) — they must outlive a rebuild, so
  // they are disposed only on full teardown (NOT in disposePerBuild, which runs every edit).
  private readonly cachedTextures: Array<{ dispose(): void }> = [];
  private readonly perBuild: Array<{ dispose(): void }> = [];
  private readonly objectRoots = new Map<string, TransformNode>();

  private gridMesh: Mesh | null = null;
  private selectionBox: Mesh | null = null;
  /** Extra pooled highlight boxes for multi-select (selectionBox is index 0). */
  private readonly extraSelectionBoxes: Mesh[] = [];
  /** Red highlight pool for objects a co-op collaborator has locked (not locally editable). */
  private lockBox: Mesh | null = null;
  private readonly extraLockBoxes: Mesh[] = [];
  // Grab sphere at the move-gizmo origin: pick it to free-drag the object along the cursor ray.
  private centerHandle: Mesh | null = null;
  private readonly previewBuild: Array<{ dispose(): void }> = [];
  // Persistent placement-preview handles (built once per shape, moved per frame — see setPlacementPreview).
  private previewShapeSig: string | null = null;
  private previewObjRoot: TransformNode | null = null;
  private previewFootRoot: TransformNode | null = null;
  private previewDrop: Mesh | null = null;
  private previewLocalCX = 0;
  private previewLocalCZ = 0;
  private previewLocalMinY = 0;
  private readonly triggerMeshes: Mesh[] = [];
  private readonly collisionMeshes: Mesh[] = [];
  /** Build-only moving-platform previews: the travel line + a far-end ghost box. */
  private readonly moverPreviewMeshes: Mesh[] = [];
  // Invisible editor-only pick volumes so 0%-opacity objects remain clickable in Build.
  private readonly opacityPickMeshes: Mesh[] = [];

  private gridVisible = true;
  private triggersVisible = true;
  private collisionVisible = false;
  private overlaysEnabled = true;
  private groundY = 0;

  constructor(private readonly scene: Scene) {
    this.root = new TransformNode('creator_geometry_root', scene);
    this.previewRoot = new TransformNode('creator_preview_root', scene);
    this.previewRoot.parent = this.root;
    this.previewRoot.setEnabled(false);
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
    this.opacityPickMeshes.length = 0;
    this.moverPreviewMeshes.length = 0;

    this.ensureGrid();
    this.ensureSelectionBox();
    this.ensureLockBox();
    this.positionGrid(layout);

    for (const obj of layout.objects) {
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
      if (obj.metadata?.mover) this.buildMoverPreview(obj);
    } else {
      this.buildMarker(obj, node);
    }
    this.applyObjectOpacity(obj, node);
  }

  /**
   * Build-only moving-platform preview: a thin line from the placed position to the far end of the
   * travel, plus a wireframe ghost box of the platform at that far end. World-space (NOT parented to
   * the object node — the runtime moves that node), toggled off with the other editor overlays.
   */
  private buildMoverPreview(obj: CreatorLayoutObject): void {
    const mover = obj.metadata?.mover;
    if (!mover) return;
    const len = Math.hypot(mover.dx, mover.dy, mover.dz);
    if (len < 1e-3) return;
    const mat = this.solidMaterial('marker_gold');

    const a = objectWorldAabb(obj);
    const cy = (a.minY + a.maxY) / 2;
    const start = { x: obj.position[0], y: cy, z: obj.position[2] };
    const line = MeshBuilder.CreateBox(`creator_mover_line_${obj.id}`, { width: 0.08, height: 0.08, depth: len }, this.scene);
    line.position.set(start.x + mover.dx / 2, start.y + mover.dy / 2, start.z + mover.dz / 2);
    // Aim local +Z along the travel direction (yaw from XZ, pitch from the vertical component).
    line.rotation.set(-Math.asin(Math.max(-1, Math.min(1, mover.dy / len))), Math.atan2(mover.dx, mover.dz), 0);
    line.material = mat;
    line.isPickable = false;
    line.parent = this.root;
    this.perBuild.push(line);
    this.moverPreviewMeshes.push(line);

    const ghost = MeshBuilder.CreateBox(`creator_mover_ghost_${obj.id}`, {
      width: Math.max(0.2, a.maxX - a.minX),
      height: Math.max(0.2, a.maxY - a.minY),
      depth: Math.max(0.2, a.maxZ - a.minZ)
    }, this.scene);
    ghost.position.set((a.minX + a.maxX) / 2 + mover.dx, cy + mover.dy, (a.minZ + a.maxZ) / 2 + mover.dz);
    const ghostMat = this.selectionMaterial();
    ghost.material = ghostMat;
    ghost.isPickable = false;
    ghost.parent = this.root;
    this.perBuild.push(ghost);
    this.moverPreviewMeshes.push(ghost);
  }

  private applyObjectOpacity(obj: CreatorLayoutObject, node: TransformNode): void {
    const opacity = objectOpacity(obj);
    for (const mesh of node.getChildMeshes(false)) mesh.visibility = opacity;
    if (opacity <= 0.001) this.buildOpacityPickProxy(obj);
  }

  private buildOpacityPickProxy(obj: CreatorLayoutObject): void {
    const a = objectWorldAabb(obj);
    const w = Math.max(0.1, a.maxX - a.minX);
    const h = Math.max(0.1, a.maxY - a.minY);
    const d = Math.max(0.1, a.maxZ - a.minZ);
    const proxy = MeshBuilder.CreateBox(`creator_pick_${obj.id}`, { width: w, height: h, depth: d }, this.scene);
    proxy.position.set((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, (a.minZ + a.maxZ) / 2);
    proxy.material = this.opacityPickMaterial();
    proxy.parent = this.root;
    this.opacityPickMeshes.push(proxy);
    this.perBuild.push(proxy);
    this.tagPickable(proxy, obj.id);
  }

  private buildSolid(obj: CreatorLayoutObject, node: TransformNode): void {
    const def = moduleDef(obj.type);
    if (!def) return;
    const texId = obj.texture && textureDef(obj.texture) ? obj.texture : null;
    const mat = texId ? this.texturedMaterial(texId) : this.terrainMaterial(obj.material ?? 'concrete');
    const cell = texId ? textureDef(texId)!.tile : GRID_CELL_METRES;
    if (def.shape === 'ramp') {
      const [w, h, d] = def.baseSize;
      const mesh = this.rampMesh(`creator_${obj.id}_ramp`, w, h, d, mat, cell, obj.scale);
      mesh.parent = node;
      this.tagPickable(mesh, obj.id);
      return;
    }
    // Per-mesh UVs use scaled world dimensions, so resizing objects keeps material density consistent
    // without touching cached material texture scales shared by other objects.
    const boxes = moduleLocalBoxes(obj.type);
    boxes.forEach((b, i) => {
      const mesh = this.gridBox(`creator_${obj.id}_${i}`, b.s[0], b.s[1], b.s[2], mat, cell, obj.scale);
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
      case 'box':
        this.buildHazardBox(obj, node, w, h, d);
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

    this.attachLabel(obj, node, this.markerLabel(obj), 1.6);

    // Facing chevron so spawn / pad orientation is readable — a flat triangle pointing LOCAL +Z (the
    // node's facing), sitting just above the pad surface.
    const reach = Math.min(w, d) * 0.32;
    const chevron = this.flatTriangle(`creator_${obj.id}_dir`, reach * 0.7, reach, this.solidMaterial('marker_gold'));
    chevron.position.set(0, Math.max(0.1, h) + 0.02, d * 0.15);
    chevron.parent = node;
    chevron.isPickable = false;
    this.perBuild.push(chevron);
  }

  /** A translucent red hazard VOLUME (kill block) — walk-through, sized to the object, base on the floor. */
  private buildHazardBox(obj: CreatorLayoutObject, node: TransformNode, w: number, h: number, d: number): void {
    const box = MeshBuilder.CreateBox(`creator_${obj.id}_hazard`, { width: w, height: h, depth: d }, this.scene);
    box.position.set(0, h / 2, 0);
    box.material = this.translucentMaterial('creator_hazard_mat', new Color3(0.95, 0.22, 0.22), 0.34);
    box.parent = node;
    this.tagPickable(box, obj.id);
    this.attachLabel(obj, node, this.markerLabel(obj), h + 0.4);
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
    this.attachLabel(obj, node, this.labelWithPrefix(obj, text), h + 0.5);
  }

  private buildArrow(obj: CreatorLayoutObject, node: TransformNode, w: number, d: number, mat: StandardMaterial): void {
    // A flat ground arrow lying in the XZ plane, pointing LOCAL +Z (the node's facing). The shaft is a
    // thin flat bar and the head a flat triangle — both flat so the whole arrow reads from above and at
    // grazing angles, and the head points the same way the arrow is rotated.
    const shaft = MeshBuilder.CreateBox(`creator_${obj.id}_shaft`, { width: w * 0.3, height: 0.06, depth: d * 0.55 }, this.scene);
    shaft.position.set(0, 0.06, -d * 0.175);
    shaft.material = mat;
    shaft.parent = node;
    this.tagPickable(shaft, obj.id);
    const head = this.flatTriangle(`creator_${obj.id}_head`, w * 0.5, d * 0.5, mat);
    head.position.set(0, 0.07, 0);
    head.parent = node;
    this.tagPickable(head, obj.id);
    this.attachLabel(obj, node, this.arrowLabel(obj), 1.4);
  }

  private buildSignboard(obj: CreatorLayoutObject, node: TransformNode, w: number, h: number): void {
    const postH = Math.max(0.6, h * 0.8);
    const post = MeshBuilder.CreateBox(`creator_${obj.id}_post`, { width: 0.16, height: postH, depth: 0.16 }, this.scene);
    post.position.set(0, postH / 2, 0);
    post.material = this.solidMaterial('marker_gold');
    post.parent = node;
    this.tagPickable(post, obj.id);
    this.attachLabel(obj, node, this.labelWithDefault(obj, obj.name || 'SIGN'), postH + h / 2);
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
    this.attachLabel(obj, node, this.labelWithDefault(obj, 'LEAVE'), h + 0.6);
  }

  private markerLabel(obj: CreatorLayoutObject): ResolvedLabelText {
    return this.labelWithDefault(obj, obj.name || moduleDef(obj.type)?.label || '');
  }

  private arrowLabel(obj: CreatorLayoutObject): ResolvedLabelText {
    return this.labelWithDefault(obj, obj.name || '');
  }

  private labelWithDefault(obj: CreatorLayoutObject, fallback: string): ResolvedLabelText {
    return this.explicitLabel(obj) ?? { text: fallback, placeholder: false };
  }

  private labelWithPrefix(obj: CreatorLayoutObject, prefix: string): ResolvedLabelText {
    const extra = this.explicitLabel(obj);
    if (!extra) return { text: prefix, placeholder: false };
    return { text: `${prefix}\n${extra.text}`, placeholder: extra.placeholder };
  }

  private explicitLabel(obj: CreatorLayoutObject): ResolvedLabelText | null {
    if (!obj.metadata || !Object.prototype.hasOwnProperty.call(obj.metadata, 'label')) return null;
    const text = obj.metadata.label ?? '';
    if (text.trim().length === 0) return { text: '', placeholder: false };
    return { text, placeholder: false };
  }

  private attachLabel(obj: CreatorLayoutObject, node: TransformNode, label: ResolvedLabelText, y: number): void {
    // so it can't be toggled off with the object node — and a hidden object shouldn't show a floating label.
    const opacity = objectOpacity(obj);
    if (opacity <= 0.001) return;
    if (obj.metadata?.labelVisible === false) return;
    if (label.text.trim().length === 0) return;
    const mesh = this.signPlane(`creator_${obj.id}_label`, label.text, {
      color: obj.metadata?.labelColor ?? 'white',
      size: obj.metadata?.labelSize ?? 'medium',
      placeholder: label.placeholder
    });
    // Parent to the (unrotated, unscaled) geometry root at the marker's WORLD position and billboard it,
    // so the text always faces the camera and can never render mirrored/backwards, whatever the object's
    // rotation. Billboarding a child of a ROTATED node misbehaves, so we root-parent + position in world.
    // The label mesh isn't owned by `node` anymore, so it must be tracked for per-build disposal.
    const scaleY = obj.scale[1] ?? 1;
    const offsetY = clamp(obj.metadata?.labelOffsetY ?? 0, -10, 30);
    mesh.position.set(obj.position[0], obj.position[1] + y * scaleY + offsetY, obj.position[2]);
    mesh.parent = this.root;
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.visibility = opacity;
    mesh.isPickable = false;
    this.perBuild.push(mesh);
  }

  /**
   * A flat, double-sided triangle lying in the XZ plane whose point faces LOCAL +Z (the node's facing),
   * built from explicit vertices so arrows / direction chevrons ALWAYS point the way the object is
   * rotated (a tessellation-3 cylinder's start angle is undefined and rendered them sideways/upright).
   */
  private flatTriangle(name: string, halfWidth: number, length: number, mat: StandardMaterial): Mesh {
    const mesh = new Mesh(name, this.scene);
    const vd = new VertexData();
    vd.positions = [0, 0, length, -halfWidth, 0, 0, halfWidth, 0, 0];
    vd.indices = [0, 1, 2, 0, 2, 1]; // both windings → visible from above and below
    vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0];
    vd.applyToMesh(mesh);
    mesh.material = mat;
    return mesh;
  }

  /** Smooth ramp wedge: base sits at local Y=0, low edge at -X, high edge at +X. */
  private rampMesh(name: string, w: number, h: number, d: number, mat: StandardMaterial, cell = GRID_CELL_METRES, scale: readonly number[] = [1, 1, 1]): Mesh {
    const hw = w / 2;
    const hd = d / 2;
    const sx = scale[0] ?? 1, sy = scale[1] ?? 1, sz = scale[2] ?? 1;
    const ww = w * sx, hh = h * sy, dd = d * sz;
    const slopedW = Math.hypot(ww, hh);
    const u = (v: number) => Math.max(1, v / cell);
    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    const addFace = (points: Vec3Tuple[], faceUvs: Array<[number, number]>): void => {
      const base = positions.length / 3;
      for (let i = 0; i < points.length; i += 1) {
        const p = points[i];
        positions.push(p[0], p[1], p[2]);
        uvs.push(faceUvs[i][0], faceUvs[i][1]);
      }
      if (points.length === 3) indices.push(base, base + 1, base + 2);
      else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    addFace(
      [[-hw, 0, -hd], [-hw, 0, hd], [hw, h, hd], [hw, h, -hd]],
      [[0, 0], [0, u(dd)], [u(slopedW), u(dd)], [u(slopedW), 0]]
    );
    addFace(
      [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd]],
      [[0, 0], [u(ww), 0], [u(ww), u(dd)], [0, u(dd)]]
    );
    addFace(
      [[hw, 0, -hd], [hw, h, -hd], [hw, h, hd], [hw, 0, hd]],
      [[0, 0], [u(hh), 0], [u(hh), u(dd)], [0, u(dd)]]
    );
    addFace(
      [[-hw, 0, -hd], [hw, h, -hd], [hw, 0, -hd]],
      [[0, 0], [u(ww), u(hh)], [u(ww), 0]]
    );
    addFace(
      [[-hw, 0, hd], [hw, 0, hd], [hw, h, hd]],
      [[0, 0], [u(ww), 0], [u(ww), u(hh)]]
    );

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const mesh = new Mesh(name, this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.uvs = uvs;
    vd.applyToMesh(mesh);
    mat.backFaceCulling = false;
    mesh.material = mat;
    return mesh;
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
      // Collision-bound debug boxes — the true oriented boxes the player actually collides with.
      for (const sub of objectCollisionBoxes(obj)) {
        const box = MeshBuilder.CreateBox(`creator_col_${obj.id}`, { width: sub.w, height: sub.h, depth: sub.d }, this.scene);
        box.position.set(sub.cx, sub.cy, sub.cz);
        box.rotation.y = sub.ry;
        box.material = collisionMat;
        box.isPickable = false;
        box.parent = this.root;
        this.collisionMeshes.push(box);
        this.perBuild.push(box);
      }
      for (const ramp of objectCollisionRamps(obj)) {
        const mesh = this.rampMesh(`creator_col_${obj.id}_ramp`, ramp.w, ramp.h, ramp.d, collisionMat);
        mesh.position.set(ramp.cx, ramp.baseY, ramp.cz);
        mesh.rotation.y = ramp.ry;
        mesh.isPickable = false;
        mesh.parent = this.root;
        this.collisionMeshes.push(mesh);
        this.perBuild.push(mesh);
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
    this.groundY = layout.ground.bounds.y ?? 0;
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
    this.selectionBox = this.createSelectionBoxMesh('creator_selection');
  }

  private selectionMaterial(): StandardMaterial {
    const cached = this.cachedMaterials.get('__selection');
    if (cached) return cached;
    const mat = new StandardMaterial('creator_selection_mat', this.scene);
    mat.emissiveColor = new Color3(1.0, 0.86, 0.2);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.wireframe = true;
    this.cachedMaterials.set('__selection', mat);
    return mat;
  }

  private createSelectionBoxMesh(name: string): Mesh {
    const box = MeshBuilder.CreateBox(name, { size: 1 }, this.scene);
    box.material = this.selectionMaterial();
    box.isPickable = false;
    box.setEnabled(false);
    box.parent = this.root;
    return box;
  }

  private ensureLockBox(): void {
    if (!this.lockBox) this.lockBox = this.createLockBoxMesh('creator_lock');
  }

  private lockMaterial(): StandardMaterial {
    const cached = this.cachedMaterials.get('__lock');
    if (cached) return cached;
    const mat = new StandardMaterial('creator_lock_mat', this.scene);
    mat.emissiveColor = new Color3(1.0, 0.16, 0.16); // illuminated red: "a collaborator is editing this"
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.wireframe = true;
    this.cachedMaterials.set('__lock', mat);
    return mat;
  }

  private createLockBoxMesh(name: string): Mesh {
    const box = MeshBuilder.CreateBox(name, { size: 1 }, this.scene);
    box.material = this.lockMaterial();
    box.isPickable = false;
    box.setEnabled(false);
    box.parent = this.root;
    return box;
  }

  /** Red highlight for objects a co-op collaborator has locked (mirrors setSelectionMany, pooled). */
  setLockedMany(objs: readonly CreatorLayoutObject[]): void {
    this.ensureLockBox();
    if (!this.lockBox) return;
    while (this.extraLockBoxes.length < Math.max(0, objs.length - 1)) {
      this.extraLockBoxes.push(this.createLockBoxMesh(`creator_lock_${this.extraLockBoxes.length + 1}`));
    }
    const pool: Mesh[] = [this.lockBox, ...this.extraLockBoxes];
    for (let i = 0; i < pool.length; i += 1) {
      const box = pool[i];
      const obj = i < objs.length && this.overlaysEnabled ? objs[i] : null;
      if (!obj) {
        box.setEnabled(false);
        continue;
      }
      this.placeSelectionBox(box, obj);
    }
  }

  setSelection(obj: CreatorLayoutObject | null): void {
    this.setSelectionMany(obj ? [obj] : []);
  }

  /** Multi-select highlight: one oriented wireframe box per selected object (pooled, never rebuilt). */
  setSelectionMany(objs: readonly CreatorLayoutObject[]): void {
    if (!this.selectionBox) return;
    // Pool: box 0 is the original selectionBox; extras are created on demand and reused.
    while (this.extraSelectionBoxes.length < Math.max(0, objs.length - 1)) {
      this.extraSelectionBoxes.push(this.createSelectionBoxMesh(`creator_selection_${this.extraSelectionBoxes.length + 1}`));
    }
    const pool: Mesh[] = [this.selectionBox, ...this.extraSelectionBoxes];
    for (let i = 0; i < pool.length; i += 1) {
      const box = pool[i];
      const obj = i < objs.length && this.overlaysEnabled ? objs[i] : null;
      if (!obj) {
        box.setEnabled(false);
        continue;
      }
      this.placeSelectionBox(box, obj);
    }
  }

  private placeSelectionBox(box: Mesh, obj: CreatorLayoutObject): void {
    // Oriented highlight: size from the LOCAL extent × scale and rotate with the object so a rotated
    // piece gets a tight box that hugs it (not a fat axis-aligned one). ry=0 reduces to the old box.
    const local = objectWorldAabb({ ...obj, position: [0, 0, 0] as Vec3Tuple, rotation: [0, 0, 0] as Vec3Tuple, scale: [1, 1, 1] as Vec3Tuple });
    const sx = obj.scale[0], sy = obj.scale[1], sz = obj.scale[2];
    const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
    const pad = 0.3;
    const lcx = ((local.minX + local.maxX) / 2) * sx;
    const lcy = ((local.minY + local.maxY) / 2) * sy;
    const lcz = ((local.minZ + local.maxZ) / 2) * sz;
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    box.rotation.set(0, ry, 0);
    box.scaling.set((local.maxX - local.minX) * sx + pad, (local.maxY - local.minY) * sy + pad, (local.maxZ - local.minZ) * sz + pad);
    box.position.set(obj.position[0] + lcx * cos + lcz * sin, obj.position[1] + lcy, obj.position[2] - lcx * sin + lcz * cos);
    box.setEnabled(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Center drag handle (grab sphere at the move-gizmo origin)
  // ---------------------------------------------------------------------------------------------

  private ensureCenterHandle(): void {
    if (this.centerHandle) return;
    const mat = new StandardMaterial('creator_center_handle_mat', this.scene);
    mat.emissiveColor = new Color3(1.0, 0.85, 0.25);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    this.cachedMaterials.set('__center_handle', mat);
    const sphere = MeshBuilder.CreateSphere('creator_center_handle', { diameter: 1, segments: 12 }, this.scene);
    sphere.material = mat;
    sphere.isPickable = true;
    sphere.renderingGroupId = 3; // draw over world geometry so the grab point is never buried inside a mesh
    sphere.setEnabled(false);
    sphere.parent = this.root;
    this.centerHandle = sphere;
  }

  /** Show the free-drag grab sphere at the move-gizmo origin (null hides it). Caller passes a scale for ~constant screen size. */
  setCenterHandle(position: Vector3 | null, scale: number): void {
    this.ensureCenterHandle();
    const handle = this.centerHandle!;
    if (!position || !this.overlaysEnabled) {
      handle.setEnabled(false);
      return;
    }
    handle.position.copyFrom(position);
    handle.scaling.setAll(Math.max(0.05, scale));
    handle.setEnabled(true);
  }

  getCenterHandleMesh(): Mesh | null {
    return this.centerHandle;
  }

  // ---------------------------------------------------------------------------------------------
  // Placement preview
  // ---------------------------------------------------------------------------------------------

  /**
   * Show/update the placement ghost. CRITICAL: the meshes are rebuilt only when the SHAPE changes
   * (type/rotation/scale/look) — never per frame, since recreating transparent meshes every frame made
   * the ghost flicker ("flash in and out") and small/thin shapes look like they never appeared. While
   * only the position changes (the common case — moving the cursor) we just move the existing meshes.
   */
  setPlacementPreview(obj: CreatorLayoutObject | null): void {
    const def = obj ? moduleDef(obj.type) : undefined;
    if (!obj || !def || !this.overlaysEnabled) {
      this.hidePreview();
      return;
    }
    const sig = this.previewShapeSignature(obj);
    if (sig !== this.previewShapeSig) {
      this.previewShapeSig = sig;
      this.buildPreviewMeshes(obj, def);
    }
    this.movePreview(obj);
    this.previewRoot.setEnabled(true);
  }

  clearPlacementPreview(): void {
    this.hidePreview();
  }

  /** Idempotent hide — disposes once, then no-ops, so repeated clears never churn meshes. */
  private hidePreview(): void {
    if (this.previewShapeSig === null && this.previewBuild.length === 0) return;
    this.disposePreview();
    this.previewRoot.setEnabled(false);
    this.previewShapeSig = null;
  }

  /** What forces a mesh rebuild — everything except world position (which is a cheap transform). */
  private previewShapeSignature(obj: CreatorLayoutObject): string {
    const r = (n: number) => Math.round((n ?? 0) * 1000) / 1000;
    return [obj.type, r(obj.rotation[1] ?? 0), r(obj.scale[0]), r(obj.scale[1]), r(obj.scale[2]), obj.material ?? '', obj.texture ?? ''].join('|');
  }

  private buildPreviewMeshes(obj: CreatorLayoutObject, def: CreatorModuleDef): void {
    this.disposePreview();

    const node = new TransformNode(`creator_preview_${obj.type}`, this.scene);
    node.parent = this.previewRoot;
    this.previewObjRoot = node;
    this.previewBuild.push(node);

    const fill = this.previewMaterial();
    if (def.category === 'terrain') {
      if (def.shape === 'ramp') {
        const [w, h, d] = def.baseSize;
        this.configurePreviewMesh(this.rampMesh(`creator_preview_${obj.type}_ramp`, w, h, d, fill), fill, node);
      } else {
        for (const b of moduleLocalBoxes(obj.type)) {
          const mesh = MeshBuilder.CreateBox(`creator_preview_${obj.type}_box`, { width: b.s[0], height: b.s[1], depth: b.s[2] }, this.scene);
          mesh.position.set(b.o[0], b.o[1], b.o[2]);
          this.configurePreviewMesh(mesh, fill, node);
        }
      }
    } else {
      this.buildMarkerPreview(obj, node, fill);
    }

    // LOCAL (unrotated, unscaled) extent — the object root supplies rotation/scale/position, so the
    // bounds + footprint stay TIGHT and rotate WITH the object instead of a fat axis-aligned square.
    const local = objectWorldAabb({ ...obj, position: [0, 0, 0] as Vec3Tuple, rotation: [0, 0, 0] as Vec3Tuple, scale: [1, 1, 1] as Vec3Tuple });
    const lw = Math.max(0.1, local.maxX - local.minX);
    const lh = Math.max(0.1, local.maxY - local.minY);
    const ld = Math.max(0.1, local.maxZ - local.minZ);
    this.previewLocalCX = (local.minX + local.maxX) / 2;
    this.previewLocalCZ = (local.minZ + local.maxZ) / 2;
    this.previewLocalMinY = local.minY;
    const lcy = (local.minY + local.maxY) / 2;

    // Tight oriented bounds outline — child of the object root, so it inherits rotation/scale/position.
    const bounds = MeshBuilder.CreateBox('creator_preview_bounds', { width: lw, height: lh, depth: ld }, this.scene);
    bounds.position.set(this.previewLocalCX, lcy, this.previewLocalCZ);
    bounds.material = this.previewOutlineMaterial();
    bounds.isPickable = false;
    bounds.parent = node;
    this.previewBuild.push(bounds);

    // Ground footprint: its own root pinned to the floor but sharing the object's yaw + XZ scale.
    const footRoot = new TransformNode('creator_preview_footroot', this.scene);
    footRoot.parent = this.previewRoot;
    this.previewFootRoot = footRoot;
    this.previewBuild.push(footRoot);
    const footMat = this.previewFootprintMaterial();
    const footprint = MeshBuilder.CreateBox('creator_preview_footprint', { width: Math.max(0.4, lw), height: 0.06, depth: Math.max(0.4, ld) }, this.scene);
    footprint.position.set(this.previewLocalCX, 0, this.previewLocalCZ);
    footprint.material = footMat;
    footprint.isPickable = false;
    footprint.parent = footRoot;
    this.previewBuild.push(footprint);

    // Unit-height drop line, scaled per frame to span ground → object base (hidden when grounded).
    const drop = MeshBuilder.CreateBox('creator_preview_drop', { width: 0.14, height: 1, depth: 0.14 }, this.scene);
    drop.material = footMat;
    drop.isPickable = false;
    drop.parent = this.previewRoot;
    drop.setEnabled(false);
    this.previewDrop = drop;
    this.previewBuild.push(drop);
  }

  /** Per-frame transform update only (no mesh creation/disposal → no flicker). */
  private movePreview(obj: CreatorLayoutObject): void {
    const px = obj.position[0], py = obj.position[1], pz = obj.position[2];
    const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
    const sx = obj.scale[0], sy = obj.scale[1], sz = obj.scale[2];
    if (this.previewObjRoot) {
      this.previewObjRoot.position.set(px, py, pz);
      this.previewObjRoot.rotation.set(0, ry, 0);
      this.previewObjRoot.scaling.set(sx, sy, sz);
    }
    if (this.previewFootRoot) {
      this.previewFootRoot.position.set(px, this.groundY + 0.04, pz);
      this.previewFootRoot.rotation.set(0, ry, 0);
      this.previewFootRoot.scaling.set(sx, 1, sz);
    }
    if (this.previewDrop) {
      // World footprint centre = object base + rotated/scaled local centre.
      const cos = Math.cos(ry);
      const sin = Math.sin(ry);
      const lcx = this.previewLocalCX * sx;
      const lcz = this.previewLocalCZ * sz;
      const wcx = px + lcx * cos + lcz * sin;
      const wcz = pz - lcx * sin + lcz * cos;
      const h = py + this.previewLocalMinY * sy - this.groundY;
      if (h > 0.15) {
        this.previewDrop.setEnabled(true);
        this.previewDrop.scaling.set(1, h, 1);
        this.previewDrop.position.set(wcx, this.groundY + h / 2, wcz);
      } else {
        this.previewDrop.setEnabled(false);
      }
    }
  }

  private buildMarkerPreview(obj: CreatorLayoutObject, node: TransformNode, mat: StandardMaterial): void {
    const def = moduleDef(obj.type);
    if (!def) return;
    const [w, h, d] = def.baseSize;
    switch (def.shape) {
      case 'gate':
      case 'portal': {
        const postT = Math.max(0.18, w * 0.06);
        for (const sx of [-1, 1]) {
          const post = MeshBuilder.CreateBox(`creator_preview_${obj.type}_post`, { width: postT, height: h, depth: Math.max(0.18, d) }, this.scene);
          post.position.set((sx * (w - postT)) / 2, h / 2, 0);
          this.configurePreviewMesh(post, mat, node);
        }
        const beam = MeshBuilder.CreateBox(`creator_preview_${obj.type}_beam`, { width: w, height: postT, depth: Math.max(0.18, d) }, this.scene);
        beam.position.set(0, h - postT / 2, 0);
        this.configurePreviewMesh(beam, mat, node);
        break;
      }
      case 'box': {
        const box = MeshBuilder.CreateBox(`creator_preview_${obj.type}_box`, { width: w, height: h, depth: d }, this.scene);
        box.position.set(0, h / 2, 0);
        this.configurePreviewMesh(box, mat, node);
        break;
      }
      case 'arrow': {
        const shaft = MeshBuilder.CreateBox(`creator_preview_${obj.type}_shaft`, { width: w * 0.3, height: 0.08, depth: d * 0.55 }, this.scene);
        shaft.position.set(0, 0.08, -d * 0.175);
        this.configurePreviewMesh(shaft, mat, node);
        const head = this.flatTriangle(`creator_preview_${obj.type}_head`, w * 0.5, d * 0.5, mat);
        head.position.set(0, 0.09, 0);
        this.configurePreviewMesh(head, mat, node);
        break;
      }
      case 'sign': {
        const post = MeshBuilder.CreateBox(`creator_preview_${obj.type}_post`, { width: 0.16, height: Math.max(0.6, h * 0.8), depth: 0.16 }, this.scene);
        post.position.set(0, Math.max(0.6, h * 0.8) / 2, 0);
        this.configurePreviewMesh(post, mat, node);
        const face = MeshBuilder.CreateBox(`creator_preview_${obj.type}_face`, { width: w, height: h, depth: Math.max(0.08, d) }, this.scene);
        face.position.set(0, Math.max(0.6, h * 0.8) + h / 2, 0);
        this.configurePreviewMesh(face, mat, node);
        break;
      }
      default: {
        const pad = MeshBuilder.CreateBox(`creator_preview_${obj.type}_pad`, { width: w, height: Math.max(0.08, h), depth: d }, this.scene);
        pad.position.set(0, Math.max(0.04, h / 2), 0);
        this.configurePreviewMesh(pad, mat, node);
        const reach = Math.min(w, d) * 0.32;
        const arrow = this.flatTriangle(`creator_preview_${obj.type}_dir`, reach * 0.7, reach, mat);
        arrow.position.set(0, Math.max(0.1, h) + 0.03, d * 0.15);
        this.configurePreviewMesh(arrow, mat, node);
        break;
      }
    }
  }

  private configurePreviewMesh(mesh: Mesh, material: StandardMaterial, parent: TransformNode): void {
    mesh.material = material;
    mesh.isPickable = false;
    mesh.parent = parent;
    this.previewBuild.push(mesh);
  }

  // ---------------------------------------------------------------------------------------------
  // Overlay visibility
  // ---------------------------------------------------------------------------------------------

  setOverlaysEnabled(enabled: boolean): void {
    this.overlaysEnabled = enabled;
    this.applyOverlayVisibility();
    if (!enabled && this.selectionBox) this.selectionBox.setEnabled(false);
    if (!enabled) for (const box of this.extraSelectionBoxes) box.setEnabled(false);
    if (!enabled && this.lockBox) this.lockBox.setEnabled(false);
    if (!enabled) for (const box of this.extraLockBoxes) box.setEnabled(false);
    if (!enabled && this.centerHandle) this.centerHandle.setEnabled(false);
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
    for (const m of this.opacityPickMeshes) m.setEnabled(on);
    for (const m of this.moverPreviewMeshes) m.setEnabled(on); // Build-only travel-path previews
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

  /** A real in-game image texture (tiled) applied as a lit material — cached + persists across rebuilds. */
  private texturedMaterial(id: string): StandardMaterial {
    const key = `tex_${id}`;
    const cached = this.cachedMaterials.get(key);
    if (cached) return cached;
    const def = textureDef(id)!;
    const mat = new StandardMaterial(`creator_${key}`, this.scene);
    const tex = new Texture(def.url, this.scene);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    mat.diffuseTexture = tex;
    mat.diffuseColor = new Color3(1, 1, 1);
    // Lift the shadowed side a touch so the texture reads clearly in the editor's flat lighting.
    mat.emissiveColor = new Color3(0.12, 0.12, 0.13);
    mat.specularColor = new Color3(0.05, 0.05, 0.06);
    this.cachedMaterials.set(key, mat);
    this.cachedTextures.push(tex);
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

  private opacityPickMaterial(): StandardMaterial {
    const cached = this.cachedMaterials.get('__opacity_pick');
    if (cached) return cached;
    const mat = new StandardMaterial('creator_opacity_pick_mat', this.scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.emissiveColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.alpha = 0;
    mat.disableLighting = true;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.cachedMaterials.set('__opacity_pick', mat);
    return mat;
  }

  private previewMaterial(): StandardMaterial {
    const cached = this.cachedMaterials.get('__placement_preview');
    if (cached) return cached;
    const color = new Color3(0.12, 0.72, 1.0);
    const mat = new StandardMaterial('creator_placement_preview_mat', this.scene);
    mat.diffuseColor = color;
    mat.emissiveColor = color.scale(0.8);
    mat.specularColor = new Color3(0, 0, 0);
    mat.alpha = 0.46;
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.cachedMaterials.set('__placement_preview', mat);
    return mat;
  }

  /** Bright, unlit marker used for the placement footprint + drop line on the ground. */
  private previewFootprintMaterial(): StandardMaterial {
    const cached = this.cachedMaterials.get('__placement_footprint');
    if (cached) return cached;
    const color = new Color3(1.0, 0.82, 0.2);
    const mat = new StandardMaterial('creator_placement_footprint_mat', this.scene);
    mat.emissiveColor = color;
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.alpha = 0.9;
    this.cachedMaterials.set('__placement_footprint', mat);
    return mat;
  }

  private previewOutlineMaterial(): StandardMaterial {
    const cached = this.cachedMaterials.get('__placement_preview_outline');
    if (cached) return cached;
    const mat = new StandardMaterial('creator_placement_preview_outline_mat', this.scene);
    mat.emissiveColor = new Color3(0.65, 0.95, 1.0);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.wireframe = true;
    this.cachedMaterials.set('__placement_preview_outline', mat);
    return mat;
  }

  private gridBox(name: string, w: number, h: number, d: number, material: StandardMaterial, cell = GRID_CELL_METRES, scale: readonly number[] = [1, 1, 1]): Mesh {
    // World-space dims drive how many texture cells tile across each face (so scaled walls keep density).
    const sx = scale[0] ?? 1, sy = scale[1] ?? 1, sz = scale[2] ?? 1;
    const ww = w * sx, hh = h * sy, dd = d * sz;
    const uv = (a: number, b: number) => new Vector4(0, 0, Math.max(1, a / cell), Math.max(1, b / cell));
    const faceUV = [uv(ww, hh), uv(ww, hh), uv(dd, hh), uv(dd, hh), uv(ww, dd), uv(ww, dd)];
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

  /**
   * A text sign whose texture AND world plane both size to fit the text: the width flexes with the
   * longest line (measured), the height with the line count. So "GO" gets a small tag and a long label
   * a wide banner, with a consistent text height and no stretching (texture + plane share one aspect).
   */
  private signPlane(name: string, text: string, options: LabelRenderOptions): Mesh {
    const lines = text.split('\n').map((l) => l.slice(0, 40)).slice(0, 3);
    const fontPx = 64;
    const padX = 46;
    const padY = 28;
    const lineStep = fontPx + 18;
    const color = LABEL_COLOR_STYLES[options.color];

    // Measure the text on a scratch 2D context so the texture is only as wide as the content needs.
    const measure = document.createElement('canvas').getContext('2d');
    let maxTextPx = 1;
    if (measure) {
      measure.font = `900 ${fontPx}px Arial`;
      for (const l of lines) maxTextPx = Math.max(maxTextPx, measure.measureText(l || ' ').width);
    } else {
      maxTextPx = Math.max(1, ...lines.map((l) => l.length)) * fontPx * 0.6;
    }
    const texW = Math.max(120, Math.min(1600, Math.round(maxTextPx + padX * 2)));
    const texH = Math.round(lines.length * lineStep + padY * 2);

    const tex = new DynamicTexture(`${name}_tex`, { width: texW, height: texH }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, texW, texH);
    ctx.fillStyle = 'rgba(12, 20, 42, 0.86)';
    roundRect(ctx, 6, 6, texW - 12, texH - 12, 20);
    ctx.fill();
    ctx.strokeStyle = options.placeholder ? 'rgba(150, 170, 205, 0.72)' : color.border;
    ctx.lineWidth = 4;
    if (options.placeholder) ctx.setLineDash([14, 10]);
    roundRect(ctx, 6, 6, texW - 12, texH - 12, 20);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = options.placeholder ? 'rgba(190, 205, 232, 0.78)' : color.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${fontPx}px Arial`;
    const startY = texH / 2 - ((lines.length - 1) * lineStep) / 2;
    lines.forEach((line, i) => ctx.fillText(line, texW / 2, startY + i * lineStep));
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

    // World size shares the texture aspect (no stretch); a constant world-per-pixel keeps text height
    // uniform while the banner grows/shrinks with the content.
    const worldPerPx = LABEL_SIZE_WORLD_PER_PX[options.size];
    const mesh = MeshBuilder.CreatePlane(name, { width: texW * worldPerPx, height: texH * worldPerPx }, this.scene);
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

  private disposePreview(): void {
    for (const d of this.previewBuild) {
      try {
        d.dispose();
      } catch {
        /* ignore double-dispose */
      }
    }
    this.previewBuild.length = 0;
    this.previewObjRoot = null;
    this.previewFootRoot = null;
    this.previewDrop = null;
  }

  dispose(): void {
    this.disposePreview();
    this.disposePerBuild();
    this.selectionBox?.dispose();
    for (const box of this.extraSelectionBoxes) box.dispose();
    this.lockBox?.dispose();
    for (const box of this.extraLockBoxes) box.dispose();
    this.centerHandle?.dispose();
    this.gridMesh?.dispose();
    for (const mat of this.cachedMaterials.values()) mat.dispose();
    this.cachedMaterials.clear();
    for (const t of this.cachedTextures) t.dispose();
    this.cachedTextures.length = 0;
    this.objectRoots.clear();
    this.previewRoot.dispose();
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

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
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
