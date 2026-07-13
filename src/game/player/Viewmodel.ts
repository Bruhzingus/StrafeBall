import { Color3, FreeCamera, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { addPolishedGlowOccluder } from '../effects/PolishedPostFX';
import { TUNING } from '../config/tuning';
import { HandController, HandState } from './HandController';
import type { MovementSnapshot } from './MovementController';
import { HandSide } from '../ball/BallState';

interface ArmRig {
  node: TransformNode; // animated hand pivot (camera-local); the ball is snapped here
  forearm: Mesh;
  hand: Mesh;
  wrist: Mesh;
  knuckles: Mesh[];
  current: Vector3; // smoothed local position
}

/**
 * First-person arm viewmodel: two greybox arms parented to the camera that visually hold the
 * balls. Each hand pivots in camera-local space and the held ball is snapped to the animated
 * hand every frame, so arm and ball move as one. Small animations: an idle bob while holding,
 * an overhand windup while charging, a follow-through on release, and a visible fake/cancel abort.
 * Purely cosmetic —
 * throw direction/origin is computed from the camera, never from these meshes.
 */
export class Viewmodel {
  private readonly skinMaterial: PBRMaterial;
  private readonly detailMaterial: PBRMaterial;
  private readonly left: ArmRig;
  private readonly right: ArmRig;
  private readonly target = new Vector3();
  private time = 0;
  private dashAnim = 0;
  private slideBlend = 0;
  private crouchBlend = 0;

  constructor(private readonly camera: FreeCamera) {
    const scene = camera.getScene();
    this.skinMaterial = new PBRMaterial('viewmodel_skin_mat', scene);
    this.skinMaterial.albedoColor = new Color3(0.86, 0.58, 0.46);
    this.skinMaterial.emissiveColor = new Color3(0.035, 0.018, 0.012);
    this.skinMaterial.metallic = 0;
    this.skinMaterial.roughness = 0.48;

    this.detailMaterial = new PBRMaterial('viewmodel_detail_mat', scene);
    this.detailMaterial.albedoColor = new Color3(0.58, 0.34, 0.28);
    this.detailMaterial.emissiveColor = new Color3(0.018, 0.009, 0.006);
    this.detailMaterial.metallic = 0;
    this.detailMaterial.roughness = 0.56;

    this.left = this.buildArm('left', scene);
    this.right = this.buildArm('right', scene);
  }

  update(dt: number, hands: HandController, movement?: MovementSnapshot): void {
    this.time += dt;
    if (movement?.dashingThisFrame) this.dashAnim = 1;
    else this.dashAnim = Math.max(0, this.dashAnim - dt / 0.22);
    const blend = 1 - Math.exp(-14 * Math.max(0, dt));
    this.slideBlend += ((movement?.sliding ? 1 : 0) - this.slideBlend) * blend;
    this.crouchBlend += ((movement?.crouching && !movement.sliding ? 1 : 0) - this.crouchBlend) * blend;
    this.poseArm(dt, this.left, 'left', hands.left);
    this.poseArm(dt, this.right, 'right', hands.right);
  }

  dispose(): void {
    this.left.node.dispose();
    this.right.node.dispose();
    this.skinMaterial.dispose();
    this.detailMaterial.dispose();
  }

  private buildArm(side: HandSide, scene: Scene): ArmRig {
    const node = new TransformNode(`viewmodel_${side}`, scene);
    node.parent = this.camera;

    const forearm = MeshBuilder.CreateCapsule(
      `viewmodel_${side}_forearm`,
      { height: TUNING.arms.forearmLength, radius: TUNING.arms.forearmRadius },
      scene
    );
    forearm.parent = node;
    forearm.material = this.skinMaterial;
    forearm.isPickable = false;
    // Lay the forearm along camera Z, reaching back from the hand toward the body.
    forearm.rotation.x = Math.PI / 2;
    forearm.position.set(0, 0, -TUNING.arms.forearmLength / 2);

    const wrist = MeshBuilder.CreateCylinder(
      `viewmodel_${side}_wrist`,
      { height: 0.045, diameter: TUNING.arms.forearmRadius * 2.25, tessellation: 14 },
      scene
    );
    wrist.parent = node;
    wrist.material = this.detailMaterial;
    wrist.isPickable = false;
    wrist.rotation.x = Math.PI / 2;
    wrist.position.set(0, 0, -0.085);

    const hand = MeshBuilder.CreateSphere(
      `viewmodel_${side}_hand`,
      { diameter: TUNING.arms.handRadius * 2, segments: 12 },
      scene
    );
    hand.parent = node;
    hand.material = this.skinMaterial;
    hand.isPickable = false;
    hand.scaling.set(1.08, 0.82, 1.18);

    const knuckles = this.buildKnuckles(side, node, scene);

    const sign = side === 'left' ? -1 : 1;
    const current = new Vector3(sign * TUNING.arms.restSide, TUNING.arms.restDrop, TUNING.arms.restForward);
    node.position.copyFrom(current);
    // Glow occluders: the first-person arms fill a lot of screen right in front of glowing wall
    // strips/portals — without a hole in the glow map the halos bleed through them as bright bands
    // (same defect the balls had). Safe no-op outside Polished.
    for (const mesh of [forearm, wrist, hand, ...knuckles]) addPolishedGlowOccluder(mesh);
    return { node, forearm, hand, wrist, knuckles, current };
  }

  private buildKnuckles(side: HandSide, node: TransformNode, scene: Scene): Mesh[] {
    const sign = side === 'left' ? -1 : 1;
    const meshes: Mesh[] = [];
    const offsets = [-0.045, -0.015, 0.015, 0.045];

    for (let i = 0; i < offsets.length; i += 1) {
      const knuckle = MeshBuilder.CreateSphere(
        `viewmodel_${side}_knuckle_${i}`,
        { diameter: 0.025, segments: 8 },
        scene
      );
      knuckle.parent = node;
      knuckle.position.set(offsets[i], 0.024, 0.078);
      knuckle.scaling.set(1.0, 0.58, 0.85);
      knuckle.material = this.detailMaterial;
      knuckle.isPickable = false;
      meshes.push(knuckle);
    }

    const thumb = MeshBuilder.CreateSphere(
      `viewmodel_${side}_thumb`,
      { diameter: 0.05, segments: 8 },
      scene
    );
    thumb.parent = node;
    thumb.position.set(sign * 0.082, -0.012, 0.028);
    thumb.scaling.set(0.7, 0.92, 1.15);
    thumb.rotation.z = -sign * 0.55;
    thumb.material = this.skinMaterial;
    thumb.isPickable = false;
    meshes.push(thumb);

    return meshes;
  }

  private poseArm(dt: number, rig: ArmRig, side: HandSide, hand: HandState): void {
    const sign = side === 'left' ? -1 : 1;
    const holding = !!hand.ball || hand.visualHolding;
    this.computeTarget(side, sign, hand, holding);

    // Frame-rate-independent smoothing toward the target pose.
    const k = 1 - Math.exp(-TUNING.arms.smoothing * dt);
    rig.current.x += (this.target.x - rig.current.x) * k;
    rig.current.y += (this.target.y - rig.current.y) * k;
    rig.current.z += (this.target.z - rig.current.z) * k;
    rig.node.position.copyFrom(rig.current);

    // Tilt back during the overhand windup, then snap through on release.
    const charge = hand.charging ? Math.min(1, hand.chargeSeconds / TUNING.ball.maxChargeSeconds) : 0;
    const fakeWindup = hand.fakeCharge01 * easeOutCubic(hand.fakeAnim);
    const windup = Math.max(charge, fakeWindup);
    const throwSwing = easeOutCubic(hand.throwAnim);
    const catchReach = easeOutCubic(hand.catchAttemptAnim) + (hand.catchStance ? 0.26 : 0);
    const catchSnap = easeOutCubic(hand.catchAnim);
    const pickup = easeOutCubic(hand.pickupAnim);
    const parry = easeOutCubic(hand.parryAnim);
    const dashPose = Math.sin(this.dashAnim * Math.PI) * (this.dashAnim > 0 ? 1 : 0);
    rig.node.rotation.x =
      -throwSwing * 1.05 +
      windup * 0.72 -
      catchReach * 0.34 -
      catchSnap * 0.2 +
      pickup * 0.16 -
      parry * 0.32 +
      dashPose * 0.14 +
      this.slideBlend * 0.12 +
      (holding ? -0.08 : 0.08);
    rig.node.rotation.y = sign * (catchReach * 0.08 - parry * 0.28);
    rig.node.rotation.z = -sign * windup * 0.18 + sign * throwSwing * 0.12 - sign * parry * 0.18;
    rig.hand.scaling.set(1.08 + catchReach * 0.12 + parry * 0.08, 0.82 - catchReach * 0.08, 1.18 + catchReach * 0.16 + pickup * 0.08);
    rig.wrist.scaling.set(1 + parry * 0.16, 1, 1 + catchReach * 0.08);
    for (let i = 0; i < 4 && i < rig.knuckles.length; i += 1) {
      rig.knuckles[i].position.y = 0.024 + catchReach * 0.018 - parry * 0.006;
    }

    // Snap the held ball into the animated hand.
    if (hand.ball) {
      rig.node.computeWorldMatrix(true);
      hand.ball.mesh.position.copyFrom(rig.node.getAbsolutePosition());
    }
  }

  private computeTarget(side: HandSide, sign: number, hand: HandState, holding: boolean): void {
    const throwSwing = easeOutCubic(hand.throwAnim);
    const fakeWindup = hand.fakeCharge01 * easeOutCubic(hand.fakeAnim);
    const catchReach = Math.min(1, easeOutCubic(hand.catchAttemptAnim) + (hand.catchStance ? 0.42 : 0));
    const catchSnap = easeOutCubic(hand.catchAnim);
    const pickup = easeOutCubic(hand.pickupAnim);
    const parry = easeOutCubic(hand.parryAnim);

    const idle = !holding && throwSwing <= 0 && fakeWindup <= 0 && catchReach <= 0 && catchSnap <= 0 && pickup <= 0 && parry <= 0;
    if (idle) {
      this.target.set(sign * TUNING.arms.restSide, TUNING.arms.restDrop, TUNING.arms.restForward);
    } else {
      const charge = hand.charging ? Math.min(1, hand.chargeSeconds / TUNING.ball.maxChargeSeconds) : 0;
      const windup = Math.max(charge, fakeWindup);
      const bob = Math.sin(this.time * TUNING.arms.bobSpeed + (side === 'left' ? 0 : Math.PI)) * TUNING.arms.bobAmplitude;
      this.target.set(
      sign * (
        TUNING.hands.holdSide +
        windup * TUNING.arms.windupSide -
        throwSwing * TUNING.arms.throwCenter -
        parry * 0.1
      ),
      TUNING.hands.holdDrop +
        bob +
        windup * TUNING.arms.windupLift -
        throwSwing * TUNING.arms.throwDrop +
        catchReach * 0.08 +
        catchSnap * 0.12 +
        pickup * 0.18 +
        parry * 0.14,
      TUNING.hands.holdForward -
        windup * TUNING.arms.windupPull +
        throwSwing * TUNING.arms.throwReach +
        catchReach * 0.42 -
        catchSnap * 0.16 +
        pickup * 0.1 +
        parry * 0.24
      );
    }
    // Movement poses stay secondary to hand actions: dash tucks the arms back, slide braces them
    // low and forward, and crouch draws them slightly inward without obscuring the center reticle.
    const dashPose = Math.sin(this.dashAnim * Math.PI) * (this.dashAnim > 0 ? 1 : 0);
    this.target.x *= 1 - this.crouchBlend * 0.08;
    this.target.y += this.crouchBlend * 0.05 - this.slideBlend * 0.1 - dashPose * 0.05;
    this.target.z += this.slideBlend * 0.12 - dashPose * 0.16;
  }
}

function easeOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - (1 - x) * (1 - x) * (1 - x);
}
