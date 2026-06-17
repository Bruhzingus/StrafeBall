import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { BallManager } from '../ball/BallManager';
import { Ball } from '../ball/Ball';
import { BallState } from '../ball/BallState';
import { safeNormalize, lerp, saturate } from '../utils/math';
import type { BotDifficulty } from '../practice/PracticeState';
import { BOT_DIFFICULTY_CONFIG } from '../practice/PracticeState';

export type BotThrowMode = 'quick' | 'charge';

const QUICK_BOT_POS = new Vector3(-3.5, 0, 11);
const CHARGE_BOT_POS = new Vector3(3.5, 0, 11);
const BOT_EYE_HEIGHT = 1.4;

/**
 * Practice partner. Two instances: quick-throw and charge-throw bot.
 * Only throws when enabled. Uses player-style model (same construction as target dummies).
 */
export class PracticeBot {
  public readonly mesh: Mesh;
  private readonly throwArm: TransformNode;
  private readonly restArm: TransformNode;
  private readonly handAnchor: TransformNode;
  private readonly bodyMat: PBRMaterial;
  private readonly trimMat: PBRMaterial;

  private held: Ball | null = null;
  private throwTimer: number;
  private swingTimer = 0;
  private animTime = 0;
  private enabled = false;

  private readonly basePosition: Vector3;

  constructor(
    private readonly scene: Scene,
    private readonly ballManager: BallManager,
    public readonly mode: BotThrowMode
  ) {
    this.basePosition = mode === 'quick' ? QUICK_BOT_POS.clone() : CHARGE_BOT_POS.clone();

    // Teal = quick bot, orange = charge bot (distinct, same palette as moving dummy)
    const bodyColor = mode === 'quick'
      ? new Color3(0.0, 0.72, 0.65)
      : new Color3(0.88, 0.44, 0.1);
    const trimColor = mode === 'quick'
      ? new Color3(0.02, 0.14, 0.16)
      : new Color3(0.24, 0.1, 0.02);

    this.bodyMat = makePbr(scene, `bot_body_${mode}`, bodyColor, { roughness: 0.34, emissive: bodyColor.scale(0.1) });
    this.trimMat = makePbr(scene, `bot_trim_${mode}`, trimColor, { metallic: 0.1, roughness: 0.32 });

    this.mesh = MeshBuilder.CreateCapsule(`bot_body_mesh_${mode}`, {
      height: 1.8, radius: 0.3, tessellation: 14
    }, scene);
    this.mesh.position.copyFrom(this.basePosition);
    this.mesh.position.y = 0.9;
    this.mesh.rotation.y = Math.PI; // face toward -Z (player side)
    this.mesh.material = this.bodyMat;
    this.mesh.isPickable = false;
    this.mesh.metadata = { practiceBot: true, mode };

    this.buildDetails();

    this.throwArm = this.buildArm(1);
    this.restArm = this.buildArm(-1);
    this.restArm.rotation.x = 0.18;

    this.handAnchor = new TransformNode(`bot_hand_${mode}`, scene);
    this.handAnchor.parent = this.throwArm;
    this.handAnchor.position.set(0, -0.62, 0);

    this.throwTimer = this.getConfig().intervalSeconds;
    this.setEnabled(false);
  }

  private getConfig() {
    return BOT_DIFFICULTY_CONFIG[this._difficulty];
  }

  private _difficulty: BotDifficulty = 'normal';

  setDifficulty(d: BotDifficulty): void {
    this._difficulty = d;
    // Reset timer to new interval
    this.throwTimer = Math.min(this.throwTimer, this.getConfig().intervalSeconds);
  }

  /** Advance bot logic. Returns true on the frame a throw fires. */
  update(dt: number, targetPosition: Vector3): boolean {
    if (!this.enabled) return false;

    this.throwTimer -= dt;
    this.animTime += dt;
    if (this.swingTimer > 0) this.swingTimer = Math.max(0, this.swingTimer - dt);

    const cfg = this.getConfig();

    if (!this.held && this.swingTimer <= 0 && this.throwTimer <= cfg.windupSeconds) {
      const ball = this.ballManager.findNearestFreeBall(this.mesh.position);
      if (ball) this.grab(ball);
    }

    this.animateArm(cfg.windupSeconds);
    if (this.held) this.positionHeldInHand();

    if (this.throwTimer <= 0) {
      if (!this.held) {
        this.throwTimer = 0;
        return false;
      }
      this.release(targetPosition, cfg);
      return true;
    }
    return false;
  }

  reset(): void {
    this.held = null;
    this.throwTimer = this.getConfig().intervalSeconds;
    this.swingTimer = 0;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.setEnabled(enabled);
    this.throwArm.setEnabled(enabled);
    this.restArm.setEnabled(enabled);
    this.handAnchor.setEnabled(enabled);
    for (const child of this.mesh.getChildMeshes(false)) child.setEnabled(enabled);
    if (!enabled && this.held) {
      // Drop the ball back to loose
      this.held.state = BallState.Loose;
      this.held = null;
    }
    if (enabled) {
      this.throwTimer = this.getConfig().intervalSeconds;
    }
  }

  dispose(): void {
    this.bodyMat.dispose();
    this.trimMat.dispose();
    this.mesh.dispose();
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

  private release(targetPosition: Vector3, cfg: typeof BOT_DIFFICULTY_CONFIG[BotDifficulty]): void {
    const ball = this.held;
    this.held = null;
    this.swingTimer = 0.2;
    this.throwTimer = cfg.intervalSeconds;
    if (!ball) return;

    // Aim at the player's center mass, not the camera eye. targetPosition is the eye position, which
    // sits ~0.45 m above the chest; aiming there (plus the upward arc bias below) sent throws sailing
    // over the player's head. Drop to chest height so the ball arrives at the body.
    const aimPoint = targetPosition.clone();
    aimPoint.y -= 0.5;

    const origin = this.handWorldPosition();
    const dir = safeNormalize(aimPoint.subtract(origin));

    // Add aim spread
    if (cfg.aimSpread > 0) {
      dir.x += (Math.random() - 0.5) * cfg.aimSpread;
      dir.y += (Math.random() - 0.5) * cfg.aimSpread;
    }

    const isCharged = this.mode === 'charge';
    // The charge bot throws a flat, fast, gravity-free ball — adding the lob arc on top of a chest
    // aim makes it rise over the head. Only the quick (arcing) bot gets the upward arc bias.
    if (!isCharged) dir.y += cfg.arc;

    const speed = isCharged ? cfg.chargeThrowSpeed : cfg.throwSpeed;
    const dropScale = isCharged ? 0 : 1;

    this.ballManager.throwBall(ball, origin, dir, speed, 'bot', isCharged, dropScale);
  }

  private animateArm(windupSeconds: number): void {
    let angle: number;
    if (this.swingTimer > 0) {
      const s = this.swingTimer / 0.2;
      angle = lerp(0.18, -1.25, s);
    } else if (this.held) {
      const p = saturate(1 - this.throwTimer / windupSeconds);
      angle = lerp(0.18, 1.2, p * p);
    } else {
      angle = 0.18 + Math.sin(this.animTime * 1.5) * 0.05;
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

  private buildDetails(): void {
    const scene = this.scene;
    const root = this.mesh;

    // Head
    const head = MeshBuilder.CreateSphere(`bot_head_${this.mode}`, { diameter: 0.44, segments: 14 }, scene);
    head.parent = root;
    head.position.set(0, 1.08, 0);
    head.scaling.set(1.0, 0.86, 0.95);
    head.material = this.bodyMat;
    head.isPickable = false;

    // Torso plate
    const torso = MeshBuilder.CreateBox(`bot_torso_${this.mode}`, { width: 0.58, height: 0.62, depth: 0.18 }, scene);
    torso.parent = root;
    torso.position.set(0, 0.2, -0.27);
    torso.material = this.trimMat;
    torso.isPickable = false;

    // Hips
    const hips = MeshBuilder.CreateBox(`bot_hips_${this.mode}`, { width: 0.5, height: 0.18, depth: 0.34 }, scene);
    hips.parent = root;
    hips.position.set(0, -0.48, 0);
    hips.material = this.trimMat;
    hips.isPickable = false;

    for (const sign of [-1, 1]) {
      // Shoulder pad
      const shoulder = MeshBuilder.CreateBox(`bot_shoulder_${this.mode}_${sign}`, {
        width: 0.34, height: 0.14, depth: 0.34
      }, scene);
      shoulder.parent = root;
      shoulder.position.set(sign * 0.44, 0.48, -0.02);
      shoulder.rotation.z = -sign * 0.16;
      shoulder.material = this.trimMat;
      shoulder.isPickable = false;

      // Leg
      const leg = MeshBuilder.CreateCapsule(`bot_leg_${this.mode}_${sign}`, {
        height: 0.68, radius: 0.085, tessellation: 12
      }, scene);
      leg.parent = root;
      leg.position.set(sign * 0.16, -0.8, 0);
      leg.material = this.bodyMat;
      leg.isPickable = false;

      // Foot
      const foot = MeshBuilder.CreateBox(`bot_foot_${this.mode}_${sign}`, {
        width: 0.24, height: 0.09, depth: 0.36
      }, scene);
      foot.parent = root;
      foot.position.set(sign * 0.16, -1.16, -0.08);
      foot.material = this.trimMat;
      foot.isPickable = false;
    }

    // Mode label visor
    const visorLabel = MeshBuilder.CreateBox(`bot_visor_${this.mode}`, {
      width: 0.38, height: 0.09, depth: 0.04
    }, scene);
    visorLabel.parent = root;
    visorLabel.position.set(0, 1.04, -0.28);
    visorLabel.material = this.trimMat;
    visorLabel.isPickable = false;
  }

  private buildArm(sign: number): TransformNode {
    const pivot = new TransformNode(`bot_shoulder_pivot_${this.mode}_${sign}`, this.scene);
    pivot.parent = this.mesh;
    pivot.position.set(sign * 0.34, BOT_EYE_HEIGHT - 0.04, 0);

    const forearm = MeshBuilder.CreateCapsule(`bot_arm_${this.mode}_${sign}`, {
      height: 0.62, radius: 0.07, tessellation: 10
    }, this.scene);
    forearm.parent = pivot;
    forearm.position.set(0, -0.31, 0);
    forearm.material = this.bodyMat;
    forearm.isPickable = false;

    const glove = MeshBuilder.CreateSphere(`bot_glove_${this.mode}_${sign}`, {
      diameter: 0.19, segments: 10
    }, this.scene);
    glove.parent = pivot;
    glove.position.set(0, -0.62, 0);
    glove.material = this.trimMat;
    glove.isPickable = false;

    return pivot;
  }
}

function makePbr(
  scene: Scene,
  name: string,
  albedo: Color3,
  opts: { metallic?: number; roughness?: number; emissive?: Color3 } = {}
): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = albedo;
  m.metallic = opts.metallic ?? 0;
  m.roughness = opts.roughness ?? 0.45;
  if (opts.emissive) m.emissiveColor = opts.emissive;
  return m;
}
