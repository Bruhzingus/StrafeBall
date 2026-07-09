import { Client, Room } from 'colyseus';
import {
  COURSE_RACE_LIMITS,
  cleanRaceName,
  sanitizePose,
  sanitizeRunEvent,
  sanityCheckCourseJson,
  type RaceClosed,
  type RaceEventBroadcast,
  type RacePose,
  type RacePosesBroadcast,
  type RaceRosterBroadcast,
  type RaceRosterEntry,
  type RaceWelcome
} from '../../../shared/courseRace';

/**
 * Course Race room — a private, invite-only ghost-relay session for racing a Creator course.
 *
 * Deliberately NOT a simulation room (see shared/courseRace.ts for the model): every racer runs
 * the course locally on the offline movement stack; this room only
 *   - holds the host's course JSON as an opaque sanity-checked blob and hands it to joiners,
 *   - relays sanitized racer poses in a fixed-rate batch broadcast,
 *   - relays sanitized run events and keeps the session's best-time roster,
 *   - lets the host restart everyone's run or close the session by leaving.
 *
 * It never touches DuelRoom / ServerGameLoop / the shared movement sim — a separate, lower-stakes
 * room type. Every inbound payload passes a shared pure sanitizer, so a hostile client can at
 * worst spam bounded, well-formed messages (and the per-message guards below bound even that).
 */

export interface CourseRoomOptions {
  name?: string;
  /** The host's course layout, JSON-stringified. Required; sanity-checked in onCreate. */
  courseJson?: string;
}

// Cheap process-wide DoS guard, mirroring DuelRoom's MAX_ROOMS pattern.
const MAX_COURSE_ROOMS = 100;
let activeCourseRoomCount = 0;

interface RacerState {
  name: string;
  bestMs: number | null;
  lastMs: number | null;
  pose: RacePose | null;
  /** True when a fresh pose arrived since the last broadcast (don't rebroadcast stale poses). */
  poseDirty: boolean;
  lastPoseAcceptedAtMs: number;
  /** Token bucket for run events (checkpoints can legitimately cluster). */
  eventTokens: number;
  eventTokensRefilledAtMs: number;
}

export class CourseRoom extends Room {
  private courseJson = '';
  private hostSessionId = '';
  private lastRestartAtMs = 0;
  private readonly racers = new Map<string, RacerState>();

  onCreate(options: CourseRoomOptions = {}): void {
    // Validate BEFORE counting this room as active: a rejected create throws, and if the framework
    // then skips onDispose (room never fully created) an increment here would leak the counter until
    // the capacity guard locks out all course rooms. onDispose clamps at 0, so counting only after a
    // successful create is correct whether or not onDispose fires for a failed one.
    const check = sanityCheckCourseJson(options.courseJson);
    if (!check.ok) {
      // Rejecting creation surfaces as a failed client.create() promise — the creator sees the error.
      throw new Error(`course rejected: ${check.reason}`);
    }
    activeCourseRoomCount += 1;
    this.setPrivate(true);
    this.maxClients = COURSE_RACE_LIMITS.maxRacers;
    // Poses at ~20/s plus events/restart headroom. Colyseus force-closes clients exceeding this.
    this.maxMessagesPerSecond = 60;

    this.courseJson = options.courseJson as string;
    this.log(`race room created objects=${check.objectCount} courseChars=${this.courseJson.length}`);

    this.onMessage('race-pose', (client, message: unknown) => {
      const racer = this.racers.get(client.sessionId);
      if (!racer) return;
      const now = Date.now();
      if (now - racer.lastPoseAcceptedAtMs < COURSE_RACE_LIMITS.poseMinIntervalMs) return;
      const pose = sanitizePose(message);
      if (!pose) return;
      racer.pose = pose;
      racer.poseDirty = true;
      racer.lastPoseAcceptedAtMs = now;
    });

    this.onMessage('race-run-event', (client, message: unknown) => {
      const racer = this.racers.get(client.sessionId);
      if (!racer) return;
      if (!this.takeEventToken(racer)) return;
      const event = sanitizeRunEvent(message);
      if (!event) return;
      if (event.kind === 'finish' && typeof event.timeMs === 'number') {
        racer.lastMs = event.timeMs;
        racer.bestMs = racer.bestMs === null ? event.timeMs : Math.min(racer.bestMs, event.timeMs);
      }
      this.broadcast('race-event', {
        id: client.sessionId,
        name: racer.name,
        event
      } satisfies RaceEventBroadcast);
      if (event.kind === 'finish') this.broadcastRoster();
    });

    this.onMessage('race-restart', (client) => {
      if (client.sessionId !== this.hostSessionId) return;
      const now = Date.now();
      if (now - this.lastRestartAtMs < COURSE_RACE_LIMITS.restartMinIntervalMs) return;
      this.lastRestartAtMs = now;
      this.broadcast('race-restart', {});
    });

    // Fixed-rate batched pose relay. Only fresh poses go out; an idle/AFK racer costs nothing.
    this.setSimulationInterval(() => this.broadcastPoses(), Math.round(1000 / COURSE_RACE_LIMITS.poseBroadcastHz));
  }

  onAuth(_client: Client, _options: CourseRoomOptions): boolean {
    if (activeCourseRoomCount > MAX_COURSE_ROOMS) {
      this.log('join rejected reason=server-at-capacity');
      return false;
    }
    const allowed = this.clients.length < this.maxClients;
    if (!allowed) this.log('join rejected reason=room-full');
    return allowed;
  }

  onJoin(client: Client, options: CourseRoomOptions): void {
    const name = cleanRaceName(options.name);
    if (this.racers.size === 0) this.hostSessionId = client.sessionId;
    this.racers.set(client.sessionId, {
      name,
      bestMs: null,
      lastMs: null,
      pose: null,
      poseDirty: false,
      lastPoseAcceptedAtMs: 0,
      eventTokens: COURSE_RACE_LIMITS.runEventBurst,
      eventTokensRefilledAtMs: Date.now()
    });
    this.log(`racer joined id=${client.sessionId} name="${name}" host=${client.sessionId === this.hostSessionId}`);

    // Re-flag every existing racer's last-known pose so the next relay tick re-sends it to everyone,
    // including this joiner. Without this a newcomer sees no ghosts until each other racer moves —
    // so a lobby of players lined up stationary at the start line would appear as an empty course.
    for (const racer of this.racers.values()) {
      if (racer.pose) racer.poseDirty = true;
    }

    client.send('race-welcome', {
      courseJson: this.courseJson,
      selfId: client.sessionId,
      hostId: this.hostSessionId,
      roster: this.rosterEntries()
    } satisfies RaceWelcome);
    this.broadcastRoster();
  }

  onLeave(client: Client, _code?: number): void {
    const wasHost = client.sessionId === this.hostSessionId;
    this.racers.delete(client.sessionId);
    this.log(`racer left id=${client.sessionId} host=${wasHost}`);
    if (wasHost) {
      // The session is the host's course — no host, no session (mirrors private-duel spirit).
      this.broadcast('race-closed', { reason: 'host-left' } satisfies RaceClosed);
      void this.disconnect();
      return;
    }
    this.broadcastRoster();
  }

  onDispose(): void {
    activeCourseRoomCount = Math.max(0, activeCourseRoomCount - 1);
    this.log('race room disposed');
  }

  // ---------------------------------------------------------------------------------------------

  private broadcastPoses(): void {
    if (this.racers.size < 2) {
      // Nobody to relay to (or only the host waiting) — still clear dirty flags cheaply.
      for (const racer of this.racers.values()) racer.poseDirty = false;
      return;
    }
    const poses: RacePosesBroadcast['poses'] = [];
    for (const [id, racer] of this.racers) {
      if (!racer.poseDirty || !racer.pose) continue;
      racer.poseDirty = false;
      poses.push({ id, ...racer.pose });
    }
    if (poses.length === 0) return;
    this.broadcast('race-poses', { poses } satisfies RacePosesBroadcast);
  }

  private rosterEntries(): RaceRosterEntry[] {
    const entries: RaceRosterEntry[] = [];
    for (const [id, racer] of this.racers) {
      entries.push({ id, name: racer.name, host: id === this.hostSessionId, bestMs: racer.bestMs, lastMs: racer.lastMs });
    }
    return entries;
  }

  private broadcastRoster(): void {
    this.broadcast('race-roster', {
      hostId: this.hostSessionId,
      roster: this.rosterEntries()
    } satisfies RaceRosterBroadcast);
  }

  private takeEventToken(racer: RacerState): boolean {
    const now = Date.now();
    const elapsed = (now - racer.eventTokensRefilledAtMs) / 1000;
    if (elapsed > 0) {
      racer.eventTokens = Math.min(
        COURSE_RACE_LIMITS.runEventBurst,
        racer.eventTokens + elapsed * COURSE_RACE_LIMITS.runEventRefillPerSecond
      );
      racer.eventTokensRefilledAtMs = now;
    }
    if (racer.eventTokens < 1) return false;
    racer.eventTokens -= 1;
    return true;
  }

  private log(message: string): void {
    console.log(`[course ${this.roomId}] ${message}`);
  }
}
