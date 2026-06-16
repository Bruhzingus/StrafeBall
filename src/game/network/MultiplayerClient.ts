import { Client, Room } from '@colyseus/sdk';
import type {
  CatchParryRequest,
  DropRequest,
  InputCommand,
  PickupRequest,
  ResetRequest,
  ServerMessage,
  ServerSnapshot,
  ThrowRequest
} from '../../../shared/protocol';
import type { HandSide, PlayerInput, Vec3 } from '../../../shared/types';

export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'error';

export class MultiplayerClient {
  public readonly serverUrl: string;
  public status: ConnectionStatus = 'offline';
  public errorMessage = '';
  public roomId = '';
  public localPlayerId = '';
  public pingMs: number | null = null;
  public latestSnapshot: ServerSnapshot | null = null;
  public snapshotDebug = {
    receivedPerSecond: 0,
    averageMsBetweenSnapshots: 0,
    maxMsBetweenSnapshots: 0
  };

  private readonly client: Client;
  private room: Room | null = null;
  private pingTimer: number | null = null;
  private lastPingClientTime = 0;
  private snapshotWindowStartedAtMs = 0;
  private snapshotWindowCount = 0;
  private lastSnapshotReceivedAtMs = 0;
  private snapshotIntervalTotalMs = 0;
  private snapshotIntervalCount = 0;
  private snapshotIntervalMaxMs = 0;
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

  async createRoom(name: string): Promise<void> {
    await this.connect(() => this.client.create('duel', { name: cleanName(name) }));
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

  requestReset(): void {
    this.room?.send('reset', { type: 'reset', playerId: this.localPlayerId } satisfies ResetRequest);
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
      this.recordSnapshotReceived();
      this.latestSnapshot = message;
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
      this.resetSnapshotDebug();
    });
  }

  private recordSnapshotReceived(): void {
    const now = Date.now();
    if (this.snapshotWindowStartedAtMs === 0) this.snapshotWindowStartedAtMs = now;

    if (this.lastSnapshotReceivedAtMs > 0) {
      const interval = now - this.lastSnapshotReceivedAtMs;
      this.snapshotIntervalTotalMs += interval;
      this.snapshotIntervalCount += 1;
      this.snapshotIntervalMaxMs = Math.max(this.snapshotIntervalMaxMs, interval);
    }

    this.lastSnapshotReceivedAtMs = now;
    this.snapshotWindowCount += 1;

    const elapsed = now - this.snapshotWindowStartedAtMs;
    if (elapsed < 1000) return;

    this.snapshotDebug = {
      receivedPerSecond: this.snapshotWindowCount / (elapsed / 1000),
      averageMsBetweenSnapshots: this.snapshotIntervalCount > 0 ? this.snapshotIntervalTotalMs / this.snapshotIntervalCount : 0,
      maxMsBetweenSnapshots: this.snapshotIntervalMaxMs
    };

    this.snapshotWindowStartedAtMs = now;
    this.snapshotWindowCount = 0;
    this.snapshotIntervalTotalMs = 0;
    this.snapshotIntervalCount = 0;
    this.snapshotIntervalMaxMs = 0;
  }

  private resetSnapshotDebug(): void {
    this.snapshotDebug = {
      receivedPerSecond: 0,
      averageMsBetweenSnapshots: 0,
      maxMsBetweenSnapshots: 0
    };
    this.snapshotWindowStartedAtMs = 0;
    this.snapshotWindowCount = 0;
    this.lastSnapshotReceivedAtMs = 0;
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
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 24) : 'Player';
}
