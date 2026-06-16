import { describe, it, expect } from 'vitest';
import { Vector3 } from '@babylonjs/core';
import {
  clamp,
  saturate,
  lerp,
  approach,
  angleBetweenDegrees,
  safeNormalize,
  projectOnPlane
} from '../src/game/utils/math';

describe('clamp', () => {
  it('clamps below, within, and above range', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(4, 0, 10)).toBe(4);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('saturate', () => {
  it('clamps to [0,1]', () => {
    expect(saturate(-0.2)).toBe(0);
    expect(saturate(0.3)).toBe(0.3);
    expect(saturate(2)).toBe(1);
  });
});

describe('lerp', () => {
  it('interpolates endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});

describe('approach', () => {
  it('steps toward the target without overshooting', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(0, 10, 50)).toBe(10); // clamped to target
    expect(approach(10, 0, 3)).toBe(7);
    expect(approach(10, 0, 50)).toBe(0);
    expect(approach(5, 5, 1)).toBe(5);
  });
});

describe('angleBetweenDegrees', () => {
  it('measures the angle between two directions', () => {
    expect(angleBetweenDegrees(new Vector3(1, 0, 0), new Vector3(1, 0, 0))).toBeCloseTo(0, 5);
    expect(angleBetweenDegrees(new Vector3(1, 0, 0), new Vector3(0, 1, 0))).toBeCloseTo(90, 5);
    expect(angleBetweenDegrees(new Vector3(1, 0, 0), new Vector3(-1, 0, 0))).toBeCloseTo(180, 5);
  });
});

describe('safeNormalize', () => {
  it('normalizes a non-zero vector to unit length', () => {
    const n = safeNormalize(new Vector3(0, 3, 0));
    expect(n.x).toBeCloseTo(0, 6);
    expect(n.y).toBeCloseTo(1, 6);
    expect(n.length()).toBeCloseTo(1, 6);
  });

  it('returns the fallback for a near-zero vector', () => {
    const fallback = new Vector3(0, 0, 1);
    const n = safeNormalize(new Vector3(0, 0, 0), fallback);
    expect(n.equals(fallback)).toBe(true);
  });

  it('does not return a reference to the fallback (clones it)', () => {
    const fallback = new Vector3(0, 0, 1);
    const n = safeNormalize(new Vector3(0, 0, 0), fallback);
    expect(n).not.toBe(fallback);
  });
});

describe('projectOnPlane', () => {
  it('removes the component along the plane normal', () => {
    const projected = projectOnPlane(new Vector3(2, 5, 0), new Vector3(0, 1, 0));
    expect(projected.x).toBeCloseTo(2, 6);
    expect(projected.y).toBeCloseTo(0, 6);
    expect(projected.z).toBeCloseTo(0, 6);
  });
});
