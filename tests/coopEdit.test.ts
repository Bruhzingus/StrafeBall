import { describe, it, expect } from 'vitest';
import {
  COOP_EDIT_LIMITS,
  cleanCoopName,
  sanitizeCoopObjectShallow,
  sanitizeCoopPresence,
  sanitizeObjectId,
  sanityCheckCourseJson
} from '../shared/coopEdit';
import { blankCourseLayout, committedCourseLayout } from '../src/game/practice/creator/CreatorLayout';

describe('coopEdit — course blob sanity check (server trust boundary)', () => {
  it('accepts real course layouts', () => {
    for (const layout of [blankCourseLayout(), committedCourseLayout()]) {
      const result = sanityCheckCourseJson(JSON.stringify(layout));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.objectCount).toBe(layout.objects.length);
    }
  });

  it('rejects junk, oversized, malformed, and object bombs', () => {
    expect(sanityCheckCourseJson(undefined).ok).toBe(false);
    expect(sanityCheckCourseJson('').ok).toBe(false);
    expect(sanityCheckCourseJson('{not json').ok).toBe(false);
    expect(sanityCheckCourseJson('[]').ok).toBe(false);
    expect(sanityCheckCourseJson('{"name":"x"}')).toEqual({ ok: false, reason: 'missing-objects' });
    const bomb = JSON.stringify({ objects: new Array(COOP_EDIT_LIMITS.maxObjects + 1).fill({}) });
    expect(sanityCheckCourseJson(bomb)).toEqual({ ok: false, reason: 'too-many-objects' });
    const oversized = '"' + 'x'.repeat(COOP_EDIT_LIMITS.maxCourseJsonChars + 5) + '"';
    expect(sanityCheckCourseJson(oversized)).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('coopEdit — object id + shallow object sanitizer', () => {
  it('accepts short non-empty ids, rejects the rest', () => {
    expect(sanitizeObjectId('wall_47')).toBe('wall_47');
    expect(sanitizeObjectId('  spaced  ')).toBe('spaced');
    expect(sanitizeObjectId('')).toBeNull();
    expect(sanitizeObjectId('   ')).toBeNull();
    expect(sanitizeObjectId(42)).toBeNull();
    expect(sanitizeObjectId('x'.repeat(COOP_EDIT_LIMITS.maxIdLength + 1))).toBeNull();
  });

  it('accepts an object carrying a usable id within the size cap; rejects the rest', () => {
    expect(sanitizeCoopObjectShallow({ id: 'a', type: 'long_wall', position: [1, 2, 3] })).toEqual({ id: 'a' });
    expect(sanitizeCoopObjectShallow({ type: 'long_wall' })).toBeNull(); // no id
    expect(sanitizeCoopObjectShallow(null)).toBeNull();
    expect(sanitizeCoopObjectShallow([])).toBeNull();
    expect(sanitizeCoopObjectShallow('nope')).toBeNull();
    const fat = { id: 'a', blob: 'x'.repeat(COOP_EDIT_LIMITS.maxObjectJsonChars) };
    expect(sanitizeCoopObjectShallow(fat)).toBeNull();
  });
});

describe('coopEdit — presence sanitizer', () => {
  it('passes a normal presence through, defaulting mode + selection', () => {
    expect(sanitizeCoopPresence({ x: 5, y: 6, z: 7, yaw: 1, mode: 'playtest', selection: 'obj_9' }))
      .toEqual({ x: 5, y: 6, z: 7, yaw: 1, mode: 'playtest', selection: 'obj_9' });
    expect(sanitizeCoopPresence({ x: 0, y: 0, z: 0, yaw: 0 }))
      .toEqual({ x: 0, y: 0, z: 0, yaw: 0, mode: 'build', selection: '' });
  });

  it('rejects non-finite poses (msgpack can carry NaN/Infinity) and clamps coordinates', () => {
    expect(sanitizeCoopPresence({ x: Number.NaN, y: 0, z: 0, yaw: 0 })).toBeNull();
    expect(sanitizeCoopPresence({ x: 0, y: Number.POSITIVE_INFINITY, z: 0, yaw: 0 })).toBeNull();
    expect(sanitizeCoopPresence(undefined)).toBeNull();
    const clamped = sanitizeCoopPresence({ x: 1e12, y: 0, z: 0, yaw: 0 });
    expect(clamped!.x).toBe(COOP_EDIT_LIMITS.maxCoordinate);
  });

  it('coerces an unknown mode to build and drops an oversized selection id', () => {
    expect(sanitizeCoopPresence({ x: 0, y: 0, z: 0, yaw: 0, mode: 'hacker' })!.mode).toBe('build');
    const p = sanitizeCoopPresence({ x: 0, y: 0, z: 0, yaw: 0, selection: 'x'.repeat(COOP_EDIT_LIMITS.maxIdLength + 1) });
    expect(p!.selection).toBe('');
  });
});

describe('coopEdit — name cleaning', () => {
  it('trims, strips control chars, caps, and falls back to Builder', () => {
    expect(cleanCoopName('  Randall  ')).toBe('Randall');
    expect(cleanCoopName('BadName')).toBe('BadName');
    expect(cleanCoopName('x'.repeat(100)).length).toBe(COOP_EDIT_LIMITS.maxNameLength);
    expect(cleanCoopName('')).toBe('Builder');
    expect(cleanCoopName(undefined)).toBe('Builder');
  });
});
