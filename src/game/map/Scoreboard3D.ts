import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3
} from '@babylonjs/core';
import { TUNING } from '../config/tuning';

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
  private readonly emissiveBase = new Color3(0.04, 0.05, 0.09);

  /**
   * @param wallZ   z of the end wall this board hangs on (+ or − halfLength).
   * @param facing  +1 if the board faces toward −Z (mounted on the +Z wall), −1 otherwise.
   */
  constructor(scene: Scene, name: string, wallZ: number, facing: number) {
    const width = 5.2;
    const height = 1.9;
    const y = 3.1;

    this.root = new TransformNode(`${name}_root`, scene);
    this.basePosition = new Vector3(0, y, wallZ - facing * 0.07);
    this.root.position.copyFrom(this.basePosition);
    // Face into the court: the +Z wall board looks toward −Z and vice-versa.
    this.root.rotation.y = facing > 0 ? Math.PI : 0;

    // Dark backing board.
    const backing = MeshBuilder.CreateBox(`${name}_backing`, { width: width + 0.2, height: height + 0.2, depth: 0.14 }, scene);
    backing.parent = this.root;
    backing.isPickable = false;
    const backingMat = new StandardMaterial(`${name}_backing_mat`, scene);
    backingMat.diffuseColor = new Color3(0.09, 0.11, 0.16);
    backingMat.specularColor = new Color3(0.05, 0.05, 0.06);
    backing.material = backingMat;

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
    this.faceTexture = new DynamicTexture(`${name}_face_tex`, { width: 512, height: 192 }, scene, false);
    this.faceTexture.hasAlpha = false;
    this.faceMaterial = new StandardMaterial(`${name}_face_mat`, scene);
    this.faceMaterial.diffuseTexture = this.faceTexture;
    this.faceMaterial.emissiveTexture = this.faceTexture;
    this.faceMaterial.emissiveColor = this.emissiveBase.clone();
    this.faceMaterial.specularColor = new Color3(0, 0, 0);
    this.faceMaterial.disableLighting = true;

    const face = MeshBuilder.CreatePlane(`${name}_face`, { width, height }, scene);
    face.parent = this.root;
    face.position.z = -0.09; // sit just in front of the backing
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
    // LED background.
    ctx.fillStyle = '#06090f';
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Team labels.
    ctx.font = 'bold 30px "Arial Black", Arial, sans-serif';
    ctx.fillStyle = '#3f7bff';
    ctx.fillText('BLUE', 110, 38);
    ctx.fillStyle = '#ff5140';
    ctx.fillText('RED', 402, 38);

    // Big score digits.
    ctx.font = 'bold 110px "Arial Black", Arial, sans-serif';
    ctx.fillStyle = '#5b9bff';
    ctx.fillText(String(blue), 110, 118);
    ctx.fillStyle = '#ff6a5a';
    ctx.fillText(String(red), 402, 118);

    // Center separator / banner.
    if (label) {
      ctx.font = 'bold 40px "Arial Black", Arial, sans-serif';
      ctx.fillStyle = '#ffcf2e';
      ctx.fillText(label, w / 2, 100);
    } else {
      ctx.font = 'bold 80px "Arial Black", Arial, sans-serif';
      ctx.fillStyle = '#ffcf2e';
      ctx.fillText('-', w / 2, 110);
    }

    this.faceTexture.update(false);
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
