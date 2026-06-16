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

export class PlayerController {
  public readonly root: TransformNode;
  public readonly camera: FreeCamera;
  public readonly dash = new DashController();
  public readonly backflip = new BackflipController();
  public readonly movement: MovementController;
  public readonly hands: HandController;
  public readonly catching: CatchController;
  public lastMovementSnapshot!: MovementSnapshot;

  private pitch = 0;
  private yaw = 0;
  private readonly mouseSensitivity = 0.0022;

  constructor(scene: Scene, private readonly input: InputManager, ballManager: BallManager, collision: CollisionWorld, effects: Effects) {
    this.root = new TransformNode('playerRoot', scene);
    this.root.position = new Vector3(0, 0, -12);

    this.camera = new FreeCamera('playerCamera', new Vector3(0, 1.58, 0), scene);
    this.camera.parent = this.root;
    this.camera.minZ = 0.05;
    this.camera.fov = 1.2;
    // Babylon doesn't auto-assign a created camera as active, so the scene would render
    // nothing (blank canvas) without this. We drive look manually, so no attachControl.
    scene.activeCamera = this.camera;

    this.movement = new MovementController(this.root, this.camera, this.dash, this.backflip, collision);
    this.hands = new HandController(this.camera, ballManager, this.backflip, effects);
    this.catching = new CatchController(this.camera, ballManager, this.hands, this.movement, effects);
    // Seed a valid snapshot so the HUD never reads `undefined` on a frame before the first
    // sim step has run.
    this.lastMovementSnapshot = this.movement.snapshot();
  }

  update(dt: number): void {
    // Look first (drains this frame's mouse delta), then physics, then hands/catch.
    this.updateLook();

    const catchStanceActive = this.hands.left.catchStance || this.hands.right.catchStance;
    this.lastMovementSnapshot = this.movement.update(dt, this.input, catchStanceActive);

    // Force the camera world/view matrix fresh after the body moved this frame so hands/catch
    // (and held-ball visuals) read an up-to-date eye position and aim with no extra latency.
    this.camera.getViewMatrix(true);

    this.hands.update(dt, this.input, this.lastMovementSnapshot);
    this.catching.update(dt, this.input, this.lastMovementSnapshot);
    this.hands.updateHeldVisuals();

    if (this.input.wasKeyPressed(CONTROL_KEYS.reset)) {
      this.resetPosition();
    }
  }

  resetPosition(): void {
    this.root.position.set(0, 0, -12);
    this.movement.velocity.setAll(0);
  }

  // Mouse look runs once per render frame so aiming stays smooth and low-latency regardless of
  // refresh rate. consumeMouseDelta drains all movement since the last frame (no smoothing, so
  // no added input delay). Yaw rotates the body root; pitch tilts the camera (clamped).
  private updateLook(): void {
    const { dx, dy } = this.input.consumeMouseDelta();
    this.yaw += dx * this.mouseSensitivity;
    this.pitch += dy * this.mouseSensitivity;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    this.root.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.y = 0;
    this.camera.rotation.z = 0;
  }
}
