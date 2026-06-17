import { describe, it, expect } from 'vitest';
import { airStrafeWishDirection, yawForward, yawRight, movementWishDirection } from '../src/game/utils/vector';

describe('yawForward', () => {
  it('points +Z at yaw 0 and +X at yaw 90deg', () => {
    const f0 = yawForward(0);
    expect(f0.x).toBeCloseTo(0, 6);
    expect(f0.z).toBeCloseTo(1, 6);

    const f90 = yawForward(Math.PI / 2);
    expect(f90.x).toBeCloseTo(1, 6);
    expect(f90.z).toBeCloseTo(0, 6);
  });

  it('is always horizontal and unit length', () => {
    const f = yawForward(0.9);
    expect(f.y).toBe(0);
    expect(f.length()).toBeCloseTo(1, 6);
  });
});

describe('yawRight', () => {
  it('points +X at yaw 0 and is perpendicular to forward', () => {
    const r = yawRight(0);
    expect(r.x).toBeCloseTo(1, 6);
    expect(r.z).toBeCloseTo(0, 6);

    const yaw = 0.7;
    expect(yawForward(yaw).x * yawRight(yaw).x + yawForward(yaw).z * yawRight(yaw).z).toBeCloseTo(0, 6);
  });
});

describe('movementWishDirection', () => {
  it('returns a normalized direction for a single axis of input', () => {
    const forwardOnly = movementWishDirection(0, 0, 1);
    expect(forwardOnly.x).toBeCloseTo(0, 6);
    expect(forwardOnly.z).toBeCloseTo(1, 6);

    const rightOnly = movementWishDirection(0, 1, 0);
    expect(rightOnly.x).toBeCloseTo(1, 6);
    expect(rightOnly.z).toBeCloseTo(0, 6);
  });

  it('normalizes diagonal input to unit length', () => {
    const diag = movementWishDirection(0, 1, 1);
    expect(diag.length()).toBeCloseTo(1, 6);
    expect(diag.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(diag.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('returns a zero vector for no input (safe fallback)', () => {
    const none = movementWishDirection(0, 0, 0);
    expect(none.length()).toBe(0);
  });
});

describe('airStrafeWishDirection', () => {
  it('uses only A/D side input for air acceleration', () => {
    const right = airStrafeWishDirection(0, 1);
    expect(right.x).toBeCloseTo(1, 6);
    expect(right.z).toBeCloseTo(0, 6);

    const left = airStrafeWishDirection(0, -1);
    expect(left.x).toBeCloseTo(-1, 6);
    expect(left.z).toBeCloseTo(0, 6);
  });

  it('returns zero with no A/D input', () => {
    expect(airStrafeWishDirection(0, 0).length()).toBe(0);
  });
});
