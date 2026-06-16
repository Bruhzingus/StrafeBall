import { Color3, FreeCamera, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { HandController, HandState } from './HandController';
import { HandSide } from '../ball/BallState';

interface ArmRig {
  node: TransformNode; // animated hand pivot (camera-local); the ball is snapped here
  forearm: Mesh;
  hand: Mesh;
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
  private readonly material: StandardMaterial;
  private readonly left: ArmRig;
  private readonly right: ArmRig;
  private readonly target = new Vector3();
  private time = 0;

  constructor(private readonly camera: FreeCamera) {
    const scene = camera.getScene();
    this.material = new StandardMaterial('viewmodel_arm_mat', scene);
    this.material.diffuseColor = new Color3(0.85, 0.56, 0.44);
    this.material.emissiveColor = new Color3(0.12, 0.07, 0.05);
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
    this.material.dispose();
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
    forearm.material = this.material;
    forearm.isPickable = false;
    // Lay the forearm along camera Z, reaching back from the hand toward the body.
    forearm.rotation.x = Math.PI / 2;
    forearm.position.set(0, 0, -TUNING.arms.forearmLength / 2);

    const hand = MeshBuilder.CreateSphere(
      `viewmodel_${side}_hand`,
      { diameter: TUNING.arms.handRadius * 2, segments: 8 },
      scene
    );
    hand.parent = node;
    hand.material = this.material;
    hand.isPickable = false;

    const sign = side === 'left' ? -1 : 1;
    const current = new Vector3(sign * TUNING.arms.restSide, TUNING.arms.restDrop, TUNING.arms.restForward);
    node.position.copyFrom(current);
    return { node, forearm, hand, current };
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
