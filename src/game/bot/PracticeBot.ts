import { Color3, Mesh, MeshBuilder, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { BallManager } from '../ball/BallManager';
import { ModelLoader } from '../assets/ModelLoader';
import { Ball } from '../ball/Ball';
import { BallState } from '../ball/BallState';
import { safeNormalize, lerp, saturate } from '../utils/math';

/**
 * An always-on practice partner. On a fixed interval it grabs the nearest ball already lying on
 * the map (loose or dead), holds it briefly while its throwing arm winds up, then lobs it at the
 * player so you can drill catching, parrying and blocking. It never spawns balls: if none are
 * free it simply waits, conserving the ball count. The ball is only "held" during the short
 * wind-up, so it isn't removed from play for long.
 */
export class PracticeBot {
  public readonly mesh: Mesh;
  private readonly position: Vector3;

  private readonly throwArm: TransformNode; // animated shoulder pivot (right arm)
  private readonly restArm: TransformNode; // static left arm
  private readonly handAnchor: TransformNode; // grip point at the end of the throwing arm
  private readonly armMaterial: StandardMaterial;

  private held: Ball | null = null;
  private throwTimer: number;
  private swingTimer = 0;
  private animTime = 0;

  constructor(loader: ModelLoader, private readonly ballManager: BallManager) {
    this.position = new Vector3(TUNING.bot.position.x, TUNING.bot.position.y, TUNING.bot.position.z);
    // Face the player (local +Z toward -world Z) so the throwing arm swings toward them.
    this.mesh = loader.createVisual('dummy', { name: 'practice_bot', position: this.position, rotationY: Math.PI });

    const body = (this.mesh.material as StandardMaterial).clone('practice_bot_mat');
    body.diffuseColor = new Color3(0.2, 0.62, 0.92);
    body.emissiveColor = new Color3(0.05, 0.18, 0.28);
    this.mesh.material = body;
    this.mesh.metadata = { practiceBot: true };

    this.armMaterial = new StandardMaterial('practice_bot_arm_mat', this.mesh.getScene());
    this.armMaterial.diffuseColor = new Color3(0.16, 0.5, 0.78);
    this.armMaterial.emissiveColor = new Color3(0.04, 0.14, 0.22);

    this.throwArm = this.buildArm(1);
    this.restArm = this.buildArm(-1);
    this.restArm.rotation.x = TUNING.bot.restArmAngle;

    this.handAnchor = new TransformNode('practice_bot_hand', this.mesh.getScene());
    this.handAnchor.parent = this.throwArm;
    this.handAnchor.position.set(0, -TUNING.bot.armLength, 0);

    this.throwTimer = TUNING.bot.throwIntervalSeconds;
  }

  /**
   * Advance the wind-up/throw cycle, lobbing a map ball at `targetPosition` on release. Returns
   * true on the frame a throw fires so the caller can play the throw FX.
   */
  update(dt: number, targetPosition: Vector3): boolean {
    this.throwTimer -= dt;
    this.animTime += dt;
    if (this.swingTimer > 0) this.swingTimer = Math.max(0, this.swingTimer - dt);

    // Enter the wind-up: reserve the nearest free ball into the throwing hand.
    if (!this.held && this.swingTimer <= 0 && this.throwTimer <= TUNING.bot.windupSeconds) {
      const ball = this.ballManager.findNearestFreeBall(this.position);
      if (ball) this.grab(ball);
    }

    this.animateArm();
    if (this.held) this.positionHeldInHand();

    if (this.throwTimer <= 0) {
      if (!this.held) {
        this.throwTimer = 0; // no ball available — wait here (never spawn one)
        return false;
      }
      this.release(targetPosition);
      return true;
    }
    return false;
  }

  /** Drop any reserved ball (used when balls are reset out from under the bot). */
  reset(): void {
    this.held = null;
    this.throwTimer = TUNING.bot.throwIntervalSeconds;
    this.swingTimer = 0;
  }

  dispose(): void {
    this.armMaterial.dispose();
    this.mesh.material?.dispose();
    this.mesh.dispose(); // disposes child arm/hand nodes too
  }

  private grab(ball: Ball): void {
    ball.state = BallState.Held;
    ball.owner = 'bot';
    ball.heldHand = null;
    ball.isSuper = false;
    ball.bounceCount = 0;
    ball.velocity.setAll(0);
    this.held = ball;
  }

  private release(targetPosition: Vector3): void {
    const ball = this.held;
    this.held = null;
    this.swingTimer = TUNING.bot.armSwingSeconds;
    this.throwTimer = TUNING.bot.throwIntervalSeconds;
    if (!ball) return;

    const origin = this.handWorldPosition();
    const direction = safeNormalize(targetPosition.subtract(origin));
    direction.y += TUNING.bot.arc; // gentle lob; throwBall renormalizes
    this.ballManager.throwBall(ball, origin, direction, TUNING.bot.throwSpeed, 'bot', false);
  }

  private animateArm(): void {
    let angle: number;
    if (this.swingTimer > 0) {
      // Follow-through: swing from the extended throw angle back to rest.
      const s = this.swingTimer / TUNING.bot.armSwingSeconds; // 1 -> 0
      angle = lerp(TUNING.bot.restArmAngle, TUNING.bot.throwArmAngle, s);
    } else if (this.held) {
      // Wind-up: ease the arm from rest back to the cocked angle as release nears.
      const p = saturate(1 - this.throwTimer / TUNING.bot.windupSeconds);
      angle = lerp(TUNING.bot.restArmAngle, TUNING.bot.cockArmAngle, p * p);
    } else {
      // Idle sway.
      angle = TUNING.bot.restArmAngle + Math.sin(this.animTime * 1.5) * 0.05;
    }
    this.throwArm.rotation.x = angle;
  }

  private positionHeldInHand(): void {
    if (this.held) this.held.mesh.position.copyFrom(this.handWorldPosition());
  }

  private handWorldPosition(): Vector3 {
    this.throwArm.computeWorldMatrix(true);
    this.handAnchor.computeWorldMatrix(true);
    return this.handAnchor.getAbsolutePosition();
  }

  private buildArm(sign: number): TransformNode {
    const scene = this.mesh.getScene();
    const pivot = new TransformNode(`practice_bot_shoulder_${sign}`, scene);
    pivot.parent = this.mesh;
    pivot.position.set(sign * TUNING.bot.shoulderSide, TUNING.bot.shoulderHeight, 0);

    const forearm = MeshBuilder.CreateCapsule(
      `practice_bot_arm_${sign}`,
      { height: TUNING.bot.armLength, radius: TUNING.bot.armRadius },
      scene
    );
    forearm.parent = pivot;
    forearm.material = this.armMaterial;
    forearm.isPickable = false;
    forearm.position.set(0, -TUNING.bot.armLength / 2, 0); // hang down from the shoulder
    return pivot;
  }
}
