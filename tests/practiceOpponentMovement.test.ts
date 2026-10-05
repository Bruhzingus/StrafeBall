import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { PracticeOpponent } from '../src/game/bot/PracticeOpponent';
import { TUNING } from '../src/game/config/tuning';
import { CollisionWorld } from '../src/game/map/Collider';

const STEP = 1 / 60;
const PLAYER_EYE = new Vector3(0, 1.55, -8);

function setup(collision = new CollisionWorld()) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const balls = new BallManager({ scene } as ModelLoader, collision);
  const opponent = new PracticeOpponent(scene, balls, { collision });
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
  return { balls, opponent, addBall, dispose };
}

describe('practice opponent movement', () => {
  it('lands on cover after a shock launch and can move off it without getting trapped', () => {
    const collision = new CollisionWorld([{
      minX: -1, maxX: 1, minY: 0, maxY: 1, minZ: 14.5, maxZ: 16.5, kind: 'mat'
    }]);
    const rig = setup(collision);
    try {
      rig.opponent.applyPowerupBlast('shock', new Vector3(0, 0.9, 8));
      let landedOnCover = false;
      for (let frame = 0; frame < 180; frame += 1) {
        rig.opponent.update(STEP, PLAYER_EYE);
        const feet = rig.opponent.feetPosition;
        if (Math.abs(feet.x) <= 1.38 && feet.z >= 14.12) {
          const height = rig.opponent.mesh.position.y - 0.92;
          expect(height).toBeGreaterThanOrEqual(1 - 1e-6);
          landedOnCover ||= Math.abs(height - 1) < 1e-6;
        }
      }
      expect(landedOnCover).toBe(true);
      expect(rig.opponent.feetPosition.z).toBeLessThan(14.12);
    } finally {
      rig.dispose();
    }
  });

  it('patrols laterally without ammunition while staying on its own half and saving stamina', () => {
    const rig = setup();
    try {
      rig.addBall('player-side-only', 0, -1);
      const start = rig.opponent.feetPosition;
      const charges = rig.opponent.dash.charges;
      let widestPatrol = 0;
      for (let frame = 0; frame < 180; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        const feet = rig.opponent.feetPosition;
        widestPatrol = Math.max(widestPatrol, Math.abs(feet.x - start.x));
        expect(feet.z).toBeGreaterThan(0.8);
        expect(event.dashed).toBe(false);
      }
      expect(widestPatrol).toBeGreaterThan(0.6);
      expect(rig.opponent.dash.charges).toBe(charges);
      expect(rig.opponent.isHoldingBall).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('carries a pursuit dash, spends one charge, then recharges while idle', () => {
    const rig = setup();
    try {
      const ball = rig.addBall('distant-ball', 8.5, 2);
      const initialCharges = rig.opponent.dash.charges;
      let dashed = false;
      for (let frame = 0; frame < 90 && !dashed; frame += 1) {
        dashed = rig.opponent.update(STEP, PLAYER_EYE).dashed;
      }
      expect(dashed).toBe(true);
      expect(rig.opponent.dash.charges).toBe(initialCharges - 1);

      const afterDash = rig.opponent.feetPosition;
      rig.opponent.update(STEP, PLAYER_EYE);
      const carriedDistance = Vector3.Distance(afterDash, rig.opponent.feetPosition);
      expect(carriedDistance).toBeGreaterThan(4.8 * STEP * 1.3);

      rig.balls.removeBall(ball);
      for (let frame = 0; frame < 210; frame += 1) rig.opponent.update(STEP, PLAYER_EYE);
      expect(rig.opponent.dash.charges).toBe(initialCharges);
    } finally {
      rig.dispose();
    }
  });

  it('walks after reaching the reserved defensive stamina charge', () => {
    const rig = setup();
    try {
      rig.addBall('distant-ball', 8.5, 2);
      rig.opponent.dash.charges = 1;
      const start = rig.opponent.feetPosition;
      for (let frame = 0; frame < 54; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        expect(event.dashed).toBe(false);
        expect(rig.opponent.dash.charges).toBe(1);
      }
      expect(Vector3.Distance(start, rig.opponent.feetPosition)).toBeGreaterThan(2);
      expect(rig.opponent.feetPosition.z).toBeGreaterThan(0.8);
    } finally {
      rig.dispose();
    }
  });
});
