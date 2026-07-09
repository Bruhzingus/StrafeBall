/**
 * Co-op Course Editing — thin socket wrapper for the collaborative EditRoom (see shared/coopEdit.ts
 * and server/src/rooms/EditRoom.ts). Owns exactly the Colyseus connection: create/join with a room
 * code, throttled presence sends, per-object edit/lock sends, and typed message callbacks. Fully
 * separate from MultiplayerClient (the duel connection) and CourseRaceClient (the race connection).
 */

import { Client, Room } from '@colyseus/sdk';
import {
  COOP_EDIT_LIMITS,
  type CoopClosed,
  type CoopEditBroadcast,
  type CoopLocksBroadcast,
  type CoopPresence,
  type CoopPresenceBroadcast,
  type CoopRosterBroadcast,
  type CoopWelcome
} from '../../../shared/coopEdit';
import { resolveServerUrl } from './MultiplayerClient';

export interface CoopEditCallbacks {
  onWelcome(welcome: CoopWelcome): void;
  onRoster(roster: CoopRosterBroadcast): void;
  onEdit(message: CoopEditBroadcast): void;
  onLocks(message: CoopLocksBroadcast): void;
  onPresence(message: CoopPresenceBroadcast): void;
  onClosed(closed: CoopClosed): void;
  /** Socket dropped for any reason other than an explicit coop-closed. */
  onDisconnected(): void;
}

const PRESENCE_SEND_INTERVAL_MS = 1000 / COOP_EDIT_LIMITS.presenceSendHz;

export class CoopEditClient {
  private readonly client: Client;
  private room: Room | null = null;
  private lastPresenceSentAtMs = 0;
  private connectGeneration = 0;

  constructor(private readonly callbacks: CoopEditCallbacks, serverUrl = resolveServerUrl()) {
    this.client = new Client(serverUrl);
  }

  get connected(): boolean {
    return this.room !== null;
  }

  get roomId(): string {
    return this.room?.roomId ?? '';
  }

  async createSession(name: string, courseJson: string): Promise<void> {
    await this.connect(() => this.client.create('coop', { name, courseJson }));
  }

  async joinSession(code: string, name: string): Promise<void> {
    await this.connect(() => this.client.joinById(code.trim(), { name }));
  }

  private async connect(factory: () => Promise<Room>): Promise<void> {
    const generation = ++this.connectGeneration;
    await this.leave();
    const room = await factory();
    if (generation !== this.connectGeneration) {
      void room.leave(true);
      return;
    }
    this.room = room;
    room.onMessage('coop-welcome', (m: CoopWelcome) => this.callbacks.onWelcome(m));
    room.onMessage('coop-roster', (m: CoopRosterBroadcast) => this.callbacks.onRoster(m));
    room.onMessage('coop-edit', (m: CoopEditBroadcast) => this.callbacks.onEdit(m));
    room.onMessage('coop-locks', (m: CoopLocksBroadcast) => this.callbacks.onLocks(m));
    room.onMessage('coop-presence', (m: CoopPresenceBroadcast) => this.callbacks.onPresence(m));
    room.onMessage('coop-closed', (m: CoopClosed) => this.callbacks.onClosed(m));
    room.onLeave(() => {
      if (this.room === room) {
        this.room = null;
        this.callbacks.onDisconnected();
      }
    });
  }

  /** Relay one commit's worth of changes — all upserts + deletes batched into a single message. */
  sendEdit(upserts: Record<string, unknown>[], deletes: string[]): void {
    if (upserts.length === 0 && deletes.length === 0) return;
    this.room?.send('coop-edit', { upserts, deletes });
  }

  /** Request an exclusive lock on an object (server arbitrates; grant arrives via onLocks). */
  sendLock(id: string): void {
    this.room?.send('coop-lock', { id });
  }

  sendUnlock(id: string): void {
    this.room?.send('coop-unlock', { id });
  }

  sendUnlockAll(): void {
    this.room?.send('coop-unlock-all', {});
  }

  /** Send local presence, throttled to the shared send rate. */
  sendPresence(presence: CoopPresence): void {
    const room = this.room;
    if (!room) return;
    const now = performance.now();
    if (now - this.lastPresenceSentAtMs < PRESENCE_SEND_INTERVAL_MS) return;
    this.lastPresenceSentAtMs = now;
    room.send('coop-presence', presence);
  }

  async leave(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.room = null;
    try {
      await room.leave(true);
    } catch {
      // Socket already gone.
    }
  }
}
