import { Client, Room } from '@colyseus/sdk';
import type {
  CatchEvent,
  CatchParryRequest,
  DropRequest,
  HitEvent,
  HitRevertEvent,
  InputCommand,
  ParryEvent,
  PickupRequest,
  ResetRequest,
  StartVoteRequest,
  ServerMessage,
  ServerSnapshot,
  SwitchTeamRequest,
  ThrowEvent,
  ThrowRequest
} from '../../../shared/protocol';
import type { HandSide, MatchMode, PlayerInput, Vec3 } from '../../../shared/types';
import { PERF_REPORT_INTERVAL_MS } from '../../../shared/netConfig';

export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'error';

/** Shared empty array returned by drainThrowEvents when nothing is queued (no per-call allocation). */
const EMPTY_THROW_EVENTS: readonly ThrowEvent[] = [];
const EMPTY_CATCH_EVENTS: readonly CatchEvent[] = [];
const EMPTY_PARRY_EVENTS: readonly ParryEvent[] = [];
const EMPTY_HIT_EVENTS: readonly HitEvent[] = [];
const EMPTY_HIT_REVERT_EVENTS: readonly HitRevertEvent[] = [];

export class MultiplayerClient {
  public readonly serverUrl: string;
  public status: ConnectionStatus = 'offline';
  public errorMessage = '';
  public roomId = '';
  public localPlayerId = '';
  public pingMs: number | null = null;
  public latestSnapshot: ServerSnapshot | null = null;
  // Throw events received since the last drain. The renderer drains these each frame to seed/refresh
  // deterministic live-ball visual prediction. Bounded: cleared on drain and on leave/reset.
  private throwEventQueue: ThrowEvent[] = [];
  private catchEventQueue: CatchEvent[] = [];
  private parryEventQueue: ParryEvent[] = [];
  private hitEventQueue: HitEvent[] = [];
  private hitRevertEventQueue: HitRevertEvent[] = [];
  public snapshotDebug = {
    receivedPerSecond: 0,
    uniqueTicksPerSecond: 0,
    averageMsBetweenSnapshots: 0,
    maxMsBetweenSnapshots: 0,
    duplicateOrOutOfOrder: 0,
    staleDropped: 0,
    socketBufferedAmount: 0
  };

  private readonly client: Client;
  private room: Room | null = null;
  private pingTimer: number | null = null;
  private lastPingClientTime = 0;
  private snapshotWindowStartedAtMs = 0;
  private snapshotWindowCount = 0;
  private snapshotWindowUniqueCount = 0;
  private snapshotWindowDuplicateCount = 0;
  private lastSnapshotReceivedAtMs = 0;
  private lastSnapshotTick = -1;
  private snapshotIntervalTotalMs = 0;
  private snapshotIntervalCount = 0;
  private snapshotIntervalMaxMs = 0;
  private snapshotWindowStaleDropped = 0;
  // Incremented on every connect() call. Lets an awaited join() detect it was superseded by a
  // newer call (e.g. user double-clicks Create) and leave the orphaned room rather than
  // overwriting this.room and leaking the server-side session.
  private connectGeneration = 0;

  constructor(serverUrl = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:2567') {
    this.serverUrl = serverUrl;
    this.client = new Client(serverUrl);
  }

  get connected(): boolean {
    return this.status === 'connected' && this.room !== null;
  }

  async createRoom(name: string, mode: MatchMode = '1v1'): Promise<void> {
    await this.connect(() => this.client.create('duel', { name: cleanName(name), mode }));
  }

  async joinRoom(roomId: string, name: string): Promise<void> {
    const code = roomId.trim();
    if (!code) {
      this.status = 'error';
      this.errorMessage = 'Enter a room code.';
      return;
    }
    await this.connect(() => this.client.joinById(code, { name: cleanName(name) }));
  }

  leave(): void {
    this.stopPing();
    this.room?.leave();
    this.room = null;
    this.status = 'offline';
    this.roomId = '';
    this.localPlayerId = '';
    this.latestSnapshot = null;
    this.throwEventQueue = [];
    this.catchEventQueue = [];
    this.parryEventQueue = [];
    this.hitEventQueue = [];
    this.hitRevertEventQueue = [];
    this.resetSnapshotDebug();
  }

  dispose(): void {
    this.leave();
  }

  sendInput(input: PlayerInput): void {
    this.room?.send('input', {
      type: 'input',
      playerId: this.localPlayerId,
      sequence: input.sequence,
      clientTimeMs: input.clientTimeMs,
      input
    } satisfies InputCommand);
  }

  requestPickup(): void {
    this.room?.send('pickup', { type: 'pickup', playerId: this.localPlayerId } satisfies PickupRequest);
  }

  requestDrop(hand?: HandSide): void {
    this.room?.send('drop', { type: 'drop', playerId: this.localPlayerId, hand } satisfies DropRequest);
  }

  requestThrow(hand: HandSide, direction: Vec3, charge01: number): void {
    this.room?.send('throw', {
      type: 'throw',
      playerId: this.localPlayerId,
      hand,
      direction,
      charge01
    } satisfies ThrowRequest);
  }

  requestCatchParry(hand: HandSide | undefined, facing: Vec3): void {
    this.room?.send('catch-parry', {
      type: 'catch-parry',
      playerId: this.localPlayerId,
      hand,
      facing
    } satisfies CatchParryRequest);
  }

  /** Drain throw events received since the last call (renderer consumes these for ball prediction). */
  drainThrowEvents(): readonly ThrowEvent[] {
    if (this.throwEventQueue.length === 0) return EMPTY_THROW_EVENTS;
    const events = this.throwEventQueue;
    this.throwEventQueue = [];
    return events;
  }

  drainCatchEvents(): readonly CatchEvent[] {
    if (this.catchEventQueue.length === 0) return EMPTY_CATCH_EVENTS;
    const events = this.catchEventQueue;
    this.catchEventQueue = [];
    return events;
  }

  drainParryEvents(): readonly ParryEvent[] {
    if (this.parryEventQueue.length === 0) return EMPTY_PARRY_EVENTS;
    const events = this.parryEventQueue;
    this.parryEventQueue = [];
    return events;
  }

  drainHitEvents(): readonly HitEvent[] {
    if (this.hitEventQueue.length === 0) return EMPTY_HIT_EVENTS;
    const events = this.hitEventQueue;
    this.hitEventQueue = [];
    return events;
  }

  drainHitRevertEvents(): readonly HitRevertEvent[] {
    if (this.hitRevertEventQueue.length === 0) return EMPTY_HIT_REVERT_EVENTS;
    const events = this.hitRevertEventQueue;
    this.hitRevertEventQueue = [];
    return events;
  }

  requestReset(): void {
    this.room?.send('reset', { type: 'reset', playerId: this.localPlayerId } satisfies ResetRequest);
  }

  requestStartVote(): void {
    this.room?.send('start-vote', { type: 'start-vote', playerId: this.localPlayerId } satisfies StartVoteRequest);
  }

  requestSwitchTeam(teamId: string, teamSlotIndex?: number): void {
    this.room?.send('switch-team', {
      type: 'switch-team',
      playerId: this.localPlayerId,
      teamId,
      teamSlotIndex
    } satisfies SwitchTeamRequest);
  }

  private async connect(join: () => Promise<Room>): Promise<void> {
    const gen = ++this.connectGeneration;
    this.leave();
    this.status = 'connecting';
    this.errorMessage = '';

    try {
      const room = await join();

      if (gen !== this.connectGeneration) {
        // A newer connect() started while we were awaiting the server handshake. Leave the
        // orphaned room so the server session is cleaned up immediately rather than waiting for
        // a timeout. Don't update any shared state — the newer call owns it.
        void room.leave().catch(() => undefined);
        return;
      }

      this.room = room;
      this.status = 'connected';
      this.roomId = room.roomId;
      this.localPlayerId = room.sessionId;
      this.bindRoom(room);
      this.startPing();
    } catch (error) {
      if (gen !== this.connectGeneration) return; // superseded, ignore the error
      this.room = null;
      this.status = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  private bindRoom(room: Room): void {
    room.onMessage('snapshot', (message: ServerSnapshot) => {
      if (this.room !== room) return;
      this.recordSnapshotReceived(message);
      if (this.latestSnapshot && message.tick <= this.latestSnapshot.tick) {
        this.snapshotWindowStaleDropped += 1;
        return;
      }
      this.latestSnapshot = message;
    });

    room.onMessage('throw-event', (message: ThrowEvent) => {
      if (this.room !== room) return;
      // Cap the queue so a burst (or a frame the renderer didn't drain) can't grow unbounded.
      if (this.throwEventQueue.length >= 32) this.throwEventQueue.shift();
      this.throwEventQueue.push(message);
    });

    room.onMessage('catch-event', (message: CatchEvent) => {
      if (this.room !== room) return;
      if (this.catchEventQueue.length >= 16) this.catchEventQueue.shift();
      this.catchEventQueue.push(message);
    });

    room.onMessage('parry-event', (message: ParryEvent) => {
      if (this.room !== room) return;
      if (this.parryEventQueue.length >= 16) this.parryEventQueue.shift();
      this.parryEventQueue.push(message);
    });

    room.onMessage('hit-event', (message: HitEvent) => {
      if (this.room !== room) return;
      if (this.hitEventQueue.length >= 16) this.hitEventQueue.shift();
      this.hitEventQueue.push(message);
    });

    room.onMessage('hit-revert-event', (message: HitRevertEvent) => {
      if (this.room !== room) return;
      if (this.hitRevertEventQueue.length >= 16) this.hitRevertEventQueue.shift();
      this.hitRevertEventQueue.push(message);
    });

    room.onMessage('joined-room', (message: Extract<ServerMessage, { type: 'joined-room' }>) => {
      if (this.room !== room) return;
      this.localPlayerId = message.playerId;
      this.latestSnapshot = {
        type: 'snapshot',
        tick: message.room.tick,
        serverTimeMs: Date.now(),
        room: message.room
      };
    });

    room.onMessage('request-rejected', (message: Extract<ServerMessage, { type: 'request-rejected' }>) => {
      if (this.room !== room) return;
      this.errorMessage = `${message.request}: ${message.reason}`;
    });

    room.onMessage('pong', (message: Extract<ServerMessage, { type: 'pong' }>) => {
      if (this.room !== room) return;
      this.pingMs = Math.max(0, Date.now() - message.clientTimeMs);
    });

    room.onError((code, message) => {
      if (this.room !== room) return;
      this.status = 'error';
      this.errorMessage = `${code}: ${message}`;
    });

    room.onLeave(() => {
      if (this.room !== room) return;
      this.stopPing();
      this.room = null;
      this.status = 'offline';
      this.roomId = '';
      this.localPlayerId = '';
      this.latestSnapshot = null;
      this.throwEventQueue = [];
      this.catchEventQueue = [];
      this.parryEventQueue = [];
      this.hitEventQueue = [];
      this.hitRevertEventQueue = [];
      this.resetSnapshotDebug();
    });
  }

  private recordSnapshotReceived(message: ServerSnapshot): void {
    const now = performance.now();
    if (this.snapshotWindowStartedAtMs === 0) this.snapshotWindowStartedAtMs = now;

    if (message.tick > this.lastSnapshotTick) {
      this.snapshotWindowUniqueCount += 1;
      this.lastSnapshotTick = message.tick;
    } else {
      this.snapshotWindowDuplicateCount += 1;
    }

    if (this.lastSnapshotReceivedAtMs > 0) {
      const interval = now - this.lastSnapshotReceivedAtMs;
      this.snapshotIntervalTotalMs += interval;
      this.snapshotIntervalCount += 1;
      this.snapshotIntervalMaxMs = Math.max(this.snapshotIntervalMaxMs, interval);
    }

    this.lastSnapshotReceivedAtMs = now;
    this.snapshotWindowCount += 1;

    const elapsed = now - this.snapshotWindowStartedAtMs;
    if (elapsed < PERF_REPORT_INTERVAL_MS) return;

    this.snapshotDebug = {
      receivedPerSecond: this.snapshotWindowCount / (elapsed / 1000),
      uniqueTicksPerSecond: this.snapshotWindowUniqueCount / (elapsed / 1000),
      averageMsBetweenSnapshots: this.snapshotIntervalCount > 0 ? this.snapshotIntervalTotalMs / this.snapshotIntervalCount : 0,
      maxMsBetweenSnapshots: this.snapshotIntervalMaxMs,
      duplicateOrOutOfOrder: this.snapshotWindowDuplicateCount,
      staleDropped: this.snapshotWindowStaleDropped,
      socketBufferedAmount: this.socketBufferedAmount()
    };

    this.snapshotWindowStartedAtMs = now;
    this.snapshotWindowCount = 0;
    this.snapshotWindowUniqueCount = 0;
    this.snapshotWindowDuplicateCount = 0;
    this.snapshotWindowStaleDropped = 0;
    this.snapshotIntervalTotalMs = 0;
    this.snapshotIntervalCount = 0;
    this.snapshotIntervalMaxMs = 0;
  }

  private resetSnapshotDebug(): void {
    this.snapshotDebug = {
      receivedPerSecond: 0,
      uniqueTicksPerSecond: 0,
      averageMsBetweenSnapshots: 0,
      maxMsBetweenSnapshots: 0,
      duplicateOrOutOfOrder: 0,
      staleDropped: 0,
      socketBufferedAmount: 0
    };
    this.snapshotWindowStartedAtMs = 0;
    this.snapshotWindowCount = 0;
    this.snapshotWindowUniqueCount = 0;
    this.snapshotWindowDuplicateCount = 0;
    this.snapshotWindowStaleDropped = 0;
    this.lastSnapshotReceivedAtMs = 0;
    this.lastSnapshotTick = -1;
    this.snapshotIntervalTotalMs = 0;
    this.snapshotIntervalCount = 0;
    this.snapshotIntervalMaxMs = 0;
  }

  private startPing(): void {
    this.stopPing();
    this.sendPing();
    this.pingTimer = window.setInterval(() => this.sendPing(), 2000);
  }

  private sendPing(): void {
    if (!this.room) return;
    this.lastPingClientTime = Date.now();
    this.room.send('ping', { clientTimeMs: this.lastPingClientTime });
  }

  private stopPing(): void {
    if (this.pingTimer === null) return;
    window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private socketBufferedAmount(): number {
    const room = this.room as Room & {
      connection?: {
        ws?: { bufferedAmount?: number };
        transport?: { ws?: { bufferedAmount?: number } };
      };
    };
    return room.connection?.ws?.bufferedAmount
      ?? room.connection?.transport?.ws?.bufferedAmount
      ?? 0;
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 24) : 'Player';
}
