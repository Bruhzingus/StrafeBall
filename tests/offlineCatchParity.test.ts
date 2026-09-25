import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it, vi } from 'vitest';
import { GAME_CONSTANTS } from '../shared/constants';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { BallState } from '../src/game/ball/BallState';
import type { Effects } from '../src/game/effects/Effects';
import type { InputManager } from '../src/game/input/InputManager';
import { CollisionWorld } from '../src/game/map/Collider';
import { CatchController } from '../src/game/player/CatchController';
import type { DashController } from '../src/game/player/DashController';
import { HandController } from '../src/game/player/HandController';
import type { MovementController, MovementSnapshot } from '../src/game/player/MovementController';

function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera('catch_camera', new Vector3(0, GAME_CONSTANTS.player.eyeHeight, 0), scene);
  camera.rotation.y = Math.PI;
  camera.getViewMatrix(true);
  const manager = new BallManager({ scene } as ModelLoader, new CollisionWorld());
  const effects = {
    onCatchAttempt: vi.fn(),
    onCatch: vi.fn(),
    onParry: vi.fn()
  } as unknown as Effects;
  const hands = new HandController(camera, manager, effects);
  const movement = {
    addCatchRecoil: vi.fn(),
    addCatchBoost: vi.fn()
  } as unknown as MovementController;
  const dash = { addChargeFromHit: vi.fn() } as unknown as DashController;
  const catching = new CatchController(camera, manager, hands, movement, dash, effects);
  manager.setBallAdvanceHandler((ball, from, to) => catching.resolveAdvancedBall(ball, from, to));
  const movementSnapshot = {
    position: Vector3.Zero(),
    dashingThisFrame: false
  } as MovementSnapshot;
  const input = {
    pointerLocked: true,
    wasMousePressed: (button: number) => button === 0
  } as unknown as InputManager;
  return { engine, scene, camera, manager, effects, hands, movement, dash, catching, movementSnapshot, input };
}

describe('offline catch order', () => {
  it('opens the attempt before movement and catches on the ball’s actual swept path', () => {
    const rig = setup();
    try {
      const ball = new Ball(
        MeshBuilder.CreateSphere('incoming', { diameter: 0.3 }, rig.scene),
        new Vector3(0, GAME_CONSTANTS.player.eyeHeight, -3.3)
      );
      ball.throw('bot', new Vector3(0, 0, 20), false, 0);
      rig.manager.balls.push(ball);

      rig.catching.update(0.05, rig.input, rig.movementSnapshot);
      expect(rig.hands.left.ball).toBeNull(); // The click alone does not catch an out-of-range ball.
      rig.manager.update(0.05); // Its swept path now enters the shared catch range.

      expect(rig.hands.left.ball).toBe(ball);
      expect(ball.state).toBe(BallState.Held);
      expect(rig.movement.addCatchRecoil).toHaveBeenCalledWith(new Vector3(0, 0, 20));
      expect(rig.movement.addCatchBoost).toHaveBeenCalledOnce();
      expect(rig.dash.addChargeFromHit).toHaveBeenCalledOnce();
      expect(rig.effects.onCatch).toHaveBeenCalledOnce();
    } finally {
      rig.manager.clear();
      rig.scene.dispose();
      rig.engine.dispose();
    }
  });

  it('runs defense on the pre-collision segment and stops collision after a catch', () => {
    const rig = setup();
    try {
      const ball = new Ball(
        MeshBuilder.CreateSphere('wall_ball', { diameter: 0.3 }, rig.scene),
        new Vector3(0, GAME_CONSTANTS.player.eyeHeight, -GAME_CONSTANTS.map.halfLength + 0.5)
      );
      ball.throw('bot', new Vector3(0, 0, -20), false, 0);
      let segment: { from: Vector3; to: Vector3 } | null = null;
      ball.update(0.05, undefined, (advanced, from, to) => {
        segment = { from, to };
        advanced.setHeld('left');
      });

      expect(segment).not.toBeNull();
      expect(segment!.from.z).toBeCloseTo(-GAME_CONSTANTS.map.halfLength + 0.5);
      expect(segment!.to.z).toBeCloseTo(-GAME_CONSTANTS.map.halfLength - 0.5);
      expect(ball.mesh.position.z).toBeCloseTo(segment!.to.z);
      expect(ball.bounceCount).toBe(0);
      expect(ball.state).toBe(BallState.Held);
      ball.mesh.dispose();
    } finally {
      rig.scene.dispose();
      rig.engine.dispose();
    }
  });
});
