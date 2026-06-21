import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3
} from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { createBeveledPanelMesh } from './GymVisualRevamp';

type SegmentId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';

const SEGMENT_MAP: Record<string, readonly SegmentId[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'd', 'e', 'g'],
  '3': ['a', 'b', 'c', 'd', 'g'],
  '4': ['b', 'c', 'f', 'g'],
  '5': ['a', 'c', 'd', 'f', 'g'],
  '6': ['a', 'c', 'd', 'e', 'f', 'g'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
  '-': ['g'],
  ' ': [],
};

/**
 * A live 3D gym scoreboard mounted on an end wall. Renders the two team scores (blue vs red) onto
 * an emissive LED-style panel via a DynamicTexture, updated in real time from the match state, and
 * "buzzes" (shake + flash) whenever a score changes — the cartoon-gym equivalent of the hit buzzer.
 *
 * Two of these are placed (one per end wall) facing into the court. They are presentation only; the
 * authoritative score still comes from the server snapshot (online) or the rules (offline), and the
 * HTML HUD scoreboard remains untouched.
 */
export class Scoreboard3D {
  private readonly root: TransformNode;
  private readonly faceTexture: DynamicTexture;
  private readonly faceMaterial: StandardMaterial;
  private readonly rim: Mesh;
  private readonly rimMaterial: StandardMaterial;
  /** The board's meshes — exposed so the arena can exclude them from static-mesh freezing. */
  public readonly meshes: Mesh[] = [];

  // Last drawn values so we only repaint the texture when a number actually changes.
  private lastBlue = -1;
  private lastRed = -1;
  private lastLabel = '';

  // Buzz animation state.
  private buzzTime = 0;
  private readonly buzzDuration = 0.85;
  private readonly basePosition: Vector3;
  private readonly emissiveBase = new Color3(0.08, 0.05, 0.02);

  /**
   * @param wallZ   z of the end wall this board hangs on (+ or − halfLength).
   * @param facing  +1 if the board faces toward −Z (mounted on the +Z wall), −1 otherwise.
   */
  constructor(scene: Scene, name: string, wallZ: number, facing: number) {
    const width = 5.2;
    const height = 1.9;
    const y = 5.1;

    this.root = new TransformNode(`${name}_root`, scene);
    this.basePosition = new Vector3(0, y, wallZ - facing * 0.07);
    this.root.position.copyFrom(this.basePosition);
    // Face into the court: the +Z wall board looks toward −Z and vice-versa.
    this.root.rotation.y = facing > 0 ? Math.PI : 0;

    // Dark backing board. A visual-only beveled panel (recessed outer border + slightly raised center
    // behind the LED face) gives the casing a defined edge instead of a flat slab — same outer
    // dimensions, placement, and material, so score behaviour and the LED face are unchanged.
    const backingMat = new StandardMaterial(`${name}_backing_mat`, scene);
    backingMat.diffuseColor = new Color3(0.09, 0.11, 0.16);
    backingMat.specularColor = new Color3(0.05, 0.05, 0.06);
    const backing = createBeveledPanelMesh(scene, `${name}_backing`, {
      width: width + 0.2,
      height: height + 0.2,
      depth: 0.14,
      material: backingMat,
      border: 0.08,
      raise: 0.012
    });
    backing.parent = this.root;

    // Gold rim (flashes during a buzz).
    this.rimMaterial = new StandardMaterial(`${name}_rim_mat`, scene);
    this.rimMaterial.diffuseColor = new Color3(1.0, 0.82, 0.1);
    this.rimMaterial.emissiveColor = new Color3(0.5, 0.36, 0.0);
    this.rim = MeshBuilder.CreateBox(`${name}_rim`, { width: width + 0.34, height: 0.12, depth: 0.16 }, scene);
    this.rim.parent = this.root;
    this.rim.position.y = height / 2 + 0.12;
    this.rim.material = this.rimMaterial;
    this.rim.isPickable = false;

    // LED face with a DynamicTexture we paint the score onto.
    this.faceTexture = new DynamicTexture(`${name}_face_tex`, { width: 512, height: 192 }, scene, true);
    this.faceTexture.hasAlpha = false;
    this.faceTexture.anisotropicFilteringLevel = 16;
    this.faceTexture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
    this.faceTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.faceTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    // Babylon's plane UVs read mirrored from the court-facing side here; flip U once so the
    // scoreboard text reads correctly on both end walls.
    this.faceTexture.uScale = -1;
    this.faceTexture.uOffset = 1;
    this.faceMaterial = new StandardMaterial(`${name}_face_mat`, scene);
    this.faceMaterial.diffuseTexture = this.faceTexture;
    this.faceMaterial.emissiveTexture = this.faceTexture;
    this.faceMaterial.emissiveColor = this.emissiveBase.clone();
    this.faceMaterial.specularColor = new Color3(0, 0, 0);
    this.faceMaterial.disableLighting = true;
    this.faceMaterial.backFaceCulling = false;

    const face = MeshBuilder.CreatePlane(`${name}_face`, { width, height }, scene);
    face.parent = this.root;
    face.position.z = 0.09; // sit just in front of the backing, facing into the court
    face.material = this.faceMaterial;
    face.isPickable = false;

    this.meshes.push(backing, this.rim, face);
    this.draw(0, 0, '');
  }

  /**
   * Update the displayed scores. `label` is an optional centered banner (e.g. countdown digit, GO!,
   * or WIN) drawn under the numbers. Buzzes automatically when either score increases.
   */
  setScores(blue: number, red: number, label = ''): void {
    const scoreChanged = (this.lastBlue >= 0 && blue > this.lastBlue) || (this.lastRed >= 0 && red > this.lastRed);
    if (blue !== this.lastBlue || red !== this.lastRed || label !== this.lastLabel) {
      this.draw(blue, red, label);
      this.lastBlue = blue;
      this.lastRed = red;
      this.lastLabel = label;
    }
    if (scoreChanged) this.buzz();
  }

  /** Trigger the buzz (shake + flash) without changing the score — e.g. on a hit you took. */
  buzz(): void {
    this.buzzTime = this.buzzDuration;
  }

  /** Advance the buzz animation. Call once per frame with dt seconds. */
  update(dt: number): void {
    if (this.buzzTime <= 0) return;
    this.buzzTime = Math.max(0, this.buzzTime - dt);
    const t = this.buzzTime / this.buzzDuration; // 1 -> 0
    // Decaying high-frequency shake on the whole board.
    const shake = Math.sin(this.buzzTime * 48) * 0.06 * t;
    this.root.position.set(this.basePosition.x + shake, this.basePosition.y + shake * 0.5, this.basePosition.z);
    // Flash the LED face + rim brighter while buzzing.
    const glow = 0.7 * t;
    this.faceMaterial.emissiveColor.set(this.emissiveBase.r + glow, this.emissiveBase.g + glow * 0.6, this.emissiveBase.b + glow * 0.2);
    this.rimMaterial.emissiveColor.set(0.5 + glow, 0.36 + glow * 0.7, glow * 0.4);
    if (this.buzzTime <= 0) {
      this.root.position.copyFrom(this.basePosition);
      this.faceMaterial.emissiveColor.copyFrom(this.emissiveBase);
      this.rimMaterial.emissiveColor.set(0.5, 0.36, 0.0);
    }
  }

  dispose(): void {
    this.root.dispose();
    this.faceTexture.dispose();
    this.faceMaterial.dispose();
    this.rimMaterial.dispose();
  }

  /** Paint the score digits (+ optional banner) onto the LED texture. */
  private draw(blue: number, red: number, label: string): void {
    const ctx = this.faceTexture.getContext() as CanvasRenderingContext2D;
    const w = 512;
    const h = 192;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#030303';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#1a1410';
    ctx.fillRect(14, 14, w - 28, h - 28);
    ctx.fillStyle = '#070707';
    ctx.fillRect(24, 24, w - 48, h - 48);

    this.drawDisplayWindow(ctx, 42, 50, 164, 102);
    this.drawDisplayWindow(ctx, 306, 50, 164, 102);
    this.drawStatusWindow(ctx, 222, 34, 68, 120);

    ctx.strokeStyle = '#7f4a11';
    ctx.lineWidth = 4;
    ctx.strokeRect(14, 14, w - 28, h - 28);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'miter';

    this.drawHeader(ctx, 'BLUE', 124, 36, '#d5d9df', '#3f7bff');
    this.drawHeader(ctx, 'RED', 388, 36, '#d5d9df', '#ff5140');

    this.drawSevenSegmentText(ctx, String(Math.max(0, blue)).padStart(2, '0'), 124, 101, 52, 82, 10);
    this.drawSevenSegmentText(ctx, String(Math.max(0, red)).padStart(2, '0'), 388, 101, 52, 82, 10);
    this.drawStatusLabel(ctx, label.toUpperCase(), w / 2, 96);

    ctx.fillStyle = 'rgba(255, 161, 58, 0.045)';
    for (let y = 0; y < h; y += 4) {
      ctx.fillRect(24, y, w - 48, 1);
    }

    this.faceTexture.update(true);
  }

  private drawHeader(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    textColor: string,
    accentColor: string
  ): void {
    ctx.fillStyle = accentColor;
    ctx.fillRect(x - 46, y + 18, 92, 4);
    ctx.font = 'bold 26px "Arial Black", Arial, sans-serif';
    ctx.fillStyle = textColor;
    ctx.fillText(text, x, y);
  }

  private drawDisplayWindow(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
    ctx.fillStyle = '#2b1b0d';
    ctx.fillRect(x - 5, y - 5, width + 10, height + 10);
    ctx.fillStyle = '#090909';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#4a2c11';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
    ctx.fillStyle = 'rgba(255, 171, 79, 0.04)';
    ctx.fillRect(x + 8, y + 8, width - 16, 12);
  }

  private drawStatusWindow(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
    ctx.fillStyle = '#24170b';
    ctx.fillRect(x - 4, y - 4, width + 8, height + 8);
    ctx.fillStyle = '#080808';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#4a2c11';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
  }

  private drawStatusLabel(ctx: CanvasRenderingContext2D, label: string, x: number, y: number): void {
    if (!label) {
      ctx.font = 'bold 24px "Arial Black", Arial, sans-serif';
      ctx.fillStyle = '#b37a35';
      ctx.fillText('VS', x, y);
      return;
    }

    if (/^[0-9-]{1,2}$/.test(label)) {
      this.drawSevenSegmentText(ctx, label, x, y, 24, 42, 8, '#ffb55a', 'rgba(88, 46, 10, 0.22)');
      return;
    }

    if (label.endsWith(' WINS')) {
      const winner = label.replace(' WINS', '');
      const accent = winner === 'BLUE' ? '#7ea7ff' : winner === 'RED' ? '#ff8e80' : '#ffb55a';
      ctx.font = 'bold 18px "Arial Black", Arial, sans-serif';
      ctx.fillStyle = accent;
      ctx.fillText(winner, x, y - 14);
      ctx.font = 'bold 20px "Arial Black", Arial, sans-serif';
      ctx.fillStyle = '#ffb55a';
      ctx.fillText('WINS', x, y + 14);
      return;
    }

    ctx.font = 'bold 22px "Arial Black", Arial, sans-serif';
    ctx.fillStyle = '#ffb55a';
    ctx.fillText(label, x, y);
  }

  private drawSevenSegmentText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    digitWidth: number,
    digitHeight: number,
    gap: number,
    color = '#ff962a',
    offColor = 'rgba(96, 46, 11, 0.24)'
  ): void {
    const chars = text.split('');
    const totalWidth = chars.length * digitWidth + Math.max(0, chars.length - 1) * gap;
    let left = x - totalWidth / 2;
    for (const char of chars) {
      this.drawSevenSegmentDigit(ctx, char, left, y - digitHeight / 2, digitWidth, digitHeight, color, offColor);
      left += digitWidth + gap;
    }
  }

  private drawSevenSegmentDigit(
    ctx: CanvasRenderingContext2D,
    char: string,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    offColor: string
  ): void {
    const segments = this.buildDigitSegments(x, y, width, height);
    const lit = new Set(SEGMENT_MAP[char] ?? SEGMENT_MAP[' ']);
    const thickness = Math.max(7, Math.round(width * 0.17));

    for (const [segmentId, segment] of Object.entries(segments) as [SegmentId, [number, number, number, number]][]) {
      this.strokeSegment(ctx, segment, thickness, offColor, 0);
      if (lit.has(segmentId)) {
        this.strokeSegment(ctx, segment, thickness, color, Math.max(10, Math.round(width * 0.22)));
        this.strokeSegment(ctx, segment, Math.max(2, Math.round(thickness * 0.42)), '#ffd1a0', 0);
      }
    }
  }

  private buildDigitSegments(x: number, y: number, width: number, height: number): Record<SegmentId, [number, number, number, number]> {
    const padX = width * 0.18;
    const padY = height * 0.12;
    const left = x + padX;
    const right = x + width - padX;
    const top = y + padY;
    const bottom = y + height - padY;
    const mid = y + height / 2;
    const legInset = Math.max(6, width * 0.11);

    return {
      a: [left + legInset, top, right - legInset, top],
      b: [right, top + legInset, right, mid - legInset],
      c: [right, mid + legInset, right, bottom - legInset],
      d: [left + legInset, bottom, right - legInset, bottom],
      e: [left, mid + legInset, left, bottom - legInset],
      f: [left, top + legInset, left, mid - legInset],
      g: [left + legInset, mid, right - legInset, mid],
    };
  }

  private strokeSegment(
    ctx: CanvasRenderingContext2D,
    [x1, y1, x2, y2]: [number, number, number, number],
    thickness: number,
    color: string,
    shadowBlur: number
  ): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = shadowBlur;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Build both end-wall scoreboards (one per side), facing into the court. */
export function createSideScoreboards(scene: Scene): Scoreboard3D[] {
  const z = TUNING.map.halfLength;
  return [
    new Scoreboard3D(scene, 'scoreboard_north', z, 1),
    new Scoreboard3D(scene, 'scoreboard_south', -z, -1)
  ];
}
