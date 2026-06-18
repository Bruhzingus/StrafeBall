import { Client, Room } from 'colyseus';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type {
  ClientMessage,
  InputCommand,
  StartVoteRequest,
  SwitchTeamRequest,
  ServerMessage,
  ServerSnapshot,
  SnapshotPayload
} from '../../../shared/protocol';
import type { PlayerInput } from '../../../shared/types';
import { GAME_CONSTANTS } from '../../../shared/constants';
import {
  CLIENT_INPUT_RATE,
  MAX_ACCUMULATOR_CLAMP_MS,
  MAX_ACCUMULATOR_STEPS,
  PERF_REPORT_INTERVAL_MS,
  ROOM_LOOP_WAKE_INTERVAL_MS,
  SERVER_STEP_MS,
  SERVER_TICK_RATE,
  SNAPSHOT_BACKPRESSURE_BYTES,
  SNAPSHOT_ENCODING,
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_RATE,
  USE_COMPACT_SNAPSHOTS,
  describeNetConfig,
  resolveServerDebugFlags,
  type DebugFlags
} from '../../../shared/netConfig';
import { makeCompactSnapshot, rosterFromRoom } from '../../../shared/snapshotCodec';
import { ServerGameLoop } from '../simulation/ServerGameLoop';
import { advanceSnapshotDeadline } from './snapshotScheduler';

export interface DuelRoomOptions {
  name?: string;
  mode?: '1v1' | '2v2';
}

// All timing/rate constants now come from the centralized netConfig — never hardcode a rate here.
// Visual state is sent through explicit `snapshot` messages, not Colyseus Schema patches, so we
// keep the manual snapshot cadence (SNAPSHOT_RATE) explicit and decoupled from the sim tick.
const COLYSEUS_PATCH_RATE_MS: number | null = null;
// How long a dropped player has to reconnect before their team may forfeit (#12).
const RECONNECT_SECONDS = GAME_CONSTANTS.match.disconnectForfeitSeconds;
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
  maxClients = GAME_CONSTANTS.match.teamIds.length;
  autoDispose = true;

  private game!: ServerGameLoop;
  private readonly debug: DebugFlags = resolveServerDebugFlags();
  private roomMode: '1v1' | '2v2' = '1v1';
  private playersPerTeam = 1;
  private readonly buckets = new Map<string, Map<string, Bucket>>();
  private readonly createdAtMs = Date.now();
  private rateWindowStartedAtMs = 0;
  private simTicksThisWindow = 0;
  private snapshotsThisWindow = 0;
  private simTickMsTotal = 0;
  private simTickMsMax = 0;
  private stepCapHitsThisWindow = 0;
  private snapshotBuildMsTotal = 0;
  private snapshotBuildMsMax = 0;
  private snapshotBroadcastMsTotal = 0;
  private snapshotBroadcastMsMax = 0;
  private snapshotLateMsTotal = 0;
  private snapshotLateMsMax = 0;
  private snapshotDeadlineSkipsThisWindow = 0;
  private snapshotNoNewTickSkipsThisWindow = 0;
  private snapshotBackpressureSkipsThisWindow = 0;
  private snapshotAllBackpressureSkipsThisWindow = 0;
  private snapshotClientSendsThisWindow = 0;
  // Approximate snapshot payload size, sampled cheaply (only when PERF_DEBUG is on) once per window.
  private snapshotPayloadBytesTotal = 0;
  private snapshotPayloadBytesMax = 0;
  private snapshotPayloadSamples = 0;
  private snapshotWsBufferedBytesTotal = 0;
  private snapshotWsBufferedBytesMax = 0;
  private snapshotWsBufferedSamples = 0;
  private simulationAccumulatorMs = 0;
  private lastLoopWakeAtMs = 0;
  private nextSnapshotDueAtMs = 0;
  private lastSnapshotTickSent = -1;
  // When sim and snapshot rates are equal (mode A/C) we broadcast one snapshot per sim step, which
  // is exactly the old coupled behavior — no accumulator drift, lowest latency.
  private readonly snapshotCoupledToTick = SNAPSHOT_RATE === SERVER_TICK_RATE;
  private readonly inputPacketsThisWindowByPlayerId = new Map<string, number>();
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  onCreate(options: DuelRoomOptions = {}): void {
    activeRoomCount += 1;
    this.eventLoopDelay.enable();
    this.setPrivate(true);
    this.patchRate = COLYSEUS_PATCH_RATE_MS;
    this.roomMode = options.mode === '2v2' ? '2v2' : '1v1';
    this.playersPerTeam = this.roomMode === '2v2' ? GAME_CONSTANTS.match.playersPerTeam : 1;
    this.maxClients = GAME_CONSTANTS.match.teamIds.length * this.playersPerTeam;
    // Coarse built-in backstop on top of the per-type token buckets below (#11).
    this.maxMessagesPerSecond = Math.max(150, Math.ceil(SERVER_TICK_RATE * 3));
    this.game = new ServerGameLoop(this.roomId, {
      tickRate: SERVER_TICK_RATE,
      mode: this.roomMode,
      playersPerTeam: this.playersPerTeam,
      logger: (message) => this.log(message),
      debug: this.debug
    });
    // One-time room-created line describing the active net config + the manual-snapshot patch mode.
    this.log(
      `room created mode=${this.roomMode} playersPerTeam=${this.playersPerTeam} ${describeNetConfig()} ` +
      `snapshotEncoding=${SNAPSHOT_ENCODING} snapshotBackpressure=${SNAPSHOT_BACKPRESSURE_BYTES}B ` +
      `colyseusPatchRate=${formatPatchRate(COLYSEUS_PATCH_RATE_MS)}`
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

    this.onMessage('start-vote', (client, _message: StartVoteRequest) => {
      if (!this.allow(client, 'reset')) return;
      const result = this.game.handleStartVote(client.sessionId);
      if (!result.ok) this.reject(client, 'start-vote', result.reason);
    });

    this.onMessage('switch-team', (client, message: SwitchTeamRequest) => {
      if (!this.allow(client, 'reset')) return;
      const result = this.game.handleTeamSwitch(client.sessionId, message?.teamId, message?.teamSlotIndex);
      if (!result.ok) this.reject(client, 'switch-team', result.reason);
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
        this.nextSnapshotDueAtMs = 0;
        this.lastSnapshotTickSent = -1;
        return;
      }

      if (this.lastLoopWakeAtMs === 0) this.lastLoopWakeAtMs = now;
      if (this.nextSnapshotDueAtMs === 0) this.nextSnapshotDueAtMs = now + SNAPSHOT_INTERVAL_MS;
      // Monotonic clock; clamp the elapsed slice so an alt-tab/GC pause can't dump a huge backlog.
      const elapsedMs = Math.min(MAX_ACCUMULATOR_CLAMP_MS, now - this.lastLoopWakeAtMs);
      this.lastLoopWakeAtMs = now;
      this.simulationAccumulatorMs += elapsedMs;

      // Drain fixed sim steps, capped to avoid a spiral-of-death after a long pause.
      let steps = 0;
      while (this.simulationAccumulatorMs + 0.001 >= SERVER_STEP_MS && steps < MAX_ACCUMULATOR_STEPS) {
        this.simulationAccumulatorMs -= SERVER_STEP_MS;
        steps += 1;

        const startedAt = performance.now();
        this.game.advance();
        this.recordSimulationTick(performance.now() - startedAt, performance.now());

        // Broadcast any authoritative throw events accepted this step BEFORE the snapshot, so the
        // client can seed deterministic live-ball prediction the instant a throw lands.
        this.broadcastStepEvents();

        // Coupled fast path (mode A/C, snapshots == sim): broadcast every step, exactly the old
        // behavior — lowest latency, no snapshot accumulator drift.
        if (this.snapshotCoupledToTick) {
          const snapshotAt = performance.now();
          this.broadcastSnapshot(snapshotAt, snapshotAt);
        }
      }

      // Step cap hit with backlog remaining: discard the backlog (don't time-warp) and report only
      // under PERF_DEBUG so a real playtest stays silent.
      if (steps >= MAX_ACCUMULATOR_STEPS && this.simulationAccumulatorMs >= SERVER_STEP_MS) {
        this.stepCapHitsThisWindow += 1;
        this.simulationAccumulatorMs = SERVER_STEP_MS;
      }

      if (!this.snapshotCoupledToTick) {
        this.broadcastDueSnapshot(performance.now());
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
    this.broadcastRosterUpdate();
  }

  // Unconsented disconnect: pause the player and give them a window to reconnect with their
  // state intact (#12). If the window elapses, the framework proceeds to onLeave.
  async onDrop(client: Client, _code?: number): Promise<void> {
    this.game.setConnected(client.sessionId, false, Date.now() + RECONNECT_SECONDS * 1000);
    this.log(`player dropped id=${client.sessionId} — awaiting reconnection`);
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      // reconnection window elapsed — onLeave will finalize the departure
    }
  }

  onReconnect(client: Client): void {
    this.game.setConnected(client.sessionId, true, null);
    this.log(`player reconnected id=${client.sessionId}`);
    this.broadcastRosterUpdate();
  }

  // Terminal departure (consented leave, or reconnection window expired) → the remaining player
  // wins by forfeit (#13).
  onLeave(client: Client, _code?: number): void {
    this.buckets.delete(client.sessionId);
    this.game.abandon(client.sessionId);
    this.log(`player left id=${client.sessionId}`);
    this.broadcast('player-left', { type: 'player-left', playerId: client.sessionId } satisfies ServerMessage);
    this.broadcastRosterUpdate();
  }

  onDispose(): void {
    activeRoomCount = Math.max(0, activeRoomCount - 1);
    this.eventLoopDelay.disable();
    this.log('room disposed');
    this.game.dispose();
  }

  private recordInputPacket(playerId: string): void {
    this.inputPacketsThisWindowByPlayerId.set(playerId, (this.inputPacketsThisWindowByPlayerId.get(playerId) ?? 0) + 1);
  }

  /** Record one fixed sim step for the periodic [rates] summary. Counts ticks separately from
   * snapshots since the two cadences can differ (mode B). Emits the summary at most once/second,
   * and ONLY when PERF_DEBUG is enabled. */
  private recordSimulationTick(simTickMs: number, now: number): void {
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
    this.snapshotBuildMsTotal = 0;
    this.snapshotBuildMsMax = 0;
    this.snapshotBroadcastMsTotal = 0;
    this.snapshotBroadcastMsMax = 0;
    this.snapshotLateMsTotal = 0;
    this.snapshotLateMsMax = 0;
    this.snapshotDeadlineSkipsThisWindow = 0;
    this.snapshotNoNewTickSkipsThisWindow = 0;
    this.snapshotBackpressureSkipsThisWindow = 0;
    this.snapshotAllBackpressureSkipsThisWindow = 0;
    this.snapshotClientSendsThisWindow = 0;
    this.snapshotPayloadBytesTotal = 0;
    this.snapshotPayloadBytesMax = 0;
    this.snapshotPayloadSamples = 0;
    this.snapshotWsBufferedBytesTotal = 0;
    this.snapshotWsBufferedBytesMax = 0;
    this.snapshotWsBufferedSamples = 0;
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
    const playerStates = Object.values(this.game.state.players);
    let activePlayers = 0;
    let alivePlayers = 0;
    let eliminatedPlayers = 0;
    let disconnectedPlayers = 0;
    for (const player of playerStates) {
      if (player.connected === false) {
        disconnectedPlayers += 1;
        continue;
      }
      activePlayers += 1;
      if (player.combatState === 'eliminated' || player.lives <= 0) {
        eliminatedPlayers += 1;
      } else {
        alivePlayers += 1;
      }
    }
    let activeBalls = 0;
    let liveBalls = 0;
    for (const ball of balls) {
      if (ball.phase !== 'dead') activeBalls += 1;
      if (ball.phase === 'live' || ball.phase === 'deflected') liveBalls += 1;
    }

    const mem = process.memoryUsage();
    const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

    const avgPayload = this.snapshotPayloadSamples > 0
      ? Math.round(this.snapshotPayloadBytesTotal / this.snapshotPayloadSamples)
      : 0;
    const avgSnapshotBuildMs = this.snapshotsThisWindow > 0 ? this.snapshotBuildMsTotal / this.snapshotsThisWindow : 0;
    const avgSnapshotBroadcastMs = this.snapshotsThisWindow > 0 ? this.snapshotBroadcastMsTotal / this.snapshotsThisWindow : 0;
    const avgSnapshotLateMs = this.snapshotsThisWindow > 0 ? this.snapshotLateMsTotal / this.snapshotsThisWindow : 0;
    const eventLoopDelayAvgMs = this.eventLoopDelay.mean > 0 ? this.eventLoopDelay.mean / 1e6 : 0;
    const eventLoopDelayMaxMs = this.eventLoopDelay.max > 0 ? this.eventLoopDelay.max / 1e6 : 0;
    const socketBuffer = this.socketBufferStats();
    const wsBufferedAvg = this.snapshotWsBufferedSamples > 0
      ? Math.round(this.snapshotWsBufferedBytesTotal / this.snapshotWsBufferedSamples)
      : socketBuffer.avgBytes;
    const wsBufferedMax = Math.max(this.snapshotWsBufferedBytesMax, socketBuffer.maxBytes);
    const buffers = this.game.getDebugBufferStats();
    const roomAgeSec = Math.max(0, (Date.now() - this.createdAtMs) / 1000);

    // Combat counters for this window (verify the lag-comp catch fix in production).
    const c = this.game.drainCombatMetrics();

    this.log(
      `[perf] roomAgeSec=${roomAgeSec.toFixed(1)} ` +
      `sim=${SERVER_TICK_RATE}Hz input=${CLIENT_INPUT_RATE}Hz snapshots=${SNAPSHOT_RATE}Hz ` +
      `simTicks=${(this.simTicksThisWindow / elapsedSeconds).toFixed(1)}/s ` +
      `snapshotsSent=${(this.snapshotsThisWindow / elapsedSeconds).toFixed(1)}/s snapshotClientSends=${(this.snapshotClientSendsThisWindow / elapsedSeconds).toFixed(1)}/s ` +
      `simTickMs avg=${avgSimTickMs.toFixed(2)} max=${this.simTickMsMax.toFixed(2)} ` +
      `snapshotBuildMs avg=${avgSnapshotBuildMs.toFixed(3)} max=${this.snapshotBuildMsMax.toFixed(3)} ` +
      `snapshotBroadcastMs avg=${avgSnapshotBroadcastMs.toFixed(3)} max=${this.snapshotBroadcastMsMax.toFixed(3)} ` +
      `snapshotLateMs avg=${avgSnapshotLateMs.toFixed(2)} max=${this.snapshotLateMsMax.toFixed(2)} skippedSnapshots=${this.snapshotDeadlineSkipsThisWindow} noNewTickSkips=${this.snapshotNoNewTickSkipsThisWindow} backpressureSkips=${this.snapshotBackpressureSkipsThisWindow} allBackpressureSkips=${this.snapshotAllBackpressureSkipsThisWindow} ` +
      `players total=${playerStates.length} active=${activePlayers} alive=${alivePlayers} eliminated=${eliminatedPlayers} disconnected=${disconnectedPlayers} ` +
      `balls total=${balls.length} active=${activeBalls} live=${liveBalls} ` +
      `inputsProcessed={${inputRates || 'none'}} ` +
      `inputDrain={avg=${buffers.inputsDrainedAvg.toFixed(2)} max=${buffers.inputsDrainedMax} maxQueueBefore=${buffers.maxInputQueueBeforeDrain}} ` +
      `buffers={input=${buffers.inputQueues} inputMax=${buffers.maxInputQueue} throw=${buffers.pendingThrowEvents} combat=${buffers.pendingCombatEvents} defenseHist=${buffers.defenseHistoryEntries} ballHist=${buffers.ballHistoryEntries} catch=${buffers.catchAttempts} hit=${buffers.recentHits}} ` +
      `combat={catchTry=${c.catchAttemptsOpened} catch=${c.catches} reclaim=${c.reclaimCatches} parry=${c.parries} hit=${c.hits} revert=${c.hitReverts}} ` +
      `accumulatorCaps=${this.stepCapHitsThisWindow} ` +
      `snapshotBytes avg=${avgPayload} max=${this.snapshotPayloadBytesMax} ` +
      `wsBuffered avg=${wsBufferedAvg}B max=${wsBufferedMax}B ` +
      `eventLoopMs avg=${eventLoopDelayAvgMs.toFixed(2)} max=${eventLoopDelayMaxMs.toFixed(2)} ` +
      `mem heapUsed=${mb(mem.heapUsed)}MB heapTotal=${mb(mem.heapTotal)}MB rss=${mb(mem.rss)}MB`
    );

    if (this.debug.SOAK_DEBUG) {
      this.log(
        `[soak] roomAgeSec=${roomAgeSec.toFixed(1)} ` +
        `accumulators={simMs=${this.simulationAccumulatorMs.toFixed(2)} nextSnapshotInMs=${Math.max(0, this.nextSnapshotDueAtMs - performance.now()).toFixed(2)}} ` +
        `queues={inputTotal=${buffers.inputQueues} inputMax=${buffers.maxInputQueue} defenseTotal=${buffers.defenseHistoryEntries} defenseMax=${buffers.maxDefenseHistoryEntries} ballTotal=${buffers.ballHistoryEntries} ballMax=${buffers.maxBallHistoryEntries}} ` +
        `snapshots={lastTickSent=${this.lastSnapshotTickSent} noNewTickSkips=${this.snapshotNoNewTickSkipsThisWindow}} ` +
        `socket={avgBuffered=${socketBuffer.avgBytes} maxBuffered=${socketBuffer.maxBytes}} ` +
        `runtime={clients=${this.clients.length} messageBuckets=${this.buckets.size} listeners=${this.clients.length * 7 + 1}}`
      );
    }

    this.eventLoopDelay.reset();
  }

  /**
   * Record one snapshot broadcast for the [perf] summary (decoupled from sim ticks in mode B).
   * The payload-size sample uses JSON.stringify, which is expensive — so it runs at most ONCE per
   * report window, and only when PERF_DEBUG is on. Real playtests with PERF_DEBUG off pay nothing.
   */
  private recordSnapshot(payload: SnapshotPayload, buildMs: number, broadcastMs: number, lateMs: number, sentClients: number): void {
    this.snapshotsThisWindow += 1;
    this.snapshotClientSendsThisWindow += sentClients;
    this.snapshotBuildMsTotal += buildMs;
    this.snapshotBuildMsMax = Math.max(this.snapshotBuildMsMax, buildMs);
    this.snapshotBroadcastMsTotal += broadcastMs;
    this.snapshotBroadcastMsMax = Math.max(this.snapshotBroadcastMsMax, broadcastMs);
    this.snapshotLateMsTotal += lateMs;
    this.snapshotLateMsMax = Math.max(this.snapshotLateMsMax, lateMs);
    const sampleStride = Math.max(1, Math.floor(SNAPSHOT_RATE / 4));
    if (this.debug.PERF_DEBUG && this.snapshotPayloadSamples < 8 && this.snapshotsThisWindow % sampleStride === 1) {
      const bytes = JSON.stringify(payload).length;
      this.snapshotPayloadBytesTotal += bytes;
      this.snapshotPayloadBytesMax = Math.max(this.snapshotPayloadBytesMax, bytes);
      this.snapshotPayloadSamples += 1;
    }
  }

  private broadcastStepEvents(): void {
    const throwEvents = this.game.drainThrowEvents();
    for (const event of throwEvents) this.broadcast('throw-event', event);

    const combatEvents = this.game.drainCombatEvents();
    for (const event of combatEvents) this.broadcast(event.type, event);
  }

  private broadcastDueSnapshot(actualNowMs: number): void {
    if (actualNowMs + 0.001 < this.nextSnapshotDueAtMs) return;

    const dueAtMs = this.nextSnapshotDueAtMs;
    const schedule = advanceSnapshotDeadline(dueAtMs, actualNowMs, SNAPSHOT_INTERVAL_MS);
    this.snapshotDeadlineSkipsThisWindow += schedule.skippedIntervals;
    this.nextSnapshotDueAtMs = schedule.nextDueAtMs;

    // Don't queue stale visual duplicates when the sim hasn't advanced since the last send.
    if (this.game.state.tick <= this.lastSnapshotTickSent) {
      this.snapshotNoNewTickSkipsThisWindow += 1;
      return;
    }

    this.broadcastSnapshot(dueAtMs, actualNowMs);
  }

  private broadcastSnapshot(dueAtMs: number, actualNowMs: number): void {
    const sendableClients = this.snapshotSendableClients();
    if (sendableClients.length === 0) return;

    const snapshot = this.game.snapshot();
    const snapshotBuildMs = this.game.getLastSnapshotBuildMs();
    const encodeStartedAt = performance.now();
    const payload = this.encodeSnapshot(snapshot);
    const buildMs = snapshotBuildMs + (performance.now() - encodeStartedAt);
    const broadcastStartedAt = performance.now();
    for (const client of sendableClients) {
      client.send('snapshot', payload);
    }
    const broadcastMs = performance.now() - broadcastStartedAt;
    this.lastSnapshotTickSent = snapshot.tick;
    this.recordSnapshot(payload, buildMs, broadcastMs, Math.max(0, actualNowMs - dueAtMs), sendableClients.length);
  }

  private snapshotSendableClients(): Client[] {
    const sendable: Client[] = [];
    let skipped = 0;

    for (const client of this.clients) {
      const buffered = readClientBufferedAmount(client);
      if (buffered !== null) this.recordSnapshotBufferedAmount(buffered);
      if (buffered !== null && buffered > SNAPSHOT_BACKPRESSURE_BYTES) {
        skipped += 1;
        continue;
      }
      sendable.push(client);
    }

    if (skipped > 0) {
      this.snapshotBackpressureSkipsThisWindow += skipped;
      if (skipped === this.clients.length) this.snapshotAllBackpressureSkipsThisWindow += 1;
    }

    return sendable;
  }

  private encodeSnapshot(snapshot: ServerSnapshot): SnapshotPayload {
    return USE_COMPACT_SNAPSHOTS ? makeCompactSnapshot(snapshot) : snapshot;
  }

  private recordSnapshotBufferedAmount(buffered: number): void {
    this.snapshotWsBufferedBytesTotal += buffered;
    this.snapshotWsBufferedBytesMax = Math.max(this.snapshotWsBufferedBytesMax, buffered);
    this.snapshotWsBufferedSamples += 1;
  }

  private broadcastRosterUpdate(): void {
    this.broadcast('roster-update', {
      type: 'roster-update',
      roster: rosterFromRoom(this.game.state)
    } satisfies ServerMessage);
  }

  private socketBufferStats(): { avgBytes: number; maxBytes: number } {
    if (this.clients.length === 0) return { avgBytes: 0, maxBytes: 0 };

    let total = 0;
    let samples = 0;
    let maxBytes = 0;
    for (const client of this.clients) {
      const buffered = readClientBufferedAmount(client);
      if (buffered === null) continue;
      total += buffered;
      samples += 1;
      maxBytes = Math.max(maxBytes, buffered);
    }

    return {
      avgBytes: samples > 0 ? Math.round(total / samples) : 0,
      maxBytes
    };
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

function readClientBufferedAmount(client: Client): number | null {
  const raw = client as Client & {
    ref?: {
      bufferedAmount?: number;
      getBufferedAmount?: () => number;
      ws?: { bufferedAmount?: number; getBufferedAmount?: () => number };
    };
  };
  if (typeof raw.ref?.bufferedAmount === 'number') return raw.ref.bufferedAmount;
  if (typeof raw.ref?.ws?.bufferedAmount === 'number') return raw.ref.ws.bufferedAmount;
  const directAmount = raw.ref?.getBufferedAmount?.();
  if (typeof directAmount === 'number') return directAmount;
  const uwsAmount = raw.ref?.ws?.getBufferedAmount?.();
  return typeof uwsAmount === 'number' ? uwsAmount : null;
}
