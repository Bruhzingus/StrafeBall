import { Client, Room } from 'colyseus';
import { performance } from 'node:perf_hooks';
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

const SIMULATION_TICK_RATE = 30;
// Visual state is sent through explicit `snapshot` messages, not Colyseus Schema patches.
// Keep this intentional so SERVER_TICK_RATE and client receive rate are not conflated.
const SNAPSHOT_RATE = 30;
const SIMULATION_STEP_MS = 1000 / SIMULATION_TICK_RATE;
const ROOM_LOOP_WAKE_RATE = 60;
const ROOM_LOOP_WAKE_INTERVAL_MS = 1000 / ROOM_LOOP_WAKE_RATE;
const MAX_SIMULATION_STEPS_PER_WAKE = 4;
const COLYSEUS_PATCH_RATE_MS: number | null = null;
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
  private rateWindowStartedAtMs = 0;
  private simTicksThisWindow = 0;
  private snapshotsThisWindow = 0;
  private simTickMsTotal = 0;
  private simTickMsMax = 0;
  private simulationAccumulatorMs = 0;
  private lastLoopWakeAtMs = 0;
  private readonly inputPacketsThisWindowByPlayerId = new Map<string, number>();

  onCreate(): void {
    activeRoomCount += 1;
    this.setPrivate(true);
    this.patchRate = COLYSEUS_PATCH_RATE_MS;
    // Coarse built-in backstop on top of the per-type token buckets below (#11).
    this.maxMessagesPerSecond = 150;
    this.game = new ServerGameLoop(this.roomId, {
      tickRate: SIMULATION_TICK_RATE,
      logger: (message) => this.log(message),
      debugInput: process.env.DEBUG_INPUT === '1' || process.env.DEBUG_GAMEPLAY === '1'
    });
    this.log(
      `room created simTickRate=${SIMULATION_TICK_RATE}Hz manualSnapshotRate=${SNAPSHOT_RATE}Hz ` +
      `loopWakeRate=${ROOM_LOOP_WAKE_RATE}Hz colyseusPatchRate=${formatPatchRate(COLYSEUS_PATCH_RATE_MS)}`
    );

    this.onMessage('input', (client, message: Partial<InputCommand> | (Partial<PlayerInput> & { sequence?: number }) | undefined) => {
      if (!this.allow(client, 'input')) return;
      this.recordInputPacket(client.sessionId);
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
      const now = performance.now();
      if (this.clients.length === 0) {
        this.simulationAccumulatorMs = 0;
        this.lastLoopWakeAtMs = now;
        return;
      }

      if (this.lastLoopWakeAtMs === 0) this.lastLoopWakeAtMs = now;
      this.simulationAccumulatorMs += Math.min(250, now - this.lastLoopWakeAtMs);
      this.lastLoopWakeAtMs = now;

      let steps = 0;
      while (this.simulationAccumulatorMs + 0.001 >= SIMULATION_STEP_MS && steps < MAX_SIMULATION_STEPS_PER_WAKE) {
        this.simulationAccumulatorMs -= SIMULATION_STEP_MS;
        steps += 1;

        const startedAt = performance.now();
        const snapshot = this.game.step();
        const simTickMs = performance.now() - startedAt;
        this.broadcast('snapshot', snapshot);
        this.recordSimulationRate(simTickMs);
      }

      if (steps >= MAX_SIMULATION_STEPS_PER_WAKE && this.simulationAccumulatorMs >= SIMULATION_STEP_MS) {
        this.simulationAccumulatorMs = SIMULATION_STEP_MS;
      }
    }, ROOM_LOOP_WAKE_INTERVAL_MS);
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

  private recordInputPacket(playerId: string): void {
    this.inputPacketsThisWindowByPlayerId.set(playerId, (this.inputPacketsThisWindowByPlayerId.get(playerId) ?? 0) + 1);
  }

  private recordSimulationRate(simTickMs: number): void {
    const now = Date.now();
    if (this.rateWindowStartedAtMs === 0) this.rateWindowStartedAtMs = now;
    this.simTicksThisWindow += 1;
    this.snapshotsThisWindow += 1;
    this.simTickMsTotal += simTickMs;
    this.simTickMsMax = Math.max(this.simTickMsMax, simTickMs);

    const elapsedMs = now - this.rateWindowStartedAtMs;
    if (elapsedMs < 1000) return;

    const elapsedSeconds = elapsedMs / 1000;
    const inputRates = [...this.inputPacketsThisWindowByPlayerId.entries()]
      .map(([playerId, count]) => `${playerId.slice(-4)}:${(count / elapsedSeconds).toFixed(1)}/s`)
      .join(',');
    const avgSimTickMs = this.simTicksThisWindow > 0 ? this.simTickMsTotal / this.simTicksThisWindow : 0;
    this.log(
      `[rates] simTicks=${(this.simTicksThisWindow / elapsedSeconds).toFixed(1)}/s ` +
      `snapshots=${(this.snapshotsThisWindow / elapsedSeconds).toFixed(1)}/s ` +
      `patchRate=${formatPatchRate(COLYSEUS_PATCH_RATE_MS)} ` +
      `inputPackets={${inputRates || 'none'}} ` +
      `simTickMs avg=${avgSimTickMs.toFixed(2)} max=${this.simTickMsMax.toFixed(2)}`
    );

    this.rateWindowStartedAtMs = now;
    this.simTicksThisWindow = 0;
    this.snapshotsThisWindow = 0;
    this.simTickMsTotal = 0;
    this.simTickMsMax = 0;
    this.inputPacketsThisWindowByPlayerId.clear();
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

function formatPatchRate(patchRateMs: number | null): string {
  return patchRateMs === null ? 'disabled(manual snapshots)' : `${(1000 / patchRateMs).toFixed(1)}Hz`;
}
