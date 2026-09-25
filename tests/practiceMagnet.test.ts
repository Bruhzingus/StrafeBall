import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { stepPracticeMagnetBall } from '../src/game/practice/PracticeMagnet';

const player = { x: 0, y: 0, z: 0 };

describe('practice magnet', () => {
  it('pulls nearby loose balls horizontally with the server speed cap', () => {
    const ball = { x: 9, y: 0.5, z: 0 };
    const result = stepPracticeMagnetBall(ball, { x: 0, y: 2, z: 0 }, player, 1, 0, false, true);

    expect(result.pulling).toBe(true);
    expect(result.distantPulling).toBe(false);
    expect(result.velocity).toEqual({ x: -C.powerup.magnetSpeed, y: 2, z: 0 });
  });

  it('waits for distant balls to settle, then keeps pulling them while moving', () => {
    const ball = { x: 12, y: 0.5, z: 0 };
    const still = stepPracticeMagnetBall(ball, { x: 0, y: 0, z: 0 }, player, C.powerup.stationarySeconds, 0, false, true);
    expect(still.pulling).toBe(false);

    const firstPull = stepPracticeMagnetBall(ball, { x: 0, y: 0, z: 0 }, player, 0.01, still.settledSeconds, false, true);
    expect(firstPull.pulling).toBe(true);
    expect(firstPull.distantPulling).toBe(true);

    const ongoing = stepPracticeMagnetBall(ball, { x: -0.5, y: 0, z: 0 }, player, 0.01, 0, firstPull.distantPulling, true);
    expect(ongoing.pulling).toBe(true);
    expect(ongoing.settledSeconds).toBe(0);
  });

  it('claims a reachable ball and leaves it alone when no hand is free', () => {
    const ball = { x: 0.5, y: 0.5, z: 0 };
    const reachable = stepPracticeMagnetBall(ball, { x: 0, y: 0, z: 0 }, player, 0.1, 0, false, true);
    expect(reachable.reachedPlayer).toBe(true);
    expect(reachable.pulling).toBe(false);

    const fullHands = stepPracticeMagnetBall(ball, { x: 0, y: 0, z: 0 }, player, 0.1, 0, false, false);
    expect(fullHands.reachedPlayer).toBe(false);
    expect(fullHands.pulling).toBe(false);
    expect(fullHands.settledSeconds).toBeCloseTo(0.1);
  });
});
