import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from '@babylonjs/core';
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
  private readonly bodyMaterial: PBRMaterial;
  private readonly armMaterial: PBRMaterial;
  private readonly armorMaterial: PBRMaterial;
  private readonly trimMaterial: PBRMaterial;

  private held: Ball | null = null;
  private throwTimer: number;
  private swingTimer = 0;
  private animTime = 0;

  constructor(loader: ModelLoader, private readonly ballManager: BallManager) {
    this.position = new Vector3(TUNING.bot.position.x, TUNING.bot.position.y, TUNING.bot.position.z);
    // Face the player (local +Z toward -world Z) so the throwing arm swings toward them.
    this.mesh = loader.createVisual('dummy', { name: 'practice_bot', position: this.position, rotationY: Math.PI });

    const scene = this.mesh.getScene();
    this.bodyMaterial = makePbrMaterial(scene, 'practice_bot_body_mat', new Color3(0.18, 0.52, 0.92), {
      roughness: 0.34,
      emissive: new Color3(0.01, 0.06, 0.12)
    });
    this.armMaterial = makePbrMaterial(scene, 'practice_bot_arm_mat', new Color3(0.15, 0.44, 0.78), {
      roughness: 0.38,
      emissive: new Color3(0.01, 0.04, 0.08)
    });
    this.armorMaterial = makePbrMaterial(scene, 'practice_bot_armor_mat', new Color3(0.04, 0.08, 0.14), {
      metallic: 0.18,
      roughness: 0.32,
      emissive: new Color3(0.004, 0.01, 0.02)
    });
    this.trimMaterial = makePbrMaterial(scene, 'practice_bot_trim_mat', new Color3(0.96, 0.78, 0.18), {
      metallic: 0.2,
      roughness: 0.28,
      emissive: new Color3(0.08, 0.05, 0.005)
    });

    this.mesh.material = this.bodyMaterial;
    this.mesh.metadata = { practiceBot: true };
    this.buildBodyDetails();

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

  setEnabled(enabled: boolean): void {
    this.mesh.setEnabled(enabled);
    this.throwArm.setEnabled(enabled);
    this.restArm.setEnabled(enabled);
    this.handAnchor.setEnabled(enabled);
    for (const child of this.mesh.getChildMeshes(false)) {
      child.setEnabled(enabled);
    }
  }

  dispose(): void {
    this.bodyMaterial.dispose();
    this.armMaterial.dispose();
    this.armorMaterial.dispose();
    this.trimMaterial.dispose();
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

  private buildBodyDetails(): void {
    const scene = this.mesh.getScene();

    const helmet = MeshBuilder.CreateSphere('practice_bot_helmet', { diameter: 0.54, segments: 18 }, scene);
    helmet.parent = this.mesh;
    helmet.position.set(0, 1.0, -0.02);
    helmet.scaling.set(1.08, 0.78, 0.98);
    helmet.material = this.armorMaterial;
    helmet.isPickable = false;

    const visor = MeshBuilder.CreateBox('practice_bot_visor', { width: 0.42, height: 0.1, depth: 0.04 }, scene);
    visor.parent = this.mesh;
    visor.position.set(0, 1.02, -0.28);
    visor.material = this.trimMaterial;
    visor.isPickable = false;

    const chest = MeshBuilder.CreateBox('practice_bot_chest_plate', { width: 0.54, height: 0.58, depth: 0.08 }, scene);
    chest.parent = this.mesh;
    chest.position.set(0, 0.22, -0.29);
    chest.material = this.armorMaterial;
    chest.isPickable = false;

    const hip = MeshBuilder.CreateBox('practice_bot_hips', { width: 0.5, height: 0.18, depth: 0.32 }, scene);
    hip.parent = this.mesh;
    hip.position.set(0, -0.48, 0);
    hip.material = this.armorMaterial;
    hip.isPickable = false;

    for (const sign of [-1, 1]) {
      const shoulder = MeshBuilder.CreateBox(
        `practice_bot_shoulder_pad_${sign}`,
        { width: 0.36, height: 0.16, depth: 0.42 },
        scene
      );
      shoulder.parent = this.mesh;
      shoulder.position.set(sign * 0.46, 0.48, -0.02);
      shoulder.rotation.z = -sign * 0.18;
      shoulder.material = this.armorMaterial;
      shoulder.isPickable = false;

      const leg = MeshBuilder.CreateCapsule(
        `practice_bot_leg_${sign}`,
        { height: 0.72, radius: 0.095, tessellation: 12 },
        scene
      );
      leg.parent = this.mesh;
      leg.position.set(sign * 0.16, -0.78, 0);
      leg.material = this.bodyMaterial;
      leg.isPickable = false;

      const shinPad = MeshBuilder.CreateBox(
        `practice_bot_shin_pad_${sign}`,
        { width: 0.14, height: 0.34, depth: 0.055 },
        scene
      );
      shinPad.parent = this.mesh;
      shinPad.position.set(sign * 0.16, -0.83, -0.1);
      shinPad.material = this.trimMaterial;
      shinPad.isPickable = false;

      const shoe = MeshBuilder.CreateBox(
        `practice_bot_shoe_${sign}`,
        { width: 0.24, height: 0.1, depth: 0.42 },
        scene
      );
      shoe.parent = this.mesh;
      shoe.position.set(sign * 0.16, -1.18, -0.08);
      shoe.material = this.armorMaterial;
      shoe.isPickable = false;
    }
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

    const glove = MeshBuilder.CreateSphere(
      `practice_bot_glove_${sign}`,
      { diameter: TUNING.bot.armRadius * 2.7, segments: 12 },
      scene
    );
    glove.parent = pivot;
    glove.position.set(0, -TUNING.bot.armLength, 0);
    glove.scaling.set(1.08, 0.82, 1.18);
    glove.material = this.armorMaterial;
    glove.isPickable = false;

    return pivot;
  }
}

function makePbrMaterial(
  scene: Scene,
  name: string,
  albedo: Color3,
  options: { metallic?: number; roughness?: number; emissive?: Color3 } = {}
): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = albedo;
  material.metallic = options.metallic ?? 0;
  material.roughness = options.roughness ?? 0.45;
  if (options.emissive) material.emissiveColor = options.emissive;
  return material;
}
