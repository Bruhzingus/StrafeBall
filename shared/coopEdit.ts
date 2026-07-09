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

export const COOP_EDIT_LIMITS = {
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
} as const;

export type CoopMode = 'build' | 'playtest';

/** A collaborator's live pose + what they're doing, for presence avatars + selection highlight. */
export interface CoopPresence {
  x: number;
  y: number;
  z: number;
  yaw: number;
  mode: CoopMode;
  /** Object id the collaborator currently has selected (drives the remote selection highlight), or ''. */
  selection: string;
}

export interface CoopRosterEntry {
  id: string;
  name: string;
  host: boolean;
}

/** Server → a joining client: everything needed to enter the shared session. */
export interface CoopWelcome {
  courseJson: string;
  selfId: string;
  hostId: string;
  roster: CoopRosterEntry[];
  /** Current lock owners: object id → collaborator session id. */
  locks: Record<string, string>;
}

export interface CoopRosterBroadcast {
  hostId: string;
  roster: CoopRosterEntry[];
}

/** Server → clients: authoritative lock map (object id → owner session id). Full snapshot each time. */
export interface CoopLocksBroadcast {
  locks: Record<string, string>;
}

/**
 * One committed edit, BATCHED — all objects a single commit changed/removed travel in ONE message,
 * so even a big multi-object operation (paste, select-all move, prefab stamp, undo) is a single
 * packet and never trips the per-second message cap. Objects are relayed opaquely (the server checks
 * only id + size; the receiving client validates each).
 */
export interface CoopEditBroadcast {
  from: string;
  upserts: Record<string, unknown>[];
  deletes: string[];
}

export interface CoopPresenceBroadcast {
  presences: Array<{ id: string } & CoopPresence>;
}

export interface CoopClosed {
  reason: 'host-left' | 'closed';
}

// ---------------------------------------------------------------------------------------------
// Pure sanitizers — every inbound field passes through one of these before the server keeps or
// relays it. All total: any input shape returns a safe value or a rejection.
// ---------------------------------------------------------------------------------------------

export type CourseSanityResult = { ok: true; objectCount: number } | { ok: false; reason: string };

/** Shallow shape/size check on the host's course blob (identical spirit to courseRace). */
export function sanityCheckCourseJson(courseJson: unknown): CourseSanityResult {
  if (typeof courseJson !== 'string') return { ok: false, reason: 'not-a-string' };
  if (courseJson.length === 0) return { ok: false, reason: 'empty' };
  if (courseJson.length > COOP_EDIT_LIMITS.maxCourseJsonChars) return { ok: false, reason: 'too-large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(courseJson);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not-an-object' };
  const objects = (parsed as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) return { ok: false, reason: 'missing-objects' };
  if (objects.length > COOP_EDIT_LIMITS.maxObjects) return { ok: false, reason: 'too-many-objects' };
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'malformed-object' };
  }
  return { ok: true, objectCount: objects.length };
}

export function cleanCoopName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Builder';
  const cleaned = Array.from(raw)
    .filter((c) => c >= ' ')
    .join('')
    .trim()
    .slice(0, COOP_EDIT_LIMITS.maxNameLength);
  return cleaned || 'Builder';
}

/** An object id must be a short, non-empty string. Returns null when unusable. */
export function sanitizeObjectId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!id || id.length > COOP_EDIT_LIMITS.maxIdLength) return null;
  return id;
}

/**
 * Shallow validation of a relayed object: must be a plain object carrying a usable string `id`, and
 * serialize within the per-object size cap. The receiving client runs full CreatorLayout validation;
 * the server only needs the id (to route the lock/relay) and a size bound. Returns the id, or null.
 */
export function sanitizeCoopObjectShallow(raw: unknown): { id: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = sanitizeObjectId((raw as { id?: unknown }).id);
  if (!id) return null;
  let size = 0;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    return null; // circular / non-serializable
  }
  if (size > COOP_EDIT_LIMITS.maxObjectJsonChars) return null;
  return { id };
}

function finiteClamped(v: unknown, limit: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(-limit, Math.min(limit, v));
}

/** Validate + clamp an inbound presence packet (msgpack can carry NaN/Infinity — never trust it). */
export function sanitizeCoopPresence(raw: unknown): CoopPresence | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const x = finiteClamped(p.x, COOP_EDIT_LIMITS.maxCoordinate);
  const y = finiteClamped(p.y, COOP_EDIT_LIMITS.maxCoordinate);
  const z = finiteClamped(p.z, COOP_EDIT_LIMITS.maxCoordinate);
  const yaw = finiteClamped(p.yaw, 1000);
  if (x === null || y === null || z === null || yaw === null) return null;
  const mode: CoopMode = p.mode === 'playtest' ? 'playtest' : 'build';
  const selectionRaw = typeof p.selection === 'string' ? p.selection.trim() : '';
  const selection = selectionRaw.length <= COOP_EDIT_LIMITS.maxIdLength ? selectionRaw : '';
  return { x, y, z, yaw, mode, selection };
}
