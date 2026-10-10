import { describe, expect, it } from 'vitest';
import { eventLoopExcessDelayMs } from '../src/network/eventLoopMetrics';

describe('event-loop diagnostic calibration', () => {
  it('does not classify the normal 20ms sampling interval as host stall time', () => {
    expect(eventLoopExcessDelayMs(20_000_000)).toBe(0);
    expect(eventLoopExcessDelayMs(20_800_000)).toBeCloseTo(0.8);
  });

  it('reports timer overshoot from a blocked loop', () => {
    expect(eventLoopExcessDelayMs(120_000_000)).toBe(100);
  });

  it('handles empty histograms and early timer wakeups without negative or NaN diagnostics', () => {
    for (const value of [NaN, Infinity, 0, 511, 19_000_000]) {
      expect(eventLoopExcessDelayMs(value)).toBe(0);
    }
  });
});
