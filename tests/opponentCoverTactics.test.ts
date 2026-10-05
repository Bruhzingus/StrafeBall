import { Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { shotLaneClear } from '../src/game/bot/OpponentCover';
import { findCoverPlan } from '../src/game/bot/OpponentCoverTactics';
import { CollisionWorld, type AABB } from '../src/game/map/Collider';
import { TUNING } from '../src/game/config/tuning';

const feet = new Vector3(0, 0, 9);
const playerEye = new Vector3(0, 1.55, -8);
const bounds = { minX: -9.5, maxX: 9.5, minZ: 0.8, maxZ: 16.5, floorY: 0 };
const centerMat: AABB = {
  kind: 'mat', id: 'center-mat', minX: -1.3, maxX: 1.3,
  minY: 0, maxY: 1.75, minZ: 5.4, maxZ: 5.6
};

describe('opponent cover tactics', () => {
  it('finds a torso-shielded hide point and a clear peek on each side', () => {
    const world = new CollisionWorld([centerMat]);
    const plan = findCoverPlan(feet, playerEye, bounds, world, 1);

    expect(plan).not.toBeNull();
    expect(plan!.coverId).toBe('center-mat');
    expect(plan!.hide.z).toBeGreaterThan(centerMat.maxZ);
    expect(shotLaneClear(playerEye, plan!.hide.add(new Vector3(0, 1, 0)), world)).toBe(false);
    expect(plan!.peek.x).toBeGreaterThan(centerMat.maxX);
    expect(plan!.oppositePeek).not.toBeNull();
    expect(plan!.oppositePeek!.x).toBeLessThan(centerMat.minX);
    const target = playerEye.subtract(new Vector3(0, 0.52, 0));
    for (const point of [plan!.peek, plan!.oppositePeek!]) {
      expect(point.z).toBeGreaterThan(bounds.minZ);
      expect(shotLaneClear(point.add(new Vector3(0, 1.4, 0)), target, world,
        TUNING.ball.radius + 0.12)).toBe(true);
    }

    const left = findCoverPlan(feet, playerEye, bounds, world, -1);
    expect(left?.peek.x).toBeLessThan(centerMat.minX);
    expect(left?.oppositePeek?.x).toBeGreaterThan(centerMat.maxX);
  });

  it('uses the available side when court bounds remove the preferred peek', () => {
    const edgeMat: AABB = {
      kind: 'mat', id: 'edge-mat', minX: 6, maxX: 8.6,
      minY: 0, maxY: 1.75, minZ: 5.4, maxZ: 5.6
    };
    const world = new CollisionWorld([edgeMat]);
    const plan = findCoverPlan(new Vector3(7.2, 0, 9), playerEye, bounds, world, 1);

    expect(plan).not.toBeNull();
    expect(plan!.coverId).toBe('edge-mat');
    expect(plan!.peek.x).toBeLessThan(edgeMat.minX);
    expect(plan!.oppositePeek).toBeNull();
    expect(plan!.hide.x).toBeLessThan(bounds.maxX - 0.42);
    expect(plan!.peek.z).toBeGreaterThan(bounds.minZ + 0.42);
  });

  it('ignores disabled and knocked-over mats, and accepts a restored standing mat', () => {
    const world = new CollisionWorld([{ ...centerMat, enabled: false }]);
    expect(findCoverPlan(feet, playerEye, bounds, world)).toBeNull();

    world.boxes[0] = { ...centerMat, maxY: 0.18 };
    expect(findCoverPlan(feet, playerEye, bounds, world)).toBeNull();

    world.boxes[0] = { ...centerMat };
    expect(findCoverPlan(feet, playerEye, bounds, world)?.coverId).toBe('center-mat');
  });

  it('honors an unreachable path estimate when choosing between mats', () => {
    const leftMat: AABB = { ...centerMat, id: 'left', minX: -4.3, maxX: -1.7 };
    const rightMat: AABB = { ...centerMat, id: 'right', minX: 1.7, maxX: 4.3 };
    const world = new CollisionWorld([leftMat, rightMat]);
    const routeDistance = (from: Vector3, to: Vector3) => to.x > 0
      ? Number.POSITIVE_INFINITY : Math.hypot(to.x - from.x, to.z - from.z);

    expect(findCoverPlan(feet, playerEye, bounds, world, 1, routeDistance)?.coverId).toBe('left');
  });
});
