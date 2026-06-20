"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimeRing = void 0;
exports.defenseHandEmpty = defenseHandEmpty;
/**
 * Fixed-capacity ring of recent samples keyed by server time. Stores at most `windowMs` of history
 * (so memory is bounded regardless of session length) and supports nearest-time lookup for rewind.
 */
class TimeRing {
    windowMs;
    maxEntries;
    samples = [];
    constructor(windowMs, maxEntries = Number.POSITIVE_INFINITY) {
        this.windowMs = windowMs;
        this.maxEntries = maxEntries;
    }
    push(sample) {
        this.samples.push(sample);
        const cutoff = sample.serverTimeMs - this.windowMs;
        // Drop anything older than the window. Samples are pushed in increasing time order, so the
        // stale ones are always at the front.
        let drop = 0;
        while (drop < this.samples.length && this.samples[drop].serverTimeMs < cutoff)
            drop += 1;
        const overCapacity = Math.max(0, this.samples.length - drop - this.maxEntries);
        if (overCapacity > 0)
            drop += overCapacity;
        if (drop > 0)
            this.samples.splice(0, drop);
    }
    /**
     * Sample nearest the requested server time, or null if empty. Used for lag-comp rewind. On a tie
     * (multiple samples at the same time — can happen when several ticks share a wall-clock ms) the
     * LATEST such sample wins, so we never rewind to a staler state than necessary. Samples are stored
     * in increasing time order, so iterating with `<=` naturally keeps the last equal-or-closer one.
     */
    nearest(serverTimeMs) {
        if (this.samples.length === 0)
            return null;
        let best = this.samples[0];
        let bestDelta = Math.abs(best.serverTimeMs - serverTimeMs);
        for (let i = 1; i < this.samples.length; i += 1) {
            const delta = Math.abs(this.samples[i].serverTimeMs - serverTimeMs);
            if (delta <= bestDelta) {
                best = this.samples[i];
                bestDelta = delta;
            }
        }
        return best;
    }
    /**
     * The two samples straddling `serverTimeMs` — [before, after] — for reconstructing a swept
     * segment at a rewound time. If the time is outside the buffer (or only one sample exists) both
     * entries are the nearest single sample (a degenerate zero-length segment, still valid). Samples
     * are stored in increasing time order.
     */
    bracket(serverTimeMs) {
        if (this.samples.length === 0)
            return null;
        if (this.samples.length === 1)
            return [this.samples[0], this.samples[0]];
        for (let i = 0; i < this.samples.length - 1; i += 1) {
            if (this.samples[i].serverTimeMs <= serverTimeMs && serverTimeMs <= this.samples[i + 1].serverTimeMs) {
                return [this.samples[i], this.samples[i + 1]];
            }
        }
        // Outside the range: clamp to the closest end pair.
        if (serverTimeMs < this.samples[0].serverTimeMs)
            return [this.samples[0], this.samples[0]];
        const last = this.samples[this.samples.length - 1];
        return [last, last];
    }
    /** Most recent sample, or null. */
    latest() {
        return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
    }
    /** Age (ms) of the sample nearest `serverTimeMs` relative to it — for debug. */
    ageOfNearest(serverTimeMs) {
        const n = this.nearest(serverTimeMs);
        return n ? Math.abs(n.serverTimeMs - serverTimeMs) : Number.POSITIVE_INFINITY;
    }
    clear() {
        this.samples.length = 0;
    }
    get size() {
        return this.samples.length;
    }
}
exports.TimeRing = TimeRing;
/** Which hand's emptiness a defense sample reports. */
function defenseHandEmpty(sample, hand) {
    return hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty;
}
