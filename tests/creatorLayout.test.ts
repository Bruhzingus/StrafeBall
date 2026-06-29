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
    expect(Math.abs(wall.position[0])).toBeLessThan(100000);
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
