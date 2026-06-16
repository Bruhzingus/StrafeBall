import { Client, Room } from 'colyseus';
import type {
  ClientMessage,
  InputCommand,
  ServerMessage
} from '../../../shared/protocol';
import type { PlayerInput } from '../../../shared/types';
import { ServerGameLoop } from '../simulation/ServerGameLoop';

export interface DuelRoomOptions {
  name?: string;
}

const TICK_RATE = 30;
// How long a dropped player has to reconnect before they forfeit (#12).
const RECONNECT_SECONDS = 20;
// Hard cap on concurrent duel rooms per process (#19 — cheap DoS guard).
const MAX_ROOMS = 200;

let activeRoomCount = 0;

// Per-message-type rate limits: { capacity (burst), refillPerSecond } (#11).
const RATE_LIMITS: Record<string, { capacity: number; refillPerSecond: number }> = {
  input: { capacity: 60, refillPerSecond: 45 },
  throw: { capacity: 8, refillPerSecond: 8 },
  pickup: { capacity: 8, refillPerSecond: 8 },
  'catch-parry': { capacity: 10, refillPerSecond: 10 },
  drop: { capacity: 8, refillPerSecond: 8 },
  reset: { capacity: 2, refillPerSecond: 0.5 },
  ping: { capacity: 4, refillPerSecond: 2 }
};

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class DuelRoom extends Room {
  maxClients = 2;
  autoDispose = true;

  private game!: ServerGameLoop;
  private readonly buckets = new Map<string, Map<string, Bucket>>();

  onCreate(): void {
    activeRoomCount += 1;
    this.setPrivate(true);
    // Coarse built-in backstop on top of the per-type token buckets below (#11).
    this.maxMessagesPerSecond = 150;
    this.game = new ServerGameLoop(this.roomId, {
      tickRate: TICK_RATE,
      logger: (message) => this.log(message),
      debugInput: process.env.DEBUG_INPUT === '1' || process.env.DEBUG_GAMEPLAY === '1'
    });
    this.log('room created');

    this.onMessage('input', (client, message: Partial<InputCommand> | (Partial<PlayerInput> & { sequence?: number }) | undefined) => {
      if (!this.allow(client, 'input')) return;
      const wrapped = message && typeof message === 'object' && 'input' in message
        ? (message as Partial<InputCommand>)
        : undefined;
      const input = wrapped ? wrapped.input : (message as Partial<PlayerInput> | undefined);
      const seq = wrapped?.sequence ?? wrapped?.input?.sequence ?? (message as { sequence?: number } | undefined)?.sequence ?? 0;
      if (!this.game.handleInput(client.sessionId, input, seq)) {
        this.reject(client, 'input', 'unknown-player');
      }
    });

    this.onMessage('pickup', (client) => {
      if (!this.allow(client, 'pickup')) return;
      const result = this.game.handlePickup(client.sessionId);
      if (!result.ok) {
        this.log(`pickup rejected player=${client.sessionId} reason=${result.reason}`);
        this.reject(client, 'pickup', result.reason);
      } else if (result.log) {
        this.log(result.log);
      }
    });

    this.onMessage('drop', (client, message: { hand?: 'left' | 'right' }) => {
      if (!this.allow(client, 'drop')) return;
      const result = this.game.handleDrop(client.sessionId, message?.hand);
      if (!result.ok) this.reject(client, 'drop', result.reason);
    });

    this.onMessage('throw', (client, message: { hand?: 'left' | 'right' }) => {
      if (!this.allow(client, 'throw')) return;
      // direction/charge are intentionally NOT trusted — the server uses its own facing and the
      // server-tracked charge (#7). Only the hand selection comes from the client.
      const result = this.game.handleThrow(client.sessionId, { hand: message?.hand });
      if (!result.ok) {
        this.log(`throw rejected player=${client.sessionId} reason=${result.reason}`);
        this.reject(client, 'throw', result.reason);
      } else if (result.log) {
        this.log(result.log);
      }
    });

    this.onMessage('catch-parry', (client) => {
      if (!this.allow(client, 'catch-parry')) return;
      // facing is taken from the server's known aim, not the client (#8).
      const result = this.game.handleCatchParry(client.sessionId);
      if (!result.ok) this.reject(client, 'catch-parry', result.reason);
    });

    this.onMessage('reset', (client) => {
      if (!this.allow(client, 'reset')) return;
      const result = this.game.handleReset(client.sessionId);
      if (!result.ok) this.reject(client, 'reset', result.reason);
    });

    this.onMessage('ping', (client, message: { clientTimeMs?: number }) => {
      if (!this.allow(client, 'ping')) return;
      client.send('pong', {
        type: 'pong',
        clientTimeMs: message?.clientTimeMs ?? 0,
        serverTimeMs: Date.now()
      } satisfies ServerMessage);
    });

    this.setSimulationInterval(() => {
      // Skip the whole step+broadcast when no one is here (#18); empty rooms auto-dispose.
      if (this.clients.length === 0) return;
      this.broadcast('snapshot', this.game.step());
    }, 1000 / TICK_RATE);
  }

  onAuth(_client: Client, _options: DuelRoomOptions): boolean {
    if (activeRoomCount > MAX_ROOMS) {
      this.log('join rejected reason=server-at-capacity');
      return false;
    }
    const allowed = this.clients.length < this.maxClients;
    if (!allowed) this.log('join rejected reason=room-full');
    return allowed;
  }

  onJoin(client: Client, options: DuelRoomOptions): void {
    const player = this.game.addPlayer(client.sessionId, options.name);
    if (!player) {
      client.leave(4001);
      return;
    }
    this.game.setConnected(client.sessionId, true);
    this.log(`player joined id=${player.id} name="${player.name}" side=${player.spawnSide}`);

    client.send('joined-room', {
      type: 'joined-room',
      room: this.game.snapshot().room,
      playerId: player.id
    } satisfies ServerMessage);

    this.broadcast('player-joined', { type: 'player-joined', playerId: player.id } satisfies ServerMessage, { except: client });
  }

  // Unconsented disconnect: pause the player and give them a window to reconnect with their
  // state intact (#12). If the window elapses, the framework proceeds to onLeave.
  async onDrop(client: Client, _code?: number): Promise<void> {
    this.game.setConnected(client.sessionId, false);
    this.log(`player dropped id=${client.sessionId} — awaiting reconnection`);
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      // reconnection window elapsed — onLeave will finalize the departure
    }
  }

  onReconnect(client: Client): void {
    this.game.setConnected(client.sessionId, true);
    this.log(`player reconnected id=${client.sessionId}`);
  }

  // Terminal departure (consented leave, or reconnection window expired) → the remaining player
  // wins by forfeit (#13).
  onLeave(client: Client, _code?: number): void {
    this.buckets.delete(client.sessionId);
    this.game.abandon(client.sessionId);
    this.log(`player left id=${client.sessionId}`);
    this.broadcast('player-left', { type: 'player-left', playerId: client.sessionId } satisfies ServerMessage);
  }

  onDispose(): void {
    activeRoomCount = Math.max(0, activeRoomCount - 1);
    this.log('room disposed');
    this.game.dispose();
  }

  /** Token-bucket rate limit per client per message type (#11). Returns false if over limit. */
  private allow(client: Client, type: string): boolean {
    const limit = RATE_LIMITS[type];
    if (!limit) return true;

    let perClient = this.buckets.get(client.sessionId);
    if (!perClient) {
      perClient = new Map();
      this.buckets.set(client.sessionId, perClient);
    }

    const now = Date.now();
    const bucket = perClient.get(type) ?? { tokens: limit.capacity, lastRefillMs: now };
    const elapsed = (now - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(limit.capacity, bucket.tokens + elapsed * limit.refillPerSecond);
    bucket.lastRefillMs = now;

    if (bucket.tokens < 1) {
      perClient.set(type, bucket);
      return false;
    }
    bucket.tokens -= 1;
    perClient.set(type, bucket);
    return true;
  }

  private reject(client: Client, request: ClientMessage['type'], reason: string): void {
    client.send('request-rejected', { type: 'request-rejected', request, reason } satisfies ServerMessage);
  }

  private log(message: string): void {
    console.log(`[duel ${this.roomId}] ${message}`);
  }
}
