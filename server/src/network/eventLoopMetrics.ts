/** Node's histogram records the interval between timer samples, including this resolution. */
export const EVENT_LOOP_SAMPLE_RESOLUTION_MS = 20;

/**
 * Approximate timer overshoot, rather than reporting the sampling interval itself as a stall.
 * An idle 20ms monitor normally reports about 20ms raw. NaN means no samples yet.
 * This is diagnostic timer lateness, not a precise measure of any single callback's duration.
 */
export function eventLoopExcessDelayMs(sampleNs: number): number {
  if (!Number.isFinite(sampleNs)) return 0;
  return Math.max(0, sampleNs / 1_000_000 - EVENT_LOOP_SAMPLE_RESOLUTION_MS);
}
