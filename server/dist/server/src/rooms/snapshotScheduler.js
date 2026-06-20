"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.advanceSnapshotDeadline = advanceSnapshotDeadline;
/**
 * Advance a periodic snapshot deadline without re-phasing it to "now".
 * Preserving the original cadence avoids timer-drift rate collapse when the room wake lands a
 * little late: a 96 Hz target should alternate short/long wake gaps, not permanently fall back to
 * the wake interval's coarser harmonics.
 */
function advanceSnapshotDeadline(dueAtMs, actualNowMs, intervalMs) {
    if (actualNowMs + 0.001 < dueAtMs) {
        return { nextDueAtMs: dueAtMs, skippedIntervals: 0 };
    }
    const skippedIntervals = Math.max(0, Math.floor((actualNowMs - dueAtMs) / intervalMs));
    return {
        nextDueAtMs: dueAtMs + (skippedIntervals + 1) * intervalMs,
        skippedIntervals
    };
}
