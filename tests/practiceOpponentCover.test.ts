import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { BallState } from '../src/game/ball/BallState';
import { shotTrajectoryClear } from '../src/game/bot/OpponentCover';
import { PracticeOpponent } from '../src/game/bot/PracticeOpponent';
import { TUNING } from '../src/game/config/tuning';
import { CollisionWorld, type AABB } from '../src/game/map/Collider';

const STEP = 1 / 60;
const PLAYER_EYE = new Vector3(0, 1.55, -8);

function setup(boxes: AABB[]) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const collision = new CollisionWorld(boxes);
  const balls = new BallManager({ scene } as ModelLoader, collision);
  const opponent = new PracticeOpponent(scene, balls, { collision });
  const ball = new Ball(MeshBuilder.CreateSphere('cover-ammo', { diameter: TUNING.ball.radius * 2 }, scene),
    new Vector3(0, TUNING.ball.radius, 9));
  balls.balls.push(ball);
  return {
    ball, collision, opponent,
    dispose() {
      opponent.dispose();
      balls.clear();
      scene.dispose();
      engine.dispose();
    }
  };
}

describe('practice opponent cover decisions', () => {
  it('keeps its ball while a standing barrier covers every lane from its own half', () => {
    // The barrier reaches across the court and starts inside the bot's legal half. The bot cannot
    // step in front of it or get an unobstructed chest-height shot from behind it.
    const rig = setup([{
      kind: 'mat', id: 'unbroken-cover',
      minX: -11, maxX: 11, minY: 0, maxY: 3, minZ: 0.5, maxZ: 2.5
    }]);
    try {
      for (let frame = 0; frame < 600; frame += 1) {
        expect(rig.opponent.update(STEP, PLAYER_EYE).threw).toBe(false);
        expect(rig.opponent.feetPosition.z).toBeGreaterThan(0);
      }
      expect(rig.opponent.isHoldingBall).toBe(true);
      expect(rig.ball.state).toBe(BallState.Held);

      // A knocked-down or removed mat must release the waiting bot without a reset.
      rig.collision.boxes[0].enabled = false;
      let threwAfterOpening = false;
      for (let frame = 0; frame < 180 && !threwAfterOpening; frame += 1) {
        threwAfterOpening = rig.opponent.update(STEP, PLAYER_EYE).threw;
      }
      expect(threwAfterOpening).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('moves to a clear lane and only releases cover-clear trajectories', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const rig = setup([{
      kind: 'mat', id: 'central-cover',
      minX: -1.3, maxX: 1.3, minY: 0, maxY: 1.75, minZ: 5.4, maxZ: 5.6
    }]);
    try {
      let largestLateralMove = 0;
      let releasedShots = 0;
      for (let frame = 0; frame < 1800 && releasedShots < 4; frame += 1) {
        const event = rig.opponent.update(STEP, PLAYER_EYE);
        largestLateralMove = Math.max(largestLateralMove, Math.abs(rig.opponent.feetPosition.x));
        expect(rig.opponent.feetPosition.z).toBeGreaterThan(0);
        if (!event.threw) continue;

        releasedShots += 1;
        expect(rig.ball.state).toBe(BallState.Live);
        expect(shotTrajectoryClear({
          origin: rig.ball.mesh.position.clone(),
          target: new Vector3(PLAYER_EYE.x, PLAYER_EYE.y - 0.52, PLAYER_EYE.z),
          velocity: rig.ball.velocity.clone(),
          dropScale: rig.ball.dropScale,
          curveAccel: rig.ball.curveAccel.clone(),
          collision: rig.collision,
          floorY: 0,
          gravityScale: rig.ball.mapGravityScale
        })).toBe(true);
        rig.ball.reset(new Vector3(rig.opponent.feetPosition.x, TUNING.ball.radius, rig.opponent.feetPosition.z));
      }
      expect(largestLateralMove).toBeGreaterThan(1.5);
      expect(releasedShots).toBe(4);
    } finally {
      random.mockRestore();
      rig.dispose();
    }
  });
});
