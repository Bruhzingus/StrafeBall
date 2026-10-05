import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { createBallState, settleBallIfSlow } from '../shared/simulation/BallSim';
import type { AABB } from '../shared/simulation/MapGeometry';
import { Ball } from '../src/game/ball/Ball';
import { BallState } from '../src/game/ball/BallState';

describe('ball settling', () => {
  it.each([0, 0.1, -0.1])('keeps a dead ball airborne at vertical speed %s', (vy) => {
    const ball = createBallState('apex', { x: 0, y: 2, z: 0 }, {
      phase: 'dead', velocity: { x: 0, y: vy, z: 0 }
    });
    expect(settleBallIfSlow(ball).phase).toBe('dead');
  });

  it('settles a slow ball resting on the floor', () => {
    const ball = createBallState('floor', { x: 0, y: C.ball.radius, z: 0 }, { phase: 'dead' });
    expect(settleBallIfSlow(ball).phase).toBe('loose');
  });

  it('settles on a box top, but keeps falling beside or above it', () => {
    const box: AABB = { minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1 };
    const onTop = createBallState('cover', { x: 0, y: 2 + C.ball.radius, z: 0 }, { phase: 'dead' });
    expect(settleBallIfSlow(onTop, C, [box]).phase).toBe('loose');
    expect(settleBallIfSlow({ ...onTop, position: { ...onTop.position, x: 3 } }, C, [box]).phase).toBe('dead');
    expect(settleBallIfSlow({ ...onTop, position: { ...onTop.position, y: 2.5 } }, C, [box]).phase).toBe('dead');
  });

  it('keeps an offline ball in flight at a bounce apex', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const ball = new Ball(MeshBuilder.CreateSphere('apex', {}, scene), new Vector3(0, 2, 0));
      ball.state = BallState.Dead;
      ball.velocity.y = C.ball.gravity / 256;
      ball.update(1 / 256);
      expect(ball.state).toBe(BallState.Dead);
      for (let i = 0; i < 256; i++) ball.update(1 / 256);
      expect(ball.mesh.position.y).toBeLessThan(1);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
