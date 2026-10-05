import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { BallState } from '../src/game/ball/BallState';
import { PracticeOpponent, type PracticeOpponentPlayerObservation } from '../src/game/bot/PracticeOpponent';
import { TUNING } from '../src/game/config/tuning';
import { CollisionWorld } from '../src/game/map/Collider';

const STEP = 1 / 60;
const PLAYER_EYE = new Vector3(0, 1.55, -8);
const IDLE: PracticeOpponentPlayerObservation = { catching: false, charging: false, dashing: false };

function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const collision = new CollisionWorld();
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
  return { opponent, addBall, dispose };
}

function advance(opponent: PracticeOpponent, frames: number, observation: PracticeOpponentPlayerObservation = IDLE,
  eye = PLAYER_EYE): void {
  for (let frame = 0; frame < frames; frame += 1) opponent.update(STEP, eye, undefined, undefined, observation);
}

describe('practice opponent tactical reads', () => {
  it('shows a feint, retains the ball, then winds up and makes a real throw', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const rig = setup();
    try {
      const ball = rig.addBall('feint-ball', new Vector3(0, TUNING.ball.radius, 9));
      let sawWindup = false;
      let feinted = false;
      let windupHeight = 0;
      for (let frame = 0; frame < 180 && !feinted; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        sawWindup ||= rig.opponent.attackPhase === 'windup';
        if (rig.opponent.attackPhase === 'windup') windupHeight = Math.max(windupHeight, ball.mesh.position.y);
        feinted = event.feinted === true;
        if (feinted) {
          expect(event.threw).toBe(false);
          expect(rig.opponent.attackPhase).toBe('feint');
          expect(rig.opponent.heldBallCount).toBe(1);
          expect(ball.state).toBe(BallState.Held);
        }
      }
      expect(sawWindup).toBe(true);
      expect(feinted).toBe(true);
      expect(windupHeight).toBeGreaterThan(1.1);

      let rewound = false;
      let threw = false;
      for (let frame = 0; frame < 180 && !threw; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        if (frame === 10) expect(ball.mesh.position.y).toBeLessThan(windupHeight - 0.15);
        if (rig.opponent.attackPhase === 'windup') rewound = true;
        if (event.threw) {
          threw = true;
          expect(ball.state).toBe(BallState.Live);
          expect(ball.owner).toBe('bot');
        }
      }
      expect(rewound).toBe(true);
      expect(threw).toBe(true);
    } finally {
      random.mockRestore();
      rig.dispose();
    }
  });

  it('can bite on a visible charge, then a canceled charge leaves its catch on cooldown', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const rig = setup();
    try {
      const charging = { ...IDLE, charging: true };
      advance(rig.opponent, 40, charging); // perception delay plus the sustained windup read
      const eye = rig.opponent.feetPosition.add(new Vector3(0, 1.55, 0));
      const immediate = rig.addBall('windup-throw', eye.add(new Vector3(0, 0, -2)));
      immediate.throw('player', new Vector3(0, 0, 10), false, 0);
      expect(rig.opponent.resolveAdvancedBall(immediate,
        eye.add(new Vector3(0, 0, -2)), eye.add(new Vector3(0, 0, 2)))?.kind).toBe('catch');

      // Reset the encounter so the same windup is canceled before the actual throw.
      rig.opponent.reset();
      advance(rig.opponent, 40, charging);
      advance(rig.opponent, 16, IDLE); // catch window has closed; cooldown has not
      const laterEye = rig.opponent.feetPosition.add(new Vector3(0, 1.55, 0));
      const late = rig.addBall('after-feint-throw', laterEye.add(new Vector3(0, 0, -2)));
      late.throw('player', new Vector3(0, 0, 10), false, 0);
      expect(rig.opponent.resolveAdvancedBall(late,
        laterEye.add(new Vector3(0, 0, -2)), laterEye.add(new Vector3(0, 0, 2)))?.kind).toBe('hit');
    } finally {
      random.mockRestore();
      rig.dispose();
    }
  });

  it('holds a pressure follow-up until it sees a dodge, then retargets the moving player', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const rig = setup();
    try {
      const first = rig.addBall('first-hand', new Vector3(0, TUNING.ball.radius, 9));
      const second = rig.addBall('second-hand', new Vector3(0.4, TUNING.ball.radius, 9));
      let openerFrame = -1;
      for (let frame = 0; frame < 180; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        if (event.threw) { openerFrame = frame; break; }
      }
      expect(openerFrame).toBeGreaterThanOrEqual(0);
      expect(rig.opponent.heldBallCount).toBe(1);
      expect(first.state === BallState.Live || second.state === BallState.Live).toBe(true);

      // The opener remains in flight: a pressure follow-up waits for a visible response.
      for (let frame = 0; frame < 58; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE, undefined, undefined, IDLE);
        expect(event.threw).toBe(false);
      }
      const newEye = new Vector3(3, 1.55, -8);
      let followupFrame = -1;
      for (let frame = 0; frame < 22; frame += 1) {
        const event = rig.opponent.update(STEP, newEye, undefined, undefined,
          frame < 12 ? { ...IDLE, dashing: true } : IDLE);
        if (event.threw) { followupFrame = frame; break; }
      }
      expect(followupFrame).toBeGreaterThanOrEqual(0);
      expect(rig.opponent.heldBallCount).toBe(0);
      const lastShot = first.state === BallState.Live && second.state === BallState.Live
        ? second : first.state === BallState.Live ? first : second;
      expect(lastShot.velocity.x).toBeGreaterThan(0);
    } finally {
      random.mockRestore();
      rig.dispose();
    }
  });

  it('reserves the second hand for a later shot when stamina is scarce', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const rig = setup();
    try {
      rig.opponent.dash.charges = 1;
      rig.addBall('opening-ball', new Vector3(0, TUNING.ball.radius, 9));
      rig.addBall('reserve-ball', new Vector3(0.4, TUNING.ball.radius, 9));
      let openerFrame = -1;
      for (let frame = 0; frame < 240; frame += 1) {
        if (rig.opponent.update(STEP, PLAYER_EYE).threw) { openerFrame = frame; break; }
      }
      expect(openerFrame).toBeGreaterThanOrEqual(0);
      expect(rig.opponent.heldBallCount).toBe(1);
      for (let frame = 0; frame < 90; frame += 1) {
        expect(rig.opponent.update(STEP, PLAYER_EYE).threw).toBe(false);
      }
      let followup = false;
      for (let frame = 0; frame < 180 && !followup; frame += 1) {
        followup = rig.opponent.update(STEP, PLAYER_EYE).threw;
      }
      expect(followup).toBe(true);
    } finally {
      random.mockRestore();
      rig.dispose();
    }
  });

  it('restores one stamina charge only for its own successful throw and only once', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const rig = setup();
    try {
      const ownBall = rig.addBall('own-throw', new Vector3(0, TUNING.ball.radius, 9));
      const unrelated = rig.addBall('unrelated-throw', new Vector3(0, TUNING.ball.radius, -2));
      let threw = false;
      for (let frame = 0; frame < 180 && !threw; frame += 1) {
        threw = rig.opponent.update(STEP, PLAYER_EYE).threw;
      }
      expect(threw).toBe(true);
      expect(ownBall.state).toBe(BallState.Live);
      rig.opponent.dash.charges = 1;
      rig.opponent.notifyBallHitPlayer(unrelated);
      expect(rig.opponent.dash.charges).toBe(1);
      rig.opponent.notifyBallHitPlayer(ownBall);
      expect(rig.opponent.dash.charges).toBe(2);
      rig.opponent.notifyBallHitPlayer(ownBall);
      expect(rig.opponent.dash.charges).toBe(2);
    } finally {
      random.mockRestore();
      rig.dispose();
    }
  });
});
