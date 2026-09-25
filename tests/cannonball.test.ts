import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import {
  applyCannonBounce,
  advanceBall,
  cannonLaunchVelocity,
  cannonSpeedGrowthFactor,
  createBallState
} from '../shared/simulation/BallSim';

describe('cannonball tuning', () => {
  it('launches 25% slower than the old charged-speed throw', () => {
    const velocity = cannonLaunchVelocity({ x: 0, y: 0, z: 1 });
    expect(Math.hypot(velocity.x, velocity.y, velocity.z)).toBeCloseTo(C.ball.chargedThrowSpeed * 0.75, 6);
  });

  it('compounds speed by 10% every six meters', () => {
    expect(cannonSpeedGrowthFactor(0)).toBe(1);
    expect(cannonSpeedGrowthFactor(6)).toBeCloseTo(1.1, 8);
    expect(cannonSpeedGrowthFactor(12)).toBeCloseTo(1.21, 8);
  });

  it('applies the exponential speed growth while the cannon is in flight', () => {
    const start = C.ball.chargedThrowSpeed * C.powerup.cannonLaunchSpeedMultiplier;
    let ball = createBallState('cannon', undefined, {
      kind: 'cannon',
      phase: 'live',
      velocity: { x: 0, y: 0, z: start }
    });

    while (ball.curveDistance < C.powerup.cannonSpeedGrowthDistance) {
      ball = advanceBall(ball, 1 / 240);
    }

    expect(ball.velocity.z / start).toBeCloseTo(C.powerup.cannonSpeedGrowthMultiplier, 2);
  });

  it('uses its own four-impact cap instead of the ordinary bounce limit', () => {
    let ball = createBallState('cannon', undefined, { kind: 'cannon', phase: 'live' });
    for (let bounce = 1; bounce <= C.powerup.cannonMaxBounces; bounce += 1) {
      ball = applyCannonBounce(ball);
      expect(ball.bounceCount).toBe(bounce);
      expect(ball.phase).toBe(bounce < C.powerup.cannonMaxBounces ? 'live' : 'dead');
    }
  });
});
