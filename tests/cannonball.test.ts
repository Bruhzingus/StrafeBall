import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import {
  applyCannonBounce,
  advanceBall,
  cannonDropScale,
  cannonLaunchVelocity,
  cannonSpeedGrowthFactor,
  createBallState
} from '../shared/simulation/BallSim';

describe('cannonball tuning', () => {
  it('is 20% smaller and launches 25% slower at full charge than the previous cannonball', () => {
    expect(C.powerup.cannonHeldScale).toBe(2 * 0.8);
    expect(C.powerup.cannonFlightScale).toBe(5 * 0.8);
    const velocity = cannonLaunchVelocity({ x: 0, y: 0, z: 1 }, 1);
    expect(Math.hypot(velocity.x, velocity.y, velocity.z)).toBeCloseTo(C.ball.chargedThrowSpeed * 0.75 * 0.75, 6);
  });

  it('makes partial charges short and keeps the useful range near full charge', () => {
    const forward = { x: 0, y: 0, z: 1 };
    const full = cannonLaunchVelocity(forward, 1).z;
    const half = cannonLaunchVelocity(forward, 0.5).z;
    const nearFull = cannonLaunchVelocity(forward, 0.9).z;
    expect(half).toBeLessThan(full * 0.4);
    expect(nearFull).toBeLessThan(full * 0.8);
    expect(cannonDropScale(0.5)).toBeGreaterThan(0.9);
    expect(cannonDropScale(0.9)).toBeGreaterThan(0.3);
    expect(cannonDropScale(1)).toBe(0);

    const travel = (charge: number): number => {
      let ball = createBallState(`cannon_${charge}`, { x: 0, y: 1.6, z: 0 }, {
        kind: 'cannon', phase: 'live', velocity: cannonLaunchVelocity(forward, charge), dropScale: cannonDropScale(charge)
      });
      for (let tick = 0; tick < 480 && ball.position.y > C.ball.radius * C.powerup.cannonFlightScale; tick += 1) {
        ball = advanceBall(ball, 1 / 240);
      }
      return ball.position.z;
    };
    expect(travel(0.5)).toBeLessThan(5);
    expect(travel(1)).toBeGreaterThan(C.map.halfLength);
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
