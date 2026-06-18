import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { SoundManager } from '../audio/SoundManager';
import { settings } from '../config/Settings';

/**
 * Lightweight, asset-free game feedback: a full-screen vignette flash (DOM), a single
 * reusable world-space spark, one reusable parry ring, plus procedural sounds. Exposed as named gameplay events
 * (playerThrow/onCatch/onParry/onPlayerHit/...) so call sites don't touch audio/DOM directly.
 *
 * Owns persistent flash/spark/ring objects that are re-triggered and faded out in
 * update(), so nothing is allocated per effect.
 */
export class Effects {
  private readonly flashEl: HTMLDivElement;
  private flashTime = 0;
  private flashDuration = 0;
  private flashPeak = 0;

  private readonly spark: Mesh;
  private readonly sparkMaterial: StandardMaterial;
  private sparkTime = 0;
  private sparkDuration = 0;
  private readonly sparkBaseSize: number;
  private readonly ring: Mesh;
  private readonly ringMaterial: StandardMaterial;
  private ringTime = 0;
  private ringDuration = 0;
  private readonly ringBaseSize: number;

  constructor(scene: Scene, private readonly sound: SoundManager, parent: HTMLElement = document.body) {
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'hit-flash';
    parent.appendChild(this.flashEl);

    this.sparkMaterial = new StandardMaterial('fx_spark_mat', scene);
    this.sparkMaterial.emissiveColor = new Color3(1, 0.7, 0.25);
    this.sparkMaterial.disableLighting = true;
    this.spark = MeshBuilder.CreateSphere('fx_spark', { diameter: 1, segments: 8 }, scene);
    this.spark.material = this.sparkMaterial;
    this.spark.isPickable = false;
    this.spark.isVisible = false;
    this.sparkBaseSize = 0.9;

    this.ringMaterial = new StandardMaterial('fx_parry_ring_mat', scene);
    this.ringMaterial.emissiveColor = new Color3(0.35, 0.7, 1);
    this.ringMaterial.diffuseColor = new Color3(0.15, 0.45, 1);
    this.ringMaterial.disableLighting = true;
    this.ringMaterial.alpha = 0;
    this.ring = MeshBuilder.CreateTorus('fx_parry_ring', { diameter: 1, thickness: 0.035, tessellation: 32 }, scene);
    this.ring.material = this.ringMaterial;
    this.ring.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.ring.isPickable = false;
    this.ring.isVisible = false;
    this.ringBaseSize = 1.05;
  }

  // --- Gameplay events ----------------------------------------------------------------------

  playerThrow(): void {
    this.sound.whoosh(1);
    this.triggerFlash(0.08, 0.045, '255, 207, 46');
  }

  botThrow(): void {
    this.sound.whoosh(0.78);
  }

  onCatch(_speed = 0): void {
    this.sound.click();
    this.triggerFlash(0.16, 0.18, '90, 230, 150');
  }

  /** Catch attempts stay subtle; only a confirmed catch should sound successful. */
  onCatchAttempt(_side: 'left' | 'right'): void {
    if (!settings.reducedEffects) this.triggerFlash(0.08, 0.055, '120, 180, 255');
  }

  onParry(speed = 18, position?: Vector3): void {
    this.sound.ping(speed, 0.55);
    this.triggerFlash(0.2, 0.26, '120, 180, 255');
    if (position) this.triggerRing(position, new Color3(0.35, 0.7, 1));
  }

  /**
   * A successful backflip-QTE throw landed. `tier`/`maxTier` scale the celebratory chime + gold
   * flash so the dead-center (top tier) throw feels the most rewarding.
   */
  onBackflipThrow(tier: number, maxTier: number): void {
    const strength = maxTier > 1 ? Math.max(0, Math.min(1, (tier - 1) / (maxTier - 1))) : 1;
    this.sound.whoosh(1.1);
    this.sound.perfectThrow(strength);
    this.triggerFlash(0.18, 0.1 + 0.12 * strength, '255, 207, 46'); // school-gold
  }

  onSlide(speed = 0): void {
    this.sound.slideBrush(speed);
    this.triggerFlash(0.1, 0.09, '80, 160, 255');
  }

  onDash(speed = 0): void {
    this.sound.whoosh(0.95, 0.7);
    this.sound.squeak(0.58 + Math.min(0.22, speed / 28), 0.7);
    this.triggerFlash(0.12, 0.14, '240, 220, 80');
  }

  onBackflip(): void {
    this.sound.whoosh(0.6);
    this.triggerFlash(0.15, 0.1, '190, 110, 255');
  }

  /** The player failed to catch/block and took a hit. */
  onPlayerHit(position: Vector3, speed = 24): void {
    this.sound.ping(speed, 1);
    this.triggerFlash(0.45, 0.45, '255, 70, 70');
    this.triggerSpark(position, new Color3(1, 0.35, 0.3));
  }

  /** A player throw connected with a target dummy. */
  onDummyHit(speed = 24): void {
    this.sound.ping(speed, 0.7);
    this.triggerFlash(0.16, 0.18, '255, 180, 50');
  }

  onMatchWin(): void {
    this.sound.gameEndBuzzer();
    this.triggerFlash(0.4, 0.12, '255, 180, 70');
  }

  // --- Per-frame fade -----------------------------------------------------------------------

  update(dt: number): void {
    if (this.flashTime > 0) {
      this.flashTime = Math.max(0, this.flashTime - dt);
      const t = this.flashDuration > 0 ? this.flashTime / this.flashDuration : 0;
      this.flashEl.style.opacity = String(this.flashPeak * t);
    }

    if (this.sparkTime > 0) {
      this.sparkTime = Math.max(0, this.sparkTime - dt);
      const t = this.sparkDuration > 0 ? this.sparkTime / this.sparkDuration : 0;
      // Pop outward as it fades.
      const scale = this.sparkBaseSize * (1.4 - t);
      this.spark.scaling.setAll(scale);
      this.sparkMaterial.alpha = t;
      if (this.sparkTime <= 0) this.spark.isVisible = false;
    }

    if (this.ringTime > 0) {
      this.ringTime = Math.max(0, this.ringTime - dt);
      const t = this.ringDuration > 0 ? this.ringTime / this.ringDuration : 0;
      const scale = this.ringBaseSize * (1.6 - t * 0.6);
      this.ring.scaling.setAll(scale);
      this.ringMaterial.alpha = t * 0.92;
      if (this.ringTime <= 0) this.ring.isVisible = false;
    }
  }

  dispose(): void {
    this.flashEl.remove();
    this.spark.dispose();
    this.sparkMaterial.dispose();
    this.ring.dispose();
    this.ringMaterial.dispose();
  }

  private triggerFlash(duration: number, peak: number, rgb: string): void {
    this.flashDuration = duration;
    this.flashTime = duration;
    this.flashPeak = settings.reducedEffects ? peak * 0.45 : peak;
    // Vignette: transparent center, colored toward the edges — reads as a hit indicator without
    // whiting out the whole view.
    this.flashEl.style.background = `radial-gradient(ellipse at center, rgba(${rgb}, 0) 35%, rgba(${rgb}, 1) 120%)`;
    this.flashEl.style.opacity = String(this.flashPeak);
  }

  private triggerSpark(position: Vector3, color: Color3): void {
    if (settings.reducedEffects) return;
    this.sparkMaterial.emissiveColor.copyFrom(color);
    this.sparkMaterial.alpha = 1;
    this.spark.position.copyFrom(position);
    this.spark.scaling.setAll(this.sparkBaseSize * 0.4);
    this.spark.isVisible = true;
    this.sparkDuration = 0.22;
    this.sparkTime = 0.22;
  }

  private triggerRing(position: Vector3, color: Color3): void {
    if (settings.reducedEffects) return;
    this.ringMaterial.emissiveColor.copyFrom(color);
    this.ringMaterial.diffuseColor.copyFrom(color);
    this.ringMaterial.alpha = 0.92;
    this.ring.position.copyFrom(position);
    this.ring.scaling.setAll(this.ringBaseSize * 0.4);
    this.ring.isVisible = true;
    this.ringDuration = 0.24;
    this.ringTime = 0.24;
  }
}
