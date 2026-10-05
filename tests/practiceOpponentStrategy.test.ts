import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { BallState } from '../src/game/ball/BallState';
import { PracticeOpponent, type PracticeOpponentBallEvent } from '../src/game/bot/PracticeOpponent';
import { TUNING } from '../src/game/config/tuning';
import { CollisionWorld } from '../src/game/map/Collider';

const STEP = 1 / 60;
const PLAYER_EYE = new Vector3(0, 1.55, -8);

function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const balls = new BallManager({ scene } as ModelLoader, new CollisionWorld());
  const opponent = new PracticeOpponent(scene, balls);
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

function collectPair(rig: ReturnType<typeof setup>): [Ball, Ball] {
  const first = rig.addBall('first', new Vector3(0, TUNING.ball.radius, 9));
  const second = rig.addBall('second', new Vector3(0.7, TUNING.ball.radius, 9));
  for (let frame = 0; frame < 90 && rig.opponent.heldBallCount < 2; frame += 1) {
    expect(rig.opponent.update(STEP, PLAYER_EYE).threw).toBe(false);
  }
  expect(rig.opponent.heldBallCount).toBe(2);
  return [first, second];
}

describe('practice opponent ball strategy', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('collects two nearby balls into different hands, leaves a third, and repositions before throwing', () => {
    const rig = setup();
    try {
      const third = rig.addBall('third', new Vector3(1.3, TUNING.ball.radius, 9));
      const [first, second] = collectPair(rig);
      expect([first, second, third].filter((ball) => ball.state === BallState.Held)).toHaveLength(2);
      expect(third.state).toBe(BallState.Loose);
      expect(new Set([first.heldHand, second.heldHand])).toEqual(new Set(['left', 'right']));

      const start = rig.opponent.feetPosition;
      let moved = 0;
      for (let frame = 0; frame < 30; frame += 1) {
        expect(rig.opponent.update(STEP, PLAYER_EYE).threw).toBe(false);
        moved = Math.max(moved, Vector3.Distance(start, rig.opponent.feetPosition));
        expect(rig.opponent.heldBallCount).toBe(2);
      }
      expect(moved).toBeGreaterThan(0.1);
    } finally {
      rig.dispose();
    }
  });

  it('keeps the second ball after its first shot and spaces the follow-up throw', () => {
    const rig = setup();
    try {
      const pair = collectPair(rig);
      let firstShotFrame = -1;
      for (let frame = 0; frame < 300; frame += 1) {
        if (rig.opponent.update(STEP, PLAYER_EYE).threw) {
          firstShotFrame = frame;
          break;
        }
      }
      expect(firstShotFrame).toBeGreaterThanOrEqual(35);
      expect(rig.opponent.heldBallCount).toBe(1);
      expect(pair.filter((ball) => ball.state === BallState.Held)).toHaveLength(1);
      expect(pair.filter((ball) => ball.state === BallState.Live && ball.owner === 'bot')).toHaveLength(1);

      for (let frame = 0; frame < 36; frame += 1) {
        expect(rig.opponent.update(STEP, PLAYER_EYE).threw).toBe(false);
        expect(rig.opponent.heldBallCount).toBe(1);
      }
      let secondShot = false;
      for (let frame = 0; frame < 360 && !secondShot; frame += 1) {
        secondShot = rig.opponent.update(STEP, PLAYER_EYE).threw;
      }
      expect(secondShot).toBe(true);
      expect(rig.opponent.heldBallCount).toBe(0);
      expect(pair.every((ball) => ball.state === BallState.Live && ball.owner === 'bot')).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('sometimes chooses a single ball even when a second is nearby', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rig = setup();
    try {
      const first = rig.addBall('first', new Vector3(0, TUNING.ball.radius, 9));
      const second = rig.addBall('second', new Vector3(0.7, TUNING.ball.radius, 9));
      let firstShot = false;
      for (let frame = 0; frame < 300 && !firstShot; frame += 1) {
        firstShot = rig.opponent.update(STEP, PLAYER_EYE).threw;
        expect(rig.opponent.heldBallCount).toBeLessThanOrEqual(1);
      }
      expect(firstShot).toBe(true);
      expect(first.state).toBe(BallState.Live);
      expect(second.state).toBe(BallState.Loose);
    } finally {
      rig.dispose();
    }
  });

  it('catches a readable player throw with its free hand while carrying one ball', () => {
    const rig = setup();
    try {
      rig.opponent.setDifficulty('hard');
      rig.addBall('held', new Vector3(0, TUNING.ball.radius, 9));
      rig.opponent.update(STEP, PLAYER_EYE);
      expect(rig.opponent.heldBallCount).toBe(1);

      const incoming = rig.addBall('incoming', new Vector3(0, 1.55, 5.5));
      incoming.throw('player', new Vector3(0, 0, 10), false, 0);
      const events: PracticeOpponentBallEvent[] = [];
      rig.balls.setBallAdvanceObserver((ball, start, end) => {
        const event = rig.opponent.resolveAdvancedBall(ball, start, end);
        if (event) events.push(event);
      });
      for (let frame = 0; frame < 12 && events.length === 0; frame += 1) {
        rig.opponent.update(0.04, PLAYER_EYE);
        rig.balls.update(0.04);
      }
      expect(events.map((event) => event.kind)).toEqual(['catch']);
      expect(rig.opponent.heldBallCount).toBe(2);
      expect(incoming.state).toBe(BallState.Held);
      expect(incoming.heldHand).toBe('right');
    } finally {
      rig.dispose();
    }
  });

  it('drops both balls on reset and when switched off', () => {
    const rig = setup();
    try {
      const pair = collectPair(rig);
      rig.opponent.reset();
      expect(rig.opponent.heldBallCount).toBe(0);
      expect(pair.every((ball) => ball.state !== BallState.Held)).toBe(true);

      pair[0].reset(new Vector3(0, TUNING.ball.radius, 9));
      pair[1].reset(new Vector3(0.7, TUNING.ball.radius, 9));
      for (let frame = 0; frame < 90 && rig.opponent.heldBallCount < 2; frame += 1) {
        rig.opponent.update(STEP, PLAYER_EYE);
      }
      expect(rig.opponent.heldBallCount).toBe(2);
      rig.opponent.setEnabled(false);
      expect(rig.opponent.heldBallCount).toBe(0);
      expect(pair.every((ball) => ball.state !== BallState.Held)).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('drops both carried balls when hit by the player', () => {
    const rig = setup();
    try {
      const pair = collectPair(rig);
      const feet = rig.opponent.feetPosition;
      const incoming = rig.addBall('hit', new Vector3(feet.x, 1.55, feet.z - 1));
      incoming.throw('player', new Vector3(0, 0, 20), false, 0);
      const event = rig.opponent.resolveAdvancedBall(incoming,
        new Vector3(feet.x, 1.55, feet.z - 1), new Vector3(feet.x, 1.55, feet.z + 1));
      expect(event?.kind).toBe('hit');
      expect(rig.opponent.heldBallCount).toBe(0);
      expect(pair.every((ball) => ball.state !== BallState.Held)).toBe(true);
    } finally {
      rig.dispose();
    }
  });
});
