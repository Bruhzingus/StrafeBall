/**
 * Course Race — thin socket wrapper for the ghost-relay CourseRoom (see shared/courseRace.ts and
 * server/src/rooms/CourseRoom.ts for the model).
 *
 * This owns exactly one concern: the Colyseus connection for a race session — create/join with a
 * room code, throttled pose sends, run-event sends, and typed message callbacks. Everything above
 * it (ghost rendering, UI, ArenaScene wiring) lives in CourseRaceSession. Completely separate from
 * MultiplayerClient — the duel connection is never touched or shared.
 */

import { Client, Room } from '@colyseus/sdk';
import {
  COURSE_RACE_LIMITS,
  type RaceClosed,
  type RaceEventBroadcast,
  type RacePose,
  type RacePosesBroadcast,
  type RaceRosterBroadcast,
  type RaceRunEvent,
  type RaceWelcome
} from '../../../shared/courseRace';
import { resolveServerUrl } from './MultiplayerClient';

export interface CourseRaceCallbacks {
  onWelcome(welcome: RaceWelcome): void;
  onRoster(roster: RaceRosterBroadcast): void;
  onPoses(poses: RacePosesBroadcast): void;
  onEvent(event: RaceEventBroadcast): void;
  onRestart(): void;
  onClosed(closed: RaceClosed): void;
  /** Socket dropped / room left for any reason other than an explicit race-closed. */
  onDisconnected(): void;
}

const POSE_SEND_INTERVAL_MS = 1000 / COURSE_RACE_LIMITS.poseSendHz;

export class CourseRaceClient {
  private readonly client: Client;
  private room: Room | null = null;
  private lastPoseSentAtMs = 0;
  // Incremented per connect; a stale awaited join that lost the race leaves its orphan room.
  private connectGeneration = 0;

  constructor(private readonly callbacks: CourseRaceCallbacks, serverUrl = resolveServerUrl()) {
    this.client = new Client(serverUrl);
  }

  get connected(): boolean {
    return this.room !== null;
  }

  get roomId(): string {
    return this.room?.roomId ?? '';
  }

  async createRace(name: string, courseJson: string): Promise<void> {
    await this.connect(() => this.client.create('course', { name, courseJson }));
  }

  async joinRace(code: string, name: string): Promise<void> {
    await this.connect(() => this.client.joinById(code.trim(), { name }));
  }

  private async connect(factory: () => Promise<Room>): Promise<void> {
    const generation = ++this.connectGeneration;
    await this.leave();
    const room = await factory();
    if (generation !== this.connectGeneration) {
      // Superseded by a newer connect while awaiting — abandon this room, don't leak the session.
      void room.leave(true);
      return;
    }
    this.room = room;
    this.wireRoom(room);
  }

  private wireRoom(room: Room): void {
    room.onMessage('race-welcome', (message: RaceWelcome) => this.callbacks.onWelcome(message));
    room.onMessage('race-roster', (message: RaceRosterBroadcast) => this.callbacks.onRoster(message));
    room.onMessage('race-poses', (message: RacePosesBroadcast) => this.callbacks.onPoses(message));
    room.onMessage('race-event', (message: RaceEventBroadcast) => this.callbacks.onEvent(message));
    room.onMessage('race-restart', () => this.callbacks.onRestart());
    room.onMessage('race-closed', (message: RaceClosed) => this.callbacks.onClosed(message));
    room.onLeave(() => {
      if (this.room === room) {
        this.room = null;
        this.callbacks.onDisconnected();
      }
    });
  }

  /** Send the local racer's pose, internally throttled to the shared send rate. */
  sendPose(pose: RacePose): void {
    const room = this.room;
    if (!room) return;
    const now = performance.now();
    if (now - this.lastPoseSentAtMs < POSE_SEND_INTERVAL_MS) return;
    this.lastPoseSentAtMs = now;
    room.send('race-pose', pose);
  }

  sendRunEvent(event: RaceRunEvent): void {
    this.room?.send('race-run-event', event);
  }

  /** Host only (the server enforces it): restart everyone's run. */
  sendRestart(): void {
    this.room?.send('race-restart', {});
  }

  /** Leave the current session (no-op when not connected). Safe to call repeatedly. */
  async leave(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.room = null; // clear first so the onLeave handler doesn't double-fire onDisconnected
    try {
      await room.leave(true);
    } catch {
      // Socket already gone — nothing to clean up.
    }
  }
}
