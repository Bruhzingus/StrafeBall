import { describe, it, expect } from 'vitest';
import { validateLayout } from '../src/game/practice/creator/CreatorLayout';
import { buildCreatorCollisionBoxes } from '../src/game/practice/creator/CreatorWorld';
import { CreatorMovers, moverFractionAt, standingOnMoverBox } from '../src/game/practice/creator/CreatorMovers';
import type { PlayerController } from '../src/game/player/PlayerController';

describe('CreatorMovers — ping-pong phase math', () => {
  // distance 10 @ 4 m/s → travel 2.5s; pause 0.5s → cycle 6s.
  const f = (t: number) => moverFractionAt(t, 10, 4, 0.5);

  it('outbound ramps linearly from 0 to 1', () => {
    expect(f(0)).toBe(0);
    expect(f(1.25)).toBeCloseTo(0.5, 6);
    expect(f(2.5)).toBeCloseTo(1, 6);
  });

  it('dwells at the far end for pauseSeconds, then returns', () => {
    expect(f(2.6)).toBe(1);
    expect(f(2.99)).toBe(1);
    expect(f(3.0 + 1.25)).toBeCloseTo(0.5, 6); // halfway home
    expect(f(5.5)).toBeCloseTo(0, 6);
  });

  it('dwells at home, then repeats periodically', () => {
    expect(f(5.7)).toBe(0);
    expect(f(6 + 1.25)).toBeCloseTo(0.5, 6);
    expect(f(0.8)).toBeCloseTo(f(6.8), 6);
  });

  it('degenerate movers (no distance / no speed / bad time) stay parked at 0', () => {
    expect(moverFractionAt(3, 0, 4, 0.5)).toBe(0);
    expect(moverFractionAt(3, 10, 0, 0.5)).toBe(0);
    expect(moverFractionAt(Number.NaN, 10, 4, 0.5)).toBe(0);
  });
});

describe('CreatorMovers — standing test', () => {
  const axisBox = { minX: -3, maxX: 3, minZ: -3, maxZ: 3 };

  it('grounded player on top of an axis-aligned box counts as riding; beside/above it does not', () => {
    expect(standingOnMoverBox(axisBox, 1, 0, 1.5, 0, 0.4)).toBe(true);
    expect(standingOnMoverBox(axisBox, 1, 5, 1.5, 0, 0.4)).toBe(false); // off the footprint
    expect(standingOnMoverBox(axisBox, 1, 0, 5.0, 0, 0.4)).toBe(false); // far above
    expect(standingOnMoverBox(axisBox, 1, 0, 0.5, 0, 0.4)).toBe(false); // below the top band
  });

  it('honours yaw for oriented boxes', () => {
    // 6x2 box rotated 90°: its long axis now runs along world Z.
    const oriented = { minX: -3, maxX: 3, minZ: -3, maxZ: 3, ry: Math.PI / 2, cx: 0, cz: 0, hx: 3, hz: 1 };
    expect(standingOnMoverBox(oriented, 1, 0, 1.5, 2.5, 0.2)).toBe(true); // along rotated long axis
    expect(standingOnMoverBox(oriented, 1, 2.5, 1.5, 0, 0.2)).toBe(false); // along rotated SHORT axis
  });
});

describe('CreatorMovers — collider translation + ride delta', () => {
  function makeWorld() {
    const layout = validateLayout({
      objects: [{ type: 'moving_platform', position: [0, 0, 0], metadata: { mover: { dx: 10, dy: 0, dz: 0, speed: 4, pauseSeconds: 0.5 } } }]
    }).layout;
    const boxes = buildCreatorCollisionBoxes(layout, 'test_');
    const movers = new CreatorMovers();
    movers.build(layout, boxes, null, 'test_');
    return { layout, boxes, movers };
  }

  function fakePlayer(x: number, y: number, z: number, grounded = true): PlayerController {
    return { movement: { grounded }, root: { position: { x, y, z } } } as unknown as PlayerController;
  }

  it('translates the collider entries IN PLACE (same references) as time advances', () => {
    const { boxes, movers } = makeWorld();
    const box = boxes[0];
    const startMinX = box.minX;
    movers.update(1, null); // 1s @ 4 m/s of a 10m run → +4m
    expect(box.minX).toBeCloseTo(startMinX + 4, 5);
    expect(boxes[0]).toBe(box); // never rebuilt
  });

  it('carries a standing rider by the frame delta; bystanders are untouched', () => {
    const { boxes, movers } = makeWorld();
    const top = boxes[0].maxY;
    const rider = fakePlayer(0, top + 0.5, 0);
    movers.update(0.5, rider); // +2m
    expect(rider.root.position.x).toBeCloseTo(2, 5);

    const { movers: movers2 } = makeWorld();
    const bystander = fakePlayer(50, top + 0.5, 50);
    movers2.update(0.5, bystander);
    expect(bystander.root.position.x).toBe(50);

    const { movers: movers3, boxes: boxes3 } = makeWorld();
    const airborne = fakePlayer(0, boxes3[0].maxY + 0.5, 0, false);
    movers3.update(0.5, airborne); // not grounded → not carried
    expect(airborne.root.position.x).toBe(0);
  });

  it('resetPhase snaps the platform and clock back home', () => {
    const { boxes, movers } = makeWorld();
    const startMinX = boxes[0].minX;
    movers.update(1.7, null);
    expect(boxes[0].minX).not.toBeCloseTo(startMinX, 3);
    movers.resetPhase();
    expect(boxes[0].minX).toBeCloseTo(startMinX, 6);
    movers.update(1, null);
    expect(boxes[0].minX).toBeCloseTo(startMinX + 4, 5); // clock restarted from zero
  });
});
