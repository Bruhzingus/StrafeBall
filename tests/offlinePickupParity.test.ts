import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { CollisionWorld } from '../src/game/map/Collider';

describe('offline pickup selection', () => {
  it('uses the server’s root-relative pickup shape and 3D nearest-ball order', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const manager = new BallManager({ scene } as ModelLoader, new CollisionWorld());
    const add = (name: string, position: Vector3): Ball => {
      const ball = new Ball(MeshBuilder.CreateSphere(name, { diameter: 0.3 }, scene), position);
      manager.balls.push(ball);
      return ball;
    };

    try {
      const root = Vector3.Zero();
      const nearestToWaist = add('high', new Vector3(0.2, 1.1, 0));
      const nearestToRoot = add('low', new Vector3(0.8, 0.1, 0));
      expect(manager.findPickupCandidate(root)).toBe(nearestToRoot);

      // Within the shared horizontal radius but outside the former waist-centered sphere.
      manager.balls.splice(manager.balls.indexOf(nearestToRoot), 1);
      manager.balls.splice(manager.balls.indexOf(nearestToWaist), 1);
      const edge = add('edge', new Vector3(1.85, 0.1, 0));
      expect(manager.findPickupCandidate(root)).toBe(edge);

      // An overhead ball passes a waist-centered sphere yet exceeds the shared vertical limit.
      manager.balls.splice(manager.balls.indexOf(edge), 1);
      add('too_high', new Vector3(0, 1.3, 0));
      expect(manager.findPickupCandidate(root)).toBeNull();

      const grenade = add('grenade', new Vector3(0.2, 0.2, 0));
      grenade.powerupKind = 'shock';
      expect(manager.findPickupCandidate(root)).toBeNull();
    } finally {
      for (const mesh of scene.meshes) mesh.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
