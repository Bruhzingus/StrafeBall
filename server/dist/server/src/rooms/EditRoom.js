"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditRoom = void 0;
const colyseus_1 = require("colyseus");
const coopEdit_1 = require("../../../shared/coopEdit");
const MAX_EDIT_ROOMS = 100;
let activeEditRoomCount = 0;
class EditRoom extends colyseus_1.Room {
    hostSessionId = '';
    /** The live course: the parsed layout with its `objects` array kept current by relayed edits. */
    currentCourse = { objects: [] };
    /** Fast id → object lookup mirroring currentCourse.objects (kept in sync). */
    objectsById = new Map();
    /** Authoritative lock table: object id → owner session id. */
    locks = new Map();
    collaborators = new Map();
    onCreate(options = {}) {
        // Validate before counting this room active (a rejected create throws; onDispose clamps at 0).
        const check = (0, coopEdit_1.sanityCheckCourseJson)(options.courseJson);
        if (!check.ok)
            throw new Error(`course rejected: ${check.reason}`);
        activeEditRoomCount += 1;
        this.setPrivate(true);
        this.maxClients = coopEdit_1.COOP_EDIT_LIMITS.maxCollaborators;
        this.maxMessagesPerSecond = 120; // edits + presence + locks
        this.currentCourse = JSON.parse(options.courseJson);
        const objects = Array.isArray(this.currentCourse.objects) ? this.currentCourse.objects : [];
        for (const obj of objects) {
            const shallow = (0, coopEdit_1.sanitizeCoopObjectShallow)(obj);
            if (shallow)
                this.objectsById.set(shallow.id, obj);
        }
        this.log(`co-op room created objects=${this.objectsById.size} courseChars=${options.courseJson.length}`);
        this.onMessage('coop-edit', (client, message) => {
            const collab = this.collaborators.get(client.sessionId);
            if (!collab || !message || typeof message !== 'object')
                return;
            const upsertsIn = Array.isArray(message.upserts) ? message.upserts : [];
            const deletesIn = Array.isArray(message.deletes) ? message.deletes : [];
            if (upsertsIn.length + deletesIn.length > coopEdit_1.COOP_EDIT_LIMITS.maxEditBatch)
                return; // absurd batch
            const acceptedUpserts = [];
            const acceptedDeletes = [];
            let locksChanged = false;
            for (const raw of upsertsIn) {
                const shallow = (0, coopEdit_1.sanitizeCoopObjectShallow)(raw);
                if (!shallow)
                    continue;
                const owner = this.locks.get(shallow.id);
                if (owner && owner !== client.sessionId)
                    continue; // held by someone else
                if (!owner) {
                    this.locks.set(shallow.id, client.sessionId); // auto-lock a brand-new object to its placer
                    locksChanged = true;
                }
                this.objectsById.set(shallow.id, raw);
                acceptedUpserts.push(raw);
            }
            for (const raw of deletesIn) {
                const id = (0, coopEdit_1.sanitizeObjectId)(raw);
                if (!id)
                    continue;
                const owner = this.locks.get(id);
                if (owner && owner !== client.sessionId)
                    continue;
                this.objectsById.delete(id);
                if (this.locks.delete(id))
                    locksChanged = true;
                acceptedDeletes.push(id);
            }
            if (acceptedUpserts.length === 0 && acceptedDeletes.length === 0) {
                if (locksChanged)
                    this.broadcastLocks();
                return;
            }
            this.syncObjectsArray();
            if (locksChanged)
                this.broadcastLocks();
            this.broadcast('coop-edit', { from: client.sessionId, upserts: acceptedUpserts, deletes: acceptedDeletes }, { except: client });
        });
        this.onMessage('coop-lock', (client, message) => {
            const collab = this.collaborators.get(client.sessionId);
            if (!collab)
                return;
            const id = (0, coopEdit_1.sanitizeObjectId)(message?.id);
            if (!id)
                return;
            const owner = this.locks.get(id);
            if (owner && owner !== client.sessionId)
                return; // someone else holds it — deny silently
            if (owner === client.sessionId)
                return; // already ours; no rebroadcast churn
            this.locks.set(id, client.sessionId);
            this.broadcastLocks();
        });
        this.onMessage('coop-unlock', (client, message) => {
            const id = (0, coopEdit_1.sanitizeObjectId)(message?.id);
            if (!id)
                return;
            if (this.locks.get(id) === client.sessionId) {
                this.locks.delete(id);
                this.broadcastLocks();
            }
        });
        this.onMessage('coop-unlock-all', (client) => {
            if (this.releaseLocksOf(client.sessionId))
                this.broadcastLocks();
        });
        this.onMessage('coop-presence', (client, message) => {
            const collab = this.collaborators.get(client.sessionId);
            if (!collab)
                return;
            const now = Date.now();
            if (now - collab.lastPresenceAcceptedAtMs < coopEdit_1.COOP_EDIT_LIMITS.presenceMinIntervalMs)
                return;
            const presence = (0, coopEdit_1.sanitizeCoopPresence)(message);
            if (!presence)
                return;
            collab.presence = presence;
            collab.presenceDirty = true;
            collab.lastPresenceAcceptedAtMs = now;
        });
        this.setSimulationInterval(() => this.broadcastPresences(), Math.round(1000 / coopEdit_1.COOP_EDIT_LIMITS.presenceBroadcastHz));
    }
    onAuth(_client, _options) {
        if (activeEditRoomCount > MAX_EDIT_ROOMS) {
            this.log('join rejected reason=server-at-capacity');
            return false;
        }
        return this.clients.length < this.maxClients;
    }
    onJoin(client, options) {
        const name = (0, coopEdit_1.cleanCoopName)(options.name);
        if (this.collaborators.size === 0)
            this.hostSessionId = client.sessionId;
        this.collaborators.set(client.sessionId, {
            name,
            presence: null,
            presenceDirty: false,
            lastPresenceAcceptedAtMs: 0
        });
        this.log(`collaborator joined id=${client.sessionId} name="${name}" host=${client.sessionId === this.hostSessionId}`);
        // Re-flag existing presences so the next relay tick shows this joiner everyone's current position.
        for (const collab of this.collaborators.values()) {
            if (collab.presence)
                collab.presenceDirty = true;
        }
        client.send('coop-welcome', {
            courseJson: JSON.stringify(this.currentCourse),
            selfId: client.sessionId,
            hostId: this.hostSessionId,
            roster: this.rosterEntries(),
            locks: this.lockRecord()
        });
        this.broadcastRoster();
    }
    onLeave(client, _code) {
        const wasHost = client.sessionId === this.hostSessionId;
        this.collaborators.delete(client.sessionId);
        const freed = this.releaseLocksOf(client.sessionId);
        this.log(`collaborator left id=${client.sessionId} host=${wasHost}`);
        if (wasHost) {
            this.broadcast('coop-closed', { reason: 'host-left' });
            void this.disconnect();
            return;
        }
        if (freed)
            this.broadcastLocks();
        this.broadcastRoster();
    }
    onDispose() {
        activeEditRoomCount = Math.max(0, activeEditRoomCount - 1);
        this.log('co-op room disposed');
    }
    // ---------------------------------------------------------------------------------------------
    /** Rewrite currentCourse.objects from the id map (keeps the serialized-for-joiners copy current). */
    syncObjectsArray() {
        this.currentCourse.objects = [...this.objectsById.values()];
    }
    releaseLocksOf(sessionId) {
        let changed = false;
        for (const [id, owner] of this.locks) {
            if (owner === sessionId) {
                this.locks.delete(id);
                changed = true;
            }
        }
        return changed;
    }
    lockRecord() {
        const out = {};
        for (const [id, owner] of this.locks)
            out[id] = owner;
        return out;
    }
    broadcastLocks() {
        this.broadcast('coop-locks', { locks: this.lockRecord() });
    }
    broadcastPresences() {
        if (this.collaborators.size < 2) {
            for (const collab of this.collaborators.values())
                collab.presenceDirty = false;
            return;
        }
        const presences = [];
        for (const [id, collab] of this.collaborators) {
            if (!collab.presenceDirty || !collab.presence)
                continue;
            collab.presenceDirty = false;
            presences.push({ id, ...collab.presence });
        }
        if (presences.length === 0)
            return;
        this.broadcast('coop-presence', { presences });
    }
    rosterEntries() {
        const entries = [];
        for (const [id, collab] of this.collaborators) {
            entries.push({ id, name: collab.name, host: id === this.hostSessionId });
        }
        return entries;
    }
    broadcastRoster() {
        this.broadcast('coop-roster', { hostId: this.hostSessionId, roster: this.rosterEntries() });
    }
    log(message) {
        console.log(`[coop ${this.roomId}] ${message}`);
    }
}
exports.EditRoom = EditRoom;
