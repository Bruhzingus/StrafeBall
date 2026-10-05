import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { BallState } from '../src/game/ball/BallState';
import { shotLaneClear } from '../src/game/bot/OpponentCover';
import { PracticeOpponent } from '../src/game/bot/PracticeOpponent';
import { TUNING } from '../src/game/config/tuning';
import { CollisionWorld, type AABB } from '../src/game/map/Collider';

const STEP = 1 / 60;
const PLAYER_EYE = new Vector3(0, 1.55, -8);
const STANDING_MAT: AABB = {
  kind: 'mat', id: 'cover-mat', minX: -1.3, maxX: 1.3,
  minY: 0, maxY: 1.75, minZ: 5.4, maxZ: 5.6
};

function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const collision = new CollisionWorld([{ ...STANDING_MAT }]);
  const balls = new BallManager({ scene } as ModelLoader, collision);
  const opponent = new PracticeOpponent(scene, balls, {
    collision, position: new Vector3(2.5, 0, 9)
  });
  const addBall = (name: string, x: number, z: number) => {
    const position = new Vector3(x, TUNING.ball.radius, z);
    const ball = new Ball(MeshBuilder.CreateSphere(name, { diameter: TUNING.ball.radius * 2 }, scene), position);
    balls.balls.push(ball);
    return ball;
  };
  const exposed = () => shotLaneClear(PLAYER_EYE,
    opponent.feetPosition.add(new Vector3(0, 1, 0)), collision);
  return {
    opponent, collision, addBall, exposed,
    dispose() {
      opponent.dispose();
      balls.clear();
      scene.dispose();
      engine.dispose();
    }
  };
}

describe('practice opponent cover tactics', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('hides from an armed player, peeks to fire, then hides and attacks from the other side', () => {
    const rig = setup();
    try {
      rig.addBall('first', 2.5, 9);
      rig.addBall('second', 2.9, 9);
      expect(rig.exposed()).toBe(true);
      rig.opponent.update(STEP, PLAYER_EYE);
      expect(rig.opponent.heldBallCount).toBe(1);
      rig.opponent.dash.charges = 1;
      rig.opponent.update(STEP, PLAYER_EYE);
      expect(rig.opponent.heldBallCount).toBe(2);

      const playerBall = rig.addBall('player-held', 0, -8);
      playerBall.setHeld('left');
      expect(playerBall.state).toBe(BallState.Held);

      let hidBeforeFiring = false;
      let hidAfterFirstShot = false;
      const shots: Vector3[] = [];
      for (let frame = 0; frame < 900 && shots.length < 2; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        const position = rig.opponent.feetPosition;
        expect(position.z).toBeGreaterThan(0.8);
        if (!rig.exposed()) {
          if (shots.length === 0) hidBeforeFiring = true;
          if (shots.length === 1) hidAfterFirstShot = true;
        }
        if (event.threw) {
          expect(rig.exposed()).toBe(true);
          shots.push(position);
        }
      }

      expect(hidBeforeFiring).toBe(true);
      expect(shots).toHaveLength(2);
      expect(hidAfterFirstShot).toBe(true);
      expect(shots[0].x).toBeGreaterThan(STANDING_MAT.maxX);
      expect(shots[1].x).toBeLessThan(STANDING_MAT.minX);
    } finally {
      rig.dispose();
    }
  });

  it('leaves invalid cover and resumes open-court throwing when the mat is disabled', () => {
    const rig = setup();
    try {
      rig.addBall('bot-held', 2.5, 9);
      rig.opponent.update(STEP, PLAYER_EYE);
      expect(rig.opponent.heldBallCount).toBe(1);
      const playerBall = rig.addBall('player-held', 0, -8);
      playerBall.setHeld('left');
      rig.opponent.dash.charges = 1;

      let hid = false;
      for (let frame = 0; frame < 100; frame += 1) {
        expect(rig.opponent.update(STEP, PLAYER_EYE).threw).toBe(false);
        hid ||= !rig.exposed();
      }
      expect(hid).toBe(true);
      expect(rig.opponent.heldBallCount).toBe(1);

      rig.collision.boxes[0].enabled = false;
      let threw = false;
      for (let frame = 0; frame < 360 && !threw; frame += 1) {
        threw = rig.opponent.update(STEP, PLAYER_EYE).threw;
      }
      expect(threw).toBe(true);
      expect(rig.opponent.heldBallCount).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});
