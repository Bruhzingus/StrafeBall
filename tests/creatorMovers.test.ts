import { describe, it, expect } from 'vitest';
import { validateLayout } from '../src/game/practice/creator/CreatorLayout';
import {
  buildCreatorCollisionBoxes,
  buildCreatorWallFaces,
  buildCreatorWallBounceFaces,
  creatorWallNormalAt
} from '../src/game/practice/creator/CreatorWorld';
import {
  CreatorMovers,
  moverFractionAt,
  standingOnMoverBox,
  wallRunningOnMoverFace,
  ballRidingMoverBox
} from '../src/game/practice/creator/CreatorMovers';
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
    const runFaces = buildCreatorWallFaces(layout);
    const bounceFaces = buildCreatorWallBounceFaces(layout);
    const movers = new CreatorMovers();
    movers.build(layout, boxes, null, 'test_', runFaces, bounceFaces);
    return { layout, boxes, runFaces, bounceFaces, movers };
  }

  /** `wallNormal` non-null models an active wall-run on a wall with that outward normal. */
  function fakePlayer(
    x: number,
    y: number,
    z: number,
    grounded = true,
    wallNormal: { x: number; z: number } | null = null
  ): PlayerController {
    return {
      movement: { grounded, activeWallNormal: () => wallNormal },
      root: { position: { x, y, z } }
    } as unknown as PlayerController;
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

  it('exposes the live offset so layout-position readers (triggers/pads/gates) can follow a platform', () => {
    const { layout, movers } = makeWorld();
    const out = { x: 0, y: 0, z: 0 };
    expect(movers.offsetOf(layout.objects[0].id, out)).toBe(true);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    movers.update(1, null);
    expect(movers.offsetOf(layout.objects[0].id, out)).toBe(true);
    expect(out.x).toBeCloseTo(4, 5);
    expect(movers.offsetOf('not_a_mover', out)).toBe(false);
  });
});

describe('CreatorMovers — moving platforms carry their wall surfaces', () => {
  // A tall thin wall that slides +X, so it has real wall-run faces to ride.
  function makeWallWorld() {
    const layout = validateLayout({
      objects: [{
        type: 'wallrun_wall',
        position: [0, 0, 0],
        scale: [1, 1, 1],
        metadata: { mover: { dx: 10, dy: 0, dz: 0, speed: 4, pauseSeconds: 0.5 } }
      }]
    }).layout;
    const boxes = buildCreatorCollisionBoxes(layout, 'test_');
    const runFaces = buildCreatorWallFaces(layout);
    const bounceFaces = buildCreatorWallBounceFaces(layout);
    const movers = new CreatorMovers();
    movers.build(layout, boxes, null, 'test_', runFaces, bounceFaces);
    return { layout, boxes, runFaces, bounceFaces, movers };
  }

  it('gives a mover BOTH run and bounce faces (it used to be excluded from both)', () => {
    const { runFaces, bounceFaces, layout } = makeWallWorld();
    const id = layout.objects[0].id;
    expect(runFaces.some((f) => f.objectId === id)).toBe(true);
    expect(bounceFaces.some((f) => f.objectId === id)).toBe(true);
  });

  it('never lets a mover claim the yard boundary faces', () => {
    const { runFaces } = makeWallWorld();
    // Boundary faces are appended with no owner; if one ever gained an objectId a mover would drag
    // the whole yard wall around with it.
    expect(runFaces.some((f) => f.objectId === undefined)).toBe(true);
  });

  it('translates faces in place, so the wall-run query follows the platform', () => {
    const { runFaces, movers } = makeWallWorld();
    // The +X face specifically: a probe just OUTSIDE it is in open space, so a hit means the query
    // genuinely found this wall rather than some other surface.
    const face = runFaces.find((f) => f.objectId !== undefined && f.nx > 0.99);
    if (!face) throw new Error('expected a +X face');
    const startOx = face.ox;

    // Standing 0.5m off the face attaches before the platform moves.
    expect(creatorWallNormalAt(runFaces, startOx + 0.5, 0, 2)).not.toBeNull();

    movers.update(1, null); // +4m
    expect(face.ox).toBeCloseTo(startOx + 4, 5);
    expect(runFaces).toContain(face); // mutated in place, never rebuilt

    // The query reads the same array the mover mutates, so the wall is now findable 4m downrange...
    expect(creatorWallNormalAt(runFaces, startOx + 4 + 0.5, 0, 2)).not.toBeNull();
    // ...and no longer where it started (that spot is now well clear of the wall).
    expect(creatorWallNormalAt(runFaces, startOx - 2, 0, 2)).toBeNull();
  });

  it('recomputes faces from their base each frame, so a long session cannot drift', () => {
    const { runFaces, movers } = makeWallWorld();
    const face = runFaces.find((f) => f.objectId !== undefined);
    if (!face) throw new Error('expected an owned face');
    const startOx = face.ox;
    // Many small steps then home again — an incrementing implementation accumulates error here.
    for (let i = 0; i < 600; i += 1) movers.update(1 / 60, null);
    movers.resetPhase();
    expect(face.ox).toBe(startOx);
  });

  it('carries a wall-running player by the frame delta', () => {
    // The face at +X of the wall has outward normal (1,0). Hug it from just outside.
    const { runFaces, movers } = makeWallWorld();
    const face = runFaces.find((f) => f.objectId !== undefined && f.nx > 0.99);
    if (!face) throw new Error('expected a +X face');

    const startX = face.ox + 0.5;
    const rider = fakeWallRunner(startX, 2, 0, { x: 1, z: 0 });
    movers.update(0.5, rider); // platform advances +2m
    expect(rider.root.position.x).toBeCloseTo(startX + 2, 5);
    // Still hugging the face after both moved — i.e. the run survives, which is the whole point.
    expect(wallRunningOnMoverFace(face, 1, 0, rider.root.position.x, 2, 0)).toBe(true);
  });

  it('does not steal a rider attached to a different wall in the same spot', () => {
    const { runFaces, movers } = makeWallWorld();
    const face = runFaces.find((f) => f.objectId !== undefined && f.nx > 0.99);
    if (!face) throw new Error('expected a +X face');
    // Same position, but attached to a wall facing the other way — not this platform's rider.
    const other = fakeWallRunner(face.ox + 0.5, 2, 0, { x: -1, z: 0 });
    const startX = other.root.position.x;
    movers.update(0.5, other);
    expect(other.root.position.x).toBe(startX);
  });

  it('does not carry an airborne player who is not wall-running', () => {
    const { runFaces, movers } = makeWallWorld();
    const face = runFaces.find((f) => f.objectId !== undefined && f.nx > 0.99);
    if (!face) throw new Error('expected a +X face');
    const faller = fakeWallRunner(face.ox + 0.5, 2, 0, null);
    const startX = faller.root.position.x;
    movers.update(0.5, faller);
    expect(faller.root.position.x).toBe(startX);
  });

  function fakeWallRunner(
    x: number,
    y: number,
    z: number,
    wallNormal: { x: number; z: number } | null
  ): PlayerController {
    return {
      movement: { grounded: false, activeWallNormal: () => wallNormal },
      root: { position: { x, y, z } }
    } as unknown as PlayerController;
  }
});

describe('CreatorMovers — wall-run rider test', () => {
  const face = { nx: 1, nz: 0, ox: 5, oz: 0, tx: 0, tz: 1, halfLen: 10, topY: 14, bottomY: 0, objectId: 'w' };

  it('attaches only within the face reach, span and vertical band', () => {
    expect(wallRunningOnMoverFace(face, 1, 0, 5.5, 2, 0)).toBe(true);
    expect(wallRunningOnMoverFace(face, 1, 0, 7.5, 2, 0)).toBe(false); // beyond WALL_RUN_MARGIN
    expect(wallRunningOnMoverFace(face, 1, 0, 4.5, 2, 0)).toBe(false); // behind the face
    expect(wallRunningOnMoverFace(face, 1, 0, 5.5, 2, 50)).toBe(false); // off the tangent span
    expect(wallRunningOnMoverFace(face, 1, 0, 5.5, 20, 0)).toBe(false); // feet above the face top
  });

  it('requires the run normal to match the face (so a mover cannot steal another wall rider)', () => {
    expect(wallRunningOnMoverFace(face, -1, 0, 5.5, 2, 0)).toBe(false);
    expect(wallRunningOnMoverFace(face, 0, 1, 5.5, 2, 0)).toBe(false);
  });
});

describe('CreatorMovers — ball rider test', () => {
  const box = { minX: -3, maxX: 3, minZ: -3, maxZ: 3 };

  it('carries a ball resting on the surface, not one in the air above or beside it', () => {
    expect(ballRidingMoverBox(box, 1, 0, 1 + 0.11, 0, 0.11)).toBe(true);
    expect(ballRidingMoverBox(box, 1, 0, 3, 0, 0.11)).toBe(false); // hovering well above
    expect(ballRidingMoverBox(box, 1, 9, 1 + 0.11, 0, 0.11)).toBe(false); // off the footprint
  });
});
