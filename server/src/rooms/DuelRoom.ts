import { Client, Room } from 'colyseus';
import { performance } from 'node:perf_hooks';
import type {
  ClientMessage,
  InputCommand,
  ServerMessage,
  ServerSnapshot
} from '../../../shared/protocol';
import type { PlayerInput } from '../../../shared/types';
import {
  MAX_ACCUMULATOR_CLAMP_MS,
  MAX_ACCUMULATOR_STEPS,
  PERF_REPORT_INTERVAL_MS,
  ROOM_LOOP_WAKE_INTERVAL_MS,
  SERVER_STEP_MS,
  SERVER_TICK_RATE,
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_RATE,
  describeNetConfig,
  resolveServerDebugFlags,
  type DebugFlags
} from '../../../shared/netConfig';
import { ServerGameLoop } from '../simulation/ServerGameLoop';

export interface DuelRoomOptions {
  name?: string;
}

// All timing/rate constants now come from the centralized netConfig — never hardcode a rate here.
// Visual state is sent through explicit `snapshot` messages, not Colyseus Schema patches, so we
// keep the manual snapshot cadence (SNAPSHOT_RATE) explicit and decoupled from the sim tick.
const COLYSEUS_PATCH_RATE_MS: number | null = null;
// How long a dropped player has to reconnect before they forfeit (#12).
const RECONNECT_SECONDS = 20;
// Hard cap on concurrent duel rooms per process (#19 — cheap DoS guard).
const MAX_ROOMS = 200;

let activeRoomCount = 0;

// Per-message-type rate limits: { capacity (burst), refillPerSecond } (#11).
// Input is sized from the active tick rate with burst headroom so a steady input stream is never
// throttled, capacity ~1.5x the rate to absorb reconnection/jitter bursts.
const RATE_LIMITS: Record<string, { capacity: number; refillPerSecond: number }> = {
  input: { capacity: Math.ceil(SERVER_TICK_RATE * 1.5), refillPerSecond: SERVER_TICK_RATE + 15 },
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
  private readonly debug: DebugFlags = resolveServerDebugFlags();
  private readonly buckets = new Map<string, Map<string, Bucket>>();
  private rateWindowStartedAtMs = 0;
  private simTicksThisWindow = 0;
  private snapshotsThisWindow = 0;
  private simTickMsTotal = 0;
  private simTickMsMax = 0;
  private stepCapHitsThisWindow = 0;
  // Approximate snapshot payload size, sampled cheaply (only when PERF_DEBUG is on) once per window.
  private snapshotPayloadBytesTotal = 0;
  private snapshotPayloadBytesMax = 0;
  private snapshotPayloadSamples = 0;
  // Two independent accumulators: one drains fixed sim steps, the other gates snapshot broadcasts
  // so snapshots run at SNAPSHOT_RATE decoupled from the sim tick (mode B = 60 sim / 30 snapshots).
  private simulationAccumulatorMs = 0;
  private snapshotAccumulatorMs = 0;
  private lastLoopWakeAtMs = 0;
  private latestSnapshot: ServerSnapshot | null = null;
  // When sim and snapshot rates are equal (mode A/C) we broadcast one snapshot per sim step, which
  // is exactly the old coupled behavior — no accumulator drift, lowest latency.
  private readonly snapshotCoupledToTick = SNAPSHOT_RATE === SERVER_TICK_RATE;
  private readonly inputPacketsThisWindowByPlayerId = new Map<string, number>();

  onCreate(): void {
    activeRoomCount += 1;
    this.setPrivate(true);
    this.patchRate = COLYSEUS_PATCH_RATE_MS;
    // Coarse built-in backstop on top of the per-type token buckets below (#11).
    this.maxMessagesPerSecond = Math.max(150, Math.ceil(SERVER_TICK_RATE * 3));
    this.game = new ServerGameLoop(this.roomId, {
      tickRate: SERVER_TICK_RATE,
      logger: (message) => this.log(message),
      debug: this.debug
    });
    // One-time room-created line describing the active net config + the manual-snapshot patch mode.
    this.log(`room created ${describeNetConfig()} colyseusPatchRate=${formatPatchRate(COLYSEUS_PATCH_RATE_MS)}`);

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
        if (this.debug.PICKUP_DEBUG) this.log(`pickup rejected player=${client.sessionId} reason=${result.reason}`);
        this.reject(client, 'pickup', result.reason);
      } else if (result.log && this.debug.PICKUP_DEBUG) {
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
        if (this.debug.THROW_DEBUG) this.log(`throw rejected player=${client.sessionId} reason=${result.reason}`);
        this.reject(client, 'throw', result.reason);
      } else if (result.log && this.debug.THROW_DEBUG) {
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
        this.snapshotAccumulatorMs = 0;
        this.lastLoopWakeAtMs = now;
        this.latestSnapshot = null;
        return;
      }

      if (this.lastLoopWakeAtMs === 0) this.lastLoopWakeAtMs = now;
      // Monotonic clock; clamp the elapsed slice so an alt-tab/GC pause can't dump a huge backlog.
      const elapsedMs = Math.min(MAX_ACCUMULATOR_CLAMP_MS, now - this.lastLoopWakeAtMs);
      this.lastLoopWakeAtMs = now;
      this.simulationAccumulatorMs += elapsedMs;
      // The snapshot accumulator is only used in the decoupled path; leave it at zero when coupled
      // so it can't drift/grow while unused.
      if (!this.snapshotCoupledToTick) this.snapshotAccumulatorMs += elapsedMs;

      // Drain fixed sim steps, capped to avoid a spiral-of-death after a long pause.
      let steps = 0;
      while (this.simulationAccumulatorMs + 0.001 >= SERVER_STEP_MS && steps < MAX_ACCUMULATOR_STEPS) {
        this.simulationAccumulatorMs -= SERVER_STEP_MS;
        steps += 1;

        const startedAt = performance.now();
        this.latestSnapshot = this.game.step();
        this.recordSimulationTick(performance.now() - startedAt);

        // Broadcast any authoritative throw events accepted this step BEFORE the snapshot, so the
        // client can seed deterministic live-ball prediction the instant a throw lands.
        const throwEvents = this.game.drainThrowEvents();
        for (const event of throwEvents) this.broadcast('throw-event', event);

        // Coupled fast path (mode A/C, snapshots == sim): broadcast every step, exactly the old
        // behavior — lowest latency, no snapshot accumulator drift.
        if (this.snapshotCoupledToTick) {
          this.broadcast('snapshot', this.latestSnapshot);
          this.recordSnapshot(this.latestSnapshot);
        }
      }

      // Step cap hit with backlog remaining: discard the backlog (don't time-warp) and report only
      // under PERF_DEBUG so a real playtest stays silent.
      if (steps >= MAX_ACCUMULATOR_STEPS && this.simulationAccumulatorMs >= SERVER_STEP_MS) {
        this.stepCapHitsThisWindow += 1;
        this.simulationAccumulatorMs = SERVER_STEP_MS;
      }

      // Decoupled snapshot broadcast (mode B, snapshots < sim): emit the latest simulated state on
      // the snapshot cadence, independent of how many sim steps ran this wake. Catch up at most one
      // interval per wake to avoid bursts; clamp the accumulator so it can't grow unbounded.
      if (!this.snapshotCoupledToTick && this.latestSnapshot) {
        if (this.snapshotAccumulatorMs + 0.001 >= SNAPSHOT_INTERVAL_MS) {
          this.snapshotAccumulatorMs -= SNAPSHOT_INTERVAL_MS;
          if (this.snapshotAccumulatorMs > SNAPSHOT_INTERVAL_MS) this.snapshotAccumulatorMs = SNAPSHOT_INTERVAL_MS;
          this.broadcast('snapshot', this.latestSnapshot);
          this.recordSnapshot(this.latestSnapshot);
        }
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

  /** Record one fixed sim step for the periodic [rates] summary. Counts ticks separately from
   * snapshots since the two cadences can differ (mode B). Emits the summary at most once/second,
   * and ONLY when PERF_DEBUG is enabled. */
  private recordSimulationTick(simTickMs: number): void {
    const now = Date.now();
    if (this.rateWindowStartedAtMs === 0) this.rateWindowStartedAtMs = now;
    this.simTicksThisWindow += 1;
    this.simTickMsTotal += simTickMs;
    this.simTickMsMax = Math.max(this.simTickMsMax, simTickMs);

    const elapsedMs = now - this.rateWindowStartedAtMs;
    if (elapsedMs < PERF_REPORT_INTERVAL_MS) return;

    if (this.debug.PERF_DEBUG) this.emitPerfReport(elapsedMs);

    this.rateWindowStartedAtMs = now;
    this.simTicksThisWindow = 0;
    this.snapshotsThisWindow = 0;
    this.simTickMsTotal = 0;
    this.simTickMsMax = 0;
    this.stepCapHitsThisWindow = 0;
    this.snapshotPayloadBytesTotal = 0;
    this.snapshotPayloadBytesMax = 0;
    this.snapshotPayloadSamples = 0;
    this.inputPacketsThisWindowByPlayerId.clear();
  }

  /** Emit the throttled (every PERF_REPORT_INTERVAL_MS) server [perf] report. PERF_DEBUG-gated. */
  private emitPerfReport(elapsedMs: number): void {
    const elapsedSeconds = elapsedMs / 1000;
    const inputRates = [...this.inputPacketsThisWindowByPlayerId.entries()]
      .map(([playerId, count]) => `${playerId.slice(-4)}:${(count / elapsedSeconds).toFixed(1)}/s`)
      .join(',');
    const avgSimTickMs = this.simTicksThisWindow > 0 ? this.simTickMsTotal / this.simTicksThisWindow : 0;

    const balls = Object.values(this.game.state.balls);
    let liveBalls = 0;
    for (const ball of balls) if (ball.phase === 'live' || ball.phase === 'deflected') liveBalls += 1;
    const players = Object.keys(this.game.state.players).length;

    const mem = process.memoryUsage();
    const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

    const avgPayload = this.snapshotPayloadSamples > 0
      ? Math.round(this.snapshotPayloadBytesTotal / this.snapshotPayloadSamples)
      : 0;

    // Combat counters for this window (verify the lag-comp catch fix in production).
    const c = this.game.drainCombatMetrics();

    this.log(
      `[perf] simTicks=${(this.simTicksThisWindow / elapsedSeconds).toFixed(1)}/s ` +
      `snapshots=${(this.snapshotsThisWindow / elapsedSeconds).toFixed(1)}/s ` +
      `simTickMs avg=${avgSimTickMs.toFixed(2)} max=${this.simTickMsMax.toFixed(2)} ` +
      `players=${players} balls=${balls.length} liveBalls=${liveBalls} ` +
      `inputPackets={${inputRates || 'none'}} ` +
      `combat={catchTry=${c.catchAttemptsOpened} catch=${c.catches} reclaim=${c.reclaimCatches} parry=${c.parries} hit=${c.hits} revert=${c.hitReverts}} ` +
      `stepCapHits=${this.stepCapHitsThisWindow} ` +
      `snapshotBytes avg=${avgPayload} max=${this.snapshotPayloadBytesMax} ` +
      `mem heapUsed=${mb(mem.heapUsed)}MB heapTotal=${mb(mem.heapTotal)}MB rss=${mb(mem.rss)}MB`
    );
  }

  /**
   * Record one snapshot broadcast for the [perf] summary (decoupled from sim ticks in mode B).
   * The payload-size sample uses JSON.stringify, which is expensive — so it runs at most ONCE per
   * report window, and only when PERF_DEBUG is on. Real playtests with PERF_DEBUG off pay nothing.
   */
  private recordSnapshot(snapshot: ServerSnapshot): void {
    this.snapshotsThisWindow += 1;
    if (this.debug.PERF_DEBUG && this.snapshotPayloadSamples === 0) {
      const bytes = JSON.stringify(snapshot).length;
      this.snapshotPayloadBytesTotal += bytes;
      this.snapshotPayloadBytesMax = Math.max(this.snapshotPayloadBytesMax, bytes);
      this.snapshotPayloadSamples += 1;
    }
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
