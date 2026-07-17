import { describe, it, expect } from 'vitest';
import {
  validateLayout,
  sanitizeTriggerSpec,
  remapTriggerTargets,
  instantiatePrefab,
  makePrefabFromObjects,
  CreatorLayout,
  CreatorLayoutObject,
  CreatorTriggerSpec
} from '../src/game/practice/creator/CreatorLayout';
import { buildCreatorCollisionBoxes, buildCreatorWallFaces, buildCreatorWallBounceFaces } from '../src/game/practice/creator/CreatorWorld';
import { CreatorTriggers } from '../src/game/practice/creator/CreatorTriggers';
import type { PlayerController } from '../src/game/player/PlayerController';

describe('sanitizeTriggerSpec', () => {
  it('accepts a well-formed spec and keeps its fields', () => {
    const spec = sanitizeTriggerSpec({ by: 'ball', fire: 'toggle', action: 'hide', targets: ['a', 'b'], channel: 'gate_a' });
    expect(spec).toEqual({ by: 'ball', fire: 'toggle', action: 'hide', targets: ['a', 'b'], channel: 'gate_a' });
  });

  it('falls back to safe defaults for unknown enum values instead of dropping the spec', () => {
    const spec = sanitizeTriggerSpec({ by: 'wizard', fire: 'sometimes', action: 'explode' });
    expect(spec).toEqual({ by: 'player', fire: 'once', action: 'show' });
  });

  it('demotes teleport_player + toggle/while to every (teleport has no inverse)', () => {
    expect(sanitizeTriggerSpec({ action: 'teleport_player', fire: 'toggle' })?.fire).toBe('every');
    expect(sanitizeTriggerSpec({ action: 'teleport_player', fire: 'while' })?.fire).toBe('every');
    // A non-inverting fire mode is left alone.
    expect(sanitizeTriggerSpec({ action: 'teleport_player', fire: 'once' })?.fire).toBe('once');
  });

  it('keeps the move offset only for the move action', () => {
    expect(sanitizeTriggerSpec({ action: 'move', offset: [1, 2, 3] })?.offset).toEqual([1, 2, 3]);
    expect(sanitizeTriggerSpec({ action: 'show', offset: [1, 2, 3] })?.offset).toBeUndefined();
  });

  it('de-dupes and bounds targets', () => {
    const spec = sanitizeTriggerSpec({ action: 'show', targets: ['a', 'a', 'b'] });
    expect(spec?.targets).toEqual(['a', 'b']);
  });

  it('returns undefined for a non-object', () => {
    expect(sanitizeTriggerSpec(null)).toBeUndefined();
    expect(sanitizeTriggerSpec('nope')).toBeUndefined();
  });
});

describe('trigger metadata survives validateLayout (persistence/import/co-op path)', () => {
  it('round-trips a trigger_volume with a spec + a listener with a channel', () => {
    const { layout } = validateLayout({
      objects: [
        { id: 'trig', type: 'trigger_volume', position: [0, 0, 0], metadata: { triggerSpec: { by: 'any', fire: 'while', action: 'collide_off', channel: 'door' } } },
        { id: 'wall', type: 'long_wall', position: [5, 0, 0], metadata: { listenChannel: 'door' } }
      ]
    });
    const trig = layout.objects.find((o) => o.id === 'trig');
    const wall = layout.objects.find((o) => o.id === 'wall');
    expect(trig?.metadata?.triggerSpec).toEqual({ by: 'any', fire: 'while', action: 'collide_off', channel: 'door' });
    expect(wall?.metadata?.listenChannel).toBe('door');
  });

  it('does NOT let a trigger_volume hijack course-gate timing (separate key from triggerType)', () => {
    const { layout } = validateLayout({
      objects: [{ id: 't', type: 'trigger_volume', position: [0, 0, 0], metadata: { triggerSpec: { by: 'player', fire: 'once', action: 'show' } } }]
    });
    // A trigger volume must never carry a course triggerType, or extractCourseGates would adopt it.
    expect(layout.objects[0].metadata?.triggerType).toBeUndefined();
  });

  it('an existing moving_platform serializes WITHOUT startPaused (no content-hash churn)', () => {
    const { layout } = validateLayout({
      objects: [{ id: 'm', type: 'moving_platform', position: [0, 0, 0], metadata: { mover: { dx: 10, dy: 0, dz: 0, speed: 4, pauseSeconds: 0.5 } } }]
    });
    expect('startPaused' in (layout.objects[0].metadata!.mover as object)).toBe(false);
  });

  it('startPaused survives only when explicitly true', () => {
    const { layout } = validateLayout({
      objects: [{ id: 'm', type: 'moving_platform', position: [0, 0, 0], metadata: { mover: { dx: 10, dy: 0, dz: 0, speed: 4, pauseSeconds: 0.5, startPaused: true } } }]
    });
    expect(layout.objects[0].metadata?.mover?.startPaused).toBe(true);
  });
});

describe('remapTriggerTargets — copy/paste/prefab keep internal links, drop external ones onto originals', () => {
  function trigger(id: string, targets: string[]): CreatorLayoutObject {
    return { id, type: 'trigger_volume', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], metadata: { triggerSpec: { by: 'player', fire: 'once', action: 'show', targets } } };
  }

  it('remaps a target that was cloned, preserves one that was not', () => {
    const objs = [trigger('t1', ['door1', 'external'])];
    remapTriggerTargets(objs, new Map([['door1', 'door1_copy'], ['t1', 't1_copy']]));
    expect(objs[0].metadata?.triggerSpec?.targets).toEqual(['door1_copy', 'external']);
  });

  it('leaves triggers with no targets untouched', () => {
    const objs: CreatorLayoutObject[] = [{ id: 'x', type: 'long_wall', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
    expect(() => remapTriggerTargets(objs, new Map())).not.toThrow();
  });
});

describe('instantiatePrefab remaps internal trigger links', () => {
  it('a stamped prefab of trigger+door drives the STAMPED door, not the source', () => {
    const source: CreatorLayoutObject[] = [
      { id: 'src_trig', type: 'trigger_volume', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], metadata: { triggerSpec: { by: 'player', fire: 'once', action: 'hide', targets: ['src_door'] } } },
      { id: 'src_door', type: 'long_wall', position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
    ];
    const prefab = makePrefabFromObjects('gate', source);
    const stamped = instantiatePrefab(prefab, { x: 100, y: 0, z: 0 });
    const stampedTrig = stamped.find((o) => o.type === 'trigger_volume')!;
    const stampedDoor = stamped.find((o) => o.type === 'long_wall')!;
    // The trigger's single target is the stamped door's NEW id — not the prefab's stored source id.
    expect(stampedTrig.metadata?.triggerSpec?.targets).toEqual([stampedDoor.id]);
    expect(stampedDoor.id).not.toBe('src_door');
  });
});

// -------------------------------------------------------------------------------------------------
// Runtime behaviour — fire modes, effects, edges, and the teleport sweep guard. Headless: geometry
// and movers are null (both are optional collaborators), the player is a positional stub.
// -------------------------------------------------------------------------------------------------

describe('CreatorTriggers — runtime', () => {
  /** trigger at [0,0,0] (4x4x4 volume) + a long_wall target at [30,0,0]. */
  function makeWorld(spec: CreatorTriggerSpec) {
    const { layout } = validateLayout({
      objects: [
        { id: 'trig', type: 'trigger_volume', position: [0, 0, 0], metadata: { triggerSpec: { ...spec, targets: spec.targets ?? ['wall'] } } },
        { id: 'wall', type: 'long_wall', position: [30, 0, 0] }
      ]
    });
    const boxes = buildCreatorCollisionBoxes(layout, 'test_');
    const runFaces = buildCreatorWallFaces(layout);
    const bounceFaces = buildCreatorWallBounceFaces(layout);
    const triggers = new CreatorTriggers();
    triggers.build(layout, boxes, runFaces, bounceFaces, null, null, 'test_');
    const wallBox = boxes.find((b) => b.id?.startsWith('test_wall_'))!;
    return { layout, boxes, runFaces, triggers, wallBox };
  }

  type StubPlayer = PlayerController & { pos: { x: number; y: number; z: number } };
  function stubPlayer(x: number, y: number, z: number): StubPlayer {
    const pos = { x, y, z };
    return {
      pos,
      root: { position: pos },
      teleportTo: (target: { x: number; y: number; z: number }) => {
        pos.x = target.x;
        pos.y = target.y;
        pos.z = target.z;
      }
    } as unknown as StubPlayer;
  }

  it('collide_off makes the target colliders AND wall faces intangible on entry; reset restores', () => {
    const { layout, triggers, wallBox, runFaces } = makeWorld({ by: 'player', fire: 'once', action: 'collide_off' });
    const wallFaces = runFaces.filter((f) => f.objectId === 'wall');
    expect(wallFaces.length).toBeGreaterThan(0);
    triggers.update(1 / 60, layout, stubPlayer(0, 0, 0)); // standing inside the volume
    expect(wallBox.enabled).toBe(false);
    expect(wallFaces.every((f) => f.enabled === false)).toBe(true);
    triggers.reset();
    expect(wallBox.enabled).toBe(true);
    expect(wallFaces.every((f) => f.enabled === true)).toBe(true);
  });

  it("'once' fires exactly once per run; reset re-arms it and reverts the effect", () => {
    const { layout, triggers, wallBox } = makeWorld({ by: 'player', fire: 'once', action: 'move', offset: [5, 0, 0] });
    const player = stubPlayer(0, 0, 0);
    const startMinX = wallBox.minX;
    triggers.update(1 / 60, layout, player); // enter -> fire (+5)
    player.pos.x = 50; // leave
    triggers.update(1 / 60, layout, player);
    player.pos.x = 0; // re-enter -> must NOT fire again
    triggers.update(1 / 60, layout, player);
    expect(wallBox.minX).toBeCloseTo(startMinX + 5, 6);
    triggers.reset(); // wall back home + trigger re-armed
    expect(wallBox.minX).toBeCloseTo(startMinX, 6);
    triggers.update(1 / 60, layout, player);
    expect(wallBox.minX).toBeCloseTo(startMinX + 5, 6);
  });

  it("'every' re-fires per fresh entry (offsets stack); staying inside does not re-fire", () => {
    const { layout, triggers, wallBox } = makeWorld({ by: 'player', fire: 'every', action: 'move', offset: [5, 0, 0] });
    const player = stubPlayer(0, 0, 0);
    const startMinX = wallBox.minX;
    triggers.update(1 / 60, layout, player); // enter (+5)
    triggers.update(1 / 60, layout, player); // still inside — no re-fire
    expect(wallBox.minX).toBeCloseTo(startMinX + 5, 6);
    player.pos.x = 50;
    triggers.update(1 / 60, layout, player); // leave
    player.pos.x = 0;
    triggers.update(1 / 60, layout, player); // re-enter (+5 again)
    expect(wallBox.minX).toBeCloseTo(startMinX + 10, 6);
  });

  it("'toggle' alternates the action and its inverse per entry", () => {
    const { layout, triggers, wallBox } = makeWorld({ by: 'player', fire: 'toggle', action: 'collide_off' });
    const player = stubPlayer(0, 0, 0);
    triggers.update(1 / 60, layout, player); // entry 1 -> off
    expect(wallBox.enabled).toBe(false);
    player.pos.x = 50;
    triggers.update(1 / 60, layout, player);
    player.pos.x = 0;
    triggers.update(1 / 60, layout, player); // entry 2 -> back on
    expect(wallBox.enabled).toBe(true);
  });

  it("'while' holds only while occupied and reverts on exit", () => {
    const { layout, triggers, wallBox } = makeWorld({ by: 'player', fire: 'while', action: 'collide_off' });
    const player = stubPlayer(0, 0, 0);
    triggers.update(1 / 60, layout, player);
    expect(wallBox.enabled).toBe(false); // held while inside
    player.pos.x = 50;
    triggers.update(1 / 60, layout, player);
    expect(wallBox.enabled).toBe(true); // reverted on exit
  });

  it('channel listeners respond without a direct link', () => {
    const { layout } = validateLayout({
      objects: [
        { id: 'trig', type: 'trigger_volume', position: [0, 0, 0], metadata: { triggerSpec: { by: 'player', fire: 'once', action: 'collide_off', channel: 'door' } } },
        { id: 'wall', type: 'long_wall', position: [30, 0, 0], metadata: { listenChannel: 'door' } }
      ]
    });
    const boxes = buildCreatorCollisionBoxes(layout, 'test_');
    const triggers = new CreatorTriggers();
    triggers.build(layout, boxes, buildCreatorWallFaces(layout), buildCreatorWallBounceFaces(layout), null, null, 'test_');
    triggers.update(1 / 60, layout, stubPlayer(0, 0, 0));
    const wallBox = boxes.find((b) => b.id?.startsWith('test_wall_'))!;
    expect(wallBox.enabled).toBe(false);
  });

  it('a dangling target id is skipped without throwing', () => {
    const { layout, triggers } = makeWorld({ by: 'player', fire: 'every', action: 'hide', targets: ['deleted_object'] });
    expect(() => triggers.update(1 / 60, layout, stubPlayer(0, 0, 0))).not.toThrow();
  });

  it('a disable fired earlier in the same frame silences a trigger evaluated later', () => {
    const { layout } = validateLayout({
      objects: [
        { id: 'trig2', type: 'trigger_volume', position: [0, 0, 0], metadata: { triggerSpec: { by: 'player', fire: 'once', action: 'disable', targets: ['trig'] } } },
        { id: 'trig', type: 'trigger_volume', position: [0, 0, 0], metadata: { triggerSpec: { by: 'player', fire: 'every', action: 'move', offset: [5, 0, 0], targets: ['wall'] } } },
        { id: 'wall', type: 'long_wall', position: [30, 0, 0] }
      ]
    });
    const boxes = buildCreatorCollisionBoxes(layout, 'test_');
    const triggers = new CreatorTriggers();
    triggers.build(layout, boxes, buildCreatorWallFaces(layout), buildCreatorWallBounceFaces(layout), null, null, 'test_');
    const wallBox = boxes.find((b) => b.id?.startsWith('test_wall_'))!;
    const startMinX = wallBox.minX;
    triggers.update(1 / 60, layout, stubPlayer(0, 0, 0));
    expect(wallBox.minX).toBeCloseTo(startMinX, 6); // trig was disabled before it could move the wall
  });

  it('a held ball does not fire a ball trigger; a loose one does', () => {
    const { layout, triggers, wallBox } = makeWorld({ by: 'ball', fire: 'once', action: 'collide_off' });
    const player = stubPlayer(500, 0, 500); // far away — only balls can touch it
    const mkBall = (state: string) => ({ state, mesh: { position: { x: 0, y: 0.3, z: 0 } } });
    triggers.setBalls([mkBall('held')] as never);
    triggers.update(1 / 60, layout, player);
    expect(wallBox.enabled).not.toBe(false);
    triggers.setBalls([mkBall('loose')] as never);
    triggers.update(1 / 60, layout, player);
    expect(wallBox.enabled).toBe(false);
  });

  it('a teleport does not sweep the jump through triggers evaluated later in the same frame', () => {
    // tp (listed first) teleports the player to [0,0,0]; the bystander at [10,0,10] lies on the
    // straight line from the player's pre-jump position [16,0,16] to that destination. Without the
    // in-frame sweep guard, the bystander (evaluated after tp) would sweep pre-jump -> post-jump
    // straight through its volume and fire.
    const { layout } = validateLayout({
      objects: [
        { id: 'tp', type: 'trigger_volume', position: [0, 0, 0], scale: [2, 1, 2], metadata: { triggerSpec: { by: 'player', fire: 'every', action: 'teleport_player' } } },
        { id: 'bystander', type: 'trigger_volume', position: [10, 0, 10], metadata: { triggerSpec: { by: 'player', fire: 'every', action: 'move', offset: [5, 0, 0], targets: ['wall'] } } },
        { id: 'wall', type: 'long_wall', position: [60, 0, 60] }
      ]
    });
    const boxes = buildCreatorCollisionBoxes(layout, 'test_');
    const triggers = new CreatorTriggers();
    triggers.build(layout, boxes, buildCreatorWallFaces(layout), buildCreatorWallBounceFaces(layout), null, null, 'test_');
    const wallBox = boxes.find((b) => b.id?.startsWith('test_wall_'))!;
    const startMinX = wallBox.minX;

    // Frame 1 establishes the sweep origin at [16,0,16] — outside everything, and placed so the
    // segment from there to the teleport destination [0,0,0] passes straight through the bystander
    // at [10,0,10]. Without the guard, the bystander (evaluated after tp) sweeps origin → live
    // post-teleport position (22.6m, under the 24m cap) through its own volume and fires.
    const player = stubPlayer(16, 0, 16);
    triggers.update(1 / 60, layout, player);
    // Frame 2: step into tp's volume. tp fires first (layout order), teleporting the player to
    // [0,0,0] and nulling the in-frame sweep origin; the bystander then sees only the point [0,0,0].
    player.pos.x = 1;
    player.pos.z = 1;
    triggers.update(1 / 60, layout, player);
    expect(player.pos.x).toBe(0); // teleported to tp's own position
    expect(player.pos.z).toBe(0);
    expect(wallBox.minX).toBeCloseTo(startMinX, 6); // bystander never fired
  });
});
