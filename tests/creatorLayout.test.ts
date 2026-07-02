import { describe, it, expect } from 'vitest';
import {
  CREATOR_LIMITS,
  CREATOR_SCHEMA_VERSION,
  defaultCreatorLayout,
  validateLayout,
  isLayoutValid,
  layoutSpawn,
  objectDimensions,
  scaleForDimensions,
  objectCollisionBoxes,
  orientedBoxAabb,
  cloneLayout,
  type CreatorLayout
} from '../src/game/practice/creator/CreatorLayout';
import {
  buildCreatorCollisionBoxes,
  buildCreatorWallFaces,
  layoutWorldBounds,
  CreatorWorld
} from '../src/game/practice/creator/CreatorWorld';
import { SANDBOX_CENTER } from '../src/game/practice/MovementSandboxLayout';

describe('CreatorLayout — default + validation', () => {
  it('default layout is valid, versioned, and has a default spawn', () => {
    const layout = defaultCreatorLayout();
    expect(layout.version).toBe(CREATOR_SCHEMA_VERSION);
    expect(layout.objects.length).toBeGreaterThan(0);
    expect(isLayoutValid(layout).valid).toBe(true);
    const spawns = layout.objects.filter((o) => o.type === 'spawn_point');
    expect(spawns.length).toBe(1);
    expect(spawns.filter((s) => s.metadata?.defaultSpawn).length).toBe(1);
  });

  it('never throws on garbage and falls back to a usable layout', () => {
    for (const garbage of [null, undefined, 42, 'nope', [], { objects: 'x' }, { objects: [1, 2, 3] }]) {
      const { layout } = validateLayout(garbage);
      expect(layout.version).toBe(CREATOR_SCHEMA_VERSION);
      expect(Array.isArray(layout.objects)).toBe(true);
    }
  });

  it('drops unknown module types and clamps absurd dimensions/coords', () => {
    const raw = {
      version: 1,
      name: 'x',
      objects: [
        { type: 'not_a_real_module', position: [0, 0, 0] },
        { type: 'tall_wall', position: [999999, 999999, 999999], rotation: [0, 9999, 0], scale: [9999, 9999, 9999] }
      ]
    };
    const { layout, problems } = validateLayout(raw);
    expect(layout.objects.length).toBe(1); // unknown dropped
    expect(problems.length).toBeGreaterThan(0);
    const wall = layout.objects[0];
    expect(wall.scale.every((s) => s <= CREATOR_LIMITS.maxScale)).toBe(true);
    // Positions clamp to the documented build range (yard centre ± maxRadiusFromCenter) — no tighter,
    // so an export → import round trip preserves far-out builds up to the real limit.
    expect(wall.position[0]).toBeLessThanOrEqual(SANDBOX_CENTER.x + CREATOR_LIMITS.maxRadiusFromCenter + 1e-6);
    expect(wall.position[0]).toBeLessThan(999999);
  });

  it('round-trips far-out (but in-range) positions without squashing them', () => {
    const farX = SANDBOX_CENTER.x + 50000;
    const { layout } = validateLayout({
      objects: [{ type: 'tall_wall', position: [farX, 20, SANDBOX_CENTER.z], rotation: [0, 0, 0], scale: [1, 1, 1] }]
    });
    expect(layout.objects[0].position[0]).toBeCloseTo(farX, 4);
    expect(layout.objects[0].position[1]).toBeCloseTo(20, 4);
  });

  it('enforces a single default spawn on import', () => {
    const raw = {
      objects: [
        { type: 'spawn_point', position: [0, 0, 0], metadata: { defaultSpawn: true } },
        { type: 'spawn_point', position: [4, 0, 0], metadata: { defaultSpawn: true } }
      ]
    };
    const { layout } = validateLayout(raw);
    expect(layout.objects.filter((o) => o.metadata?.defaultSpawn).length).toBe(1);
  });

  it('dimensions <-> scale round-trip', () => {
    const layout = defaultCreatorLayout();
    const wall = layout.objects.find((o) => o.type === 'wallrun_wall')!;
    const dims = objectDimensions(wall);
    wall.scale = scaleForDimensions(wall.type, [dims[0], dims[1] * 2, dims[2]]);
    const dims2 = objectDimensions(wall);
    expect(dims2[1]).toBeCloseTo(dims[1] * 2, 4);
  });
});

describe('CreatorLayout — collision sub-boxes', () => {
  it('a Y-rotated wall yields an enclosing AABB (wider than the unrotated box)', () => {
    const { layout } = validateLayout({
      objects: [{ type: 'long_wall', position: [0, 0, 0], rotation: [0, 45, 0], scale: [1, 1, 1] }]
    });
    const boxes = objectCollisionBoxes(layout.objects[0]);
    expect(boxes.length).toBe(1);
    const a = orientedBoxAabb(boxes[0]);
    // long_wall base is 40 wide × 1.5 deep. Rotated 45°, the thin depth axis projects the 40 m length
    // onto Z, so the enclosing AABB depth grows far past the unrotated 1.5 m (≈ 40/√2).
    expect(a.maxZ - a.minZ).toBeGreaterThan(10);
    expect(a.maxZ - a.minZ).toBeLessThan(40);
  });

  it('wallrun_wall collider matches its visual solid box (center/half-extents/ry) when rotated', () => {
    // The oriented collider must equal the visual box exactly, or the wall collides off-position.
    for (const deg of [0, 30, 45, 90, 137]) {
      const { layout } = validateLayout({
        objects: [{ type: 'wallrun_wall', position: [5, 0, -7], rotation: [0, deg, 0], scale: [2, 1, 0.5] }]
      });
      const obj = layout.objects[0];
      const solid = objectCollisionBoxes(obj)[0]; // the visual/collision truth box
      const colliders = buildCreatorCollisionBoxes(layout, 'creator_');
      expect(colliders.length).toBe(1);
      const c = colliders[0];
      const nearAxis = Math.abs(Math.sin(solid.ry)) < 1e-3 || Math.abs(Math.cos(solid.ry)) < 1e-3;
      if (nearAxis) {
        // Axis-aligned: exact enclosing AABB, no oriented fields (proven fast path).
        expect(c.ry).toBeUndefined();
        const a = orientedBoxAabb(solid);
        expect(c.minX).toBeCloseTo(a.minX, 4);
        expect(c.maxX).toBeCloseTo(a.maxX, 4);
        expect(c.minZ).toBeCloseTo(a.minZ, 4);
        expect(c.maxZ).toBeCloseTo(a.maxZ, 4);
      } else {
        // Rotated: a true oriented box whose center/half-extents/angle equal the visual box.
        expect(c.ry).toBeCloseTo(solid.ry, 6);
        expect(c.cx).toBeCloseTo(solid.cx, 4);
        expect(c.cz).toBeCloseTo(solid.cz, 4);
        expect(c.hx).toBeCloseTo(solid.w / 2, 4);
        expect(c.hz).toBeCloseTo(solid.d / 2, 4);
      }
    }
  });

  it('collision-disabled and invisible objects contribute no collision boxes', () => {
    const { layout } = validateLayout({
      objects: [
        { type: 'long_wall', position: [0, 0, 0], collision: false },
        { type: 'long_wall', position: [10, 0, 0], visible: false }
      ]
    });
    expect(objectCollisionBoxes(layout.objects[0]).length).toBe(0);
    expect(objectCollisionBoxes(layout.objects[1]).length).toBe(0);
  });

  it('kill_block is a known walk-through volume (no collision boxes, has an AABB for selection)', () => {
    const { layout } = validateLayout({ objects: [{ type: 'kill_block', position: [1, 0, 2], scale: [2, 1, 1] }] });
    expect(layout.objects.length).toBe(1);
    expect(objectCollisionBoxes(layout.objects[0]).length).toBe(0); // walk-through: no collision
    const dims = objectDimensions(layout.objects[0]);
    expect(dims[0]).toBeCloseTo(8, 4); // 4 base * 2 scale
  });

  it('markers (spawn) produce no collision boxes', () => {
    const layout = defaultCreatorLayout();
    const spawn = layout.objects.find((o) => o.type === 'spawn_point')!;
    expect(objectCollisionBoxes(spawn).length).toBe(0);
  });

  it('a ramp generates a walkable stair stack (multiple steps under stepHeight)', () => {
    const { layout } = validateLayout({ objects: [{ type: 'ramp', position: [0, 0, 0] }] });
    const boxes = objectCollisionBoxes(layout.objects[0]);
    expect(boxes.length).toBeGreaterThan(1);
    const tops = boxes.map((b) => b.cy + b.h / 2).sort((x, y) => x - y);
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i] - tops[i - 1]).toBeLessThanOrEqual(0.45 + 1e-6);
    }
  });
});

describe('CreatorWorld — bounds, collision, wall-run faces', () => {
  it('tags collision boxes with the id prefix and produces wall-run faces + bounds', () => {
    const layout = defaultCreatorLayout();
    const boxes = buildCreatorCollisionBoxes(layout, 'creator_');
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b.id?.startsWith('creator_'))).toBe(true);

    const faces = buildCreatorWallFaces(layout);
    expect(faces.length).toBeGreaterThan(4); // object faces + 4 boundary faces

    const bounds = layoutWorldBounds(layout);
    expect(bounds.maxX).toBeGreaterThan(bounds.minX);
    expect(bounds.maxZ).toBeGreaterThan(bounds.minZ);
  });

  it('wallNormalAt returns a unit-ish normal near a wall and null in the open', () => {
    const layout: CreatorLayout = cloneLayout(defaultCreatorLayout());
    const world = new CreatorWorld(layout);
    // Far from any wall / boundary, deep inside the yard centre → no wall.
    expect(world.wallNormalAt((world.minX + world.maxX) / 2, (world.minZ + world.maxZ) / 2, 1)).toBeNull();
    // Just inside the west boundary should detect the inward-facing wall.
    const n = world.wallNormalAt(world.minX + 0.5, (world.minZ + world.maxZ) / 2, 1);
    expect(n).not.toBeNull();
    if (n) expect(Math.hypot(n.x, n.z)).toBeCloseTo(1, 3);
  });

  it('layoutSpawn derives position + yaw from the default spawn rotation', () => {
    const layout = defaultCreatorLayout();
    const spawn = layout.objects.find((o) => o.type === 'spawn_point')!;
    const s = layoutSpawn(layout);
    expect(s.x).toBeCloseTo(spawn.position[0], 4);
    expect(s.z).toBeCloseTo(spawn.position[2], 4);
    expect(s.yaw).toBeCloseTo((spawn.rotation[1] * Math.PI) / 180, 4);
  });
});
