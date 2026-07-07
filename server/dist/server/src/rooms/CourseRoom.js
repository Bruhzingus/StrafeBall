"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CourseRoom = void 0;
const colyseus_1 = require("colyseus");
const courseRace_1 = require("../../../shared/courseRace");
// Cheap process-wide DoS guard, mirroring DuelRoom's MAX_ROOMS pattern.
const MAX_COURSE_ROOMS = 100;
let activeCourseRoomCount = 0;
class CourseRoom extends colyseus_1.Room {
    courseJson = '';
    hostSessionId = '';
    lastRestartAtMs = 0;
    racers = new Map();
    onCreate(options = {}) {
        activeCourseRoomCount += 1;
        this.setPrivate(true);
        this.maxClients = courseRace_1.COURSE_RACE_LIMITS.maxRacers;
        // Poses at ~20/s plus events/restart headroom. Colyseus force-closes clients exceeding this.
        this.maxMessagesPerSecond = 60;
        const check = (0, courseRace_1.sanityCheckCourseJson)(options.courseJson);
        if (!check.ok) {
            // Rejecting creation surfaces as a failed client.create() promise — the creator sees the error.
            throw new Error(`course rejected: ${check.reason}`);
        }
        this.courseJson = options.courseJson;
        this.log(`race room created objects=${check.objectCount} courseChars=${this.courseJson.length}`);
        this.onMessage('race-pose', (client, message) => {
            const racer = this.racers.get(client.sessionId);
            if (!racer)
                return;
            const now = Date.now();
            if (now - racer.lastPoseAcceptedAtMs < courseRace_1.COURSE_RACE_LIMITS.poseMinIntervalMs)
                return;
            const pose = (0, courseRace_1.sanitizePose)(message);
            if (!pose)
                return;
            racer.pose = pose;
            racer.poseDirty = true;
            racer.lastPoseAcceptedAtMs = now;
        });
        this.onMessage('race-run-event', (client, message) => {
            const racer = this.racers.get(client.sessionId);
            if (!racer)
                return;
            if (!this.takeEventToken(racer))
                return;
            const event = (0, courseRace_1.sanitizeRunEvent)(message);
            if (!event)
                return;
            if (event.kind === 'finish' && typeof event.timeMs === 'number') {
                racer.lastMs = event.timeMs;
                racer.bestMs = racer.bestMs === null ? event.timeMs : Math.min(racer.bestMs, event.timeMs);
            }
            this.broadcast('race-event', {
                id: client.sessionId,
                name: racer.name,
                event
            });
            if (event.kind === 'finish')
                this.broadcastRoster();
        });
        this.onMessage('race-restart', (client) => {
            if (client.sessionId !== this.hostSessionId)
                return;
            const now = Date.now();
            if (now - this.lastRestartAtMs < courseRace_1.COURSE_RACE_LIMITS.restartMinIntervalMs)
                return;
            this.lastRestartAtMs = now;
            this.broadcast('race-restart', {});
        });
        // Fixed-rate batched pose relay. Only fresh poses go out; an idle/AFK racer costs nothing.
        this.setSimulationInterval(() => this.broadcastPoses(), Math.round(1000 / courseRace_1.COURSE_RACE_LIMITS.poseBroadcastHz));
    }
    onAuth(_client, _options) {
        if (activeCourseRoomCount > MAX_COURSE_ROOMS) {
            this.log('join rejected reason=server-at-capacity');
            return false;
        }
        const allowed = this.clients.length < this.maxClients;
        if (!allowed)
            this.log('join rejected reason=room-full');
        return allowed;
    }
    onJoin(client, options) {
        const name = (0, courseRace_1.cleanRaceName)(options.name);
        if (this.racers.size === 0)
            this.hostSessionId = client.sessionId;
        this.racers.set(client.sessionId, {
            name,
            bestMs: null,
            lastMs: null,
            pose: null,
            poseDirty: false,
            lastPoseAcceptedAtMs: 0,
            eventTokens: courseRace_1.COURSE_RACE_LIMITS.runEventBurst,
            eventTokensRefilledAtMs: Date.now()
        });
        this.log(`racer joined id=${client.sessionId} name="${name}" host=${client.sessionId === this.hostSessionId}`);
        client.send('race-welcome', {
            courseJson: this.courseJson,
            selfId: client.sessionId,
            hostId: this.hostSessionId,
            roster: this.rosterEntries()
        });
        this.broadcastRoster();
    }
    onLeave(client, _code) {
        const wasHost = client.sessionId === this.hostSessionId;
        this.racers.delete(client.sessionId);
        this.log(`racer left id=${client.sessionId} host=${wasHost}`);
        if (wasHost) {
            // The session is the host's course — no host, no session (mirrors private-duel spirit).
            this.broadcast('race-closed', { reason: 'host-left' });
            void this.disconnect();
            return;
        }
        this.broadcastRoster();
    }
    onDispose() {
        activeCourseRoomCount = Math.max(0, activeCourseRoomCount - 1);
        this.log('race room disposed');
    }
    // ---------------------------------------------------------------------------------------------
    broadcastPoses() {
        if (this.racers.size < 2) {
            // Nobody to relay to (or only the host waiting) — still clear dirty flags cheaply.
            for (const racer of this.racers.values())
                racer.poseDirty = false;
            return;
        }
        const poses = [];
        for (const [id, racer] of this.racers) {
            if (!racer.poseDirty || !racer.pose)
                continue;
            racer.poseDirty = false;
            poses.push({ id, ...racer.pose });
        }
        if (poses.length === 0)
            return;
        this.broadcast('race-poses', { poses });
    }
    rosterEntries() {
        const entries = [];
        for (const [id, racer] of this.racers) {
            entries.push({ id, name: racer.name, host: id === this.hostSessionId, bestMs: racer.bestMs, lastMs: racer.lastMs });
        }
        return entries;
    }
    broadcastRoster() {
        this.broadcast('race-roster', {
            hostId: this.hostSessionId,
            roster: this.rosterEntries()
        });
    }
    takeEventToken(racer) {
        const now = Date.now();
        const elapsed = (now - racer.eventTokensRefilledAtMs) / 1000;
        if (elapsed > 0) {
            racer.eventTokens = Math.min(courseRace_1.COURSE_RACE_LIMITS.runEventBurst, racer.eventTokens + elapsed * courseRace_1.COURSE_RACE_LIMITS.runEventRefillPerSecond);
            racer.eventTokensRefilledAtMs = now;
        }
        if (racer.eventTokens < 1)
            return false;
        racer.eventTokens -= 1;
        return true;
    }
    log(message) {
        console.log(`[course ${this.roomId}] ${message}`);
    }
}
exports.CourseRoom = CourseRoom;
