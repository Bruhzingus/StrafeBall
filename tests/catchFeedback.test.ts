import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS } from '../shared/constants';
import { catchRecoilForVelocity } from '../shared/simulation/CatchFeedback';

describe('catch recoil feedback', () => {
  it('does not recoil for ordinary quick throws', () => {
    expect(GAME_CONSTANTS.ball.quickThrowSpeed).toBeLessThan(GAME_CONSTANTS.catch.momentumRecoilMinSpeed);
    expect(catchRecoilForVelocity({ x: 0, y: 0, z: GAME_CONSTANTS.ball.quickThrowSpeed })).toBeNull();
    expect(catchRecoilForVelocity({ x: 29.99, y: 0, z: 0 })).toBeNull();
  });

  it('recoils in the incoming ball direction, continuing away from the thrower', () => {
    const recoil = catchRecoilForVelocity({ x: 0, y: 0, z: -35 });
    expect(recoil).not.toBeNull();
    expect(recoil!.directionX).toBeCloseTo(0, 6);
    expect(recoil!.directionZ).toBeCloseTo(-1, 6);
    expect(recoil!.distance).toBeCloseTo(GAME_CONSTANTS.catch.momentumRecoilMaxDistance, 6);
  });

  it('scales only the hard-throw range from minimum to maximum recoil', () => {
    const minimum = catchRecoilForVelocity({ x: 30, y: 0, z: 0 });
    const middle = catchRecoilForVelocity({ x: 32.5, y: 0, z: 0 });
    const maximum = catchRecoilForVelocity({ x: 40, y: 0, z: 0 });
    expect(minimum!.distance).toBeCloseTo(GAME_CONSTANTS.catch.momentumRecoilMinDistance, 6);
    expect(middle!.strength).toBeCloseTo(0.5, 6);
    expect(maximum!.distance).toBeCloseTo(GAME_CONSTANTS.catch.momentumRecoilMaxDistance, 6);
  });

  it('does not create horizontal knockback for a purely vertical catch', () => {
    expect(catchRecoilForVelocity({ x: 0, y: 40, z: 0 })).toBeNull();
  });
});
