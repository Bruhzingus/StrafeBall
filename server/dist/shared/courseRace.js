"use strict";
/**
 * Course Race — shared protocol for private online course sessions (ghost-relay model).
 *
 * A course race is a private, invite-only session where every racer runs the host's Creator course
 * LOCALLY on the offline movement stack (pads/movers/kill-blocks/checkpoints/timer all behave
 * exactly like solo play), while the server acts as a pure message hub:
 *   - it holds the host's course JSON as an opaque, size-capped blob and hands it to joiners;
 *   - it relays racer poses (position + yaw) so everyone renders everyone else as a ghost;
 *   - it relays run events (start/checkpoint/finish/reset) and keeps a per-session best-time roster.
 *
 * The server NEVER parses course geometry beyond the sanity check below and NEVER simulates
 * movement — a malformed or adversarial course file cannot crash or desync it, because the blob is
 * validated for shape/size here and then only ever stored + forwarded. Each receiving client runs
 * the full validateLayout() before building anything.
 *
 * Times are self-reported by clients. That is an accepted, deliberate trade-off for private
 * friend sessions (no ranking, no global leaderboard at stake); revisit if/when accounts and
 * public leaderboards exist. This module must stay dependency-free of Babylon and of src/game/**
 * (the server compiles shared/** only).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COURSE_RACE_LIMITS = void 0;
exports.sanityCheckCourseJson = sanityCheckCourseJson;
exports.cleanRaceName = cleanRaceName;
exports.sanitizePose = sanitizePose;
exports.sanitizeRunEvent = sanitizeRunEvent;
exports.COURSE_RACE_LIMITS = {
    /** Cap on the course JSON blob (UTF-16 code units ≈ bytes for ASCII JSON). ~15× the committed
     *  82-object course, so any sane creation fits while a hostile megabyte-bomb is rejected. */
    maxCourseJsonChars: 1_500_000,
    /** Cap on the layout's object count. The editor's own cap is 400; leave generous headroom. */
    maxObjects: 1200,
    /** Racers per session (host included). */
    maxRacers: 8,
    maxNameLength: 24,
    /** Client pose send rate (Hz) and the server's batched rebroadcast rate (Hz). */
    poseSendHz: 20,
    poseBroadcastHz: 15,
    /** Server-side minimum gap between accepted poses from one client (ms). Slightly under the
     *  nominal 50 ms send interval so normal jitter never drops a pose. */
    poseMinIntervalMs: 40,
    /** Run-event flood guard: burst capacity + refill per second (checkpoints can cluster). */
    runEventBurst: 6,
    runEventRefillPerSecond: 3,
    /** Host restart-all cooldown (ms). */
    restartMinIntervalMs: 1500,
    /** Reject reported run times beyond this (ms) — nothing legitimate runs for 6 hours. */
    maxTimeMs: 6 * 60 * 60 * 1000,
    /** |x|,|y|,|z| clamp for relayed poses — far beyond any real course, blocks Infinity bombs. */
    maxCoordinate: 1_000_000
};
/**
 * Lightweight shape/size check on a hosted course blob. Deliberately shallow: the server only
 * needs to know the blob is reasonably-sized, parseable JSON with a bounded objects array — full
 * semantic validation (validateLayout) runs on every receiving CLIENT instead.
 */
function sanityCheckCourseJson(courseJson) {
    if (typeof courseJson !== 'string')
        return { ok: false, reason: 'not-a-string' };
    if (courseJson.length === 0)
        return { ok: false, reason: 'empty' };
    if (courseJson.length > exports.COURSE_RACE_LIMITS.maxCourseJsonChars)
        return { ok: false, reason: 'too-large' };
    let parsed;
    try {
        parsed = JSON.parse(courseJson);
    }
    catch {
        return { ok: false, reason: 'invalid-json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { ok: false, reason: 'not-an-object' };
    const objects = parsed.objects;
    if (!Array.isArray(objects))
        return { ok: false, reason: 'missing-objects' };
    if (objects.length > exports.COURSE_RACE_LIMITS.maxObjects)
        return { ok: false, reason: 'too-many-objects' };
    for (const obj of objects) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj))
            return { ok: false, reason: 'malformed-object' };
    }
    return { ok: true, objectCount: objects.length };
}
/** Display name: strip control chars, trim, cap length; empty/invalid falls back to "Racer". */
function cleanRaceName(raw) {
    if (typeof raw !== 'string')
        return 'Racer';
    const cleaned = Array.from(raw)
        .filter((c) => c >= ' ')
        .join('')
        .trim()
        .slice(0, exports.COURSE_RACE_LIMITS.maxNameLength);
    return cleaned || 'Racer';
}
function finiteClamped(v, limit) {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return null;
    return Math.max(-limit, Math.min(limit, v));
}
/** Validate + clamp an inbound pose. Null when any field is missing/non-finite (msgpack can carry
 *  NaN/Infinity, unlike JSON — never trust the wire). */
function sanitizePose(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const p = raw;
    const x = finiteClamped(p.x, exports.COURSE_RACE_LIMITS.maxCoordinate);
    const y = finiteClamped(p.y, exports.COURSE_RACE_LIMITS.maxCoordinate);
    const z = finiteClamped(p.z, exports.COURSE_RACE_LIMITS.maxCoordinate);
    const yaw = finiteClamped(p.yaw, 1000);
    if (x === null || y === null || z === null || yaw === null)
        return null;
    return { x, y, z, yaw };
}
/** Validate an inbound run event. Null on unknown kinds / bad numbers; extra fields dropped. */
function sanitizeRunEvent(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const e = raw;
    const kind = e.kind;
    if (kind !== 'start' && kind !== 'checkpoint' && kind !== 'finish' && kind !== 'reset')
        return null;
    const out = { kind };
    if (e.timeMs !== undefined) {
        const t = typeof e.timeMs === 'number' && Number.isFinite(e.timeMs) ? e.timeMs : null;
        if (t === null || t < 0 || t > exports.COURSE_RACE_LIMITS.maxTimeMs)
            return null;
        out.timeMs = Math.round(t);
    }
    if (kind === 'finish' && out.timeMs === undefined)
        return null; // a finish must carry its time
    if (e.checkpoint !== undefined) {
        const n = typeof e.checkpoint === 'number' && Number.isFinite(e.checkpoint) ? Math.round(e.checkpoint) : null;
        if (n === null || n < 0 || n > 10_000)
            return null;
        out.checkpoint = n;
    }
    if (e.checkpointTotal !== undefined) {
        const n = typeof e.checkpointTotal === 'number' && Number.isFinite(e.checkpointTotal) ? Math.round(e.checkpointTotal) : null;
        if (n === null || n < 0 || n > 10_000)
            return null;
        out.checkpointTotal = n;
    }
    return out;
}
