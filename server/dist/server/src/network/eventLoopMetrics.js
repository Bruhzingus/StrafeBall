"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENT_LOOP_SAMPLE_RESOLUTION_MS = void 0;
exports.eventLoopExcessDelayMs = eventLoopExcessDelayMs;
/** Node's histogram records the interval between timer samples, including this resolution. */
exports.EVENT_LOOP_SAMPLE_RESOLUTION_MS = 20;
/**
 * Approximate timer overshoot, rather than reporting the sampling interval itself as a stall.
 * An idle 20ms monitor normally reports about 20ms raw. NaN means no samples yet.
 * This is diagnostic timer lateness, not a precise measure of any single callback's duration.
 */
function eventLoopExcessDelayMs(sampleNs) {
    if (!Number.isFinite(sampleNs))
        return 0;
    return Math.max(0, sampleNs / 1_000_000 - exports.EVENT_LOOP_SAMPLE_RESOLUTION_MS);
}
