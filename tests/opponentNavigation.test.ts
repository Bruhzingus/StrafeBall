import { Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { OpponentNavigation } from '../src/game/bot/OpponentNavigation';
import { CollisionWorld, type AABB } from '../src/game/map/Collider';

const BOUNDS = { minX: -5, maxX: 5, minZ: 1, maxZ: 12, floorY: 0 };
const point = (x: number, z: number) => new Vector3(x, 0, z);
const mat = (minX: number, maxX: number, minZ: number, maxZ: number): AABB => ({
  minX, maxX, minY: 0, maxY: 1.7, minZ, maxZ, kind: 'mat'
});

describe('opponent navigation', () => {
  it('routes around staggered mats with clear, legal segments', () => {
    const collision = new CollisionWorld([
      mat(-2, 1, 7.2, 8.2),
      mat(-1, 2, 4.7, 5.7),
      mat(-4.3, -3.2, 5.7, 7.1)
    ]);
    const navigation = new OpponentNavigation(BOUNDS, collision);
    const start = point(0, 10.5);
    const target = point(0, 2.5);
    expect(navigation.pathClear(start, target)).toBe(false);
    expect(navigation.routeDistance(start, target)).toBeGreaterThan(8);

    let current = start;
    let bends = 0;
    for (let step = 0; step < 16 && Vector3.Distance(current, target) > 0.01; step += 1) {
      const next = navigation.nextWaypoint(current, target);
      expect(next).not.toBeNull();
      expect(navigation.pathClear(current, next!)).toBe(true);
      expect(next!.x).toBeGreaterThanOrEqual(BOUNDS.minX + 0.38);
      expect(next!.x).toBeLessThanOrEqual(BOUNDS.maxX - 0.38);
      expect(next!.z).toBeGreaterThanOrEqual(BOUNDS.minZ + 0.38);
      expect(next!.z).toBeLessThanOrEqual(BOUNDS.maxZ - 0.38);
      expect(Vector3.Distance(current, next!)).toBeGreaterThan(0.01);
      if (Vector3.Distance(next!, target) > 0.01) bends += 1;
      current = next!;
    }
    expect(bends).toBeGreaterThan(0);
    expect(Vector3.Distance(current, target)).toBeLessThan(0.01);
  });

  it('invalidates the cached graph when a mat is disabled or moved', () => {
    const blocker = mat(-1.5, 1.5, 6, 7);
    const navigation = new OpponentNavigation(BOUNDS, new CollisionWorld([blocker]));
    const start = point(0, 9);
    const target = point(0, 3);
    expect(navigation.routeDistance(start, target)).toBeGreaterThan(6);
    expect(navigation.nextWaypoint(start, target)).not.toEqual(target);

    blocker.enabled = false;
    expect(navigation.pathClear(start, target)).toBe(true);
    expect(navigation.routeDistance(start, target)).toBeCloseTo(6);
    expect(navigation.nextWaypoint(start, target)).toEqual(target);

    blocker.enabled = true;
    blocker.minX = 3;
    blocker.maxX = 4;
    expect(navigation.pathClear(start, target)).toBe(true);
    expect(navigation.routeDistance(start, target)).toBeCloseTo(6);

    blocker.minX = -1.5;
    blocker.maxX = 1.5;
    expect(navigation.routeDistance(start, target)).toBeGreaterThan(6);
    navigation.clear();
    expect(navigation.routeDistance(start, target)).toBeGreaterThan(6);
  });

  it('returns no route when a standing mat seals the full width of the half', () => {
    const navigation = new OpponentNavigation(BOUNDS, new CollisionWorld([mat(-5, 5, 6, 7)]));
    const start = point(0, 9);
    const target = point(0, 3);
    expect(navigation.pathClear(start, target)).toBe(false);
    expect(navigation.routeDistance(start, target)).toBe(Number.POSITIVE_INFINITY);
    expect(navigation.nextWaypoint(start, target)).toBeNull();
  });

  it('approaches a reachable ball at the border or beside a mat without crossing a boundary', () => {
    const collision = new CollisionWorld([mat(-0.5, 0.5, 4, 5)]);
    const navigation = new OpponentNavigation(BOUNDS, collision);
    const start = point(0, 8);
    const borderBall = point(0, 1.1);
    expect(navigation.pathClear(start, borderBall)).toBe(false);
    expect(Number.isFinite(navigation.routeDistance(start, borderBall))).toBe(true);
    const borderRoute = navigation.nextWaypoint(start, borderBall);
    expect(borderRoute).not.toBeNull();
    expect(borderRoute!.z).toBeGreaterThanOrEqual(1.38);

    const coveredBall = point(0, 5.3);
    expect(navigation.pathClear(start, coveredBall)).toBe(false);
    expect(Number.isFinite(navigation.routeDistance(start, coveredBall))).toBe(true);
    let current = start;
    for (let step = 0; step < 12; step += 1) {
      const next = navigation.nextWaypoint(current, coveredBall);
      expect(next).not.toBeNull();
      expect(navigation.pathClear(current, next!)).toBe(true);
      if (Vector3.Distance(current, next!) < 0.01) break;
      current = next!;
    }
    expect(Vector3.Distance(current, coveredBall)).toBeLessThanOrEqual(1.65);
    expect(navigation.routeDistance(start, point(0, -2))).toBe(Number.POSITIVE_INFINITY);
  });

  it('does not mistake a pickup point through a sealed mat for a reachable ball', () => {
    const navigation = new OpponentNavigation(BOUNDS, new CollisionWorld([mat(-5, 5, 6.5, 6.7)]));
    expect(navigation.routeDistance(point(0, 9), point(0, 6.1))).toBe(Number.POSITIVE_INFINITY);
  });
});
