import { FreeCamera, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { CONTROL_KEYS } from '../config/controls';
import { InputManager } from '../input/InputManager';
import { BallManager } from '../ball/BallManager';
import { HandController } from './HandController';
import { MovementController, MovementSnapshot } from './MovementController';
import { DashController } from './DashController';
import { BackflipController } from './BackflipController';
import { CatchController } from './CatchController';
import { CollisionWorld } from '../map/Collider';
import { Effects } from '../effects/Effects';
import { settings } from '../config/Settings';
import { Viewmodel } from './Viewmodel';
import { TUNING } from '../config/tuning';
import { backflipPitchOffset } from '../../../shared/simulation/AimMath';

export class PlayerController {
  public readonly root: TransformNode;
  public readonly camera: FreeCamera;
  public readonly dash = new DashController();
  public readonly backflip = new BackflipController();
  public readonly movement: MovementController;
  public readonly hands: HandController;
  public readonly catching: CatchController;
  public readonly viewmodel: Viewmodel;
  public lastMovementSnapshot!: MovementSnapshot;

  private pitch = 0;
  private yaw = 0;
  private wallLean = 0;
  // Where the K "reset" sends the player. Defaults to the gym spawn; the Movement Sandbox points it
  // at the sandbox spawn while active so a reset stays inside the sandbox (restored on exit).
  private readonly respawnPosition = new Vector3(0, 0, -16);
  private respawnYaw: number | undefined = undefined;

  constructor(scene: Scene, private readonly input: InputManager, ballManager: BallManager, collision: CollisionWorld, effects: Effects) {
    this.root = new TransformNode('playerRoot', scene);
    this.root.position = new Vector3(0, 0, -16);

    this.camera = new FreeCamera('playerCamera', new Vector3(0, 1.58, 0), scene);
    this.camera.parent = this.root;
    this.camera.minZ = 0.05;
    this.camera.fov = 1.2;
    // Babylon doesn't auto-assign a created camera as active, so the scene would render
    // nothing (blank canvas) without this. We drive look manually, so no attachControl.
    scene.activeCamera = this.camera;

    this.movement = new MovementController(this.root, this.camera, this.dash, this.backflip, collision);
    this.hands = new HandController(this.camera, ballManager, effects);
    this.catching = new CatchController(this.camera, ballManager, this.hands, this.movement, this.dash, effects);
    this.viewmodel = new Viewmodel(this.camera);
    // Seed a valid snapshot so the HUD never reads `undefined` on a frame before the first
    // sim step has run.
    this.lastMovementSnapshot = this.movement.snapshot();
  }

  update(dt: number, throwsSuppressed = false): void {
    // Look first (drains this frame's mouse delta), then physics, then hands/catch.
    this.updateLook();

    const catchStanceActive = this.hands.left.catchStance || this.hands.right.catchStance;
    this.lastMovementSnapshot = this.movement.update(dt, this.input, catchStanceActive);
    this.applyWallRunLean(dt, this.lastMovementSnapshot.wallRunning, this.lastMovementSnapshot.wallNormal.x, this.lastMovementSnapshot.wallNormal.z);

    // Force the camera world/view matrix fresh after the body moved this frame so hands/catch
    // (and held-ball visuals) read an up-to-date eye position and aim with no extra latency.
    this.camera.getViewMatrix(true);

    this.hands.update(dt, this.input, this.lastMovementSnapshot, throwsSuppressed);
    this.catching.update(dt, this.input, this.lastMovementSnapshot);
    // Arms follow the hand state and snap the held balls into the animated hands.
    this.viewmodel.update(dt, this.hands);

    if (this.input.wasKeyPressed(CONTROL_KEYS.reset)) {
      this.resetPosition();
    }
  }

  /**
   * Online-mode update: only mouse look + viewmodel. Physics and hand sim are server-authoritative
   * so we skip MovementController/HandController/CatchController here. Position is written by
   * ArenaScene.applyPredicted() after this returns.
   */
  updateOnline(dt: number): void {
    this.updateLook();
    this.movement.tickVisualFeedback(dt);
    this.hands.tickVisualAnimations(dt);
    this.viewmodel.update(dt, this.hands);
    this.camera.getViewMatrix(true);
  }

  resetPosition(): void {
    this.teleportTo(this.respawnPosition.clone(), this.respawnYaw ?? this.yaw);
    // A reset is a fresh start: refill stamina (dash charges) + clear the backflip cooldown so a
    // botched attempt never carries its resource drain into the next try. Offline-only by
    // construction — resetPosition is never reachable while online (movement is server-authoritative).
    this.dash.refill();
    this.backflip.cooldown = 0;
  }

  /** Set where the K reset teleports to (used by the Movement Sandbox; pass no args to restore gym). */
  setRespawn(position = new Vector3(0, 0, -16), yaw?: number): void {
    this.respawnPosition.copyFrom(position);
    this.respawnYaw = yaw;
  }

  teleportTo(position: Vector3, yawRadians = this.yaw, pitchRadians = this.pitch): void {
    this.root.position.copyFrom(position);
    this.yaw = yawRadians;
    this.pitch = Math.max(-TUNING.player.lookPitchLimitRadians, Math.min(TUNING.player.lookPitchLimitRadians, pitchRadians));
    this.root.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.y = 0;
    this.camera.rotation.z = 0;
    this.wallLean = 0;
    this.root.rotation.z = 0;
    this.backflip.active = false;
    this.backflip.timer = 0;
    this.movement.resetKinematics();
    this.lastMovementSnapshot = this.movement.snapshot();
    this.camera.getViewMatrix(true);
  }

  applyWallRunLean(dt: number, wallRunning: boolean, wallNormalX = 0, wallNormalZ = 0): void {
    const target = this.wallLeanTarget(wallRunning, wallNormalX, wallNormalZ);
    const alpha = 1 - Math.exp(-TUNING.wall.leanSmoothing * Math.max(0, dt));
    this.wallLean += (target - this.wallLean) * alpha;
    if (Math.abs(this.wallLean) < 0.0005) this.wallLean = 0;

    // Roll the root so the camera, arms, and held balls share the same body tilt. The gameplay
    // aim angles stay unchanged, making this a visual wall-run animation only.
    this.root.rotation.z = this.wallLean;
    this.camera.rotation.z = 0;
  }

  // Mouse look runs once per render frame so aiming stays smooth and low-latency regardless of
  // refresh rate. consumeMouseDelta drains all movement since the last frame (no smoothing, so
  // no added input delay). Yaw rotates the body root; pitch tilts the camera (clamped).
  private updateLook(): void {
    const { dx, dy } = this.input.consumeMouseDelta();
    const sensitivity = settings.effectiveMouseSensitivity;
    this.yaw += dx * sensitivity;
    this.pitch += dy * sensitivity;
    this.pitch = Math.max(-TUNING.player.lookPitchLimitRadians, Math.min(TUNING.player.lookPitchLimitRadians, this.pitch));
    this.root.rotation.y = this.yaw;
    // Backflip view tumble: add a full backward pitch rotation over the flip (shared easing with
    // online so the move reads identically in both modes).
    this.camera.rotation.x = this.pitch + backflipPitchOffset(this.backflip.active, this.backflip.timer);
    this.camera.rotation.y = 0;
    this.camera.rotation.z = 0;
  }

  private wallLeanTarget(wallRunning: boolean, wallNormalX: number, wallNormalZ: number): number {
    if (!wallRunning) return 0;
    const len = Math.hypot(wallNormalX, wallNormalZ);
    if (len < 0.001) return 0;

    const rightX = Math.cos(this.root.rotation.y);
    const rightZ = -Math.sin(this.root.rotation.y);
    const side = (wallNormalX * rightX + wallNormalZ * rightZ) / len;
    if (Math.abs(side) < 0.05) return 0;
    return -Math.sign(side) * TUNING.wall.leanAngleRadians;
  }
}
