import { Client, Room } from 'colyseus';
import {
  COOP_EDIT_LIMITS,
  cleanCoopName,
  sanitizeCoopPresence,
  sanitizeObjectId,
  sanitizeCoopObjectShallow,
  sanityCheckCourseJson,
  type CoopClosed,
  type CoopEditBroadcast,
  type CoopLocksBroadcast,
  type CoopPresence,
  type CoopPresenceBroadcast,
  type CoopRosterBroadcast,
  type CoopRosterEntry,
  type CoopWelcome
} from '../../../shared/coopEdit';

/**
 * Co-op Course Editing room — a private, invite-only collaborative Creator session (see
 * shared/coopEdit.ts for the model). The server is a pure relay + lock arbiter: it never interprets
 * course geometry (deep validation is client-side) and never simulates.
 *
 * It holds an authoritative, incrementally-updated copy of the course (so late joiners get the
 * current state), an authoritative OBJECT LOCK TABLE (so two collaborators can never edit the same
 * object at once), a batched presence relay, and a roster. Entirely separate from DuelRoom /
 * CourseRoom.
 */

export interface EditRoomOptions {
  name?: string;
  /** The host's active course, JSON-stringified. Required; sanity-checked in onCreate. */
  courseJson?: string;
}

const MAX_EDIT_ROOMS = 100;
let activeEditRoomCount = 0;

interface Collaborator {
  name: string;
  presence: CoopPresence | null;
  presenceDirty: boolean;
  lastPresenceAcceptedAtMs: number;
}

export class EditRoom extends Room {
  private hostSessionId = '';
  /** The live course: the parsed layout with its `objects` array kept current by relayed edits. */
  private currentCourse: Record<string, unknown> = { objects: [] };
  /** Fast id → object lookup mirroring currentCourse.objects (kept in sync). */
  private readonly objectsById = new Map<string, Record<string, unknown>>();
  /** Authoritative lock table: object id → owner session id. */
  private readonly locks = new Map<string, string>();
  private readonly collaborators = new Map<string, Collaborator>();

  onCreate(options: EditRoomOptions = {}): void {
    // Validate before counting this room active (a rejected create throws; onDispose clamps at 0).
    const check = sanityCheckCourseJson(options.courseJson);
    if (!check.ok) throw new Error(`course rejected: ${check.reason}`);
    activeEditRoomCount += 1;
    this.setPrivate(true);
    this.maxClients = COOP_EDIT_LIMITS.maxCollaborators;
    this.maxMessagesPerSecond = 120; // edits + presence + locks

    this.currentCourse = JSON.parse(options.courseJson as string) as Record<string, unknown>;
    const objects = Array.isArray(this.currentCourse.objects) ? this.currentCourse.objects : [];
    for (const obj of objects) {
      const shallow = sanitizeCoopObjectShallow(obj);
      if (shallow) this.objectsById.set(shallow.id, obj as Record<string, unknown>);
    }
    this.log(`co-op room created objects=${this.objectsById.size} courseChars=${(options.courseJson as string).length}`);

    this.onMessage('coop-edit', (client, message: unknown) => {
      const collab = this.collaborators.get(client.sessionId);
      if (!collab || !message || typeof message !== 'object') return;
      const upsertsIn = Array.isArray((message as { upserts?: unknown }).upserts) ? (message as { upserts: unknown[] }).upserts : [];
      const deletesIn = Array.isArray((message as { deletes?: unknown }).deletes) ? (message as { deletes: unknown[] }).deletes : [];
      if (upsertsIn.length + deletesIn.length > COOP_EDIT_LIMITS.maxEditBatch) return; // absurd batch

      const acceptedUpserts: Record<string, unknown>[] = [];
      const acceptedDeletes: string[] = [];
      let locksChanged = false;

      for (const raw of upsertsIn) {
        const shallow = sanitizeCoopObjectShallow(raw);
        if (!shallow) continue;
        const owner = this.locks.get(shallow.id);
        if (owner && owner !== client.sessionId) continue; // held by someone else
        if (!owner) {
          this.locks.set(shallow.id, client.sessionId); // auto-lock a brand-new object to its placer
          locksChanged = true;
        }
        this.objectsById.set(shallow.id, raw as Record<string, unknown>);
        acceptedUpserts.push(raw as Record<string, unknown>);
      }
      for (const raw of deletesIn) {
        const id = sanitizeObjectId(raw);
        if (!id) continue;
        const owner = this.locks.get(id);
        if (owner && owner !== client.sessionId) continue;
        this.objectsById.delete(id);
        if (this.locks.delete(id)) locksChanged = true;
        acceptedDeletes.push(id);
      }

      if (acceptedUpserts.length === 0 && acceptedDeletes.length === 0) {
        if (locksChanged) this.broadcastLocks();
        return;
      }
      this.syncObjectsArray();
      if (locksChanged) this.broadcastLocks();
      this.broadcast(
        'coop-edit',
        { from: client.sessionId, upserts: acceptedUpserts, deletes: acceptedDeletes } satisfies CoopEditBroadcast,
        { except: client }
      );
    });

    this.onMessage('coop-lock', (client, message: unknown) => {
      const collab = this.collaborators.get(client.sessionId);
      if (!collab) return;
      const id = sanitizeObjectId((message as { id?: unknown } | undefined)?.id);
      if (!id) return;
      const owner = this.locks.get(id);
      if (owner && owner !== client.sessionId) return; // someone else holds it — deny silently
      if (owner === client.sessionId) return; // already ours; no rebroadcast churn
      this.locks.set(id, client.sessionId);
      this.broadcastLocks();
    });

    this.onMessage('coop-unlock', (client, message: unknown) => {
      const id = sanitizeObjectId((message as { id?: unknown } | undefined)?.id);
      if (!id) return;
      if (this.locks.get(id) === client.sessionId) {
        this.locks.delete(id);
        this.broadcastLocks();
      }
    });

    this.onMessage('coop-unlock-all', (client) => {
      if (this.releaseLocksOf(client.sessionId)) this.broadcastLocks();
    });

    this.onMessage('coop-presence', (client, message: unknown) => {
      const collab = this.collaborators.get(client.sessionId);
      if (!collab) return;
      const now = Date.now();
      if (now - collab.lastPresenceAcceptedAtMs < COOP_EDIT_LIMITS.presenceMinIntervalMs) return;
      const presence = sanitizeCoopPresence(message);
      if (!presence) return;
      collab.presence = presence;
      collab.presenceDirty = true;
      collab.lastPresenceAcceptedAtMs = now;
    });

    this.setSimulationInterval(() => this.broadcastPresences(), Math.round(1000 / COOP_EDIT_LIMITS.presenceBroadcastHz));
  }

  onAuth(_client: Client, _options: EditRoomOptions): boolean {
    if (activeEditRoomCount > MAX_EDIT_ROOMS) {
      this.log('join rejected reason=server-at-capacity');
      return false;
    }
    return this.clients.length < this.maxClients;
  }

  onJoin(client: Client, options: EditRoomOptions): void {
    const name = cleanCoopName(options.name);
    if (this.collaborators.size === 0) this.hostSessionId = client.sessionId;
    this.collaborators.set(client.sessionId, {
      name,
      presence: null,
      presenceDirty: false,
      lastPresenceAcceptedAtMs: 0
    });
    this.log(`collaborator joined id=${client.sessionId} name="${name}" host=${client.sessionId === this.hostSessionId}`);

    // Re-flag existing presences so the next relay tick shows this joiner everyone's current position.
    for (const collab of this.collaborators.values()) {
      if (collab.presence) collab.presenceDirty = true;
    }

    client.send('coop-welcome', {
      courseJson: JSON.stringify(this.currentCourse),
      selfId: client.sessionId,
      hostId: this.hostSessionId,
      roster: this.rosterEntries(),
      locks: this.lockRecord()
    } satisfies CoopWelcome);
    this.broadcastRoster();
  }

  onLeave(client: Client, _code?: number): void {
    const wasHost = client.sessionId === this.hostSessionId;
    this.collaborators.delete(client.sessionId);
    const freed = this.releaseLocksOf(client.sessionId);
    this.log(`collaborator left id=${client.sessionId} host=${wasHost}`);
    if (wasHost) {
      this.broadcast('coop-closed', { reason: 'host-left' } satisfies CoopClosed);
      void this.disconnect();
      return;
    }
    if (freed) this.broadcastLocks();
    this.broadcastRoster();
  }

  onDispose(): void {
    activeEditRoomCount = Math.max(0, activeEditRoomCount - 1);
    this.log('co-op room disposed');
  }

  // ---------------------------------------------------------------------------------------------

  /** Rewrite currentCourse.objects from the id map (keeps the serialized-for-joiners copy current). */
  private syncObjectsArray(): void {
    this.currentCourse.objects = [...this.objectsById.values()];
  }

  private releaseLocksOf(sessionId: string): boolean {
    let changed = false;
    for (const [id, owner] of this.locks) {
      if (owner === sessionId) {
        this.locks.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  private lockRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, owner] of this.locks) out[id] = owner;
    return out;
  }

  private broadcastLocks(): void {
    this.broadcast('coop-locks', { locks: this.lockRecord() } satisfies CoopLocksBroadcast);
  }

  private broadcastPresences(): void {
    if (this.collaborators.size < 2) {
      for (const collab of this.collaborators.values()) collab.presenceDirty = false;
      return;
    }
    const presences: CoopPresenceBroadcast['presences'] = [];
    for (const [id, collab] of this.collaborators) {
      if (!collab.presenceDirty || !collab.presence) continue;
      collab.presenceDirty = false;
      presences.push({ id, ...collab.presence });
    }
    if (presences.length === 0) return;
    this.broadcast('coop-presence', { presences } satisfies CoopPresenceBroadcast);
  }

  private rosterEntries(): CoopRosterEntry[] {
    const entries: CoopRosterEntry[] = [];
    for (const [id, collab] of this.collaborators) {
      entries.push({ id, name: collab.name, host: id === this.hostSessionId });
    }
    return entries;
  }

  private broadcastRoster(): void {
    this.broadcast('coop-roster', { hostId: this.hostSessionId, roster: this.rosterEntries() } satisfies CoopRosterBroadcast);
  }

  private log(message: string): void {
    console.log(`[coop ${this.roomId}] ${message}`);
  }
}
