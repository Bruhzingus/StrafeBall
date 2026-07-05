import { describe, it, expect } from 'vitest';
import { validateLayout } from '../src/game/practice/creator/CreatorLayout';
import {
  CourseRunState,
  courseContentHash,
  extractCourseGates,
  isTimedCourse
} from '../src/game/practice/creator/CourseRun';

describe('CourseRun — gate extraction', () => {
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
