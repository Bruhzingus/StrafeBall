import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { BallState } from '../src/game/ball/BallState';
import { PracticeOpponent, type PracticeOpponentBounds } from '../src/game/bot/PracticeOpponent';
import { TUNING } from '../src/game/config/tuning';
import { CollisionWorld, type AABB } from '../src/game/map/Collider';

const STEP = 1 / 60;
const PLAYER_EYE = new Vector3(0, 1.55, -8);
const BOUNDS: PracticeOpponentBounds = {
  minX: -5, maxX: 5, minZ: 1, maxZ: 12, ownSideMinZ: 1, floorY: 0
};

function mat(minX: number, maxX: number, minZ: number, maxZ: number): AABB {
  return { minX, maxX, minY: 0, maxY: 1.7, minZ, maxZ, kind: 'mat' };
}

function setup(position: Vector3, bounds: PracticeOpponentBounds,
  collision = new CollisionWorld(), botCollision = true) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const balls = new BallManager({ scene } as ModelLoader, collision);
  const opponent = new PracticeOpponent(scene, balls,
    { position, bounds, collision: botCollision ? collision : undefined });
  const addBall = (name: string, x: number, z: number) => {
    const position = new Vector3(x, TUNING.ball.radius, z);
    const ball = new Ball(MeshBuilder.CreateSphere(name, { diameter: TUNING.ball.radius * 2 }, scene), position);
    balls.balls.push(ball);
    return ball;
  };
  const dispose = () => {
    opponent.dispose();
    balls.clear();
    scene.dispose();
    engine.dispose();
  };
  return { opponent, balls, addBall, dispose };
}

describe('practice opponent integrated navigation', () => {
  it('picks up a ball resting against cover without trying to walk its body into the mat', () => {
    const rig = setup(new Vector3(0, 0, 9), BOUNDS,
      new CollisionWorld([mat(-1.3, 1.3, 5.4, 5.6)]));
    try {
      const ball = rig.addBall('near-mat', 0, 5.9);
      for (let frame = 0; frame < 360 && !rig.opponent.isHoldingBall; frame += 1) {
        rig.opponent.update(STEP, PLAYER_EYE);
      }
      expect(ball.state).toBe(BallState.Held);
      expect(rig.opponent.feetPosition.z).toBeGreaterThan(5.98);
    } finally {
      rig.dispose();
    }
  });

  it('reaches a ball through staggered cover without clipping mats or leaving its half', () => {
    const obstacles = [
      mat(-2, 1, 7.2, 8.2),
      mat(-1, 2, 4.7, 5.7),
      mat(-4.3, -3.2, 5.7, 7.1)
    ];
    const rig = setup(new Vector3(0, 0, 10.5), BOUNDS, new CollisionWorld(obstacles));
    try {
      const ball = rig.addBall('through-cover', 0, 2.5);
      let routedLaterally = false;
      for (let frame = 0; frame < 900 && !rig.opponent.isHoldingBall; frame += 1) {
        rig.opponent.update(STEP, PLAYER_EYE);
        const feet = rig.opponent.feetPosition;
        expect(feet.x).toBeGreaterThanOrEqual(BOUNDS.minX + 0.38);
        expect(feet.x).toBeLessThanOrEqual(BOUNDS.maxX - 0.38);
        expect(feet.z).toBeGreaterThanOrEqual(BOUNDS.minZ + 0.38);
        expect(feet.z).toBeLessThanOrEqual(BOUNDS.maxZ - 0.38);
        for (const box of obstacles) {
          const inside = feet.x > box.minX - 0.38 && feet.x < box.maxX + 0.38 &&
            feet.z > box.minZ - 0.38 && feet.z < box.maxZ + 0.38;
          expect(inside).toBe(false);
        }
        routedLaterally ||= Math.abs(feet.x) > 1.4;
      }
      expect(routedLaterally).toBe(true);
      expect(rig.opponent.isHoldingBall).toBe(true);
      expect(ball.state).toBe(BallState.Held);
    } finally {
      rig.dispose();
    }
  });

  it('chooses a farther reachable ball over a nearer ball behind a sealed mat', () => {
    const rig = setup(new Vector3(0, 0, 10), BOUNDS,
      new CollisionWorld([mat(-5, 5, 6.5, 7.5)]));
    try {
      const blocked = rig.addBall('near-but-blocked', 0, 5.7);
      const reachable = rig.addBall('far-but-reachable', 4.4, 10);
      for (let frame = 0; frame < 360 && !rig.opponent.isHoldingBall; frame += 1) {
        rig.opponent.update(STEP, PLAYER_EYE);
      }
      expect(reachable.state).toBe(BallState.Held);
      expect(blocked.state).toBe(BallState.Loose);
      expect(rig.opponent.feetPosition.z).toBeGreaterThan(7.88);
    } finally {
      rig.dispose();
    }
  });

  it('keeps extra stamina in reserve for an armed player while pursuing distant ammunition', () => {
    const bounds: PracticeOpponentBounds = {
      minX: -9.5, maxX: 9.5, minZ: 0.8, maxZ: 16.5, ownSideMinZ: 0.65, floorY: 0
    };
    const rig = setup(new Vector3(0, 0, 14), bounds, new CollisionWorld(), false);
    try {
      rig.addBall('distant-ammo', 8, 2);
      for (const [index, x] of [[0, -3], [1, -2]] as const) {
        const held = rig.addBall(`player-held-${index}`, x, -4);
        held.state = BallState.Held;
        held.owner = 'player';
      }
      let travelDashes = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        if (rig.opponent.update(STEP, PLAYER_EYE).dashed) travelDashes += 1;
        expect(rig.opponent.dash.charges).toBeGreaterThanOrEqual(2);
      }
      expect(travelDashes).toBe(1);
      expect(rig.opponent.feetPosition.z).toBeLessThan(12);
    } finally {
      rig.dispose();
    }
  });

  it('walks into a narrow bend before considering a dash', () => {
    const obstacle = mat(-1, 1, 5.5, 6.5);
    const rig = setup(new Vector3(0, 0, 9), BOUNDS, new CollisionWorld([obstacle]));
    try {
      rig.addBall('behind-bend', 0, 3);
      for (let frame = 0; frame < 30; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        const feet = rig.opponent.feetPosition;
        expect(event.dashed).toBe(false);
        expect(feet.x > obstacle.minX - 0.38 && feet.x < obstacle.maxX + 0.38 &&
          feet.z > obstacle.minZ - 0.38 && feet.z < obstacle.maxZ + 0.38).toBe(false);
      }
      expect(Math.abs(rig.opponent.feetPosition.x)).toBeGreaterThan(0.3);
      expect(rig.opponent.dash.charges).toBe(rig.opponent.dash.maxCharges);
    } finally {
      rig.dispose();
    }
  });
});
