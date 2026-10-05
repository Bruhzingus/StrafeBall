import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { BallState } from '../src/game/ball/BallState';
import { PracticeOpponent, type PracticeOpponentBallEvent, type PracticeOpponentThrowType } from '../src/game/bot/PracticeOpponent';
import { TUNING } from '../src/game/config/tuning';
import { CollisionWorld } from '../src/game/map/Collider';

const PLAYER_EYE = new Vector3(0, 1.55, -8);
const STEP = 1 / 60;

function setup(collision = new CollisionWorld()) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const balls = new BallManager({ scene } as ModelLoader, collision);
  const opponent = new PracticeOpponent(scene, balls, { collision });
  const addBall = (name: string, position: Vector3) => {
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
  return { balls, opponent, addBall, dispose };
}

describe('practice opponent', () => {
  it('waits without ammunition on its half, even when a loose ball is nearer across center court', () => {
    const rig = setup();
    try {
      const playerSideBall = rig.addBall('player-side', new Vector3(0, TUNING.ball.radius, -1));
      const spawn = rig.opponent.feetPosition;
      for (let frame = 0; frame < 180; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        expect(event.threw).toBe(false);
      }
      expect(rig.opponent.feetPosition.z).toBeCloseTo(spawn.z, 1);
      expect(rig.opponent.isHoldingBall).toBe(false);
      expect(playerSideBall.state).toBe(BallState.Loose);
    } finally {
      rig.dispose();
    }
  });

  it('moves to and picks up a settled ball on its own half without taking one from the player half', () => {
    const rig = setup();
    try {
      const playerSideBall = rig.addBall('player-side', new Vector3(0, TUNING.ball.radius, -0.5));
      const ownSideBall = rig.addBall('own-side', new Vector3(0, TUNING.ball.radius, 5));
      let closestZ = Number.POSITIVE_INFINITY;
      for (let frame = 0; frame < 240 && !rig.opponent.isHoldingBall; frame += 1) {
        rig.opponent.update(STEP, PLAYER_EYE);
        closestZ = Math.min(closestZ, rig.opponent.feetPosition.z);
        expect(rig.opponent.feetPosition.z).toBeGreaterThan(0);
      }
      expect(closestZ).toBeLessThan(8);
      expect(rig.opponent.isHoldingBall).toBe(true);
      expect(ownSideBall.state).toBe(BallState.Held);
      expect(ownSideBall.owner).toBe('bot');
      expect(playerSideBall.state).toBe(BallState.Loose);
    } finally {
      rig.dispose();
    }
  });

  it('stops acting when switched off and releases a held ball', () => {
    const rig = setup();
    try {
      const ball = rig.addBall('toggle-ammo', new Vector3(0, TUNING.ball.radius, 9));
      rig.opponent.setEnabled(false);
      for (let frame = 0; frame < 120; frame += 1) {
        expect(rig.opponent.update(STEP, PLAYER_EYE).threw).toBe(false);
      }
      expect(ball.state).toBe(BallState.Loose);
      expect(rig.opponent.isHoldingBall).toBe(false);

      rig.opponent.setEnabled(true);
      rig.opponent.update(STEP, PLAYER_EYE);
      expect(rig.opponent.isHoldingBall).toBe(true);
      rig.opponent.setEnabled(false);
      expect(rig.opponent.isHoldingBall).toBe(false);
      expect(ball.state).not.toBe(BallState.Held);
    } finally {
      rig.dispose();
    }
  });

  it('routes around standing cover to reach a ball while remaining on its half', () => {
    const collision = new CollisionWorld([{
      minX: -1, maxX: 1, minY: 0, maxY: 1.6, minZ: 5.4, maxZ: 6.6, kind: 'mat'
    }]);
    const rig = setup(collision);
    try {
      const ball = rig.addBall('behind-cover', new Vector3(0, TUNING.ball.radius, 3));
      let wentAround = false;
      for (let frame = 0; frame < 600 && !rig.opponent.isHoldingBall; frame += 1) {
        rig.opponent.update(STEP, PLAYER_EYE);
        const pos = rig.opponent.feetPosition;
        expect(pos.z).toBeGreaterThan(0.8);
        if (Math.abs(pos.x) > 1.4) wentAround = true;
      }
      expect(wentAround).toBe(true);
      expect(rig.opponent.isHoldingBall).toBe(true);
      expect(ball.state).toBe(BallState.Held);
    } finally {
      rig.dispose();
    }
  });

  it('counts a swept player throw as a hit when it reaches the opponent before a catch can open', () => {
    const rig = setup();
    try {
      const ball = rig.addBall('fast-player-throw', new Vector3(0, 1.55, 7));
      ball.throw('player', new Vector3(0, 0, 40), false, 0);
      const events: PracticeOpponentBallEvent[] = [];
      rig.balls.setBallAdvanceObserver((advanced, start, end) => {
        const event = rig.opponent.resolveAdvancedBall(advanced, start, end);
        if (event) events.push(event);
      });

      rig.opponent.update(0.05, PLAYER_EYE);
      rig.balls.update(0.05);

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('hit');
      expect(ball.state).toBe(BallState.Dead);
    } finally {
      rig.dispose();
    }
  });

  it('catches a readable incoming throw on its swept path and keeps it instead of taking a hit', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const rig = setup();
    try {
      rig.opponent.setDifficulty('hard');
      const ball = rig.addBall('readable-player-throw', new Vector3(0, 1.55, 5.5));
      ball.throw('player', new Vector3(0, 0, 10), false, 0);
      const events: PracticeOpponentBallEvent[] = [];
      rig.balls.setBallAdvanceObserver((advanced, start, end) => {
        const event = rig.opponent.resolveAdvancedBall(advanced, start, end);
        if (event) events.push(event);
      });

      for (let frame = 0; frame < 10 && events.length === 0; frame += 1) {
        rig.opponent.update(0.04, PLAYER_EYE);
        rig.balls.update(0.04);
      }

      expect(events.map((event) => event.kind)).toEqual(['catch']);
      expect(ball.state).toBe(BallState.Held);
      expect(ball.owner).toBe('bot');
      expect(rig.opponent.isHoldingBall).toBe(true);
    } finally {
      random.mockRestore();
      rig.dispose();
    }
  });

  it('uses quick, charged, curve, and backflip throws when repeatedly supplied with balls', () => {
    const rig = setup();
    try {
      const ball = rig.addBall('repeat-ammo', new Vector3(0, TUNING.ball.radius, 9));
      const types = new Set<PracticeOpponentThrowType>();
      let sawBackflip = false;
      let backflipBallWasSuper = false;

      for (let pickup = 0; pickup < 8 && types.size < 4; pickup += 1) {
        let threw = false;
        for (let frame = 0; frame < 300 && !threw; frame += 1) {
          const event = rig.opponent.update(STEP, PLAYER_EYE);
          sawBackflip ||= event.backflipped;
          if (event.threw) {
            threw = true;
            types.add(event.throwType!);
            if (event.throwType === 'backflip') backflipBallWasSuper = ball.isSuper;
          }
          expect(rig.opponent.feetPosition.z).toBeGreaterThan(0);
        }
        expect(threw).toBe(true);
        const feet = rig.opponent.feetPosition;
        ball.reset(new Vector3(feet.x, TUNING.ball.radius, feet.z));
      }

      expect(types).toEqual(new Set<PracticeOpponentThrowType>(['quick', 'charged', 'curve', 'backflip']));
      expect(sawBackflip).toBe(true);
      expect(backflipBallWasSuper).toBe(true);
    } finally {
      rig.dispose();
    }
  });
});
