import { describe, expect, it } from 'vitest';
import { AdaptiveInterpDelay } from '../src/game/network/AdaptiveInterpDelay';
import {
  ADAPTIVE_INTERP_GAP_MARGIN_MS,
  ADAPTIVE_INTERP_MAX_DELAY_MS,
  ADAPTIVE_INTERP_MIN_DELAY_MS,
  INTERPOLATION_DELAY_MS,
  SNAPSHOT_INTERVAL_MS
} from '../shared/netConfig';

// Deterministic config for behavior tests (independent of the active net mode).
const testOptions = {
  startDelayMs: 75,
  minDelayMs: 40,
  maxDelayMs: 150,
  nominalIntervalMs: 16.67,
  gapDecayPerWindow: 0.92,
  shrinkPerWindowMs: 5,
  gapMarginMs: 12,
  underrunTolerance: 2
} as const;

/** A clean window: worst gap ≈ nominal interval (plus a little frame noise), no underruns. */
const CLEAN_GAP_MS = 20;

describe('AdaptiveInterpDelay', () => {
  it('starts at the mode static delay', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    expect(controller.currentDelayMs).toBe(75);
  });

  it('defaults derive from the shared net config', () => {
    const controller = new AdaptiveInterpDelay();
    expect(controller.currentDelayMs).toBe(
      Math.min(ADAPTIVE_INTERP_MAX_DELAY_MS, Math.max(ADAPTIVE_INTERP_MIN_DELAY_MS, INTERPOLATION_DELAY_MS))
    );
    // Floor must cover at least two snapshot intervals or the buffer can never bracket the cursor.
    expect(ADAPTIVE_INTERP_MIN_DELAY_MS).toBeGreaterThanOrEqual(SNAPSHOT_INTERVAL_MS * 2);
    expect(ADAPTIVE_INTERP_MAX_DELAY_MS).toBeGreaterThan(ADAPTIVE_INTERP_MIN_DELAY_MS);
    expect(ADAPTIVE_INTERP_GAP_MARGIN_MS).toBeGreaterThan(0);
  });

  it('shrinks toward the floor on a clean connection, limited per window', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    const first = controller.observeWindow(CLEAN_GAP_MS, 0);
    // Shrink is rate-limited: one window may reclaim at most shrinkPerWindowMs.
    expect(first).toBe(70);

    let delay = first;
    for (let i = 0; i < 30; i += 1) delay = controller.observeWindow(CLEAN_GAP_MS, 0);
    expect(delay).toBe(40); // clamped at the floor, never below
  });

  it('widens immediately when a delivery gap exceeds the current buffer', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    for (let i = 0; i < 30; i += 1) controller.observeWindow(CLEAN_GAP_MS, 0);
    expect(controller.currentDelayMs).toBe(40);

    // A 90ms delivery gap (server hitch + jitter stacking) must widen in ONE window.
    const widened = controller.observeWindow(90, 0);
    expect(widened).toBe(90 + testOptions.gapMarginMs);
  });

  it('widens on underruns even when no single inter-arrival gap recorded the stall', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    for (let i = 0; i < 30; i += 1) controller.observeWindow(CLEAN_GAP_MS, 0);
    const before = controller.currentDelayMs;

    // Stall straddled the window boundary: gaps look clean but frames extrapolated past tolerance.
    const widened = controller.observeWindow(CLEAN_GAP_MS, 10);
    expect(widened).toBeGreaterThan(before);
    expect(widened).toBe(
      Math.min(testOptions.maxDelayMs, before + testOptions.nominalIntervalMs + testOptions.gapMarginMs)
    );
  });

  it('tolerates occasional extrapolated frames without widening', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    for (let i = 0; i < 30; i += 1) controller.observeWindow(CLEAN_GAP_MS, 0);
    const before = controller.currentDelayMs;
    const after = controller.observeWindow(CLEAN_GAP_MS, testOptions.underrunTolerance);
    expect(after).toBeLessThanOrEqual(before);
  });

  it('never exceeds the ceiling regardless of gap size', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    expect(controller.observeWindow(3000, 500)).toBe(testOptions.maxDelayMs);
  });

  it('decays a spike back down over subsequent clean windows', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    controller.observeWindow(120, 0);
    const spiked = controller.currentDelayMs;
    expect(spiked).toBe(120 + testOptions.gapMarginMs);

    let delay = spiked;
    for (let i = 0; i < 60; i += 1) delay = controller.observeWindow(CLEAN_GAP_MS, 0);
    expect(delay).toBe(testOptions.minDelayMs);

    // Recovery is gradual (decay + shrink limit), not a cliff: still above floor after 3 windows.
    const again = new AdaptiveInterpDelay(testOptions);
    again.observeWindow(120, 0);
    again.observeWindow(CLEAN_GAP_MS, 0);
    again.observeWindow(CLEAN_GAP_MS, 0);
    again.observeWindow(CLEAN_GAP_MS, 0);
    expect(again.currentDelayMs).toBeGreaterThan(testOptions.minDelayMs);
    expect(again.currentDelayMs).toBeLessThan(spiked);
  });

  it('a repeatedly jittery connection holds a wide buffer instead of oscillating', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    // Alternate clean and spiky windows (the friend's connection during server hitches).
    let minSeen = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 20; i += 1) {
      controller.observeWindow(i % 3 === 0 ? 80 : CLEAN_GAP_MS, 0);
      if (i >= 3) minSeen = Math.min(minSeen, controller.currentDelayMs);
    }
    // The decayed peak keeps the buffer sized for the recurring spike, not the clean windows.
    expect(minSeen).toBeGreaterThanOrEqual(80 * 0.92 * 0.92 + testOptions.gapMarginMs - testOptions.shrinkPerWindowMs);
  });

  it('reset returns to the static start delay and forgets learned jitter', () => {
    const controller = new AdaptiveInterpDelay(testOptions);
    controller.observeWindow(140, 50);
    controller.reset();
    expect(controller.currentDelayMs).toBe(75);
    // After reset a clean window shrinks normally (no lingering peak).
    expect(controller.observeWindow(CLEAN_GAP_MS, 0)).toBe(70);
  });
});
