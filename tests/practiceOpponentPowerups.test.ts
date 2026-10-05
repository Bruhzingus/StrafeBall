import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { BallState } from '../src/game/ball/BallState';
import { PracticeOpponent, type PracticeOpponentPowerupContext } from '../src/game/bot/PracticeOpponent';
import { TUNING } from '../src/game/config/tuning';
import { CollisionWorld } from '../src/game/map/Collider';

const STEP = 1 / 60;
const PLAYER_EYE = new Vector3(0, 1.55, -8);
const NO_POWERUPS: PracticeOpponentPowerupContext = {
  speedActive: false, adrenalineActive: false, magnetActive: false, armorCount: 0
};

function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const balls = new BallManager({ scene } as ModelLoader, new CollisionWorld());
  const opponent = new PracticeOpponent(scene, balls, { collision: new CollisionWorld() });
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

describe('practice opponent powerup responses', () => {
  it('dodges an incoming cannonball instead of opening a catch', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const rig = setup();
    try {
      rig.opponent.setDifficulty('hard');
      const cannon = rig.addBall('cannon', new Vector3(0, 1.55, 5));
      cannon.powerupKind = 'cannon';
      cannon.throw('player', new Vector3(0, 0, 20), false, 0);
      const charges = rig.opponent.dash.charges;

      const first = rig.opponent.update(0.05, PLAYER_EYE);
      const second = rig.opponent.update(0.05, PLAYER_EYE);

      expect(first.dashed || second.dashed).toBe(true);
      expect(rig.opponent.dash.charges).toBeLessThan(charges);
      expect(rig.opponent.isHoldingBall).toBe(false);
    } finally {
      random.mockRestore();
      rig.dispose();
    }
  });

  it('moves away from an armed bomb before collecting nearby ammunition', () => {
    const rig = setup();
    try {
      const bomb = rig.addBall('armed-bomb', new Vector3(0, TUNING.ball.radius, 7.5));
      bomb.powerupKind = 'bomb';
      bomb.state = BallState.Dead;
      bomb.fuseSeconds = 1.5;
      const ammo = rig.addBall('ammo', new Vector3(0, TUNING.ball.radius, 9));
      const initialDistance = Vector3.Distance(rig.opponent.feetPosition, bomb.mesh.position);
      let dashed = false;
      for (let frame = 0; frame < 24; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        dashed ||= event.dashed;
      }

      expect(dashed).toBe(true);
      expect(Vector3.Distance(rig.opponent.feetPosition, bomb.mesh.position)).toBeGreaterThan(initialDistance + 1);
      expect(rig.opponent.isHoldingBall).toBe(false);
      expect(ammo.state).toBe(BallState.Loose);
      expect(rig.opponent.feetPosition.z).toBeGreaterThan(0);
    } finally {
      rig.dispose();
    }
  });

  it('stun prevents a travel dash and slows the opponent while it pursues a ball', () => {
    const normal = setup();
    const stunned = setup();
    try {
      normal.addBall('normal-ammo', new Vector3(0, TUNING.ball.radius, 2));
      stunned.addBall('stunned-ammo', new Vector3(0, TUNING.ball.radius, 2));
      expect(stunned.opponent.applyPowerupBlast('stun', new Vector3(0, 0.9, 9))).toBeNull();
      let normalDashed = false;
      let stunnedDashed = false;
      for (let frame = 0; frame < 45; frame += 1) {
        const normalEvent = normal.opponent.update(STEP, PLAYER_EYE);
        const stunnedEvent = stunned.opponent.update(STEP, PLAYER_EYE);
        normalDashed ||= normalEvent.dashed;
        stunnedDashed ||= stunnedEvent.dashed;
      }

      expect(normalDashed).toBe(true);
      expect(stunnedDashed).toBe(false);
      expect(stunned.opponent.dash.charges).toBeGreaterThan(normal.opponent.dash.charges);
      expect(stunned.opponent.feetPosition.z).toBeGreaterThan(normal.opponent.feetPosition.z + 1);
    } finally {
      normal.dispose();
      stunned.dispose();
    }
  });

  it('shock displaces and lifts the opponent without awarding a direct hit', () => {
    const rig = setup();
    try {
      const before = rig.opponent.feetPosition;
      expect(rig.opponent.applyPowerupBlast('shock', new Vector3(0, 0.9, 7))).toBeNull();
      rig.opponent.update(STEP, PLAYER_EYE);
      expect(rig.opponent.feetPosition.z).toBeGreaterThan(before.z);
      expect(rig.opponent.mesh.position.y).toBeGreaterThan(0.92);
    } finally {
      rig.dispose();
    }
  });

  it('counts bomb damage at the blast, while grenades never cause a direct hit', () => {
    for (const kind of ['bomb', 'shock', 'stun'] as const) {
      const rig = setup();
      try {
        const ball = rig.addBall(kind, new Vector3(0, 1.2, 9));
        ball.powerupKind = kind;
        ball.throw('player', new Vector3(0, 0, 20), false, 0);
        const contact = rig.opponent.resolveAdvancedBall(ball, new Vector3(0, 1.2, 8), new Vector3(0, 1.2, 10));
        const blast = rig.opponent.applyPowerupBlast(kind, new Vector3(0, 1, 9));

        expect(contact).toBeNull();
        expect(ball.state).toBe(BallState.Dead);
        expect(blast?.kind ?? null).toBe(kind === 'bomb' ? 'hit' : null);
      } finally {
        rig.dispose();
      }
    }
  });

  it('uses quick throws against armor and charged throws against speed or adrenaline', () => {
    const cases: Array<{ context: PracticeOpponentPowerupContext; expected: 'quick' | 'charged' }> = [
      { context: { ...NO_POWERUPS, armorCount: 2 }, expected: 'quick' },
      { context: { ...NO_POWERUPS, speedActive: true }, expected: 'charged' },
      { context: { ...NO_POWERUPS, adrenalineActive: true }, expected: 'charged' }
    ];
    for (const { context, expected } of cases) {
      const rig = setup();
      try {
        rig.addBall('ammo', new Vector3(0, TUNING.ball.radius, 9));
        let throwType: string | undefined;
        for (let frame = 0; frame < 240 && !throwType; frame += 1) {
          const event = rig.opponent.update(STEP, PLAYER_EYE, undefined, context);
          if (event.threw) throwType = event.throwType;
        }
        expect(throwType).toBe(expected);
      } finally {
        rig.dispose();
      }
    }
  });
});
