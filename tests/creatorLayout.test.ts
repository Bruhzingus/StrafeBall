import { describe, it, expect } from 'vitest';
import {
  CREATOR_LABEL_COLORS,
  CREATOR_LABEL_SIZES,
  CREATOR_LIMITS,
  CREATOR_SCHEMA_VERSION,
  blankCourseLayout,
  committedCourseLayout,
  defaultCreatorLayout,
  validateLayout,
  isLayoutValid,
  layoutSpawn,
  setExclusiveDefaultSpawn,
  objectDimensions,
  scaleForDimensions,
  objectCollisionBoxes,
  collectSpawnerMarkers,
  objectsGroupOrigin,
  rotateObjectsAroundCenterYaw,
  makePrefabFromObjects,
  instantiatePrefab,
  sanitizePrefabs,
  MAX_PREFABS,
  objectCollisionRamps,
  objectOpacity,
  orientedBoxAabb,
  cloneLayout,
  type CreatorLayout
} from '../src/game/practice/creator/CreatorLayout';
import {
  buildCreatorCollisionBoxes,
  buildCreatorWallBounceFaces,
  buildCreatorWallFaces,
  layoutWorldBounds,
  CreatorWorld
} from '../src/game/practice/creator/CreatorWorld';
import { SANDBOX_CENTER } from '../src/game/practice/MovementSandboxLayout';
import committedCourseJson from '../src/game/practice/creator/layouts/movementCourseLayout.json';

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

  it('the committed default map (shipped JSON) validates cleanly — no dropped objects, no fallback', () => {
    const { layout, problems } = validateLayout(committedCourseJson);
    expect(problems).toEqual([]);
    expect(layout.objects.length).toBe(committedCourseJson.objects.length);
    // committedCourseLayout() only falls back to the built-in default when the file is empty.
    expect(committedCourseLayout().objects.length).toBe(layout.objects.length);
    expect(layout.objects.some((o) => o.type === 'spawn_point')).toBe(true);
    expect(layout.objects.some((o) => o.type === 'leave_portal')).toBe(true);
  });

  it('never throws on garbage and falls back to a usable layout', () => {
    for (const garbage of [null, undefined, 42, 'nope', [], { objects: 'x' }, { objects: [1, 2, 3] }]) {
      const { layout } = validateLayout(garbage);
      expect(layout.version).toBe(CREATOR_SCHEMA_VERSION);
      expect(Array.isArray(layout.objects)).toBe(true);
    }
  });

  it('sanitizes course metadata: valid difficulty kept, junk dropped, description clamped', () => {
    const good = validateLayout({ name: 'x', objects: [], description: 'A fun sprint.', difficulty: 'advanced' }).layout;
    expect(good.description).toBe('A fun sprint.');
    expect(good.difficulty).toBe('advanced');

    const junk = validateLayout({ name: 'x', objects: [], description: 42, difficulty: 'impossible' }).layout;
    expect(junk.description).toBeUndefined();
    expect(junk.difficulty).toBeUndefined();

    const long = validateLayout({ name: 'x', objects: [], description: 'y'.repeat(1000) }).layout;
    expect(long.description!.length).toBe(CREATOR_LIMITS.maxDescriptionLength);
  });

  it('metadata round-trips through validation (export → import keeps it)', () => {
    const layout = blankCourseLayout();
    layout.description = 'Round trip';
    layout.difficulty = 'beginner';
    const revalidated = validateLayout(JSON.parse(JSON.stringify(layout))).layout;
    expect(revalidated.description).toBe('Round trip');
    expect(revalidated.difficulty).toBe('beginner');
  });

  it('blankCourseLayout is a valid course with exactly a default spawn and a leave portal', () => {
    const layout = blankCourseLayout();
    const { problems } = validateLayout(layout);
    expect(problems).toEqual([]);
    expect(isLayoutValid(layout).valid).toBe(true);
    expect(layout.objects.length).toBe(2);
    expect(layout.objects.filter((o) => o.type === 'spawn_point' && o.metadata?.defaultSpawn).length).toBe(1);
    expect(layout.objects.some((o) => o.type === 'leave_portal')).toBe(true);
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

  it('can promote a newly added spawn so it becomes the only active default', () => {
    const layout = defaultCreatorLayout();
    const original = layout.objects.find((o) => o.type === 'spawn_point')!;
    layout.objects.push({
      id: 'new_spawn',
      type: 'spawn_point',
      position: [original.position[0] + 10, original.position[1], original.position[2]],
      rotation: [0, 180, 0],
      scale: [1, 1, 1],
      material: 'marker_green',
      collision: false,
      opacity: 1,
      wallrunEnabled: true,
      metadata: {}
    });

    setExclusiveDefaultSpawn(layout, 'new_spawn');

    const defaults = layout.objects.filter((o) => o.type === 'spawn_point' && o.metadata?.defaultSpawn);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('new_spawn');
  });

  it('a Test Spawn overrides the main spawn, and the most-recently-placed one wins', () => {
    const { layout } = validateLayout({
      ground: { bounds: { width: 40, depth: 40, y: 0 }, material: 'ground' },
      objects: [
        { type: 'spawn_point', position: [0, 0, 0], rotation: [0, 0, 0], metadata: { defaultSpawn: true } },
        { type: 'test_spawn', position: [10, 1, 2], rotation: [0, 90, 0] },
        { type: 'test_spawn', position: [20, 3, -5], rotation: [0, 180, 0] }
      ]
    });

    const spawn = layoutSpawn(layout);
    // The LAST test_spawn in layout order (the newest) wins over both the earlier one and the default.
    expect(spawn.x).toBeCloseTo(20, 4);
    expect(spawn.y).toBeCloseTo(3, 4);
    expect(spawn.z).toBeCloseTo(-5, 4);
    expect(spawn.yaw).toBeCloseTo(Math.PI, 4);
  });

  it('falls back to the default spawn when no Test Spawn exists', () => {
    const { layout } = validateLayout({
      ground: { bounds: { width: 40, depth: 40, y: 0 }, material: 'ground' },
      objects: [{ type: 'spawn_point', position: [7, 0, 8], rotation: [0, 0, 0], metadata: { defaultSpawn: true } }]
    });
    const spawn = layoutSpawn(layout);
    expect(spawn.x).toBeCloseTo(7, 4);
    expect(spawn.z).toBeCloseTo(8, 4);
  });

  it('dimensions <-> scale round-trip', () => {
    const layout = defaultCreatorLayout();
    const wall = layout.objects.find((o) => o.type === 'wallrun_wall')!;
    const dims = objectDimensions(wall);
    wall.scale = scaleForDimensions(wall.type, [dims[0], dims[1] * 2, dims[2]]);
    const dims2 = objectDimensions(wall);
    expect(dims2[1]).toBeCloseTo(dims[1] * 2, 4);
  });

  it('sanitizes label display settings while preserving intentionally blank labels', () => {
    const { layout } = validateLayout({
      objects: [
        {
          type: 'route_arrow',
          position: [0, 0, 0],
          metadata: {
            label: '',
            labelVisible: false,
            labelSize: 'large',
            labelColor: 'gold',
            labelOffsetY: 999,
            unexpected: '<script>'
          }
        },
        {
          type: 'signboard',
          position: [0, 0, 0],
          metadata: { labelSize: 'giant', labelColor: 'plaid', labelOffsetY: -999 }
        }
      ]
    });
    const arrow = layout.objects[0];
    expect(arrow.metadata?.label).toBe('');
    expect(arrow.metadata?.labelVisible).toBe(false);
    expect(CREATOR_LABEL_SIZES).toContain(arrow.metadata?.labelSize);
    expect(CREATOR_LABEL_COLORS).toContain(arrow.metadata?.labelColor);
    expect(arrow.metadata?.labelOffsetY).toBe(CREATOR_LIMITS.maxLabelOffsetY);

    const sign = layout.objects[1];
    expect(sign.metadata?.labelSize).toBeUndefined();
    expect(sign.metadata?.labelColor).toBeUndefined();
    expect(sign.metadata?.labelOffsetY).toBe(CREATOR_LIMITS.minLabelOffsetY);
  });

  it('defaults old objects to wallrun-enabled and preserves explicit wallrun opt-outs', () => {
    const { layout } = validateLayout({
      objects: [
        { type: 'long_wall', position: [0, 0, 0] },
        { type: 'long_wall', position: [10, 0, 0], wallrunEnabled: false }
      ]
    });
    expect(layout.objects[0].wallrunEnabled).toBe(true);
    expect(layout.objects[1].wallrunEnabled).toBe(false);
  });

  it('migrates old visible flags to opacity and clamps imported opacity', () => {
    const { layout } = validateLayout({
      objects: [
        { type: 'long_wall', position: [0, 0, 0], visible: true },
        { type: 'long_wall', position: [10, 0, 0], visible: false },
        { type: 'long_wall', position: [20, 0, 0], opacity: 0.4 },
        { type: 'long_wall', position: [30, 0, 0], opacity: 99 },
        { type: 'long_wall', position: [40, 0, 0] }
      ]
    });

    expect(layout.objects.map((o) => o.opacity)).toEqual([1, 0, 0.4, 1, 1]);
    expect(layout.objects.every((o) => o.visible === undefined)).toBe(true);
    expect(objectOpacity({ visible: false })).toBe(0);
    expect(objectOpacity({ opacity: 0.25, visible: false })).toBe(0.25);
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

  it('collision-disabled objects contribute no collision boxes, but opacity does not affect collision', () => {
    const { layout } = validateLayout({
      objects: [
        { type: 'long_wall', position: [0, 0, 0], collision: false },
        { type: 'long_wall', position: [10, 0, 0], opacity: 0 },
        { type: 'long_wall', position: [20, 0, 0], visible: false }
      ]
    });
    expect(objectCollisionBoxes(layout.objects[0]).length).toBe(0);
    expect(objectCollisionBoxes(layout.objects[1]).length).toBe(1);
    expect(objectCollisionBoxes(layout.objects[2]).length).toBe(1);
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

  it('ramps generate one smooth wedge collider instead of a stair stack', () => {
    for (const type of ['ramp', 'wide_ramp'] as const) {
      const { layout } = validateLayout({ objects: [{ type, position: [0, 0, 0] }] });
      expect(objectCollisionBoxes(layout.objects[0]).length).toBe(0);

      const ramps = objectCollisionRamps(layout.objects[0]);
      expect(ramps.length).toBe(1);
      expect(ramps[0].baseY).toBe(0);
      expect(ramps[0].normal[1]).toBeGreaterThan(0.8);

      const colliders = buildCreatorCollisionBoxes(layout, 'creator_');
      expect(colliders.length).toBe(1);
      expect(colliders[0].ramp).toBeDefined();
      expect(colliders[0].id).toContain('_ramp_0');
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

  it('wallrun-disabled solids still collide and wall-bounce but do not contribute wall-run faces', () => {
    const enabled = validateLayout({ objects: [{ type: 'long_wall', position: [0, 0, 0] }] }).layout;
    const disabled = validateLayout({
      objects: [{ type: 'long_wall', position: [0, 0, 0], wallrunEnabled: false }]
    }).layout;

    expect(buildCreatorCollisionBoxes(disabled, 'creator_').length).toBe(1);
    expect(buildCreatorWallFaces(enabled).length).toBe(8); // 4 wall faces + 4 arena boundary faces
    expect(buildCreatorWallFaces(disabled).length).toBe(4); // only arena boundary faces
    expect(buildCreatorWallBounceFaces(disabled).length).toBe(8); // disabled wall still has 4 bounce faces

    const world = new CreatorWorld(disabled);
    expect(world.wallNormalAt(0, 1.25, 1)).toBeNull();
    const bounceNormal = world.wallBounceNormalAt(0, 1.25, 1);
    expect(bounceNormal).not.toBeNull();
    if (bounceNormal) expect(bounceNormal.z).toBeCloseTo(1, 3);
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

describe('CreatorLayout — collectSpawnerMarkers (shared playtest ↔ live-yard collector)', () => {
  it('collects balls, bots (with charge detection), and dummies at their placed heights', () => {
    const layout = validateLayout({
      objects: [
        { type: 'spawn_point', position: [0, 0, 0], metadata: { defaultSpawn: true } },
        { type: 'ball_spawn', position: [1, 2, 3] },
        { type: 'ball_spawn', position: [4, 0, 6] },
        { type: 'bot_spawn', position: [7, 5, 9], metadata: { label: 'Charge Bot' } },
        { type: 'bot_spawn', position: [10, 0, 12], metadata: { label: 'quick' } },
        { type: 'target_dummy', position: [13, 8, 15] },
        { type: 'long_wall', position: [0, 0, 20] } // non-spawner: ignored
      ]
    }).layout;

    const markers = collectSpawnerMarkers(layout);
    expect(markers.balls).toEqual([
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 0, z: 6 }
    ]);
    expect(markers.bots).toEqual([
      { x: 7, y: 5, z: 9, charge: true },
      { x: 10, y: 0, z: 12, charge: false }
    ]);
    expect(markers.dummies).toEqual([{ x: 13, y: 8, z: 15 }]);
  });

  it('returns empty marker sets for a layout with no spawners', () => {
    const markers = collectSpawnerMarkers(defaultCreatorLayout());
    expect(markers.balls.length + markers.bots.length + markers.dummies.length).toBe(0);
  });
});

describe('CreatorLayout — group math + prefabs (multi-select)', () => {
  const wallAt = (x: number, z: number, yaw = 0) =>
    validateLayout({ objects: [{ type: 'long_wall', position: [x, 0, z], rotation: [0, yaw, 0] }] }).layout.objects[0];

  it('objectsGroupOrigin is the XZ centroid at the lowest Y', () => {
    const a = wallAt(0, 0);
    const b = wallAt(10, 20);
    b.position = [10, 5, 20];
    const origin = objectsGroupOrigin([a, b]);
    expect(origin).toEqual({ x: 5, y: 0, z: 10 });
  });

  it('rotateObjectsAroundCenterYaw turns the group rigidly: distances to the pivot are preserved and yaws advance', () => {
    const a = wallAt(2, 0, 0);
    const b = wallAt(-2, 0, 90);
    rotateObjectsAroundCenterYaw([a, b], 0, 0, 90);
    // 90° yaw about the origin: distances preserved, both yaws advanced by 90.
    expect(Math.hypot(a.position[0], a.position[2])).toBeCloseTo(2, 6);
    expect(Math.hypot(b.position[0], b.position[2])).toBeCloseTo(2, 6);
    expect(a.rotation[1]).toBeCloseTo(90, 6);
    expect(b.rotation[1]).toBeCloseTo(180, 6);
    // The two objects stay diametrically opposite (rigid group).
    expect(a.position[0] + b.position[0]).toBeCloseTo(0, 6);
    expect(a.position[2] + b.position[2]).toBeCloseTo(0, 6);
    // Full circle returns home.
    rotateObjectsAroundCenterYaw([a, b], 0, 0, 270);
    expect(a.position[0]).toBeCloseTo(2, 5);
    expect(a.position[2]).toBeCloseTo(0, 5);
    expect(a.rotation[1]).toBeCloseTo(0, 5);
  });

  it('makePrefabFromObjects stores positions relative to the origin; instantiatePrefab restores them at a new point with fresh ids', () => {
    const a = wallAt(10, 10);
    const b = wallAt(14, 10);
    b.position = [14, 3, 10];
    const prefab = makePrefabFromObjects('Stairs', [a, b]);
    // Origin = centroid XZ (12, 10), lowest Y (0).
    expect(prefab.objects[0].position).toEqual([-2, 0, 0]);
    expect(prefab.objects[1].position).toEqual([2, 3, 0]);

    const stamped = instantiatePrefab(prefab, { x: 100, y: 1, z: -50 });
    expect(stamped[0].position).toEqual([98, 1, -50]);
    expect(stamped[1].position).toEqual([102, 4, -50]);
    expect(stamped[0].id).not.toBe(a.id);
    expect(stamped[1].id).not.toBe(b.id);
    expect(stamped[0].id).not.toBe(stamped[1].id);
    // The prefab itself is untouched by instantiation.
    expect(prefab.objects[0].position).toEqual([-2, 0, 0]);
  });

  it('sanitizePrefabs drops junk, bounds the list, and validates the objects', () => {
    expect(sanitizePrefabs(null)).toEqual([]);
    expect(sanitizePrefabs([{ name: '', objects: [] }, { name: 'x' }, 42])).toEqual([]);
    const good = sanitizePrefabs([{ name: '  Tower  ', objects: [{ type: 'long_wall', position: [0, 0, 0] }, { type: 'not_a_module' }] }]);
    expect(good.length).toBe(1);
    expect(good[0].name).toBe('Tower');
    expect(good[0].objects.length).toBe(1); // unknown module dropped by the standard sanitizer
    const many = sanitizePrefabs(Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, objects: [{ type: 'long_wall', position: [0, 0, 0] }] })));
    expect(many.length).toBe(MAX_PREFABS);
  });

  it('validateLayout carries a sanitized prefabs library through export/import round-trips', () => {
    const layout = validateLayout({
      objects: [{ type: 'long_wall', position: [0, 0, 0] }],
      prefabs: [{ name: 'Bridge', objects: [{ type: 'long_wall', position: [1, 0, 2] }] }]
    }).layout;
    expect(layout.prefabs?.length).toBe(1);
    expect(layout.prefabs?.[0].name).toBe('Bridge');
    // Round-trip through JSON (what export/import does).
    const round = validateLayout(JSON.parse(JSON.stringify(layout))).layout;
    expect(round.prefabs?.[0].objects.length).toBe(1);
  });
});
