import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { SoundManager } from '../audio/SoundManager';

/**
 * Lightweight, asset-free game feedback: a full-screen vignette flash (DOM) and a single
 * reusable world-space "spark" mesh, plus procedural sounds. Exposed as named gameplay events
 * (playerThrow/onCatch/onParry/onPlayerHit/...) so call sites don't touch audio/DOM directly.
 *
 * Owns one persistent flash element and one spark mesh that are re-triggered and faded out in
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
  }

  // --- Gameplay events ----------------------------------------------------------------------

  playerThrow(): void {
    this.sound.whoosh(1);
  }

  botThrow(): void {
    this.sound.whoosh(0.78);
  }

  onCatch(): void {
    this.sound.click();
    this.triggerFlash(0.16, 0.18, '90, 230, 150');
  }

  /**
   * Instant local feedback when the player clicks to attempt a catch (before the server confirms).
   * Deliberately subtle — a light click — so it reads as "catch attempt" without implying success
   * (the authoritative catch fires onCatch() once the server confirms it).
   */
  onCatchAttempt(_side: 'left' | 'right'): void {
    this.sound.click();
  }

  onParry(): void {
    this.sound.thud(0.55);
    this.triggerFlash(0.2, 0.26, '120, 180, 255');
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

  onSlide(): void {
    this.sound.whoosh(0.4);
    this.triggerFlash(0.1, 0.09, '80, 160, 255');
  }

  onDash(): void {
    this.sound.whoosh(1.3);
    this.triggerFlash(0.12, 0.14, '240, 220, 80');
  }

  onBackflip(): void {
    this.sound.whoosh(0.6);
    this.triggerFlash(0.15, 0.1, '190, 110, 255');
  }

  /** The player failed to catch/block and took a hit. */
  onPlayerHit(position: Vector3): void {
    this.sound.thud(1);
    this.triggerFlash(0.45, 0.45, '255, 70, 70');
    this.triggerSpark(position, new Color3(1, 0.35, 0.3));
  }

  /** A player throw connected with a target dummy. */
  onDummyHit(): void {
    this.sound.thud(0.7);
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
  }

  dispose(): void {
    this.flashEl.remove();
    this.spark.dispose();
    this.sparkMaterial.dispose();
  }

  private triggerFlash(duration: number, peak: number, rgb: string): void {
    this.flashDuration = duration;
    this.flashTime = duration;
    this.flashPeak = peak;
    // Vignette: transparent center, colored toward the edges — reads as a hit indicator without
    // whiting out the whole view.
    this.flashEl.style.background = `radial-gradient(ellipse at center, rgba(${rgb}, 0) 35%, rgba(${rgb}, 1) 120%)`;
    this.flashEl.style.opacity = String(peak);
  }

  private triggerSpark(position: Vector3, color: Color3): void {
    this.sparkMaterial.emissiveColor.copyFrom(color);
    this.sparkMaterial.alpha = 1;
    this.spark.position.copyFrom(position);
    this.spark.scaling.setAll(this.sparkBaseSize * 0.4);
    this.spark.isVisible = true;
    this.sparkDuration = 0.22;
    this.sparkTime = 0.22;
  }
}
