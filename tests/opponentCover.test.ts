import { Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import {
  findClearFiringPosition,
  shotLaneClear,
  shotTrajectoryClear
} from '../src/game/bot/OpponentCover';
import { CollisionWorld, type AABB } from '../src/game/map/Collider';

const standingMat: AABB = {
  kind: 'mat', id: 'center-cover',
  minX: -1.3, maxX: 1.3, minY: 0, maxY: 1.75, minZ: 4.45, maxZ: 4.65
};

describe('opponent cover planning', () => {
  it('recognizes that a standing mat blocks a ball-sized shot at chest height', () => {
    const origin = new Vector3(0, 1.4, 9);
    const target = new Vector3(0, 1.05, -8);
    const world = new CollisionWorld([standingMat]);

    expect(shotLaneClear(origin, target, world)).toBe(false);
    expect(shotTrajectoryClear({
      origin, target, velocity: new Vector3(0, -0.5, -30), dropScale: 0, collision: world
    })).toBe(false);
    expect(shotLaneClear(new Vector3(3, 2.7, 9), new Vector3(3, 2.7, -8), world)).toBe(true);
  });

  it('uses the live mat collision state and permits shots over a knocked-over panel', () => {
    const origin = new Vector3(0, 1.4, 9);
    const target = new Vector3(0, 1.05, -8);
    const world = new CollisionWorld([{ ...standingMat, enabled: false }]);

    expect(shotLaneClear(origin, target, world)).toBe(true);
    expect(shotTrajectoryClear({
      origin, target, velocity: new Vector3(0, -0.5, -30), dropScale: 0, collision: world
    })).toBe(true);

    world.boxes[0] = { ...standingMat, maxY: 0.18 };
    expect(shotLaneClear(origin, target, world)).toBe(true);
    expect(shotLaneClear(new Vector3(0, 0.3, 9), new Vector3(0, 0.3, -8), world)).toBe(false);
  });

  it('finds a clear, unoccupied throwing position on the opponent side', () => {
    const world = new CollisionWorld([standingMat]);
    const feet = new Vector3(0, 0, 9);
    const hand = new Vector3(0, 1.4, 9);
    const target = new Vector3(0, 1.05, -8);
    const bounds = { minX: -9.5, maxX: 9.5, minZ: 0.8, maxZ: 16.5, ownSideMinZ: 0.8, floorY: 0 };

    const position = findClearFiringPosition(feet, hand, target, bounds, world);

    expect(position).not.toBeNull();
    expect(position!.z).toBeGreaterThanOrEqual(bounds.ownSideMinZ + 0.42);
    expect(position!.z).toBeLessThan(bounds.maxZ);
    expect(position!.x).toBeGreaterThan(bounds.minX);
    expect(position!.x).toBeLessThan(bounds.maxX);
    expect(shotLaneClear(position!.add(hand.subtract(feet)), target, world)).toBe(true);
    expect(Math.hypot(position!.x - feet.x, position!.z - feet.z)).toBeLessThan(5);
  });

  it('rejects a curve that bends into a side mat even when its initial lane is clear', () => {
    const origin = new Vector3(0, 1.25, 7);
    const target = new Vector3(0, 1.25, -7);
    const sideMat: AABB = {
      kind: 'mat', id: 'side-cover',
      minX: 0.5, maxX: 1.6, minY: 0, maxY: 1.75, minZ: -2.2, maxZ: -1.8
    };
    const world = new CollisionWorld([sideMat]);
    const shot = {
      origin, target, velocity: new Vector3(0, 0, -20),
      dropScale: 0, curveAccel: new Vector3(20, 0, 0), collision: world
    };

    expect(shotLaneClear(origin, target, world)).toBe(true);
    expect(shotTrajectoryClear({ ...shot, curveAccel: Vector3.Zero() })).toBe(true);
    expect(shotTrajectoryClear(shot)).toBe(false);
  });
});
