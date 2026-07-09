"use strict";
/**
 * Co-op Course Editing — shared protocol for the real-time collaborative Creator session.
 *
 * Like the ghost-relay course race (shared/courseRace.ts), the server is a pure relay + arbiter: it
 * NEVER interprets course geometry beyond shallow shape/size checks and never simulates. Its only
 * real logic is an authoritative OBJECT LOCK TABLE — when a collaborator grabs an object the server
 * grants them an exclusive lock so no one else can edit it (and everyone renders it locked/red). This
 * is what removes edit conflicts at the source: two people can never mutate the same object at once,
 * so per-object relay never has to merge concurrent same-object edits.
 *
 * Wire flow:
 *   - The host's current course transfers on join (opaque JSON blob, size-capped).
 *   - Each committed edit relays only the CHANGED / DELETED objects by id (not the whole course).
 *   - Presence (camera/player pose + mode + current selection) relays at a fixed low rate.
 *   - Lock/unlock requests are arbitrated by the server and broadcast as the authoritative lock map.
 *
 * Deep validation of every relayed object happens on the RECEIVING CLIENT (via the editor's own
 * validateLayout), so this module — compiled into the server — stays free of any src/game import and
 * only does the shallow, dependency-free checks below.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COOP_EDIT_LIMITS = void 0;
exports.sanityCheckCourseJson = sanityCheckCourseJson;
exports.cleanCoopName = cleanCoopName;
exports.sanitizeObjectId = sanitizeObjectId;
exports.sanitizeCoopObjectShallow = sanitizeCoopObjectShallow;
exports.sanitizeCoopPresence = sanitizeCoopPresence;
exports.COOP_EDIT_LIMITS = {
    /** Cap on the initial course JSON blob (UTF-16 code units ≈ bytes for ASCII JSON). */
    maxCourseJsonChars: 1_500_000,
    /** Cap on the layout's object count at join time. */
    maxObjects: 1200,
    /** Cap on a single relayed object's JSON size (a fat object still can't be a megabyte). */
    maxObjectJsonChars: 40_000,
    /** Collaborators per session (host included). */
    maxCollaborators: 6,
    maxNameLength: 24,
    maxIdLength: 80,
    /** Presence send rate (client) and batched rebroadcast rate (server), Hz. */
    presenceSendHz: 15,
    presenceBroadcastHz: 12,
    /** Server-side minimum gap between accepted presence packets from one client (ms). */
    presenceMinIntervalMs: 45,
    /** Max objects (upserts + deletes) accepted in one batched edit message. */
    maxEditBatch: 1200,
    /** |x|,|y|,|z| clamp for relayed presence poses. */
    maxCoordinate: 1_000_000
};
/** Shallow shape/size check on the host's course blob (identical spirit to courseRace). */
function sanityCheckCourseJson(courseJson) {
    if (typeof courseJson !== 'string')
        return { ok: false, reason: 'not-a-string' };
    if (courseJson.length === 0)
        return { ok: false, reason: 'empty' };
    if (courseJson.length > exports.COOP_EDIT_LIMITS.maxCourseJsonChars)
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
    if (objects.length > exports.COOP_EDIT_LIMITS.maxObjects)
        return { ok: false, reason: 'too-many-objects' };
    for (const obj of objects) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj))
            return { ok: false, reason: 'malformed-object' };
    }
    return { ok: true, objectCount: objects.length };
}
function cleanCoopName(raw) {
    if (typeof raw !== 'string')
        return 'Builder';
    const cleaned = Array.from(raw)
        .filter((c) => c >= ' ')
        .join('')
        .trim()
        .slice(0, exports.COOP_EDIT_LIMITS.maxNameLength);
    return cleaned || 'Builder';
}
/** An object id must be a short, non-empty string. Returns null when unusable. */
function sanitizeObjectId(raw) {
    if (typeof raw !== 'string')
        return null;
    const id = raw.trim();
    if (!id || id.length > exports.COOP_EDIT_LIMITS.maxIdLength)
        return null;
    return id;
}
/**
 * Shallow validation of a relayed object: must be a plain object carrying a usable string `id`, and
 * serialize within the per-object size cap. The receiving client runs full CreatorLayout validation;
 * the server only needs the id (to route the lock/relay) and a size bound. Returns the id, or null.
 */
function sanitizeCoopObjectShallow(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const id = sanitizeObjectId(raw.id);
    if (!id)
        return null;
    let size = 0;
    try {
        size = JSON.stringify(raw).length;
    }
    catch {
        return null; // circular / non-serializable
    }
    if (size > exports.COOP_EDIT_LIMITS.maxObjectJsonChars)
        return null;
    return { id };
}
function finiteClamped(v, limit) {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return null;
    return Math.max(-limit, Math.min(limit, v));
}
/** Validate + clamp an inbound presence packet (msgpack can carry NaN/Infinity — never trust it). */
function sanitizeCoopPresence(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const p = raw;
    const x = finiteClamped(p.x, exports.COOP_EDIT_LIMITS.maxCoordinate);
    const y = finiteClamped(p.y, exports.COOP_EDIT_LIMITS.maxCoordinate);
    const z = finiteClamped(p.z, exports.COOP_EDIT_LIMITS.maxCoordinate);
    const yaw = finiteClamped(p.yaw, 1000);
    if (x === null || y === null || z === null || yaw === null)
        return null;
    const mode = p.mode === 'playtest' ? 'playtest' : 'build';
    const selectionRaw = typeof p.selection === 'string' ? p.selection.trim() : '';
    const selection = selectionRaw.length <= exports.COOP_EDIT_LIMITS.maxIdLength ? selectionRaw : '';
    return { x, y, z, yaw, mode, selection };
}
