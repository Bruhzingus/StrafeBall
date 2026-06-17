import { describe, expect, it } from 'vitest';
import { advanceSnapshotDeadline } from '../src/rooms/snapshotScheduler';

function simulateBrokenDecoupledScheduler({
  durationMs,
  wakeMs,
  stepMs,
  snapshotMs
}: {
  durationMs: number;
  wakeMs: number;
  stepMs: number;
  snapshotMs: number;
}): number {
  let now = 0;
  let lastWake = 0;
  let simAccumulator = 0;
  let nextSnapshotDueAtMs = snapshotMs;
  let sent = 0;

  while (now < durationMs) {
    now += wakeMs;
    simAccumulator += now - lastWake;
    lastWake = now;

    while (simAccumulator + 0.001 >= stepMs) {
      simAccumulator -= stepMs;
      if (now + 0.001 < nextSnapshotDueAtMs) continue;
      sent += 1;
      // Old behavior: late send re-phases from "now", which is what collapses the long-term rate.
      nextSnapshotDueAtMs = now + snapshotMs;
    }
  }

  return sent;
}

function simulateFixedDecoupledScheduler({
  durationMs,
  wakeMs,
  snapshotMs
}: {
  durationMs: number;
  wakeMs: number;
  snapshotMs: number;
}): number {
  let now = 0;
  let nextSnapshotDueAtMs = snapshotMs;
  let sent = 0;

  while (now < durationMs) {
    now += wakeMs;
    if (now + 0.001 < nextSnapshotDueAtMs) continue;
    sent += 1;
    nextSnapshotDueAtMs = advanceSnapshotDeadline(nextSnapshotDueAtMs, now, snapshotMs).nextDueAtMs;
  }

  return sent;
}

describe('advanceSnapshotDeadline', () => {
  it('preserves cadence instead of re-phasing to now when a wake lands late', () => {
    const schedule = advanceSnapshotDeadline(10.4167, 15, 10.4167);
    expect(schedule.skippedIntervals).toBe(0);
    expect(schedule.nextDueAtMs).toBeCloseTo(20.8334, 3);
  });

  it('counts skipped visual snapshots during a long hitch without queueing stale ones', () => {
    const schedule = advanceSnapshotDeadline(10, 37, 10);
    expect(schedule.skippedIntervals).toBe(2);
    expect(schedule.nextDueAtMs).toBe(40);
  });

  it('avoids the low-70s rate collapse for 180/180/96 under a 200Hz wake', () => {
    const durationMs = 5 * 60 * 1000;
    const snapshotMs = 1000 / 96;
    const stepMs = 1000 / 180;
    const wakeMs = 5;

    const broken = simulateBrokenDecoupledScheduler({ durationMs, wakeMs, stepMs, snapshotMs });
    const fixed = simulateFixedDecoupledScheduler({ durationMs, wakeMs, snapshotMs });

    expect((broken * 1000) / durationMs).toBeLessThan(75);
    expect((fixed * 1000) / durationMs).toBeGreaterThan(95);
  });
});
