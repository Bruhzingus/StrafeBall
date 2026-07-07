import { describe, it, expect } from 'vitest';
import {
  COURSE_RACE_LIMITS,
  cleanRaceName,
  sanitizePose,
  sanitizeRunEvent,
  sanityCheckCourseJson
} from '../shared/courseRace';
import { blankCourseLayout, committedCourseLayout } from '../src/game/practice/creator/CreatorLayout';

describe('courseRace — course blob sanity check (the server-side trust boundary)', () => {
  it('accepts real course layouts (blank + the committed starter)', () => {
    for (const layout of [blankCourseLayout(), committedCourseLayout()]) {
      const result = sanityCheckCourseJson(JSON.stringify(layout));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.objectCount).toBe(layout.objects.length);
    }
  });

  it('rejects non-strings, empty strings, and oversized blobs without parsing them', () => {
    expect(sanityCheckCourseJson(undefined).ok).toBe(false);
    expect(sanityCheckCourseJson(null).ok).toBe(false);
    expect(sanityCheckCourseJson(42).ok).toBe(false);
    expect(sanityCheckCourseJson({}).ok).toBe(false);
    expect(sanityCheckCourseJson('').ok).toBe(false);
    const oversized = '"' + 'x'.repeat(COURSE_RACE_LIMITS.maxCourseJsonChars + 10) + '"';
    const result = sanityCheckCourseJson(oversized);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('rejects malformed JSON and non-layout shapes instead of throwing', () => {
    expect(sanityCheckCourseJson('{not json').ok).toBe(false);
    expect(sanityCheckCourseJson('null').ok).toBe(false);
    expect(sanityCheckCourseJson('123').ok).toBe(false);
    expect(sanityCheckCourseJson('[]').ok).toBe(false);
    expect(sanityCheckCourseJson('{"name":"x"}')).toEqual({ ok: false, reason: 'missing-objects' });
    expect(sanityCheckCourseJson('{"objects":"lots"}')).toEqual({ ok: false, reason: 'missing-objects' });
  });

  it('rejects object-count bombs and arrays holding non-object entries', () => {
    const bomb = JSON.stringify({ objects: new Array(COURSE_RACE_LIMITS.maxObjects + 1).fill({}) });
    expect(sanityCheckCourseJson(bomb)).toEqual({ ok: false, reason: 'too-many-objects' });
    expect(sanityCheckCourseJson('{"objects":[1,2,3]}')).toEqual({ ok: false, reason: 'malformed-object' });
    expect(sanityCheckCourseJson('{"objects":[null]}')).toEqual({ ok: false, reason: 'malformed-object' });
    expect(sanityCheckCourseJson('{"objects":[[]]}')).toEqual({ ok: false, reason: 'malformed-object' });
  });
});

describe('courseRace — pose sanitizer (msgpack can carry NaN/Infinity, JSON cannot)', () => {
  it('passes a normal pose through unchanged', () => {
    expect(sanitizePose({ x: 657, y: 2.5, z: -5, yaw: 1.57 })).toEqual({ x: 657, y: 2.5, z: -5, yaw: 1.57 });
  });

  it('rejects missing/non-finite fields outright', () => {
    expect(sanitizePose(undefined)).toBeNull();
    expect(sanitizePose('pose')).toBeNull();
    expect(sanitizePose({ x: 1, y: 2, z: 3 })).toBeNull(); // no yaw
    expect(sanitizePose({ x: Number.NaN, y: 0, z: 0, yaw: 0 })).toBeNull();
    expect(sanitizePose({ x: 0, y: Number.POSITIVE_INFINITY, z: 0, yaw: 0 })).toBeNull();
    expect(sanitizePose({ x: 0, y: 0, z: 0, yaw: 'north' })).toBeNull();
  });

  it('clamps absurd-but-finite coordinates instead of relaying them', () => {
    const pose = sanitizePose({ x: 1e12, y: -1e12, z: 0, yaw: 0 });
    expect(pose).not.toBeNull();
    expect(pose!.x).toBe(COURSE_RACE_LIMITS.maxCoordinate);
    expect(pose!.y).toBe(-COURSE_RACE_LIMITS.maxCoordinate);
  });
});

describe('courseRace — run-event sanitizer', () => {
  it('accepts the four kinds with valid payloads', () => {
    expect(sanitizeRunEvent({ kind: 'start' })).toEqual({ kind: 'start' });
    expect(sanitizeRunEvent({ kind: 'reset' })).toEqual({ kind: 'reset' });
    expect(sanitizeRunEvent({ kind: 'checkpoint', checkpoint: 2, checkpointTotal: 3, timeMs: 12345.6 }))
      .toEqual({ kind: 'checkpoint', checkpoint: 2, checkpointTotal: 3, timeMs: 12346 });
    expect(sanitizeRunEvent({ kind: 'finish', timeMs: 41200 })).toEqual({ kind: 'finish', timeMs: 41200 });
  });

  it('rejects unknown kinds and a finish without a time', () => {
    expect(sanitizeRunEvent({ kind: 'teleport-hack' })).toBeNull();
    expect(sanitizeRunEvent({})).toBeNull();
    expect(sanitizeRunEvent(null)).toBeNull();
    expect(sanitizeRunEvent({ kind: 'finish' })).toBeNull();
  });

  it('rejects negative, non-finite, and absurd times/counts', () => {
    expect(sanitizeRunEvent({ kind: 'finish', timeMs: -5 })).toBeNull();
    expect(sanitizeRunEvent({ kind: 'finish', timeMs: Number.NaN })).toBeNull();
    expect(sanitizeRunEvent({ kind: 'finish', timeMs: COURSE_RACE_LIMITS.maxTimeMs + 1 })).toBeNull();
    expect(sanitizeRunEvent({ kind: 'checkpoint', checkpoint: -1 })).toBeNull();
    expect(sanitizeRunEvent({ kind: 'checkpoint', checkpoint: 99999 })).toBeNull();
  });

  it('drops extra/unknown fields instead of relaying them', () => {
    const event = sanitizeRunEvent({ kind: 'start', script: '<img onerror=alert(1)>', __proto__: { hacked: true } });
    expect(event).toEqual({ kind: 'start' });
  });
});

describe('courseRace — name cleaning', () => {
  it('trims, strips control characters, and caps length', () => {
    expect(cleanRaceName('  Randall  ')).toBe('Randall');
    expect(cleanRaceName('Bad\u0007Name')).toBe('BadName');
    expect(cleanRaceName('x'.repeat(100)).length).toBe(COURSE_RACE_LIMITS.maxNameLength);
  });

  it('falls back to "Racer" for empty/invalid input', () => {
    expect(cleanRaceName('')).toBe('Racer');
    expect(cleanRaceName('   ')).toBe('Racer');
    expect(cleanRaceName(undefined)).toBe('Racer');
    expect(cleanRaceName(42)).toBe('Racer');
  });
});
