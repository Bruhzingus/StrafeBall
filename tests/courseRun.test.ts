import { beforeEach, describe, it, expect, vi } from 'vitest';
import { committedCourseLayout, validateLayout } from '../src/game/practice/creator/CreatorLayout';
import {
  CourseRunTracker,
  CourseRunState,
  courseContentHash,
  extractCourseGates,
  isTimedCourse,
  loadCourseTimes,
  saveCourseTimes
} from '../src/game/practice/creator/CourseRun';

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  return values;
}

describe('CourseRun — gate extraction', () => {
  it('the shipped featured starter is a complete timed route with ordered checkpoints and all pad types', () => {
    const layout = committedCourseLayout();
    const gates = extractCourseGates(layout);
    expect(isTimedCourse(gates)).toBe(true);
    expect(gates.checkpoints.map((gate) => gate.metadata?.checkpointOrder)).toEqual([1, 2]);
    const types = new Set(layout.objects.map((object) => object.type));
    for (const pad of ['stamina_pad', 'backflip_pad', 'speed_pad', 'bounce_pad']) {
      expect([...types]).toContain(pad);
    }
  });

  it('finds start/finish and orders checkpoints by checkpointOrder then layout order', () => {
    const layout = validateLayout({
      objects: [
        { type: 'finish_gate', position: [0, 0, 30] },
        { type: 'checkpoint_gate', position: [0, 0, 20], metadata: { checkpointOrder: 2 } },
        { type: 'start_pad', position: [0, 0, 0] },
        { type: 'checkpoint_gate', position: [0, 0, 10], metadata: { checkpointOrder: 1 } },
        { type: 'checkpoint_gate', position: [0, 0, 25], metadata: { checkpointOrder: 2 } } // tie → layout order
      ]
    }).layout;
    const gates = extractCourseGates(layout);
    expect(isTimedCourse(gates)).toBe(true);
    expect(gates.start?.type).toBe('start_pad');
    expect(gates.finish?.type).toBe('finish_gate');
    expect(gates.checkpoints.map((c) => c.position[2])).toEqual([10, 20, 25]);
  });

  it('a layout without a start or without a finish is NOT a timed course', () => {
    const noStart = validateLayout({ objects: [{ type: 'finish_gate', position: [0, 0, 0] }] }).layout;
    const noFinish = validateLayout({ objects: [{ type: 'start_pad', position: [0, 0, 0] }] }).layout;
    expect(isTimedCourse(extractCourseGates(noStart))).toBe(false);
    expect(isTimedCourse(extractCourseGates(noFinish))).toBe(false);
  });
});

describe('CourseRun — run state machine', () => {
  it('clean run: start → checkpoints in order → finish records the elapsed time + splits', () => {
    const run = new CourseRunState(2);
    run.start(1000);
    expect(run.phase).toBe('running');
    expect(run.hitCheckpoint(0, 3000)).toBe('progress');
    expect(run.hitCheckpoint(1, 5000)).toBe('progress');
    const result = run.finish(8000);
    expect(result).toEqual({ ok: true, timeMs: 7000 });
    expect(run.phase).toBe('finished');
    expect(run.splits).toEqual([2000, 4000]);
  });

  it('skipping a checkpoint marks the miss and the finish refuses with that checkpoint number', () => {
    const run = new CourseRunState(3);
    run.start(0);
    expect(run.hitCheckpoint(0, 100)).toBe('progress');
    expect(run.hitCheckpoint(2, 200)).toBe('skip'); // skipped checkpoint 2 (index 1)
    expect(run.missedCheckpoint).toBe(2);
    const result = run.finish(300);
    expect(result).toEqual({ ok: false, missedCheckpoint: 2 });
    expect(run.phase).toBe('running'); // still running — the player can't finish a dirty run
  });

  it('reaching the finish early (checkpoints remaining, none skipped) refuses with the next number', () => {
    const run = new CourseRunState(2);
    run.start(0);
    expect(run.finish(500)).toEqual({ ok: false, missedCheckpoint: 1 });
  });

  it('re-crossing an already-collected checkpoint is a harmless repeat', () => {
    const run = new CourseRunState(2);
    run.start(0);
    run.hitCheckpoint(0, 100);
    expect(run.hitCheckpoint(0, 200)).toBe('repeat');
    expect(run.splits.length).toBe(1);
    expect(run.nextCheckpoint).toBe(1);
  });

  it('checkpoint/finish crossings while idle are inert', () => {
    const run = new CourseRunState(1);
    expect(run.hitCheckpoint(0, 100)).toBe('inactive');
    expect(run.finish(100)).toBeNull();
  });

  it('restarting at the start gate resets the attempt cleanly', () => {
    const run = new CourseRunState(2);
    run.start(0);
    run.hitCheckpoint(0, 100);
    run.hitCheckpoint(1, 200); // ...but restart instead of finishing
    run.start(1000);
    expect(run.nextCheckpoint).toBe(0);
    expect(run.splits).toEqual([]);
    expect(run.missedCheckpoint).toBeNull();
    expect(run.elapsedMs(1500)).toBe(500);
  });

  it('cancel() (death / K reset / leave) returns to idle and clears all progress', () => {
    const run = new CourseRunState(2);
    run.start(0);
    run.hitCheckpoint(0, 100);
    run.cancel();
    expect(run.phase).toBe('idle');
    expect(run.nextCheckpoint).toBe(0);
    expect(run.splits).toEqual([]);
    expect(run.finish(500)).toBeNull();
  });
});

describe('CourseRun — content hash (per-layout bests)', () => {
  it('is stable across renames/timestamps but changes on a real course edit', () => {
    const layout = validateLayout({
      objects: [
        { type: 'start_pad', position: [0, 0, 0] },
        { type: 'finish_gate', position: [0, 0, 30] }
      ]
    }).layout;
    const h1 = courseContentHash(layout);

    const renamed = { ...layout, name: 'Totally Different Name', updatedAt: '2099-01-01T00:00:00Z' };
    expect(courseContentHash(renamed)).toBe(h1);

    const edited = validateLayout({
      objects: [
        { type: 'start_pad', position: [0, 0, 0] },
        { type: 'finish_gate', position: [0, 0, 31] } // moved 1m
      ]
    }).layout;
    expect(courseContentHash(edited)).not.toBe(h1);
  });
});

describe('CourseRun tracker and local leaderboard', () => {
  beforeEach(() => installStorage());

  function timedLayout() {
    return validateLayout({
      name: 'Sprint',
      objects: [
        { type: 'start_pad', position: [0, 0, 0] },
        { type: 'checkpoint_gate', position: [0, 0, 10], metadata: { checkpointOrder: 1 } },
        { type: 'finish_gate', position: [0, 0, 20] }
      ]
    }).layout;
  }

  it('detects thin gates crossed between frames and persists a sorted per-course Top 10', () => {
    const layout = timedLayout();
    const finish = vi.fn();
    const tracker = new CourseRunTracker(layout, {
      onRunStart: vi.fn(),
      onCheckpoint: vi.fn(),
      onMissedCheckpoint: vi.fn(),
      onFinish: finish,
      onRunReset: vi.fn()
    });
    const cross = (time: number, z: number) => tracker.update(time, 0, 0, z, 0.35, false);

    cross(0, -4);
    cross(100, 4);
    cross(500, 14);
    cross(1100, 24);
    expect(finish).toHaveBeenLastCalledWith(1000, 1000, true, 1, [1000]);

    cross(1200, -30);
    cross(1300, -4);
    cross(1400, 4);
    cross(2000, 14);
    cross(2900, 24);
    expect(tracker.localRecords()).toEqual([1000, 1500]);
    expect(loadCourseTimes(courseContentHash(layout)).records).toEqual([1000, 1500]);
  });

  it('upgrades an old best/last-only payload into the leaderboard', () => {
    const layout = timedLayout();
    const hash = courseContentHash(layout);
    globalThis.localStorage.setItem(
      `strafeball:creator-course-times:v1:${hash}`,
      JSON.stringify({ bestMs: 4321, lastMs: 5000 })
    );
    expect(loadCourseTimes(hash)).toEqual({ bestMs: 4321, lastMs: 5000, records: [4321] });
  });

  it('sorts, validates, caps, and isolates local boards by course content', () => {
    const first = timedLayout();
    const second = validateLayout({
      ...first,
      objects: first.objects.map((object, index) => index === 2 ? { ...object, position: [0, 0, 30] } : object)
    }).layout;
    const firstHash = courseContentHash(first);
    const secondHash = courseContentHash(second);
    saveCourseTimes(firstHash, {
      bestMs: 999,
      lastMs: 1200,
      records: [5000, Number.NaN, -1, 4000, 3000, 2000, 1000, 6000, 7000, 8000, 9000, 10000, 11000]
    });

    expect(loadCourseTimes(firstHash).records).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
    expect(loadCourseTimes(secondHash).records).toEqual([]);
  });
});
