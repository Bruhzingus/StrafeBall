import {
  Color3, DynamicTexture, Mesh, MeshBuilder, PBRMaterial, Scene,
  StandardMaterial, Vector3
} from '@babylonjs/core';
import type { PracticeState, BotDifficulty } from './PracticeState';
import type { BallManager } from '../ball/BallManager';
import { TUNING } from '../config/tuning';
import { Ball } from '../ball/Ball';
import { BallState } from '../ball/BallState';
import { createBallMesh } from '../ball/BallVisualFactory';

const BUTTON_COOLDOWN = 0.6;

export type ButtonId =
  | 'addBall' | 'removeBall' | 'clearExtra' | 'giveTwoBalls'
  | 'resetScore' | 'resetMap'
  | 'toggleQuickBot' | 'toggleChargeBot' | 'stopBots'
  | 'difficulty';

interface ButtonDef { id: ButtonId; label: string; row: number; col: number; }

// 2 rows × 5 columns, spanning the full west wall above the bleachers (see diagram in the design).
// Row 0 (top) = ball controls + map/score; row 1 (bottom) = bot controls.
const BUTTON_DEFS: ButtonDef[] = [
  { id: 'addBall',         label: 'ADD BALL',    row: 0, col: 0 },
  { id: 'removeBall',      label: 'REMOVE BALL', row: 0, col: 1 },
  { id: 'clearExtra',      label: 'CLEAR BALLS', row: 0, col: 2 },
  { id: 'giveTwoBalls',    label: 'GIVE 2 BALLS',row: 0, col: 3 },
  { id: 'resetScore',      label: 'RESET SCORE', row: 0, col: 4 },
  { id: 'resetMap',        label: 'RESET MAP',   row: 1, col: 0 },
  { id: 'toggleQuickBot',  label: 'QUICK BOT',   row: 1, col: 1 },
  { id: 'toggleChargeBot', label: 'CHARGE BOT',  row: 1, col: 2 },
  { id: 'stopBots',        label: 'STOP BOTS',   row: 1, col: 3 },
  { id: 'difficulty',      label: 'DIFFICULTY',  row: 1, col: 4 },
];

const COLS = 5;
const ROWS = 2;

// The buttons mount on the west wall (x = -halfWidth) facing east into the court, filling the wide
// span ABOVE the bleachers with padding so they never touch the bleacher tops or the ceiling.
// Bleacher backs top out at ~2.08 m and run z ∈ [-length/2, +length/2]; the ceiling is wallHeight.
const BLEACHER_LENGTH = TUNING.map.halfLength * 1.45; // mirrors BLEACHER_LAYOUT.lengthScale
const Z_PADDING = 1.6;
const Y_BOTTOM = 2.95;                          // clears the bleacher backs (~2.08) with margin
const Y_TOP = TUNING.map.wallHeight - 0.95;     // clears the ceiling with margin
const Z_SPAN = BLEACHER_LENGTH - Z_PADDING * 2; // usable horizontal run along the wall
const COL_GAP = Z_SPAN / COLS;                  // one slot per column, centered within
const ROW_GAP = 1.85;
const PANEL_Y_CENTER = (Y_TOP + Y_BOTTOM) / 2;

// Large buttons that nearly fill each grid slot, leaving a small gutter between them.
const BTN_D = 0.22;
const BTN_W = COL_GAP - 0.7;   // width runs along Z (the wall's long axis)
const BTN_H = ROW_GAP - 0.55;  // height runs along Y
const WALL_X = -TUNING.map.halfWidth + BTN_D / 2 + 0.04;

function makeTex(scene: Scene, name: string, line1: string, line2 = ''): DynamicTexture {
  // Wide texture to match the wide buttons; big, legible type centered on the face.
  const tex = new DynamicTexture(name, { width: 512, height: 200 }, scene, false);
  tex.hasAlpha = false;
  // Background
  tex.drawText('', 0, 0, 'bold 1px Arial', '#000000', '#0c1a2e', false, false);
  tex.drawText(line1, null, line2 ? 88 : 122, 'bold 56px Arial', '#c8d8ff', 'transparent', false, false);
  if (line2) {
    tex.drawText(line2, null, 158, 'bold 50px Arial', '#ffdd44', 'transparent', false, false);
  }
  // DynamicTexture needs Y inversion when uploaded to a mesh-facing texture, otherwise the text
  // lands upside down on the wall/button planes.
  tex.update(true);
  return tex;
}

export class PracticeControlWall {
  private readonly buttonMeshes = new Map<ButtonId, Mesh>();
  private readonly buttonMats = new Map<ButtonId, PBRMaterial>();
  private readonly labelTextures = new Map<ButtonId, DynamicTexture>();
  private readonly ballTouching = new Map<ButtonId, Set<Ball>>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly meshes: Mesh[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly state: PracticeState,
    private readonly ballManager: BallManager,
    public readonly onButton: (id: ButtonId) => void
  ) {
    this.buildPanel();
    for (const def of BUTTON_DEFS) this.createButton(def);
  }

  private buildPanel(): void {
    // Intentionally left empty: the old dead wall-wide backing/title panel read like a broken
    // scoreboard. Keep only the interactive buttons themselves on the wall.
  }

  private createButton(def: ButtonDef): void {
    const x = WALL_X;
    const y = PANEL_Y_CENTER + (((ROWS - 1) / 2) - def.row) * ROW_GAP;
    const z = (def.col - (COLS - 1) / 2) * COL_GAP;

    const btnMat = new PBRMaterial(`pcbtn_mat_${def.id}`, this.scene);
    btnMat.albedoColor = new Color3(0.06, 0.10, 0.20);
    btnMat.metallic = 0;
    btnMat.roughness = 0.6;
    btnMat.emissiveColor = new Color3(0.03, 0.06, 0.14);
    this.buttonMats.set(def.id, btnMat);
    this.disposables.push(btnMat);

    const mesh = MeshBuilder.CreateBox(`pcbtn_${def.id}`, { width: BTN_W, height: BTN_H, depth: BTN_D }, this.scene);
    mesh.position.set(x, y, z);
    mesh.rotation.y = -Math.PI / 2; // west wall -> face east into the court
    mesh.isPickable = false;
    mesh.material = btnMat;
    this.buttonMeshes.set(def.id, mesh);
    this.ballTouching.set(def.id, new Set());
    this.meshes.push(mesh);
    this.disposables.push(mesh);

    // Label plane on the -Z face (facing player)
    const tex = makeTex(this.scene, `pcbtn_tex_${def.id}`, def.label);
    this.labelTextures.set(def.id, tex);
    this.disposables.push(tex);

    const labelMat = new StandardMaterial(`pcbtn_lmat_${def.id}`, this.scene);
    labelMat.diffuseTexture = tex;
    labelMat.emissiveTexture = tex;
    labelMat.emissiveColor = new Color3(1, 1, 1);
    labelMat.disableLighting = true;
    labelMat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(labelMat);

    // Label plane sits just in front of the button's east-facing face, oriented exactly like the
    // (working) west-wall guide panels: a standalone plane yawed -90° so it faces east into the
    // court with text upright and reading left-to-right. NOT parented to the yawed button box —
    // parenting + an extra flip is what left the text invisible/mirrored.
    const label = MeshBuilder.CreatePlane(`pcbtn_label_${def.id}`, { width: BTN_W - 0.08, height: BTN_H - 0.08 }, this.scene);
    label.position.set(x + BTN_D / 2 + 0.01, y, z);
    label.rotation.y = -Math.PI / 2;
    label.material = labelMat;
    label.isPickable = false;
    this.meshes.push(label);
    this.disposables.push(label);
  }

  setEnabled(enabled: boolean): void {
    for (const mesh of this.meshes) mesh.setEnabled(enabled);
  }

  update(dt: number): void {
    for (const key of Object.keys(this.state.buttonCooldowns)) {
      this.state.buttonCooldowns[key] = Math.max(0, this.state.buttonCooldowns[key] - dt);
    }

    for (const [id, btnMesh] of this.buttonMeshes) {
      const bp = btnMesh.position;
      const hx = BTN_D / 2 + 0.2;
      const hh = BTN_H / 2 + 0.08;
      const hz = BTN_W / 2 + 0.08;
      const wasSet = this.ballTouching.get(id)!;
      const nowSet = new Set<Ball>();

      for (const ball of this.ballManager.balls) {
        if (ball.state !== BallState.Live) continue;
        const bx = ball.mesh.position;
        if (Math.abs(bx.x - bp.x) < hx && Math.abs(bx.y - bp.y) < hh && Math.abs(bx.z - bp.z) < hz) {
          nowSet.add(ball);
          if (!wasSet.has(ball) && (this.state.buttonCooldowns[id] ?? 0) <= 0) {
            this.state.buttonCooldowns[id] = BUTTON_COOLDOWN;
            this.flashButton(id);
            this.onButton(id);
          }
        }
      }
      this.ballTouching.set(id, nowSet);
    }

    this.refreshLabels();
  }

  private flashButton(id: ButtonId): void {
    const mat = this.buttonMats.get(id);
    if (mat) mat.emissiveColor = new Color3(0.3, 0.7, 0.3);
    setTimeout(() => {
      if (mat) mat.emissiveColor = new Color3(0.03, 0.06, 0.14);
    }, 200);
  }

  refreshLabels(): void {
    const diff = this.state.botDifficulty.toUpperCase();
    const updates: Partial<Record<ButtonId, [string, string]>> = {
      toggleQuickBot:  ['QUICK BOT',  this.state.quickThrowBotEnabled  ? 'ON' : 'OFF'],
      toggleChargeBot: ['CHARGE BOT', this.state.chargeThrowBotEnabled ? 'ON' : 'OFF'],
      difficulty:      ['DIFFICULTY', diff],
    };
    for (const [id, [l1, l2]] of Object.entries(updates) as [ButtonId, [string, string]][]) {
      const tex = this.labelTextures.get(id);
      if (!tex) continue;
      const active = (id === 'toggleQuickBot' && this.state.quickThrowBotEnabled) ||
                     (id === 'toggleChargeBot' && this.state.chargeThrowBotEnabled);
      // Match makeTex's 512×200 layout so the redrawn label fills the large button face.
      tex.drawText('', 0, 0, 'bold 1px Arial', '#000', active ? '#0d2a18' : '#0c1a2e', false, false);
      tex.drawText(l1, null, 88, 'bold 56px Arial', active ? '#44ff88' : '#c8d8ff', 'transparent', false, false);
      tex.drawText(l2, null, 158, 'bold 50px Arial', '#ffdd44', 'transparent', false, false);
      tex.update(true);
    }
  }

  spawnPracticeBall(): Ball | null {
    const pos = new Vector3((Math.random() - 0.5) * 4, 0.35, -3 + (Math.random() - 0.5) * 2);
    const visual = createBallMesh(this.scene, `practice_extra_${Date.now()}`, pos);
    const ball = new Ball(visual, pos);
    this.ballManager.balls.push(ball);
    return ball;
  }

  removeOneBall(): boolean {
    if (this.ballManager.balls.length <= TUNING.map.ballCount) return false;
    const idx = this.ballManager.balls.findIndex(b => b.state === BallState.Loose || b.state === BallState.Dead);
    if (idx < 0) return false;
    this.ballManager.balls[idx].mesh.dispose();
    this.ballManager.balls.splice(idx, 1);
    return true;
  }

  clearExtraBalls(extraCount: number): void {
    let removed = 0;
    for (let i = this.ballManager.balls.length - 1; i >= 0 && removed < extraCount; i--) {
      const b = this.ballManager.balls[i];
      if (b.state === BallState.Held) continue;
      b.mesh.dispose();
      this.ballManager.balls.splice(i, 1);
      removed++;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
