import { Color3, FreeCamera, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { HandController, HandState } from './HandController';
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
 * a wind-up pull as the throw charges, and a forward punch + tilt on release. Purely cosmetic —
 * throw direction/origin is computed from the camera, never from these meshes.
 */
export class Viewmodel {
  private readonly skinMaterial: PBRMaterial;
  private readonly detailMaterial: PBRMaterial;
  private readonly left: ArmRig;
  private readonly right: ArmRig;
  private readonly target = new Vector3();
  private time = 0;

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

  update(dt: number, hands: HandController): void {
    this.time += dt;
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
    const holding = !!hand.ball;
    this.computeTarget(side, sign, hand, holding);

    // Frame-rate-independent smoothing toward the target pose.
    const k = 1 - Math.exp(-TUNING.arms.smoothing * dt);
    rig.current.x += (this.target.x - rig.current.x) * k;
    rig.current.y += (this.target.y - rig.current.y) * k;
    rig.current.z += (this.target.z - rig.current.z) * k;
    rig.node.position.copyFrom(rig.current);

    // Tilt forward during a throw (follow-through); a gentle base tilt otherwise.
    rig.node.rotation.x = -hand.throwAnim * 0.85 + (holding ? -0.12 : 0.12);

    // Snap the held ball into the animated hand.
    if (hand.ball) {
      rig.node.computeWorldMatrix(true);
      hand.ball.mesh.position.copyFrom(rig.node.getAbsolutePosition());
    }
  }

  private computeTarget(side: HandSide, sign: number, hand: HandState, holding: boolean): void {
    if (!holding) {
      this.target.set(sign * TUNING.arms.restSide, TUNING.arms.restDrop, TUNING.arms.restForward);
      return;
    }
    const charge = Math.min(1, hand.chargeSeconds / TUNING.ball.maxChargeSeconds);
    const bob = Math.sin(this.time * TUNING.arms.bobSpeed + (side === 'left' ? 0 : Math.PI)) * TUNING.arms.bobAmplitude;
    const punch = hand.throwAnim * hand.throwAnim; // ease-out punch on release
    this.target.set(
      sign * TUNING.hands.holdSide,
      TUNING.hands.holdDrop + bob + punch * TUNING.arms.throwLift,
      TUNING.hands.holdForward - charge * TUNING.arms.windupPull + punch * TUNING.arms.throwReach
    );
  }
}
