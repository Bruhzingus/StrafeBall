import { Color3, Mesh, StandardMaterial, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { BallManager } from '../ball/BallManager';
import { ModelLoader } from '../assets/ModelLoader';
import { safeNormalize } from '../utils/math';

/**
 * An always-on practice partner. On a fixed interval it grabs the nearest ball already lying
 * on the map (loose or dead) and lobs it at the player so you can drill catching, parrying and
 * blocking. It never spawns new balls: if none are free that tick it simply waits, so the ball
 * count on the map is conserved.
 */
export class PracticeBot {
  public readonly mesh: Mesh;
  private readonly position: Vector3;
  private throwTimer: number;

  constructor(loader: ModelLoader, private readonly ballManager: BallManager) {
    this.position = new Vector3(TUNING.bot.position.x, TUNING.bot.position.y, TUNING.bot.position.z);
    this.mesh = loader.createVisual('dummy', { name: 'practice_bot', position: this.position });
    // Distinct (cloned) material so the thrower reads differently from the red scoring dummies,
    // and metadata that marks it as NOT a scoring target.
    const material = (this.mesh.material as StandardMaterial).clone('practice_bot_mat');
    material.diffuseColor = new Color3(0.2, 0.62, 0.92);
    material.emissiveColor = new Color3(0.05, 0.18, 0.28);
    this.mesh.material = material;
    this.mesh.metadata = { practiceBot: true };

    this.throwTimer = TUNING.bot.throwIntervalSeconds;
  }

  /**
   * Advance the throw timer; when it elapses, throw a map ball at `targetPosition`. Returns true
   * on the frame a throw actually happens so the caller can play the throw FX. If no free ball
   * is available the timer stays elapsed and we retry next frame (never spawning one).
   */
  update(dt: number, targetPosition: Vector3): boolean {
    this.throwTimer -= dt;
    if (this.throwTimer > 0) return false;

    const ball = this.ballManager.findNearestFreeBall(this.position);
    if (!ball) return false; // No ball on the map to re-arm with right now — wait for one.

    this.throwTimer = TUNING.bot.throwIntervalSeconds;

    const origin = new Vector3(this.position.x, TUNING.bot.throwHeight, this.position.z);
    const direction = safeNormalize(targetPosition.subtract(origin));
    direction.y += TUNING.bot.arc; // gentle lob; throwBall renormalizes
    this.ballManager.throwBall(ball, origin, direction, TUNING.bot.throwSpeed, 'bot', false);
    return true;
  }

  dispose(): void {
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }
}
