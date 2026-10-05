import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../../shared/constants';
import { createBallState } from '../../shared/simulation/BallSim';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
function advanceSeconds(loop: ServerGameLoop, seconds: number): void {
  for (let i = 0; i < Math.ceil(seconds * loop.tickRate); i++) loop.advance();
}

describe('frenzy ball physics', () => {
  it.each([32, 64, 128])('lets every extra ball finish its drop and bounces at %s Hz', (tickRate) => {
    const loop = new ServerGameLoop('frenzy-fall', { tickRate });
    loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'playing';
    loop.state.match.boundary.noBoundaries = true;
    loop.state.players.a.movement.position = v(-10, 0, -15);
    loop.state.players.b.movement.position = v(10, 0, 15);
    let rolls = 0;
    (loop.mapEffectSystem as unknown as { rng: () => number }).rng = () => {
      rolls++;
      return rolls === 1 ? 0.01 : rolls === 2 ? 2.5 / 3 : 0.5;
    };
    const originalCount = Object.keys(loop.state.balls).length;
    expect(loop.mapEffectSystem.tryStart(loop.state, 0, v())).toBe(true);
    advanceSeconds(loop, C.mapEffect.warningSeconds + C.mapEffect.frenzySpawnSeconds + 10);
    expect(loop.mapEffectSystem.frenzyBalls).toHaveLength(originalCount * (C.mapEffect.frenzyBallMultiplier - 1));
    for (const id of loop.mapEffectSystem.frenzyBalls) {
      const ball = loop.state.balls[id];
      expect(ball.phase, id).toBe('loose');
      expect(ball.position.y, id).toBeCloseTo(C.ball.radius, 5);
      expect(ball.velocity, id).toEqual(v());
    }
  });

  it('resumes gravity for a loose ball suspended above the court', () => {
    const loop = new ServerGameLoop('suspended-ball');
    loop.state.balls.ball_0 = createBallState('ball_0', v(0, 3, 8));
    advanceSeconds(loop, 0.25);
    expect(loop.state.balls.ball_0.position.y).toBeLessThan(2.95);
    expect(loop.state.balls.ball_0.phase).toBe('dead');
    advanceSeconds(loop, 8);
    expect(loop.state.balls.ball_0.phase).toBe('loose');
    expect(loop.state.balls.ball_0.position.y).toBeCloseTo(C.ball.radius, 5);
  });
});
