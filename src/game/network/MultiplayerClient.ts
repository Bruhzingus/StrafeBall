import { Client, Room } from '@colyseus/sdk';
import { toWireInput } from '../../../shared/protocol';
import type {
  BattleMusicSyncMessage,
  CatchEvent,
  CatchParryRequest,
  DropRequest,
  HitEvent,
  HitRevertEvent,
  InputCommand,
  ParryEvent,
  PickupRequest,
  ResetRequest,
  RoomSettingsPatch,
  StartVoteRequest,
  StartMatchRequest,
  EndVoteRequest,
  IntermissionVoteRequest,
  UpdateRoomSettingsRequest,
  ServerMessage,
  ServerSnapshot,
  SnapshotPayload,
  SwitchTeamRequest,
  ThrowEvent,
  ThrowRequest
} from '../../../shared/protocol';
import type { HandSide, MatchMode, MatchPresetId, PlayerInput, Vec3 } from '../../../shared/types';
import type { BattleMusicSyncState } from '../../../shared/music/BattleMusic';
import type {
  NetFlightRecorderClientReport,
  NetFlightRecorderConfigMessage
} from '../../../shared/netFlightRecorder';
import { PERF_REPORT_INTERVAL_MS, netModeConfig, type NetMode, type NetModeConfig } from '../../../shared/netConfig';
import type { TickPresetId } from '../../../shared/tickPresets';
import {
  hydrateSnapshotRoster,
  inflateCompactSnapshot,
  isCompactSnapshot,
  isTieredCompactSnapshot,
  laneInfoFromFullSnapshot,
  mergeTieredCompactSnapshot,
  rosterFromRoom,
  type PlayerRoster,
  type SnapshotLaneInfo
} from '../../../shared/snapshotCodec';

export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'error';

/**
 * Resolves the Colyseus endpoint. `VITE_SERVER_URL` (set at build time) is an explicit override
 * for local dev against a standalone server. Otherwise, derive a same-origin URL from the page
 * so production builds work through the Nginx `/colyseus` proxy regardless of domain/IP, matching
 * the page's protocol (wss for https, ws for http) to avoid mixed-content/origin failures.
 */
export function resolveServerUrl(): string {
  const override = import.meta.env.VITE_SERVER_URL;
  if (override) return override;
  if (typeof window === 'undefined') return 'ws://localhost:2567';

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/colyseus`;
}

/** Shared empty array returned by drainThrowEvents when nothing is queued (no per-call allocation). */
const EMPTY_THROW_EVENTS: readonly ThrowEvent[] = [];
const EMPTY_CATCH_EVENTS: readonly CatchEvent[] = [];
const EMPTY_PARRY_EVENTS: readonly ParryEvent[] = [];
const EMPTY_HIT_EVENTS: readonly HitEvent[] = [];
const EMPTY_HIT_REVERT_EVENTS: readonly HitRevertEvent[] = [];

export class MultiplayerClient {
  // A ping send-gap or round-trip beyond this is not network latency: the ping timer (1s) was
  // throttled by a backgrounded tab / OS sleep / long main-thread stall. 4s is ~4 intervals — well
  // clear of any real RTT or transient hitch, but far below the multi-second freezes we must reject.
  private static readonly PING_FREEZE_GAP_MS = 4000;
  public readonly serverUrl: string;
  public status: ConnectionStatus = 'offline';
  public errorMessage = '';
  public roomId = '';
  public localPlayerId = '';
  public pingMs: number | null = null;
  public latestSnapshot: ServerSnapshot | null = null;
  public latestSnapshotLanes: SnapshotLaneInfo | null = null;
  public snapshotTierMode: SnapshotLaneInfo['mode'] = 'baseline';
  // The room's creation-time net mode, captured from `joined-room` (see resolvedNetConfig getter).
  private joinedRoomNetMode: NetMode | null = null;
  public battleMusicSync: BattleMusicSyncState | null = null;
  // Throw events received since the last drain. The renderer drains these each frame to seed/refresh
  // deterministic live-ball visual prediction. Bounded: cleared on drain and on leave/reset.
  private throwEventQueue: ThrowEvent[] = [];
  private catchEventQueue: CatchEvent[] = [];
  private parryEventQueue: ParryEvent[] = [];
  private hitEventQueue: HitEvent[] = [];
  private hitRevertEventQueue: HitRevertEvent[] = [];
  private readonly roster: PlayerRoster = {};
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
  private lastPongReceivedAtMs = 0;
  private pingJitterMs = 0;
  // Raw last round-trip (== pingMs, kept for clarity). Floor-tracked network RTT estimate used for
  // clock sync (immune to queue/stall spikes). Window peak of the raw RTT for the debug overlay.
  private rawPingMs = 0;
  private smoothedRttMs = 0;
  private maxRecentPingMs = 0;
  private maxRecentPingWindowStartedAtMs = 0;
  private missedPongs = 0;
  private consecutiveMissedPongs = 0;
  private awaitingPong = false;
  // Server-side connection mirror from the latest pong (see the pong protocol comment): the
  // server's outbound socket backlog toward US, and the server event-loop delay p95. null until a
  // pong carrying them arrives (older server builds omit the fields).
  private serverOutBufferedB: number | null = null;
  private serverLoopP95Ms: number | null = null;
  // Wall-clock time the in-flight ping was SENT. If the gap until its pong (or until the next send)
  // far exceeds the ping interval, our timer was throttled/frozen — a backgrounded tab, the machine
  // sleeping, or a long main-thread stall. The resulting "RTT" is that frozen wall-clock gap, NOT
  // network latency, so we must discard it rather than display a 19000ms "ping".
  private lastPingSentAtMs = 0;
  // True once a ping round-trip has been invalidated by a detected freeze, until a clean fresh
  // round trip arrives. Drives the HUD to show "stale" instead of a bogus latency number.
  private pingStale = false;
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
  private lastServerTimeSampleMs: number | null = null;
  private lastServerTimeSampleReceivedAtMs = 0;
  // Rolling peak of the client uplink WebSocket send buffer (bytes). An instantaneous read at HUD
  // refresh time misses transient spikes — and a transient uplink backlog is exactly what inflates
  // the measured ping. We sample on every input send (the highest-frequency outbound path) and on
  // every ping send, keep the window peak, and decay it slowly so the HUD shows recent worst-case.
  private wsBufferedPeakBytes = 0;
  private wsBufferedPeakDecayAtMs = 0;
  // The bufferedAmount captured at the instant the most recent ping was SENT. If this is large when
  // a slow pong arrives, the "ping" is queue time on our own uplink, not network RTT.
  private lastPingSendBufferedBytes = 0;
  private netFlightRecorderEnabled = false;
  private reconnectCount = 0;
  private hasConnectedOnce = false;

  constructor(serverUrl = resolveServerUrl()) {
    this.serverUrl = serverUrl;
    console.log(`[MultiplayerClient] Connecting to Colyseus endpoint: ${serverUrl}`);
    this.client = new Client(serverUrl);
  }

  get connected(): boolean {
    return this.status === 'connected' && this.room !== null;
  }

  get flightRecorderEnabled(): boolean {
    return this.netFlightRecorderEnabled;
  }

  get wsReadyState(): number {
    const room = this.room as Room & {
      connection?: {
        ws?: { readyState?: number };
        transport?: { ws?: { readyState?: number } };
      };
    };
    return room.connection?.ws?.readyState
      ?? room.connection?.transport?.ws?.readyState
      ?? WebSocket.CLOSED;
  }

  get reconnectAttempts(): number {
    return this.reconnectCount;
  }

  /**
   * Floor-tracked network RTT estimate (ms), immune to uplink-queue / main-thread-stall spikes that
   * inflate the raw `pingMs`. This is what should drive anything latency-compensated (e.g. the
   * server's catch rewind window) so a transient 3000ms send-queue spike can't widen lag-comp.
   * Falls back to the raw ping until the floor estimate has a sample.
   */
  get rttEstimateMs(): number | null {
    if (this.smoothedRttMs > 0) return this.smoothedRttMs;
    return this.pingMs;
  }

  getConnectionDebug(): {
    pingJitterMs: number;
    lastPongAgeMs: number | null;
    missedPongs: number;
    consecutiveMissedPongs: number;
    socketBufferedAmount: number;
    socketBufferedPeak: number;
    pingSendBufferedAmount: number;
    rttEstimateMs: number;
    maxRecentPingMs: number;
    lastSnapshotAgeMs: number | null;
    serverOutBufferedB: number | null;
    serverLoopP95Ms: number | null;
  } {
    const now = Date.now();
    const perfNow = performance.now();
    // Refresh the decayed peak even if no input was sent this tick (e.g. paused in a menu).
    this.sampleWsBufferedPeak();
    // Roll the "max recent ping" window every PERF_REPORT_INTERVAL_MS so the overlay shows the worst
    // round-trip in the last few seconds (where a spike actually shows up), not an all-time high.
    if (this.maxRecentPingWindowStartedAtMs === 0) this.maxRecentPingWindowStartedAtMs = now;
    const reportedMaxRecentPing = this.maxRecentPingMs;
    if (now - this.maxRecentPingWindowStartedAtMs >= PERF_REPORT_INTERVAL_MS) {
      this.maxRecentPingMs = this.rawPingMs;
      this.maxRecentPingWindowStartedAtMs = now;
    }
    return {
      pingJitterMs: this.pingJitterMs,
      lastPongAgeMs: this.lastPongReceivedAtMs > 0 ? Math.max(0, now - this.lastPongReceivedAtMs) : null,
      missedPongs: this.missedPongs,
      consecutiveMissedPongs: this.consecutiveMissedPongs,
      // Floor-tracked network RTT estimate (queue/stall-immune) and the worst raw round-trip in the
      // recent window. If maxRecentPingMs >> rttEstimateMs, the spike is local queue/stall, not network.
      rttEstimateMs: Math.round(this.smoothedRttMs),
      maxRecentPingMs: Math.round(reportedMaxRecentPing),
      socketBufferedAmount: this.socketBufferedAmount(),
      // Rolling worst-case uplink backlog and the backlog measured at last ping-send time. When
      // ping spikes, compare these: a high pingSendBufferedAmount proves the spike is send-queue
      // time on the client's own uplink, not network round-trip.
      socketBufferedPeak: Math.round(this.wsBufferedPeakBytes),
      pingSendBufferedAmount: this.lastPingSendBufferedBytes,
      lastSnapshotAgeMs: this.lastSnapshotReceivedAtMs > 0 ? Math.max(0, perfNow - this.lastSnapshotReceivedAtMs) : null,
      // Server-side mirror from the latest pong: the server's outbound backlog toward us (downstream
      // path congestion) and its event-loop p95 (shared-host stall). See the pong protocol comment.
      serverOutBufferedB: this.serverOutBufferedB,
      serverLoopP95Ms: this.serverLoopP95Ms
    };
  }

  async createRoom(name: string, mode: MatchMode = '1v1', tickPresetId?: TickPresetId): Promise<void> {
    await this.connect(() => this.client.create('duel', { name: cleanName(name), mode, tickPresetId }));
  }

  /**
   * The room's net mode, learned from the `joined-room` message (ALWAYS a full snapshot — never
   * read this off later snapshots, whose room fields are cadence-gated under tiered encoding).
   * Null until joined, or against a server build that predates per-room tick presets; callers must
   * fall back to the compiled defaults in that case.
   */
  get resolvedNetConfig(): NetModeConfig | null {
    return this.joinedRoomNetMode ? netModeConfig(this.joinedRoomNetMode) : null;
  }

  /** Raw NetMode for UI labeling (e.g. showing the room's tick preset in the lobby). */
  get roomNetMode(): NetMode | null {
    return this.joinedRoomNetMode;
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
    this.latestSnapshotLanes = null;
    this.snapshotTierMode = 'baseline';
    this.joinedRoomNetMode = null;
    this.battleMusicSync = null;
    this.throwEventQueue = [];
    this.catchEventQueue = [];
    this.parryEventQueue = [];
    this.hitEventQueue = [];
    this.hitRevertEventQueue = [];
    clearRoster(this.roster);
    this.resetSnapshotDebug();
    this.resetConnectionDebug();
  }

  dispose(): void {
    this.leave();
  }

  sendInput(input: PlayerInput, previous?: PlayerInput): void {
    if (!this.room) return;
    // Sample the uplink send buffer BEFORE we enqueue this input. The input stream is the dominant
    // outbound traffic (one packet per fixed step), so this is where uplink congestion first shows.
    this.sampleWsBufferedPeak();
    // Report the FLOOR-tracked RTT, not the raw ping: the server uses this for the catch lag-comp
    // rewind window, and a transient uplink-queue spike (the thing that inflates raw ping to ~3000ms)
    // must not widen lag-comp. The server still clamps/EMA-smooths it, so this only makes the rewind
    // track true network RTT more faithfully during congestion — no balance change.
    this.room.send('input', this.buildInputCommand(input, previous));
  }

  estimateInputCommandJsonBytes(input: PlayerInput, previous?: PlayerInput): number {
    return JSON.stringify(this.buildInputCommand(input, previous)).length;
  }

  private buildInputCommand(input: PlayerInput, previous?: PlayerInput): InputCommand {
    const reportedRtt = this.rttEstimateMs;
    return {
      type: 'input',
      playerId: this.localPlayerId,
      sequence: input.sequence,
      clientTimeMs: input.clientTimeMs,
      ...(reportedRtt !== null ? { rttMs: reportedRtt } : {}),
      input: toWireInput(input, previous)
    } satisfies InputCommand;
  }

  /** Update the rolling peak of the uplink WebSocket send buffer. Cheap (a couple of property reads
   *  plus arithmetic); safe to call on every input send. Decays the peak toward the current value
   *  over ~1s so the HUD reflects RECENT worst-case rather than an all-time high. */
  private sampleWsBufferedPeak(): void {
    const buffered = this.socketBufferedAmount();
    const now = Date.now();
    if (this.wsBufferedPeakDecayAtMs === 0) this.wsBufferedPeakDecayAtMs = now;
    // Linear decay of the held peak: full peak falls back to `buffered` over ~1s of no new spikes.
    const elapsed = now - this.wsBufferedPeakDecayAtMs;
    if (elapsed > 0) {
      const decay = (this.wsBufferedPeakBytes - buffered) * Math.min(1, elapsed / 1000);
      this.wsBufferedPeakBytes = Math.max(buffered, this.wsBufferedPeakBytes - decay);
      this.wsBufferedPeakDecayAtMs = now;
    }
    if (buffered > this.wsBufferedPeakBytes) this.wsBufferedPeakBytes = buffered;
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

  /**
   * Host-only: change one or more authoritative room settings (partial patch). The server validates
   * host identity + values; a rejection arrives as a `request-rejected` message. No-ops when offline.
   */
  requestRoomSettings(patch: RoomSettingsPatch): void {
    this.room?.send('update-room-settings', {
      type: 'update-room-settings',
      playerId: this.localPlayerId,
      settings: patch
    } satisfies UpdateRoomSettingsRequest);
  }

  /** Host-only: apply a recommended preset (1v1 / 2v2) to the room's settings in one message. */
  requestPreset(preset: MatchPresetId): void {
    this.requestRoomSettings({ preset });
  }

  /** Host-only: start the configured match from the lobby (begins the pre-round countdown). */
  requestStartMatch(): void {
    this.room?.send('start-match', {
      type: 'start-match',
      playerId: this.localPlayerId
    } satisfies StartMatchRequest);
  }

  /** Cast/open the early-end vote. The host opens it during a live game; everyone else then agrees. */
  requestEndVote(): void {
    this.room?.send('end-vote', {
      type: 'end-vote',
      playerId: this.localPlayerId
    } satisfies EndVoteRequest);
  }

  /** Cast a between-rounds / post-match vote: 'next-round' (intermission) or 'to-lobby'. */
  requestIntermissionVote(choice: 'next-round' | 'to-lobby'): void {
    this.room?.send('intermission-vote', {
      type: 'intermission-vote',
      playerId: this.localPlayerId,
      choice
    } satisfies IntermissionVoteRequest);
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

  requestReset(mode: 'same-teams' | 'reset-teams' = 'same-teams'): void {
    this.room?.send('reset', { type: 'reset', playerId: this.localPlayerId, mode } satisfies ResetRequest);
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

  sendNetAnomalyReport(report: NetFlightRecorderClientReport): boolean {
    if (!this.room || !this.netFlightRecorderEnabled) return false;
    if (this.wsReadyState !== WebSocket.OPEN) return false;
    this.room.send('net-anomaly-report', report);
    return true;
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
      if (this.hasConnectedOnce) this.reconnectCount += 1;
      this.hasConnectedOnce = true;
      this.bindRoom(room);
      this.startPing();
    } catch (error) {
      if (gen !== this.connectGeneration) return; // superseded, ignore the error
      this.room = null;
      this.status = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[MultiplayerClient] Matchmaking failed against ${this.serverUrl}:`,
        error
      );
    }
  }

  private bindRoom(room: Room): void {
    room.onMessage('snapshot', (message: SnapshotPayload) => {
      if (this.room !== room) return;
      const decoded = isTieredCompactSnapshot(message)
        ? mergeTieredCompactSnapshot(message, this.latestSnapshot, this.localPlayerId)
        : decodeFullSnapshotMessage(message);
      if (!decoded) return;
      this.snapshotTierMode = decoded.lanes.mode;
      this.recordSnapshotReceived(decoded.snapshot);
      const snapshot = hydrateSnapshotRoster(decoded.snapshot, this.roster);
      if (this.latestSnapshot && snapshot.tick <= this.latestSnapshot.tick) {
        this.snapshotWindowStaleDropped += 1;
        return;
      }
      this.latestSnapshot = snapshot;
      this.latestSnapshotLanes = decoded.lanes;
      this.recordServerTimeSample(snapshot.serverTimeMs);
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
      // Adopt the room's net mode here and only here: joined-room always carries the full room
      // state, unlike tiered snapshots. `?? null` tolerates an older server without the field.
      this.joinedRoomNetMode = message.room.netMode ?? null;
      replaceRoster(this.roster, rosterFromRoom(message.room));
      this.latestSnapshot = {
        type: 'snapshot',
        tick: message.room.tick,
        serverTimeMs: Date.now(),
        room: message.room
      };
      this.latestSnapshotLanes = laneInfoFromFullSnapshot(this.latestSnapshot);
      this.snapshotTierMode = 'baseline';
    });

    room.onMessage('music-sync', (message: BattleMusicSyncMessage) => {
      if (this.room !== room) return;
      this.battleMusicSync = message.music;
      this.recordServerTimeSample(message.serverTimeMs);
    });

    room.onMessage('roster-update', (message: Extract<ServerMessage, { type: 'roster-update' }>) => {
      if (this.room !== room) return;
      replaceRoster(this.roster, message.roster);
      if (this.latestSnapshot) this.latestSnapshot = hydrateSnapshotRoster(this.latestSnapshot, this.roster);
    });

    room.onMessage('request-rejected', (message: Extract<ServerMessage, { type: 'request-rejected' }>) => {
      if (this.room !== room) return;
      this.errorMessage = `${message.request}: ${message.reason}`;
    });

    room.onMessage('net-flight-recorder-config', (message: NetFlightRecorderConfigMessage) => {
      if (this.room !== room) return;
      this.netFlightRecorderEnabled = Boolean(message.enabled);
    });

    room.onMessage('pong', (message: Extract<ServerMessage, { type: 'pong' }>) => {
      if (this.room !== room) return;
      const now = Date.now();
      const roundTrip = Math.max(0, now - message.clientTimeMs);
      this.awaitingPong = false;
      this.lastPongReceivedAtMs = now;
      this.consecutiveMissedPongs = 0;
      // Server-side connection mirror (newer servers only). Recorded even for freeze-discarded
      // round trips below — these two describe the SERVER's state, not this ping's travel time.
      if (typeof message.outBufferedB === 'number') this.serverOutBufferedB = message.outBufferedB;
      if (typeof message.loopP95Ms === 'number') this.serverLoopP95Ms = message.loopP95Ms;

      // Discard a round trip that spans a detected freeze (backgrounded tab / sleep / long stall) or
      // is itself implausibly large for network RTT. Its "RTT" is frozen wall-clock time, not latency.
      // We mark pingMs null (HUD shows "—/stale") and leave the floor RTT + clock estimate untouched
      // so a 19000ms reading can't poison them. A clean fresh round trip below clears the stale flag.
      if (this.pingStale || roundTrip > MultiplayerClient.PING_FREEZE_GAP_MS) {
        this.pingMs = null;
        this.pingStale = false; // this pong cleared the freeze; the NEXT round trip is trustworthy
        return;
      }

      const previousPing = this.pingMs;
      // Raw application round-trip: send-enqueue → server echo → receive-process. This INCLUDES any
      // time the ping spent queued behind our own outbound backlog and any main-thread stall before
      // we processed the pong, so a spike here is not necessarily network latency. We surface it
      // (pingMs) but also derive a clock-safe one-way delay below that ignores such spikes.
      this.pingMs = roundTrip;
      this.rawPingMs = this.pingMs;
      this.maxRecentPingMs = Math.max(this.maxRecentPingMs, this.pingMs);
      if (previousPing !== null) {
        const delta = Math.abs(this.pingMs - previousPing);
        this.pingJitterMs = this.pingJitterMs === 0 ? delta : this.pingJitterMs * 0.8 + delta * 0.2;
      }
      // Server-time estimate must NOT be jerked around by a queue/stall spike. Estimate true network
      // RTT by tracking the FLOOR of recent samples: every spike (uplink queue, main-thread stall)
      // only ADDS delay, so the minimum recent round-trip is the best estimate of real latency. The
      // floor follows genuine latency increases slowly (it relaxes upward toward the live sample) but
      // a single 3000ms outlier can't shove the render/server clock by ~1.5s.
      this.smoothedRttMs = this.smoothedRttMs === 0
        ? this.pingMs
        : this.pingMs < this.smoothedRttMs
          ? this.pingMs // snap down: a lower sample is real network latency, adopt it immediately
          : this.smoothedRttMs + (this.pingMs - this.smoothedRttMs) * 0.1; // relax up slowly toward sustained higher RTT
      this.recordServerTimeSample(message.serverTimeMs, this.smoothedRttMs * 0.5);
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
      this.latestSnapshotLanes = null;
      this.snapshotTierMode = 'baseline';
      this.joinedRoomNetMode = null;
      this.battleMusicSync = null;
      this.throwEventQueue = [];
      this.catchEventQueue = [];
      this.parryEventQueue = [];
      this.hitEventQueue = [];
      this.hitRevertEventQueue = [];
      clearRoster(this.roster);
      this.resetSnapshotDebug();
      this.resetConnectionDebug();
    });
  }

  estimateServerTimeMs(): number | null {
    if (this.lastServerTimeSampleMs === null || this.lastServerTimeSampleReceivedAtMs <= 0) return null;
    return this.lastServerTimeSampleMs + Math.max(0, Date.now() - this.lastServerTimeSampleReceivedAtMs);
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
    // 1s cadence (was 2s): a fresher sample recovers the displayed ping faster after a transient
    // spike, and the floor-tracked RTT estimate converges quicker. One tiny ping/s is negligible
    // next to the 128–180 input packets/s already on this socket.
    this.pingTimer = window.setInterval(() => this.sendPing(), 1000);
  }

  private sendPing(): void {
    if (!this.room) return;
    const now = Date.now();
    // Detect a throttled/frozen ping timer: a backgrounded tab, OS sleep, or a long main-thread
    // stall delays setInterval far past its 1s period. When the gap between sends is much larger
    // than the interval, any pong for the previous (or this) ping measures frozen wall-clock time,
    // not network RTT — flag it stale so we don't display a bogus multi-second "ping".
    if (this.lastPingSentAtMs > 0 && now - this.lastPingSentAtMs > MultiplayerClient.PING_FREEZE_GAP_MS) {
      this.pingStale = true;
    }
    if (this.awaitingPong) {
      this.missedPongs += 1;
      this.consecutiveMissedPongs += 1;
    }
    this.lastPingClientTime = now;
    this.lastPingSentAtMs = now;
    this.awaitingPong = true;
    // Capture the uplink backlog at the instant the ping is enqueued. A large value here means the
    // ping is queued behind our own outbound backlog, so the resulting "ping" is mostly send-queue
    // time, not network RTT — the core distinction this investigation needs.
    this.sampleWsBufferedPeak();
    this.lastPingSendBufferedBytes = this.socketBufferedAmount();
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

  private resetConnectionDebug(): void {
    this.lastPingClientTime = 0;
    this.lastPongReceivedAtMs = 0;
    this.pingJitterMs = 0;
    this.missedPongs = 0;
    this.consecutiveMissedPongs = 0;
    this.awaitingPong = false;
    this.lastServerTimeSampleMs = null;
    this.lastServerTimeSampleReceivedAtMs = 0;
    this.wsBufferedPeakBytes = 0;
    this.wsBufferedPeakDecayAtMs = 0;
    this.lastPingSendBufferedBytes = 0;
    this.rawPingMs = 0;
    this.smoothedRttMs = 0;
    this.maxRecentPingMs = 0;
    this.maxRecentPingWindowStartedAtMs = 0;
    this.lastPingSentAtMs = 0;
    this.pingStale = false;
    this.serverOutBufferedB = null;
    this.serverLoopP95Ms = null;
    this.netFlightRecorderEnabled = false;
  }

  private recordServerTimeSample(serverTimeMs: number, oneWayDelayMs = (this.pingMs ?? 0) * 0.5): void {
    if (!Number.isFinite(serverTimeMs)) return;
    this.lastServerTimeSampleMs = serverTimeMs + Math.max(0, oneWayDelayMs);
    this.lastServerTimeSampleReceivedAtMs = Date.now();
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 24) : 'Player';
}

function replaceRoster(target: PlayerRoster, next: PlayerRoster): void {
  clearRoster(target);
  for (const playerId in next) target[playerId] = next[playerId];
}

function clearRoster(target: PlayerRoster): void {
  for (const playerId in target) delete target[playerId];
}

function decodeFullSnapshotMessage(message: SnapshotPayload): { snapshot: ServerSnapshot; lanes: SnapshotLaneInfo } {
  const snapshot = isCompactSnapshot(message) ? inflateCompactSnapshot(message) : message as ServerSnapshot;
  return {
    snapshot,
    lanes: laneInfoFromFullSnapshot(snapshot)
  };
}
