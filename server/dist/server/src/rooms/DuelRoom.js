"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DuelRoom = void 0;
const colyseus_1 = require("colyseus");
const node_perf_hooks_1 = require("node:perf_hooks");
const constants_1 = require("../../../shared/constants");
const roomSettings_1 = require("../../../shared/roomSettings");
const netConfig_1 = require("../../../shared/netConfig");
const tickPresets_1 = require("../../../shared/tickPresets");
const netFlightRecorder_1 = require("../../../shared/netFlightRecorder");
const snapshotCodec_1 = require("../../../shared/snapshotCodec");
const NetworkRateLimits_1 = require("../network/NetworkRateLimits");
const ServerGameLoop_1 = require("../simulation/ServerGameLoop");
const snapshotScheduler_1 = require("./snapshotScheduler");
// All timing/rate constants now come from the centralized netConfig — never hardcode a rate here.
// Visual state is sent through explicit `snapshot` messages, not Colyseus Schema patches, so we
// keep the manual snapshot cadence (SNAPSHOT_RATE) explicit and decoupled from the sim tick.
const COLYSEUS_PATCH_RATE_MS = null;
// How long a dropped player has to reconnect before their team may forfeit (#12).
const RECONNECT_SECONDS = constants_1.GAME_CONSTANTS.match.disconnectForfeitSeconds;
// Hard cap on concurrent duel rooms per process (#19 — cheap DoS guard).
const MAX_ROOMS = 200;
let activeRoomCount = 0;
class DuelRoom extends colyseus_1.Room {
    maxClients = constants_1.GAME_CONSTANTS.match.teamIds.length;
    autoDispose = true;
    game;
    debug = (0, netConfig_1.resolveServerDebugFlags)();
    roomMode = '1v1';
    playersPerTeam = 1;
    roomSettings = (0, roomSettings_1.defaultRoomSettings)('1v1');
    buckets = new Map();
    createdAtMs = Date.now();
    rateWindowStartedAtMs = 0;
    simTicksThisWindow = 0;
    snapshotsThisWindow = 0;
    simTickMsTotal = 0;
    simTickMsMax = 0;
    stepCapHitsThisWindow = 0;
    snapshotBuildMsTotal = 0;
    snapshotBuildMsMax = 0;
    snapshotBroadcastMsTotal = 0;
    snapshotBroadcastMsMax = 0;
    snapshotLateMsTotal = 0;
    snapshotLateMsMax = 0;
    snapshotDeadlineSkipsThisWindow = 0;
    snapshotNoNewTickSkipsThisWindow = 0;
    snapshotBackpressureSkipsThisWindow = 0;
    snapshotAllBackpressureSkipsThisWindow = 0;
    snapshotRecoveryHalvedThisWindow = 0;
    // Clients recently past the backpressure threshold receive snapshots at HALF rate until this
    // deadline (see snapshotSendableClients): a congested link needs a drain ramp, not an instant
    // full-rate blast that immediately re-fills its buffer and re-triggers the skip/spike oscillation.
    snapshotRecoveryUntilMsByClient = new Map();
    snapshotClientSendsThisWindow = 0;
    // Approximate snapshot payload size, sampled cheaply (only when PERF_DEBUG is on) once per window.
    snapshotPayloadBytesTotal = 0;
    snapshotPayloadBytesMax = 0;
    snapshotFullPayloadBytesTotal = 0;
    snapshotFullPayloadBytesMax = 0;
    snapshotCompactPayloadBytesTotal = 0;
    snapshotCompactPayloadBytesMax = 0;
    snapshotFrameBytesTotal = 0;
    snapshotFrameBytesMax = 0;
    snapshotFullFrameBytesTotal = 0;
    snapshotFullFrameBytesMax = 0;
    snapshotCompactFrameBytesTotal = 0;
    snapshotCompactFrameBytesMax = 0;
    snapshotPayloadSamples = 0;
    snapshotWsBufferedBytesTotal = 0;
    snapshotWsBufferedBytesMax = 0;
    snapshotWsBufferedSamples = 0;
    loopWakeStallsOver50MsThisWindow = 0;
    loopWakeStallsOver100MsThisWindow = 0;
    loopWakeStallsOver500MsThisWindow = 0;
    loopWakeDelayMsMax = 0;
    simulationAccumulatorMs = 0;
    lastLoopWakeAtMs = 0;
    nextSnapshotDueAtMs = 0;
    lastSnapshotTickSent = -1;
    snapshotCadenceCounter = 0;
    forceNextTieredFullSnapshot = true;
    lastTieredResetSerial = -1;
    lastTieredWorldDirtyKey = '';
    lastTieredPlayerDirtyKey = '';
    tieredFastLaneSnapshotsThisWindow = 0;
    tieredPlayerLaneSnapshotsThisWindow = 0;
    tieredWorldLaneSnapshotsThisWindow = 0;
    tieredBallLaneSnapshotsThisWindow = 0;
    tieredFastLaneBytesTotal = 0;
    tieredFastLaneBytesMax = 0;
    tieredPlayerLaneBytesTotal = 0;
    tieredPlayerLaneBytesMax = 0;
    tieredWorldLaneBytesTotal = 0;
    tieredWorldLaneBytesMax = 0;
    tieredLaneByteSamples = 0;
    // When sim and snapshot rates are equal (mode A/C) we broadcast one snapshot per sim step, which
    // is exactly the old coupled behavior — no accumulator drift, lowest latency.
    // Per-room net timing, resolved ONCE in onCreate from the creator's tick preset. Field
    // initializers carry the compiled defaults only as pre-onCreate safety; every real read happens
    // after onCreate has overwritten them with the room's own resolved values.
    netTiming = (0, netConfig_1.netModeConfig)(netConfig_1.ACTIVE_NET_MODE);
    serverStepMs = netConfig_1.SERVER_STEP_MS;
    snapshotIntervalMs = netConfig_1.SNAPSHOT_INTERVAL_MS;
    // Per-message-type rate limits: { capacity (burst), refillPerSecond } (#11). Built per room from
    // the ROOM's input rate — a process-wide table would be wrong the moment two rooms run different
    // tick presets (one starved, the other under-throttled).
    rateLimits = (0, NetworkRateLimits_1.buildInboundRateLimits)(netConfig_1.CLIENT_INPUT_RATE);
    snapshotCoupledToTick = netConfig_1.SNAPSHOT_RATE === netConfig_1.SERVER_TICK_RATE;
    eventLoopDelay = (0, node_perf_hooks_1.monitorEventLoopDelay)({ resolution: 20 });
    flightRecorderEventLoopDelay = (0, node_perf_hooks_1.monitorEventLoopDelay)({ resolution: 20 });
    incomingMessagesThisWindow = 0;
    incomingMessagesByType = new Map();
    incomingMessagesByPlayerId = new Map();
    incomingMessagesByPlayerIdAndType = new Map();
    tokenBucketRejectsByType = new Map();
    tokenBucketRejectsByPlayerId = new Map();
    handlerRejectsByType = new Map();
    handlerRejectsByPlayerId = new Map();
    snapshotStatsByPlayerId = new Map();
    lastCpuUsage = process.cpuUsage();
    lastHeapUsedBytes = process.memoryUsage().heapUsed;
    lastCpuSampleMicros = Number(process.hrtime.bigint() / 1000n);
    netFlightRecorderEnabled = (0, netFlightRecorder_1.resolveNetFlightRecorderEnabled)();
    flightRecorderSamples = new FixedRingBuffer(netFlightRecorder_1.NET_FLIGHT_RECORDER_RING_SIZE);
    flightRecorderClientSecondStats = new Map();
    flightRecorderSecond = createFlightRecorderSecondAccumulator();
    flightRecorderNextSampleAtMs = 0;
    lastFlightRecorderAnomalyAtMs = 0;
    lastLoggedDisconnectEventKey = '';
    flightRecorderLoopWakeDelayMsMax = 0;
    flightRecorderLoopWakeStallsOver50Ms = 0;
    flightRecorderLoopWakeStallsOver100Ms = 0;
    flightRecorderLoopWakeStallsOver500Ms = 0;
    onCreate(options = {}) {
        activeRoomCount += 1;
        this.eventLoopDelay.enable();
        this.flightRecorderEventLoopDelay.enable();
        this.flightRecorderNextSampleAtMs = Date.now() + netFlightRecorder_1.NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS;
        this.setPrivate(true);
        this.patchRate = COLYSEUS_PATCH_RATE_MS;
        // Resolve the host's authoritative settings from the requested format (the `format`/`mode` join
        // option), then derive room size from them — never from a bare constant. This is the single place
        // the room's max-clients / players-per-team come from, so 1v1 vs 2v2 size is settings-driven.
        const requestedFormat = options.format === '2v2' || options.mode === '2v2' ? '2v2' : '1v1';
        this.roomSettings = (0, roomSettings_1.defaultRoomSettings)(requestedFormat);
        const matchSettings = (0, roomSettings_1.resolveMatchSettings)(this.roomSettings);
        this.roomMode = matchSettings.format;
        this.playersPerTeam = matchSettings.teamSize;
        this.maxClients = matchSettings.maxPlayers;
        // Resolve the creator's tick preset ONCE; everything rate-derived below (sim tick, snapshot
        // cadence, inbound rate limits, telemetry) reads the ROOM's resolved timing, never the process
        // globals. Locked for the room's lifetime (netMode is not a RoomSettingsPatch field).
        const tickPreset = (0, tickPresets_1.tickPresetById)(options.tickPresetId);
        this.netTiming = (0, netConfig_1.netModeConfig)(tickPreset.netMode);
        this.serverStepMs = 1000 / this.netTiming.serverTickRate;
        this.snapshotIntervalMs = 1000 / this.netTiming.snapshotRate;
        this.snapshotCoupledToTick = this.netTiming.snapshotRate === this.netTiming.serverTickRate;
        this.rateLimits = (0, NetworkRateLimits_1.buildInboundRateLimits)(this.netTiming.clientInputRate);
        // Colyseus 0.17 applies this PER CLIENT on inbound messages and force-closes the sender when
        // exceeded, so size it to the room's client input stream plus burst headroom.
        this.maxMessagesPerSecond = (0, NetworkRateLimits_1.computeMaxMessagesPerSecondPerClient)(this.netTiming.clientInputRate);
        this.game = new ServerGameLoop_1.ServerGameLoop(this.roomId, {
            netMode: tickPreset.netMode,
            settings: this.roomSettings,
            logger: (message) => this.log(message),
            debug: this.debug
        });
        // One-time room-created line describing this room's resolved net config + the patch mode.
        this.log(`room created mode=${this.roomMode} playersPerTeam=${this.playersPerTeam} preset=${this.roomSettings.preset} ` +
            `tickPreset=${tickPreset.id} netMode=${tickPreset.netMode} sim=${this.netTiming.serverTickRate}Hz input=${this.netTiming.clientInputRate}Hz snapshots=${this.netTiming.snapshotRate}Hz ` +
            `processDefault={${(0, netConfig_1.describeNetConfig)()}} ` +
            `snapshotEncoding=${netConfig_1.SNAPSHOT_ENCODING} snapshotTierMode=${netConfig_1.SNAPSHOT_TIER_MODE} snapshotProfile=${(0, netConfig_1.describeSnapshotProfile)()} snapshotBackpressure=${netConfig_1.SNAPSHOT_BACKPRESSURE_BYTES}B ` +
            `colyseusPatchRate=${formatPatchRate(COLYSEUS_PATCH_RATE_MS)} ` +
            `colyseusMaxMessagesPerSecond=${this.maxMessagesPerSecond}/s(per-client inbound, expected~${(0, NetworkRateLimits_1.expectedPerClientMessagesPerSecond)(this.netTiming.clientInputRate)}/s)`);
        if (this.netFlightRecorderEnabled) {
            this.log(`net flight recorder enabled duration=${netFlightRecorder_1.NET_FLIGHT_RECORDER_DURATION_SECONDS}s sampleInterval=${netFlightRecorder_1.NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS}ms reportSamples=${netFlightRecorder_1.NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT}`);
        }
        this.onMessage('input', (client, message) => {
            this.recordIncomingMessage(client, 'input');
            if (!this.allow(client, 'input'))
                return;
            const wrapped = message && typeof message === 'object' && 'input' in message
                ? message
                : undefined;
            const input = wrapped
                ? inputPayloadFromCommand(wrapped)
                : message;
            const seq = wrapped?.sequence ?? wrapped?.input?.sequence ?? message?.sequence ?? 0;
            const rttMs = typeof wrapped?.rttMs === 'number' && Number.isFinite(wrapped.rttMs) ? wrapped.rttMs : undefined;
            if (!this.game.handleInput(client.sessionId, input, seq, rttMs)) {
                this.reject(client, 'input', 'unknown-player');
            }
        });
        this.onMessage('pickup', (client) => {
            this.recordIncomingMessage(client, 'pickup');
            if (!this.allow(client, 'pickup'))
                return;
            const result = this.game.handlePickup(client.sessionId);
            if (!result.ok) {
                if (this.debug.PICKUP_DEBUG)
                    this.log(`pickup rejected player=${client.sessionId} reason=${result.reason}`);
                this.reject(client, 'pickup', result.reason);
            }
            else if (result.log && this.debug.PICKUP_DEBUG) {
                this.log(result.log);
            }
        });
        this.onMessage('drop', (client, message) => {
            this.recordIncomingMessage(client, 'drop');
            if (!this.allow(client, 'drop'))
                return;
            const result = this.game.handleDrop(client.sessionId, message?.hand);
            if (!result.ok)
                this.reject(client, 'drop', result.reason);
        });
        this.onMessage('throw', (client, message) => {
            this.recordIncomingMessage(client, 'throw');
            if (!this.allow(client, 'throw'))
                return;
            // direction/charge are intentionally NOT trusted — the server uses its own facing and the
            // server-tracked charge (#7). Only the hand selection comes from the client.
            const result = this.game.handleThrow(client.sessionId, { hand: message?.hand });
            if (!result.ok) {
                if (this.debug.THROW_DEBUG)
                    this.log(`throw rejected player=${client.sessionId} reason=${result.reason}`);
                this.reject(client, 'throw', result.reason);
            }
            else if (result.log && this.debug.THROW_DEBUG) {
                this.log(result.log);
            }
        });
        this.onMessage('catch-parry', (client) => {
            this.recordIncomingMessage(client, 'catch-parry');
            if (!this.allow(client, 'catch-parry'))
                return;
            // facing is taken from the server's known aim, not the client (#8).
            const result = this.game.handleCatchParry(client.sessionId);
            if (!result.ok)
                this.reject(client, 'catch-parry', result.reason);
        });
        this.onMessage('reset', (client, message) => {
            this.recordIncomingMessage(client, 'reset');
            if (!this.allow(client, 'reset'))
                return;
            const result = this.game.handleReset(client.sessionId, message?.mode);
            if (!result.ok)
                this.reject(client, 'reset', result.reason);
        });
        this.onMessage('start-vote', (client, _message) => {
            this.recordIncomingMessage(client, 'start-vote');
            if (!this.allow(client, 'start-vote'))
                return;
            const result = this.game.handleStartVote(client.sessionId);
            if (!result.ok)
                this.reject(client, 'start-vote', result.reason);
        });
        this.onMessage('switch-team', (client, message) => {
            this.recordIncomingMessage(client, 'switch-team');
            if (!this.allow(client, 'switch-team'))
                return;
            const result = this.game.handleTeamSwitch(client.sessionId, message?.teamId, message?.teamSlotIndex);
            if (!result.ok)
                this.reject(client, 'switch-team', result.reason);
        });
        this.onMessage('update-room-settings', (client, message) => {
            this.recordIncomingMessage(client, 'update-room-settings');
            if (!this.allow(client, 'update-room-settings'))
                return;
            // Host identity + validation are fully owned by the game loop (server-authoritative); the room
            // only relays the patch and surfaces a rejection.
            const patch = (message?.settings ?? {});
            const result = this.game.handleUpdateRoomSettings(client.sessionId, patch);
            if (!result.ok) {
                if (this.debug.NET_DEBUG)
                    this.log(`settings update rejected player=${client.sessionId} reason=${result.reason}`);
                this.reject(client, 'update-room-settings', result.reason);
            }
            else if (result.log && this.debug.NET_DEBUG) {
                this.log(result.log);
            }
        });
        this.onMessage('start-match', (client) => {
            this.recordIncomingMessage(client, 'start-match');
            if (!this.allow(client, 'start-match'))
                return;
            const result = this.game.handleStartMatch(client.sessionId);
            if (!result.ok)
                this.reject(client, 'start-match', result.reason);
        });
        this.onMessage('end-vote', (client) => {
            this.recordIncomingMessage(client, 'end-vote');
            if (!this.allow(client, 'end-vote'))
                return;
            const result = this.game.handleEndVote(client.sessionId);
            if (!result.ok)
                this.reject(client, 'end-vote', result.reason);
        });
        this.onMessage('intermission-vote', (client, message) => {
            this.recordIncomingMessage(client, 'intermission-vote');
            if (!this.allow(client, 'intermission-vote'))
                return;
            const choice = message?.choice === 'to-lobby' ? 'to-lobby' : 'next-round';
            const result = this.game.handleIntermissionVote(client.sessionId, choice);
            if (!result.ok)
                this.reject(client, 'intermission-vote', result.reason);
        });
        this.onMessage('ping', (client, message) => {
            this.recordIncomingMessage(client, 'ping');
            if (!this.allow(client, 'ping'))
                return;
            client.send('pong', {
                type: 'pong',
                clientTimeMs: message?.clientTimeMs ?? 0,
                serverTimeMs: Date.now()
            });
        });
        this.onMessage('net-anomaly-report', (client, message) => {
            if (!this.netFlightRecorderEnabled || !message || message.type !== 'net-anomaly-report')
                return;
            this.handleClientAnomalyReport(client, message);
        });
        this.setSimulationInterval(() => {
            // Skip the whole step+broadcast when no one is here (#18); empty rooms auto-dispose.
            const now = node_perf_hooks_1.performance.now();
            if (this.clients.length === 0) {
                this.simulationAccumulatorMs = 0;
                this.lastLoopWakeAtMs = now;
                this.nextSnapshotDueAtMs = 0;
                this.lastSnapshotTickSent = -1;
                this.snapshotCadenceCounter = 0;
                this.forceNextTieredFullSnapshot = true;
                return;
            }
            const rawElapsedMs = this.lastLoopWakeAtMs === 0 ? 0 : now - this.lastLoopWakeAtMs;
            if (rawElapsedMs > 0)
                this.recordLoopWakeDelay(rawElapsedMs);
            if (this.nextSnapshotDueAtMs === 0)
                this.nextSnapshotDueAtMs = now + this.snapshotIntervalMs;
            // Monotonic clock; clamp the elapsed slice so an alt-tab/GC pause can't dump a huge backlog.
            const elapsedMs = Math.min(netConfig_1.MAX_ACCUMULATOR_CLAMP_MS, rawElapsedMs);
            this.lastLoopWakeAtMs = now;
            this.simulationAccumulatorMs += elapsedMs;
            // Drain fixed sim steps, capped to avoid a spiral-of-death after a long pause.
            let steps = 0;
            while (this.simulationAccumulatorMs + 0.001 >= this.serverStepMs && steps < netConfig_1.MAX_ACCUMULATOR_STEPS) {
                this.simulationAccumulatorMs -= this.serverStepMs;
                steps += 1;
                const startedAt = node_perf_hooks_1.performance.now();
                this.game.advance();
                this.recordSimulationTick(node_perf_hooks_1.performance.now() - startedAt, node_perf_hooks_1.performance.now());
                // Broadcast any authoritative throw events accepted this step BEFORE the snapshot, so the
                // client can seed deterministic live-ball prediction the instant a throw lands.
                this.broadcastStepEvents();
                this.broadcastBattleMusicSyncIfDirty();
                // Coupled fast path (mode A/C, snapshots == sim): broadcast every step, exactly the old
                // behavior — lowest latency, no snapshot accumulator drift.
                if (this.snapshotCoupledToTick) {
                    const snapshotAt = node_perf_hooks_1.performance.now();
                    this.broadcastSnapshot(snapshotAt, snapshotAt);
                }
            }
            // Step cap hit with backlog remaining: discard the backlog (don't time-warp) and report only
            // under PERF_DEBUG so a real playtest stays silent.
            if (steps >= netConfig_1.MAX_ACCUMULATOR_STEPS && this.simulationAccumulatorMs >= this.serverStepMs) {
                this.stepCapHitsThisWindow += 1;
                this.simulationAccumulatorMs = this.serverStepMs;
            }
            if (!this.snapshotCoupledToTick) {
                this.broadcastDueSnapshot(node_perf_hooks_1.performance.now());
            }
            this.maybeRecordFlightSample();
            // The wake cadence stays a single process-wide 200Hz (5ms) regardless of the room's preset:
            // even the fastest selectable preset (180Hz sim, ~5.56ms step) gets >1 wake per step, and
            // MAX_ACCUMULATOR_STEPS absorbs timer jitter. Only the drain above is per-room.
        }, netConfig_1.ROOM_LOOP_WAKE_INTERVAL_MS);
    }
    onAuth(_client, _options) {
        if (activeRoomCount > MAX_ROOMS) {
            this.log('join rejected reason=server-at-capacity');
            return false;
        }
        const allowed = this.clients.length < this.maxClients;
        if (!allowed)
            this.log('join rejected reason=room-full');
        return allowed;
    }
    onJoin(client, options) {
        const player = this.game.addPlayer(client.sessionId, options.name);
        if (!player) {
            client.leave(4001);
            return;
        }
        this.markTieredFullSnapshotDirty();
        this.game.setConnected(client.sessionId, true);
        this.log(`player joined id=${player.id} name="${player.name}" side=${player.spawnSide}`);
        client.send('joined-room', {
            type: 'joined-room',
            room: this.game.snapshot().room,
            playerId: player.id
        });
        this.sendNetFlightRecorderConfig(client);
        this.sendBattleMusicSync(client);
        this.broadcast('player-joined', { type: 'player-joined', playerId: player.id }, { except: client });
        this.broadcastRosterUpdate();
    }
    // Unconsented disconnect: pause the player and give them a window to reconnect with their
    // state intact (#12). If the window elapses, the framework proceeds to onLeave.
    async onDrop(client, _code) {
        this.game.setConnected(client.sessionId, false, Date.now() + RECONNECT_SECONDS * 1000);
        this.markTieredFullSnapshotDirty();
        this.log(`player dropped id=${client.sessionId} — awaiting reconnection`);
        this.reportServerConnectionEvent('client_drop', client.sessionId);
        try {
            await this.allowReconnection(client, RECONNECT_SECONDS);
        }
        catch {
            // reconnection window elapsed — onLeave will finalize the departure
        }
    }
    onReconnect(client) {
        this.game.setConnected(client.sessionId, true, null);
        this.markTieredFullSnapshotDirty();
        this.log(`player reconnected id=${client.sessionId}`);
        this.sendNetFlightRecorderConfig(client);
        this.sendBattleMusicSync(client);
        this.broadcastRosterUpdate();
        this.reportServerConnectionEvent('client_reconnect', client.sessionId);
    }
    // Terminal departure (consented leave, or reconnection window expired) → the remaining player
    // wins by forfeit (#13).
    onLeave(client, _code) {
        this.buckets.delete(client.sessionId);
        this.snapshotRecoveryUntilMsByClient.delete(client.sessionId);
        this.game.abandon(client.sessionId);
        this.markTieredFullSnapshotDirty();
        this.log(`player left id=${client.sessionId}`);
        this.broadcast('player-left', { type: 'player-left', playerId: client.sessionId });
        this.broadcastRosterUpdate();
        this.reportServerConnectionEvent('client_leave', client.sessionId);
    }
    onDispose() {
        activeRoomCount = Math.max(0, activeRoomCount - 1);
        this.eventLoopDelay.disable();
        this.flightRecorderEventLoopDelay.disable();
        this.log('room disposed');
        this.game.dispose();
    }
    /** Record one fixed sim step for the periodic [rates] summary. Counts ticks separately from
     * snapshots since the two cadences can differ (mode B). Emits the summary at most once/second,
     * and ONLY when PERF_DEBUG is enabled. */
    recordSimulationTick(simTickMs, now) {
        if (this.rateWindowStartedAtMs === 0)
            this.rateWindowStartedAtMs = now;
        this.simTicksThisWindow += 1;
        if (this.netFlightRecorderEnabled)
            this.flightRecorderSecond.simSteps += 1;
        this.simTickMsTotal += simTickMs;
        this.simTickMsMax = Math.max(this.simTickMsMax, simTickMs);
        const elapsedMs = now - this.rateWindowStartedAtMs;
        if (elapsedMs < netConfig_1.PERF_REPORT_INTERVAL_MS)
            return;
        if (this.debug.PERF_DEBUG)
            this.emitPerfReport(elapsedMs);
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
        this.snapshotRecoveryHalvedThisWindow = 0;
        this.snapshotClientSendsThisWindow = 0;
        this.snapshotPayloadBytesTotal = 0;
        this.snapshotPayloadBytesMax = 0;
        this.snapshotFullPayloadBytesTotal = 0;
        this.snapshotFullPayloadBytesMax = 0;
        this.snapshotCompactPayloadBytesTotal = 0;
        this.snapshotCompactPayloadBytesMax = 0;
        this.snapshotFrameBytesTotal = 0;
        this.snapshotFrameBytesMax = 0;
        this.snapshotFullFrameBytesTotal = 0;
        this.snapshotFullFrameBytesMax = 0;
        this.snapshotCompactFrameBytesTotal = 0;
        this.snapshotCompactFrameBytesMax = 0;
        this.snapshotPayloadSamples = 0;
        this.tieredFastLaneSnapshotsThisWindow = 0;
        this.tieredPlayerLaneSnapshotsThisWindow = 0;
        this.tieredWorldLaneSnapshotsThisWindow = 0;
        this.tieredBallLaneSnapshotsThisWindow = 0;
        this.tieredFastLaneBytesTotal = 0;
        this.tieredFastLaneBytesMax = 0;
        this.tieredPlayerLaneBytesTotal = 0;
        this.tieredPlayerLaneBytesMax = 0;
        this.tieredWorldLaneBytesTotal = 0;
        this.tieredWorldLaneBytesMax = 0;
        this.tieredLaneByteSamples = 0;
        this.snapshotWsBufferedBytesTotal = 0;
        this.snapshotWsBufferedBytesMax = 0;
        this.snapshotWsBufferedSamples = 0;
        this.loopWakeStallsOver50MsThisWindow = 0;
        this.loopWakeStallsOver100MsThisWindow = 0;
        this.loopWakeStallsOver500MsThisWindow = 0;
        this.loopWakeDelayMsMax = 0;
        this.incomingMessagesThisWindow = 0;
        this.incomingMessagesByType.clear();
        this.incomingMessagesByPlayerId.clear();
        this.incomingMessagesByPlayerIdAndType.clear();
        this.tokenBucketRejectsByType.clear();
        this.tokenBucketRejectsByPlayerId.clear();
        this.handlerRejectsByType.clear();
        this.handlerRejectsByPlayerId.clear();
        this.snapshotStatsByPlayerId.clear();
    }
    /** Emit the throttled (every PERF_REPORT_INTERVAL_MS) server [perf] report. PERF_DEBUG-gated. */
    emitPerfReport(elapsedMs) {
        const elapsedSeconds = elapsedMs / 1000;
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
            }
            else {
                alivePlayers += 1;
            }
        }
        let activeBalls = 0;
        let liveBalls = 0;
        let settledBalls = 0;
        for (const ball of balls) {
            if (ball.phase !== 'dead')
                activeBalls += 1;
            if (ball.phase === 'live' || ball.phase === 'deflected')
                liveBalls += 1;
            if (ball.phase === 'loose')
                settledBalls += 1;
        }
        const mem = process.memoryUsage();
        const mb = (bytes) => (bytes / 1048576).toFixed(1);
        const avgPayload = this.snapshotPayloadSamples > 0
            ? Math.round(this.snapshotPayloadBytesTotal / this.snapshotPayloadSamples)
            : 0;
        const avgFullPayload = this.snapshotPayloadSamples > 0
            ? Math.round(this.snapshotFullPayloadBytesTotal / this.snapshotPayloadSamples)
            : 0;
        const avgCompactPayload = this.snapshotPayloadSamples > 0
            ? Math.round(this.snapshotCompactPayloadBytesTotal / this.snapshotPayloadSamples)
            : 0;
        const avgSnapshotBuildMs = this.snapshotsThisWindow > 0 ? this.snapshotBuildMsTotal / this.snapshotsThisWindow : 0;
        const avgSnapshotBroadcastMs = this.snapshotsThisWindow > 0 ? this.snapshotBroadcastMsTotal / this.snapshotsThisWindow : 0;
        const avgSnapshotLateMs = this.snapshotsThisWindow > 0 ? this.snapshotLateMsTotal / this.snapshotsThisWindow : 0;
        const eventLoopDelayAvgMs = this.eventLoopDelay.mean > 0 ? this.eventLoopDelay.mean / 1e6 : 0;
        const eventLoopDelayP95Ms = this.eventLoopDelay.percentile(95) > 0 ? this.eventLoopDelay.percentile(95) / 1e6 : 0;
        const eventLoopDelayMaxMs = this.eventLoopDelay.max > 0 ? this.eventLoopDelay.max / 1e6 : 0;
        const cpuUsage = process.cpuUsage(this.lastCpuUsage);
        const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;
        const cpuPct = elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0;
        this.lastCpuUsage = process.cpuUsage();
        const socketBuffer = this.socketBufferStats();
        const wsBufferedAvg = this.snapshotWsBufferedSamples > 0
            ? Math.round(this.snapshotWsBufferedBytesTotal / this.snapshotWsBufferedSamples)
            : socketBuffer.avgBytes;
        const wsBufferedMax = Math.max(this.snapshotWsBufferedBytesMax, socketBuffer.maxBytes);
        const buffers = this.game.getDebugBufferStats();
        const playerNetStats = this.game.drainPlayerNetworkStats();
        const roomAgeSec = Math.max(0, (Date.now() - this.createdAtMs) / 1000);
        const incomingRate = this.incomingMessagesThisWindow / elapsedSeconds;
        const heapGrowthBytes = mem.heapUsed - this.lastHeapUsedBytes;
        this.lastHeapUsedBytes = mem.heapUsed;
        const avgFrameBytes = this.snapshotPayloadSamples > 0
            ? Math.round(this.snapshotFrameBytesTotal / this.snapshotPayloadSamples)
            : 0;
        const avgFullFrameBytes = this.snapshotPayloadSamples > 0
            ? Math.round(this.snapshotFullFrameBytesTotal / this.snapshotPayloadSamples)
            : 0;
        const avgCompactFrameBytes = this.snapshotPayloadSamples > 0
            ? Math.round(this.snapshotCompactFrameBytesTotal / this.snapshotPayloadSamples)
            : 0;
        const estimatedSnapshotOutBytesPerSec = avgFrameBytes * (this.snapshotClientSendsThisWindow / elapsedSeconds);
        const avgFastLaneBytes = this.tieredLaneByteSamples > 0
            ? Math.round(this.tieredFastLaneBytesTotal / this.tieredLaneByteSamples)
            : 0;
        const avgPlayerLaneBytes = this.tieredLaneByteSamples > 0
            ? Math.round(this.tieredPlayerLaneBytesTotal / this.tieredLaneByteSamples)
            : 0;
        const avgWorldLaneBytes = this.tieredLaneByteSamples > 0
            ? Math.round(this.tieredWorldLaneBytesTotal / this.tieredLaneByteSamples)
            : 0;
        const lanePct = (count) => {
            return this.snapshotsThisWindow > 0 ? ((count / this.snapshotsThisWindow) * 100).toFixed(1) : '0.0';
        };
        // Combat counters for this window (verify the lag-comp catch fix in production).
        const c = this.game.drainCombatMetrics();
        this.log(`[perf] roomAgeSec=${roomAgeSec.toFixed(1)} ` +
            `snapshotMode=${netConfig_1.SNAPSHOT_TIER_MODE} profile=${(0, netConfig_1.describeSnapshotProfile)()} ` +
            `sim=${this.netTiming.serverTickRate}Hz input=${this.netTiming.clientInputRate}Hz snapshots=${this.netTiming.snapshotRate}Hz ` +
            `simTicks=${(this.simTicksThisWindow / elapsedSeconds).toFixed(1)}/s ` +
            `snapshotsSent=${(this.snapshotsThisWindow / elapsedSeconds).toFixed(1)}/s snapshotClientSends=${(this.snapshotClientSendsThisWindow / elapsedSeconds).toFixed(1)}/s ` +
            `simTickMs avg=${avgSimTickMs.toFixed(2)} max=${this.simTickMsMax.toFixed(2)} ` +
            `snapshotBuildMs avg=${avgSnapshotBuildMs.toFixed(3)} max=${this.snapshotBuildMsMax.toFixed(3)} ` +
            `snapshotBroadcastMs avg=${avgSnapshotBroadcastMs.toFixed(3)} max=${this.snapshotBroadcastMsMax.toFixed(3)} ` +
            `snapshotLateMs avg=${avgSnapshotLateMs.toFixed(2)} max=${this.snapshotLateMsMax.toFixed(2)} skippedSnapshots=${this.snapshotDeadlineSkipsThisWindow} noNewTickSkips=${this.snapshotNoNewTickSkipsThisWindow} backpressureSkips=${this.snapshotBackpressureSkipsThisWindow} allBackpressureSkips=${this.snapshotAllBackpressureSkipsThisWindow} recoveryHalved=${this.snapshotRecoveryHalvedThisWindow} ` +
            `incoming=${incomingRate.toFixed(1)}/s ` +
            `players total=${playerStates.length} active=${activePlayers} alive=${alivePlayers} eliminated=${eliminatedPlayers} disconnected=${disconnectedPlayers} ` +
            `balls total=${balls.length} active=${activeBalls} live=${liveBalls} settled=${settledBalls} ` +
            `inputDrain={avg=${buffers.inputsDrainedAvg.toFixed(2)} max=${buffers.inputsDrainedMax} maxQueueBefore=${buffers.maxInputQueueBeforeDrain}} ` +
            `buffers={input=${buffers.inputQueues} inputMax=${buffers.maxInputQueue} throw=${buffers.pendingThrowEvents} combat=${buffers.pendingCombatEvents} defenseHist=${buffers.defenseHistoryEntries} ballHist=${buffers.ballHistoryEntries} catch=${buffers.catchAttempts} hit=${buffers.recentHits}} ` +
            `combat={catchTry=${c.catchAttemptsOpened} catch=${c.catches} reclaim=${c.reclaimCatches} parry=${c.parries} hit=${c.hits} revert=${c.hitReverts}} ` +
            `accumulatorCaps=${this.stepCapHitsThisWindow} ` +
            `snapshotBytes activeAvg=${avgPayload} activeMax=${this.snapshotPayloadBytesMax} fullAvg=${avgFullPayload} fullMax=${this.snapshotFullPayloadBytesMax} compactAvg=${avgCompactPayload} compactMax=${this.snapshotCompactPayloadBytesMax} ` +
            `snapshotFrameBytes activeAvg=${avgFrameBytes} activeMax=${this.snapshotFrameBytesMax} fullAvg=${avgFullFrameBytes} fullMax=${this.snapshotFullFrameBytesMax} compactAvg=${avgCompactFrameBytes} compactMax=${this.snapshotCompactFrameBytesMax} estimatedOut=${Math.round(estimatedSnapshotOutBytesPerSec)}B/s ` +
            `snapshotLanePct fast=${lanePct(this.tieredFastLaneSnapshotsThisWindow)} player=${lanePct(this.tieredPlayerLaneSnapshotsThisWindow)} world=${lanePct(this.tieredWorldLaneSnapshotsThisWindow)} ball=${lanePct(this.tieredBallLaneSnapshotsThisWindow)} ` +
            `snapshotLaneBytes fastAvg=${avgFastLaneBytes} fastMax=${this.tieredFastLaneBytesMax} playerAvg=${avgPlayerLaneBytes} playerMax=${this.tieredPlayerLaneBytesMax} worldAvg=${avgWorldLaneBytes} worldMax=${this.tieredWorldLaneBytesMax} ` +
            `wsBuffered avg=${wsBufferedAvg}B max=${wsBufferedMax}B ` +
            `eventLoopMs avg=${eventLoopDelayAvgMs.toFixed(2)} p95=${eventLoopDelayP95Ms.toFixed(2)} max=${eventLoopDelayMaxMs.toFixed(2)} ` +
            `loopWakeMs max=${this.loopWakeDelayMsMax.toFixed(2)} stalls50=${this.loopWakeStallsOver50MsThisWindow} stalls100=${this.loopWakeStallsOver100MsThisWindow} stalls500=${this.loopWakeStallsOver500MsThisWindow} ` +
            `cpu=${cpuPct.toFixed(1)}% ` +
            `mem heapUsed=${mb(mem.heapUsed)}MB heapTotal=${mb(mem.heapTotal)}MB external=${mb(mem.external)}MB rss=${mb(mem.rss)}MB heapGrowth=${mb(heapGrowthBytes)}MB`);
        this.log(`[perf/net] colyseusMaxMessagesPerSecond=${this.maxMessagesPerSecond}/s(per-client inbound)` +
            ` incomingByType={${formatCounterRates(this.incomingMessagesByType, elapsedSeconds)}}` +
            ` incomingByPlayer={${formatCounterRates(this.incomingMessagesByPlayerId, elapsedSeconds, formatPlayerKey)}}` +
            ` tokenRejectsByType={${formatCounterTotals(this.tokenBucketRejectsByType)}}` +
            ` tokenRejectsByPlayer={${formatCounterTotals(this.tokenBucketRejectsByPlayerId, formatPlayerKey)}}` +
            ` handlerRejectsByType={${formatCounterTotals(this.handlerRejectsByType)}}` +
            ` handlerRejectsByPlayer={${formatCounterTotals(this.handlerRejectsByPlayerId, formatPlayerKey)}}`);
        this.log(`[perf/clients] ${formatPerClientPerfLine(playerStates, playerNetStats, this.incomingMessagesByPlayerIdAndType, this.snapshotStatsByPlayerId, elapsedSeconds, avgFrameBytes)}`);
        if (this.debug.SOAK_DEBUG) {
            this.log(`[soak] roomAgeSec=${roomAgeSec.toFixed(1)} ` +
                `accumulators={simMs=${this.simulationAccumulatorMs.toFixed(2)} nextSnapshotInMs=${Math.max(0, this.nextSnapshotDueAtMs - node_perf_hooks_1.performance.now()).toFixed(2)}} ` +
                `queues={inputTotal=${buffers.inputQueues} inputMax=${buffers.maxInputQueue} defenseTotal=${buffers.defenseHistoryEntries} defenseMax=${buffers.maxDefenseHistoryEntries} ballTotal=${buffers.ballHistoryEntries} ballMax=${buffers.maxBallHistoryEntries}} ` +
                `snapshots={lastTickSent=${this.lastSnapshotTickSent} noNewTickSkips=${this.snapshotNoNewTickSkipsThisWindow}} ` +
                `socket={avgBuffered=${socketBuffer.avgBytes} maxBuffered=${socketBuffer.maxBytes}} ` +
                `runtime={clients=${this.clients.length} messageBuckets=${this.buckets.size} listeners=${this.clients.length * 7 + 1}}`);
        }
        this.eventLoopDelay.reset();
    }
    /**
     * Record one snapshot broadcast for the [perf] summary (decoupled from sim ticks in mode B).
     * The payload-size sample uses JSON.stringify, which is expensive — so it runs at most ONCE per
     * report window, and only when PERF_DEBUG is on. Real playtests with PERF_DEBUG off pay nothing.
     */
    recordSnapshot(snapshot, payload, buildMs, broadcastMs, lateMs, sentClients, frameBytesEstimate) {
        this.snapshotsThisWindow += 1;
        this.snapshotClientSendsThisWindow += sentClients;
        if (this.netFlightRecorderEnabled) {
            this.flightRecorderSecond.snapshotsSent += 1;
            if (frameBytesEstimate > 0) {
                this.flightRecorderSecond.snapshotFrameBytesTotal += frameBytesEstimate;
                this.flightRecorderSecond.snapshotFrameBytesMax = Math.max(this.flightRecorderSecond.snapshotFrameBytesMax, frameBytesEstimate);
                this.flightRecorderSecond.snapshotFrameByteSamples += 1;
            }
        }
        this.snapshotBuildMsTotal += buildMs;
        this.snapshotBuildMsMax = Math.max(this.snapshotBuildMsMax, buildMs);
        this.snapshotBroadcastMsTotal += broadcastMs;
        this.snapshotBroadcastMsMax = Math.max(this.snapshotBroadcastMsMax, broadcastMs);
        this.snapshotLateMsTotal += lateMs;
        this.snapshotLateMsMax = Math.max(this.snapshotLateMsMax, lateMs);
        this.recordTieredLanePresence(payload);
        const sampleStride = Math.max(1, Math.floor(this.netTiming.snapshotRate / 4));
        if (this.debug.PERF_DEBUG && this.snapshotPayloadSamples < 8 && this.snapshotsThisWindow % sampleStride === 1) {
            const activeBytes = JSON.stringify(payload).length;
            const fullBytes = JSON.stringify(snapshot).length;
            const compactBytes = netConfig_1.USE_COMPACT_SNAPSHOTS && payload.type === 'snapshot-compact'
                ? activeBytes
                : JSON.stringify((0, snapshotCodec_1.makeCompactSnapshot)(snapshot)).length;
            const activeFrameBytes = encodedRoomMessageBytes('snapshot', payload);
            const fullFrameBytes = encodedRoomMessageBytes('snapshot', snapshot);
            const compactFrameBytes = netConfig_1.USE_COMPACT_SNAPSHOTS && payload.type === 'snapshot-compact'
                ? activeFrameBytes
                : encodedRoomMessageBytes('snapshot', (0, snapshotCodec_1.makeCompactSnapshot)(snapshot));
            this.snapshotPayloadBytesTotal += activeBytes;
            this.snapshotPayloadBytesMax = Math.max(this.snapshotPayloadBytesMax, activeBytes);
            this.snapshotFullPayloadBytesTotal += fullBytes;
            this.snapshotFullPayloadBytesMax = Math.max(this.snapshotFullPayloadBytesMax, fullBytes);
            this.snapshotCompactPayloadBytesTotal += compactBytes;
            this.snapshotCompactPayloadBytesMax = Math.max(this.snapshotCompactPayloadBytesMax, compactBytes);
            this.snapshotFrameBytesTotal += activeFrameBytes;
            this.snapshotFrameBytesMax = Math.max(this.snapshotFrameBytesMax, activeFrameBytes);
            this.snapshotFullFrameBytesTotal += fullFrameBytes;
            this.snapshotFullFrameBytesMax = Math.max(this.snapshotFullFrameBytesMax, fullFrameBytes);
            this.snapshotCompactFrameBytesTotal += compactFrameBytes;
            this.snapshotCompactFrameBytesMax = Math.max(this.snapshotCompactFrameBytesMax, compactFrameBytes);
            this.snapshotPayloadSamples += 1;
            if ((0, snapshotCodec_1.isTieredCompactSnapshot)(payload))
                this.recordTieredLaneByteSample(payload);
        }
    }
    recordLoopWakeDelay(delayMs) {
        this.loopWakeDelayMsMax = Math.max(this.loopWakeDelayMsMax, delayMs);
        if (delayMs > 50)
            this.loopWakeStallsOver50MsThisWindow += 1;
        if (delayMs > 100)
            this.loopWakeStallsOver100MsThisWindow += 1;
        if (delayMs > 500)
            this.loopWakeStallsOver500MsThisWindow += 1;
        this.flightRecorderLoopWakeDelayMsMax = Math.max(this.flightRecorderLoopWakeDelayMsMax, delayMs);
        if (delayMs > 50)
            this.flightRecorderLoopWakeStallsOver50Ms += 1;
        if (delayMs > 100)
            this.flightRecorderLoopWakeStallsOver100Ms += 1;
        if (delayMs > 500)
            this.flightRecorderLoopWakeStallsOver500Ms += 1;
    }
    broadcastStepEvents() {
        const throwEvents = this.game.drainThrowEvents();
        for (const event of throwEvents)
            this.broadcast('throw-event', event);
        const combatEvents = this.game.drainCombatEvents();
        for (const event of combatEvents)
            this.broadcast(event.type, event);
    }
    broadcastBattleMusicSyncIfDirty() {
        const music = this.game.drainBattleMusicSyncDirty();
        if (!music)
            return;
        this.broadcast('music-sync', {
            type: 'music-sync',
            serverTimeMs: Date.now(),
            music
        });
    }
    broadcastDueSnapshot(actualNowMs) {
        if (actualNowMs + 0.001 < this.nextSnapshotDueAtMs)
            return;
        const dueAtMs = this.nextSnapshotDueAtMs;
        const schedule = (0, snapshotScheduler_1.advanceSnapshotDeadline)(dueAtMs, actualNowMs, this.snapshotIntervalMs);
        this.snapshotDeadlineSkipsThisWindow += schedule.skippedIntervals;
        this.nextSnapshotDueAtMs = schedule.nextDueAtMs;
        // Don't queue stale visual duplicates when the sim hasn't advanced since the last send.
        if (this.game.state.tick <= this.lastSnapshotTickSent) {
            this.snapshotNoNewTickSkipsThisWindow += 1;
            return;
        }
        this.broadcastSnapshot(dueAtMs, actualNowMs);
    }
    broadcastSnapshot(dueAtMs, actualNowMs) {
        // Cadence advances on every broadcast attempt (even when no client is sendable) so a client in
        // half-rate recovery can never wedge on a stuck cadence parity.
        const cadence = this.snapshotCadenceCounter;
        this.snapshotCadenceCounter += 1;
        const sendableClients = this.snapshotSendableClients(cadence, actualNowMs);
        if (sendableClients.length === 0)
            return;
        const snapshot = this.game.snapshot();
        const snapshotBuildMs = this.game.getLastSnapshotBuildMs();
        const encodeStartedAt = node_perf_hooks_1.performance.now();
        const payload = this.encodeSnapshot(snapshot, cadence);
        const buildMs = snapshotBuildMs + (node_perf_hooks_1.performance.now() - encodeStartedAt);
        const frameBytesEstimate = this.netFlightRecorderEnabled ? encodedRoomMessageBytes('snapshot', payload) : 0;
        const broadcastStartedAt = node_perf_hooks_1.performance.now();
        for (const client of sendableClients) {
            this.recordSnapshotClientSend(client.sessionId);
            if (this.netFlightRecorderEnabled && frameBytesEstimate > 0) {
                const stats = this.flightRecorderClientSecondStatsForPlayer(client.sessionId);
                stats.outboundBytes += frameBytesEstimate;
                this.flightRecorderSecond.outboundBytes += frameBytesEstimate;
            }
            client.send('snapshot', payload);
        }
        const broadcastMs = node_perf_hooks_1.performance.now() - broadcastStartedAt;
        this.lastSnapshotTickSent = snapshot.tick;
        this.recordSnapshot(snapshot, payload, buildMs, broadcastMs, Math.max(0, actualNowMs - dueAtMs), sendableClients.length, frameBytesEstimate);
    }
    snapshotSendableClients(cadence, nowMs) {
        const sendable = [];
        let skipped = 0;
        for (const client of this.clients) {
            const buffered = readClientBufferedAmount(client);
            if (buffered !== null)
                this.recordSnapshotBufferedAmount(client.sessionId, buffered);
            this.recordObservedColyseusMessageRate(client);
            if (buffered !== null && buffered > netConfig_1.SNAPSHOT_BACKPRESSURE_BYTES) {
                skipped += 1;
                // Congested: skip as before, and arm the half-rate recovery ramp for when the buffer drains.
                this.snapshotRecoveryUntilMsByClient.set(client.sessionId, nowMs + netConfig_1.SNAPSHOT_RECOVERY_HALF_RATE_MS);
                this.recordSnapshotClientSkip(client.sessionId);
                continue;
            }
            const recoveryUntilMs = this.snapshotRecoveryUntilMsByClient.get(client.sessionId);
            if (recoveryUntilMs !== undefined) {
                if (nowMs >= recoveryUntilMs) {
                    this.snapshotRecoveryUntilMsByClient.delete(client.sessionId);
                }
                else if (cadence % 2 === 1) {
                    // Recovery ramp: send only even cadences (the ones that carry the tiered player lane), so
                    // the recovering client gets a steady half-rate stream instead of a full-rate re-flood.
                    this.snapshotRecoveryHalvedThisWindow += 1;
                    continue;
                }
            }
            sendable.push(client);
        }
        if (skipped > 0) {
            this.snapshotBackpressureSkipsThisWindow += skipped;
            if (skipped === this.clients.length)
                this.snapshotAllBackpressureSkipsThisWindow += 1;
        }
        return sendable;
    }
    encodeSnapshot(snapshot, cadence) {
        if (!netConfig_1.USE_TIERED_SNAPSHOTS)
            return netConfig_1.USE_COMPACT_SNAPSHOTS ? (0, snapshotCodec_1.makeCompactSnapshot)(snapshot) : snapshot;
        const resetSerial = snapshot.room.resetVote.resetSerial;
        const resetChanged = resetSerial !== this.lastTieredResetSerial;
        if (resetChanged) {
            this.forceNextTieredFullSnapshot = true;
            this.lastTieredResetSerial = resetSerial;
        }
        const worldDirtyKey = this.tieredWorldDirtyKey(snapshot);
        const playerDirtyKey = this.tieredPlayerDirtyKey(snapshot);
        const worldDirty = worldDirtyKey !== this.lastTieredWorldDirtyKey;
        const playerDirty = playerDirtyKey !== this.lastTieredPlayerDirtyKey;
        const forceFull = this.forceNextTieredFullSnapshot;
        const includePlayerLane = forceFull || playerDirty || cadence % 2 === 0;
        const includeWorldLane = forceFull || worldDirty || cadence % 4 === 0;
        const payload = (0, snapshotCodec_1.makeTieredCompactSnapshot)(snapshot, {
            includePlayerLane,
            includeWorldLane,
            includeFastPlayerLane: !includePlayerLane,
            includeBallLane: true
        });
        if (includeWorldLane)
            this.lastTieredWorldDirtyKey = worldDirtyKey;
        if (includePlayerLane)
            this.lastTieredPlayerDirtyKey = playerDirtyKey;
        this.forceNextTieredFullSnapshot = false;
        return payload;
    }
    markTieredFullSnapshotDirty() {
        this.forceNextTieredFullSnapshot = true;
    }
    tieredWorldDirtyKey(snapshot) {
        const room = snapshot.room;
        const match = room.match;
        const boundary = match.boundary;
        const settings = room.settings;
        const resetVote = room.resetVote;
        const startVote = room.startVote;
        const endVote = room.endVote;
        const intermissionVote = room.intermissionVote;
        const score = stableNumberRecord(match.scoreByTeamId);
        const rounds = stableNumberRecord(match.roundsWonByTeamId);
        const mats = Object.values(room.mats)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((mat) => `${mat.id}:${Number(mat.knockedOver)}:${mat.knockDirection.x.toFixed(2)},${mat.knockDirection.z.toFixed(2)}`)
            .join(',');
        const boundaryEvent = boundary.lastEvent;
        const boundaryEventKey = boundaryEvent.type === 'none'
            ? 'none'
            : Object.values(boundaryEvent).join(':');
        return [
            room.hostPlayerId ?? '',
            room.phase,
            settings.preset,
            settings.format,
            settings.livesPerPlayer,
            settings.dodgeballCount,
            settings.maxLiveBallBounces,
            settings.matPreset,
            settings.roundCount,
            settings.halfCourtTimerSeconds,
            match.mode,
            match.status,
            match.winnerTeamId ?? '',
            match.currentRound,
            match.roundCount,
            score,
            rounds,
            Number(boundary.noBoundaries),
            boundaryEventKey,
            resetVote.resetSerial,
            resetVote.voteCount,
            resetVote.requiredVotes,
            resetVote.mode,
            startVote.voteCount,
            startVote.requiredVotes,
            startVote.teamChoiceCount,
            startVote.requiredTeamChoices,
            Number(endVote.active),
            endVote.voteCount,
            endVote.requiredVotes,
            Number(intermissionVote.active),
            intermissionVote.nextRoundCount,
            intermissionVote.toLobbyCount,
            intermissionVote.requiredVotes,
            mats
        ].join('|');
    }
    tieredPlayerDirtyKey(snapshot) {
        return Object.values(snapshot.room.players)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((player) => {
            const left = player.hands.left;
            const right = player.hands.right;
            return [
                player.id,
                player.teamId,
                player.spawnSide,
                player.teamSlotIndex,
                player.legalHalf,
                Number(player.connected),
                player.lives,
                player.combatState,
                left.heldBallId ?? '',
                left.mode,
                left.lastCatchAttemptId,
                right.heldBallId ?? '',
                right.mode,
                right.lastCatchAttemptId
            ].join(':');
        })
            .join('|');
    }
    recordTieredLanePresence(payload) {
        if (!(0, snapshotCodec_1.isTieredCompactSnapshot)(payload))
            return;
        this.tieredFastLaneSnapshotsThisWindow += 1;
        if ((payload.l & snapshotCodec_1.TIERED_SNAPSHOT_LANES.PLAYER) !== 0)
            this.tieredPlayerLaneSnapshotsThisWindow += 1;
        if ((payload.l & snapshotCodec_1.TIERED_SNAPSHOT_LANES.WORLD) !== 0)
            this.tieredWorldLaneSnapshotsThisWindow += 1;
        if ((payload.l & snapshotCodec_1.TIERED_SNAPSHOT_LANES.BALL) !== 0)
            this.tieredBallLaneSnapshotsThisWindow += 1;
    }
    recordTieredLaneByteSample(payload) {
        const fastBytes = JSON.stringify({
            rs: payload.rs,
            f: payload.f,
            b: payload.b
        }).length;
        const playerBytes = payload.p ? JSON.stringify(payload.p).length : 0;
        const worldBytes = payload.w ? JSON.stringify(payload.w).length : 0;
        this.tieredFastLaneBytesTotal += fastBytes;
        this.tieredFastLaneBytesMax = Math.max(this.tieredFastLaneBytesMax, fastBytes);
        this.tieredPlayerLaneBytesTotal += playerBytes;
        this.tieredPlayerLaneBytesMax = Math.max(this.tieredPlayerLaneBytesMax, playerBytes);
        this.tieredWorldLaneBytesTotal += worldBytes;
        this.tieredWorldLaneBytesMax = Math.max(this.tieredWorldLaneBytesMax, worldBytes);
        this.tieredLaneByteSamples += 1;
    }
    recordSnapshotBufferedAmount(playerId, buffered) {
        this.snapshotWsBufferedBytesTotal += buffered;
        this.snapshotWsBufferedBytesMax = Math.max(this.snapshotWsBufferedBytesMax, buffered);
        this.snapshotWsBufferedSamples += 1;
        const stats = this.snapshotStatsForPlayer(playerId);
        stats.wsBufferedBytesTotal += buffered;
        stats.wsBufferedBytesMax = Math.max(stats.wsBufferedBytesMax, buffered);
        stats.wsBufferedSamples += 1;
        if (!this.netFlightRecorderEnabled)
            return;
        this.flightRecorderClientSecondStatsForPlayer(playerId).wsBufferedBytesMax = Math.max(this.flightRecorderClientSecondStatsForPlayer(playerId).wsBufferedBytesMax, buffered);
    }
    sendNetFlightRecorderConfig(client) {
        const message = {
            type: 'net-flight-recorder-config',
            enabled: this.netFlightRecorderEnabled,
            sampleIntervalMs: netFlightRecorder_1.NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS,
            durationSeconds: netFlightRecorder_1.NET_FLIGHT_RECORDER_DURATION_SECONDS,
            reportSampleCount: netFlightRecorder_1.NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT
        };
        client.send('net-flight-recorder-config', message);
    }
    flightRecorderClientSecondStatsForPlayer(playerId) {
        let stats = this.flightRecorderClientSecondStats.get(playerId);
        if (!stats) {
            stats = { inputMessages: 0, snapshotSends: 0, outboundBytes: 0, wsBufferedBytesMax: 0 };
            this.flightRecorderClientSecondStats.set(playerId, stats);
        }
        return stats;
    }
    maybeRecordFlightSample() {
        if (!this.netFlightRecorderEnabled)
            return;
        const nowMs = Date.now();
        if (this.flightRecorderNextSampleAtMs === 0)
            this.flightRecorderNextSampleAtMs = nowMs + netFlightRecorder_1.NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS;
        if (nowMs < this.flightRecorderNextSampleAtMs)
            return;
        this.flightRecorderNextSampleAtMs += netFlightRecorder_1.NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS;
        const elapsedMicros = Number(process.hrtime.bigint() / 1000n);
        const cpu = process.cpuUsage(this.lastCpuUsage);
        const cpuElapsedMicros = Math.max(1, elapsedMicros - this.lastCpuSampleMicros);
        this.lastCpuSampleMicros = elapsedMicros;
        this.lastCpuUsage = process.cpuUsage();
        const cpuPct = ((cpu.user + cpu.system) / cpuElapsedMicros) * 100;
        const mem = process.memoryUsage();
        const heapGrowthBytes = mem.heapUsed - this.lastHeapUsedBytes;
        this.lastHeapUsedBytes = mem.heapUsed;
        const playerStats = this.game.getPlayerNetworkStats(nowMs);
        const playerStatsById = new Map(playerStats.map((entry) => [entry.playerId, entry]));
        const room = this.game.snapshot().room;
        const connectedPlayers = Object.values(room.players).filter((player) => player.connected);
        const eventLoopAvgMs = nsToMs(this.flightRecorderEventLoopDelay.mean);
        const eventLoopP95Ms = nsToMs(this.flightRecorderEventLoopDelay.percentile(95));
        const eventLoopMaxMs = nsToMs(this.flightRecorderEventLoopDelay.max);
        const sampleClients = connectedPlayers.map((player) => {
            const stats = playerStatsById.get(player.id);
            const second = this.flightRecorderClientSecondStats.get(player.id);
            const buffered = this.readRoomClientBufferedAmount(player.id);
            return {
                client: (0, netFlightRecorder_1.shortSessionId)(player.id),
                inputAgeMs: Math.round(stats?.lastInputAgeMs ?? 0),
                inputMessages: second?.inputMessages ?? 0,
                duplicateOrOutOfOrderInputs: stats?.duplicateOrOutOfOrderInputs ?? 0,
                staleResetInputs: stats?.staleResetInputs ?? 0,
                inputQueueDepth: stats?.inputQueueDepthCurrent ?? 0,
                inputQueueDepthMax: stats?.inputQueueDepthMax ?? 0,
                lastProcessedSeq: stats?.lastProcessedInputSeq ?? 0,
                lastEnqueuedSeq: stats?.lastEnqueuedInputSeq ?? 0,
                wsBufferedBytes: buffered,
                wsBufferedMaxBytes: second?.wsBufferedBytesMax ?? 0,
                estimatedSnapshotsSent: second?.snapshotSends ?? 0,
                estimatedOutboundBytes: second?.outboundBytes ?? 0,
                connectionState: player.connected ? 'connected' : 'disconnected'
            };
        });
        const sample = {
            atMs: nowMs,
            room: (0, netFlightRecorder_1.shortSessionId)(this.roomId),
            activePlayers: connectedPlayers.length,
            simTargetHz: this.netTiming.serverTickRate,
            simSteps: this.flightRecorderSecond.simSteps,
            snapshotsSent: this.flightRecorderSecond.snapshotsSent,
            snapshotsSkipped: this.flightRecorderSecond.snapshotsSkipped,
            outboundBytesPerSec: this.flightRecorderSecond.outboundBytes,
            snapshotFrameBytesAvg: this.flightRecorderSecond.snapshotFrameByteSamples > 0
                ? Math.round(this.flightRecorderSecond.snapshotFrameBytesTotal / this.flightRecorderSecond.snapshotFrameByteSamples)
                : 0,
            snapshotFrameBytesMax: this.flightRecorderSecond.snapshotFrameBytesMax,
            inputMessages: this.flightRecorderSecond.inputMessages,
            cpuPct: Number(cpuPct.toFixed(1)),
            heapUsedBytes: mem.heapUsed,
            heapGrowthBytes,
            rssBytes: mem.rss,
            externalBytes: mem.external,
            eventLoopAvgMs,
            eventLoopP95Ms,
            eventLoopMaxMs,
            loopWakeMaxMs: Number(this.flightRecorderLoopWakeDelayMsMax.toFixed(2)),
            loopWakeOver50Ms: this.flightRecorderLoopWakeStallsOver50Ms,
            loopWakeOver100Ms: this.flightRecorderLoopWakeStallsOver100Ms,
            loopWakeOver500Ms: this.flightRecorderLoopWakeStallsOver500Ms,
            clients: sampleClients
        };
        this.flightRecorderSamples.push(sample);
        this.maybeLogServerAnomaly(sample);
        this.flightRecorderSecond = createFlightRecorderSecondAccumulator(nowMs);
        this.flightRecorderClientSecondStats.clear();
        this.flightRecorderLoopWakeDelayMsMax = 0;
        this.flightRecorderLoopWakeStallsOver50Ms = 0;
        this.flightRecorderLoopWakeStallsOver100Ms = 0;
        this.flightRecorderLoopWakeStallsOver500Ms = 0;
        this.flightRecorderEventLoopDelay.reset();
    }
    maybeLogServerAnomaly(sample) {
        const nowMs = sample.atMs;
        const severe = sample.eventLoopMaxMs >= netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_SEVERE_THRESHOLD_MS;
        const shouldLog = severe
            || sample.eventLoopMaxMs >= netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS
            || sample.loopWakeMaxMs >= netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS
            || sample.cpuPct >= netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_CPU_THRESHOLD_PCT
            || sample.heapGrowthBytes >= netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_HEAP_GROWTH_THRESHOLD_BYTES
            || sample.clients.some((client) => (client.wsBufferedMaxBytes >= netFlightRecorder_1.NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES) ||
                (client.inputAgeMs >= netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_INPUT_AGE_THRESHOLD_MS) ||
                (client.inputQueueDepthMax >= netFlightRecorder_1.NET_FLIGHT_RECORDER_PENDING_INPUT_THRESHOLD))
            || sample.snapshotsSent < Math.floor(this.netTiming.snapshotRate * netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_SNAPSHOT_RATE_FLOOR_RATIO);
        if (!shouldLog)
            return;
        if (!severe && nowMs - this.lastFlightRecorderAnomalyAtMs < netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_COOLDOWN_MS)
            return;
        this.lastFlightRecorderAnomalyAtMs = nowMs;
        const recentServerSamples = this.flightRecorderSamples.toArray().slice(-netFlightRecorder_1.NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT);
        const classification = (0, netFlightRecorder_1.classifyNetAnomaly)({
            trigger: { kind: 'server_anomaly' },
            server: sample,
            affectedClientCount: sample.clients.filter((client) => client.inputAgeMs >= netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_INPUT_AGE_THRESHOLD_MS || client.wsBufferedMaxBytes >= netFlightRecorder_1.NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES).length
        });
        this.logNetAnomaly({
            kind: 'server_anomaly',
            receivedAtServerMs: nowMs,
            clientEventAtMs: null,
            room: (0, netFlightRecorder_1.shortSessionId)(this.roomId),
            client: null,
            trigger: {
                eventLoopMaxMs: sample.eventLoopMaxMs,
                loopWakeMaxMs: sample.loopWakeMaxMs,
                cpuPct: sample.cpuPct
            },
            serverContext: summarizeServerSample(sample),
            recentServerSamples,
            recentClientSamples: [],
            initialClassification: classification
        });
    }
    handleClientAnomalyReport(client, report) {
        const room = (0, netFlightRecorder_1.shortSessionId)(this.roomId);
        const clientId = (0, netFlightRecorder_1.shortSessionId)(client.sessionId);
        const recentServerSamples = this.flightRecorderSamples.toArray().slice(-netFlightRecorder_1.NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT);
        const latestServerSample = recentServerSamples[recentServerSamples.length - 1] ?? null;
        const latestClientSample = report.recentClientSamples[report.recentClientSamples.length - 1] ?? null;
        const classification = (0, netFlightRecorder_1.classifyNetAnomaly)({
            trigger: report.trigger,
            server: latestServerSample,
            clientSample: latestClientSample,
            affectedClientCount: latestServerSample?.clients.filter((entry) => entry.inputAgeMs >= netFlightRecorder_1.NET_FLIGHT_RECORDER_SERVER_INPUT_AGE_THRESHOLD_MS || entry.wsBufferedMaxBytes >= netFlightRecorder_1.NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES).length ?? 0
        });
        this.logNetAnomaly({
            kind: report.trigger.kind,
            receivedAtServerMs: Date.now(),
            clientEventAtMs: report.clientEventAtMs,
            room,
            client: clientId,
            trigger: report.trigger,
            serverContext: latestServerSample ? summarizeServerSample(latestServerSample) : null,
            recentServerSamples,
            recentClientSamples: trimJsonBytes(report.recentClientSamples, netFlightRecorder_1.NET_FLIGHT_RECORDER_MAX_REPORT_BYTES / 2),
            initialClassification: classification,
            lastSnapshotTick: report.lastSnapshotTick,
            lastAckedInputSeq: report.lastAckedInputSeq
        });
    }
    reportServerConnectionEvent(kind, sessionId) {
        if (!this.netFlightRecorderEnabled)
            return;
        if (this.game.state.match.status !== 'playing')
            return;
        const eventKey = `${kind}:${sessionId}:${this.game.state.match.status}`;
        if (eventKey === this.lastLoggedDisconnectEventKey)
            return;
        this.lastLoggedDisconnectEventKey = eventKey;
        const recentServerSamples = this.flightRecorderSamples.toArray().slice(-netFlightRecorder_1.NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT);
        this.logNetAnomaly({
            kind,
            receivedAtServerMs: Date.now(),
            clientEventAtMs: null,
            room: (0, netFlightRecorder_1.shortSessionId)(this.roomId),
            client: (0, netFlightRecorder_1.shortSessionId)(sessionId),
            trigger: { kind },
            serverContext: recentServerSamples[recentServerSamples.length - 1] ? summarizeServerSample(recentServerSamples[recentServerSamples.length - 1]) : null,
            recentServerSamples,
            recentClientSamples: [],
            initialClassification: 'likely_connection_reconnect_issue'
        });
    }
    readRoomClientBufferedAmount(playerId) {
        const client = this.clients.find((entry) => entry.sessionId === playerId);
        return client ? readClientBufferedAmount(client) : null;
    }
    logNetAnomaly(payload) {
        const compact = trimJsonBytes(payload, netFlightRecorder_1.NET_FLIGHT_RECORDER_MAX_REPORT_BYTES);
        console.log(`[net/anomaly] ${JSON.stringify(compact)}`);
    }
    broadcastRosterUpdate() {
        this.broadcast('roster-update', {
            type: 'roster-update',
            roster: (0, snapshotCodec_1.rosterFromRoom)(this.game.state)
        });
    }
    sendBattleMusicSync(client) {
        const payload = {
            type: 'music-sync',
            serverTimeMs: Date.now(),
            music: this.game.getBattleMusicSyncState()
        };
        client.send('music-sync', payload);
    }
    socketBufferStats() {
        if (this.clients.length === 0)
            return { avgBytes: 0, maxBytes: 0 };
        let total = 0;
        let samples = 0;
        let maxBytes = 0;
        for (const client of this.clients) {
            const buffered = readClientBufferedAmount(client);
            if (buffered === null)
                continue;
            total += buffered;
            samples += 1;
            maxBytes = Math.max(maxBytes, buffered);
        }
        return {
            avgBytes: samples > 0 ? Math.round(total / samples) : 0,
            maxBytes
        };
    }
    recordIncomingMessage(client, type) {
        this.incomingMessagesThisWindow += 1;
        incrementCounter(this.incomingMessagesByType, type);
        incrementCounter(this.incomingMessagesByPlayerId, client.sessionId);
        incrementNestedCounter(this.incomingMessagesByPlayerIdAndType, client.sessionId, type);
        if (this.netFlightRecorderEnabled && type === 'input') {
            this.flightRecorderSecond.inputMessages += 1;
            this.flightRecorderClientSecondStatsForPlayer(client.sessionId).inputMessages += 1;
        }
        this.recordObservedColyseusMessageRate(client);
    }
    recordObservedColyseusMessageRate(client) {
        const seen = readClientMessagesLastSecond(client);
        if (seen === null)
            return;
        const stats = this.snapshotStatsForPlayer(client.sessionId);
        stats.colyseusMessagesPerSecondMax = Math.max(stats.colyseusMessagesPerSecondMax, seen);
    }
    snapshotStatsForPlayer(playerId) {
        let stats = this.snapshotStatsByPlayerId.get(playerId);
        if (!stats) {
            stats = {
                snapshotSends: 0,
                snapshotSkips: 0,
                wsBufferedBytesTotal: 0,
                wsBufferedBytesMax: 0,
                wsBufferedSamples: 0,
                colyseusMessagesPerSecondMax: 0
            };
            this.snapshotStatsByPlayerId.set(playerId, stats);
        }
        return stats;
    }
    recordSnapshotClientSend(playerId) {
        this.snapshotStatsForPlayer(playerId).snapshotSends += 1;
        if (!this.netFlightRecorderEnabled)
            return;
        const stats = this.flightRecorderClientSecondStatsForPlayer(playerId);
        stats.snapshotSends += 1;
    }
    recordSnapshotClientSkip(playerId) {
        this.snapshotStatsForPlayer(playerId).snapshotSkips += 1;
        if (this.netFlightRecorderEnabled)
            this.flightRecorderSecond.snapshotsSkipped += 1;
    }
    /** Token-bucket rate limit per client per message type (#11). Returns false if over limit. */
    allow(client, type) {
        const limit = this.rateLimits[type];
        if (!limit)
            return true;
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
            incrementCounter(this.tokenBucketRejectsByType, type);
            incrementCounter(this.tokenBucketRejectsByPlayerId, client.sessionId);
            return false;
        }
        bucket.tokens -= 1;
        perClient.set(type, bucket);
        return true;
    }
    reject(client, request, reason) {
        incrementCounter(this.handlerRejectsByType, request);
        incrementCounter(this.handlerRejectsByPlayerId, client.sessionId);
        client.send('request-rejected', { type: 'request-rejected', request, reason });
    }
    log(message) {
        console.log(`[duel ${this.roomId}] ${message}`);
    }
}
exports.DuelRoom = DuelRoom;
class FixedRingBuffer {
    capacity;
    items;
    nextIndex = 0;
    count = 0;
    constructor(capacity) {
        this.capacity = capacity;
        this.items = new Array(capacity);
    }
    push(value) {
        this.items[this.nextIndex] = value;
        this.nextIndex = (this.nextIndex + 1) % this.capacity;
        this.count = Math.min(this.capacity, this.count + 1);
    }
    toArray() {
        const result = [];
        for (let i = 0; i < this.count; i += 1) {
            const index = (this.nextIndex - this.count + i + this.capacity) % this.capacity;
            const item = this.items[index];
            if (item !== undefined)
                result.push(item);
        }
        return result;
    }
}
function createFlightRecorderSecondAccumulator(startedAtMs = Date.now()) {
    return {
        startedAtMs,
        simSteps: 0,
        snapshotsSent: 0,
        snapshotsSkipped: 0,
        outboundBytes: 0,
        snapshotFrameBytesTotal: 0,
        snapshotFrameBytesMax: 0,
        snapshotFrameByteSamples: 0,
        inputMessages: 0
    };
}
function nsToMs(value) {
    return Number((value / 1_000_000).toFixed(2));
}
function summarizeServerSample(sample) {
    return {
        eventLoopP95Ms: sample.eventLoopP95Ms,
        eventLoopMaxMs: sample.eventLoopMaxMs,
        loopWakeMaxMs: sample.loopWakeMaxMs,
        cpuPct: sample.cpuPct,
        snapshotRate: sample.snapshotsSent,
        outboundBytesPerSec: sample.outboundBytesPerSec,
        clientWsBufferedBytes: Math.max(0, ...sample.clients.map((client) => client.wsBufferedMaxBytes))
    };
}
function trimJsonBytes(value, maxBytes) {
    const json = JSON.stringify(value);
    if (json.length <= maxBytes)
        return value;
    if (Array.isArray(value)) {
        return value.slice(Math.max(0, value.length - Math.floor(value.length / 2)));
    }
    if (value && typeof value === 'object') {
        const clone = { ...value };
        if (Array.isArray(clone.recentServerSamples))
            clone.recentServerSamples = clone.recentServerSamples.slice(-12);
        if (Array.isArray(clone.recentClientSamples))
            clone.recentClientSamples = clone.recentClientSamples.slice(-12);
        return clone;
    }
    return value;
}
function formatPatchRate(patchRateMs) {
    return patchRateMs === null ? 'disabled(manual snapshots)' : `${(1000 / patchRateMs).toFixed(1)}Hz`;
}
function inputPayloadFromCommand(command) {
    const raw = command.input;
    if (!raw)
        return raw;
    const input = { ...raw };
    if (typeof command.clientTimeMs === 'number' && Number.isFinite(command.clientTimeMs)) {
        input.clientTimeMs = command.clientTimeMs;
    }
    if (typeof command.sequence === 'number' && Number.isFinite(command.sequence)) {
        input.sequence = command.sequence;
    }
    return input;
}
function readClientBufferedAmount(client) {
    const raw = client;
    if (typeof raw.ref?.bufferedAmount === 'number')
        return raw.ref.bufferedAmount;
    if (typeof raw.ref?.ws?.bufferedAmount === 'number')
        return raw.ref.ws.bufferedAmount;
    const directAmount = raw.ref?.getBufferedAmount?.();
    if (typeof directAmount === 'number')
        return directAmount;
    const uwsAmount = raw.ref?.ws?.getBufferedAmount?.();
    return typeof uwsAmount === 'number' ? uwsAmount : null;
}
function readClientMessagesLastSecond(client) {
    const raw = client;
    return typeof raw._numMessagesLastSecond === 'number' ? raw._numMessagesLastSecond : null;
}
function encodedRoomMessageBytes(type, message) {
    return colyseus_1.getMessageBytes.raw(colyseus_1.Protocol.ROOM_DATA, type, message).byteLength;
}
function incrementCounter(map, key, delta = 1) {
    map.set(key, (map.get(key) ?? 0) + delta);
}
function incrementNestedCounter(parent, outerKey, innerKey, delta = 1) {
    let map = parent.get(outerKey);
    if (!map) {
        map = new Map();
        parent.set(outerKey, map);
    }
    incrementCounter(map, innerKey, delta);
}
function formatPlayerKey(playerId) {
    return playerId.slice(-4);
}
function formatCounterRates(map, elapsedSeconds, keyFormatter = identity) {
    if (map.size === 0)
        return 'none';
    return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => `${keyFormatter(key)}:${(count / elapsedSeconds).toFixed(1)}/s`)
        .join(',');
}
function formatCounterTotals(map, keyFormatter = identity) {
    if (map.size === 0)
        return 'none';
    return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => `${keyFormatter(key)}:${count}`)
        .join(',');
}
function formatPerClientPerfLine(players, playerNetStats, incomingByPlayerIdAndType, snapshotStatsByPlayerId, elapsedSeconds, avgSnapshotFrameBytes) {
    if (players.length === 0)
        return 'none';
    const playerNetById = new Map(playerNetStats.map((stats) => [stats.playerId, stats]));
    return players
        .map((player) => {
        const playerId = player.id;
        const key = formatPlayerKey(playerId);
        const incomingByType = incomingByPlayerIdAndType.get(playerId) ?? new Map();
        const snapshots = snapshotStatsByPlayerId.get(playerId);
        const net = playerNetById.get(playerId);
        const inputRate = (incomingByType.get('input') ?? 0) / elapsedSeconds;
        const pingRate = (incomingByType.get('ping') ?? 0) / elapsedSeconds;
        const snapshotRate = snapshots ? snapshots.snapshotSends / elapsedSeconds : 0;
        const snapshotSkipRate = snapshots ? snapshots.snapshotSkips / elapsedSeconds : 0;
        const snapshotBytesPerSecond = Math.round(snapshotRate * avgSnapshotFrameBytes);
        const wsBufferedAvg = snapshots && snapshots.wsBufferedSamples > 0
            ? Math.round(snapshots.wsBufferedBytesTotal / snapshots.wsBufferedSamples)
            : 0;
        const wsBufferedMax = snapshots?.wsBufferedBytesMax ?? 0;
        return (`${key}{input=${inputRate.toFixed(1)}/s ping=${pingRate.toFixed(1)}/s ` +
            `q=${(net?.inputQueueDepthAvg ?? 0).toFixed(2)}/${net?.inputQueueDepthMax ?? 0} cur=${net?.inputQueueDepthCurrent ?? 0} ` +
            `drain=${(net?.inputsDrainedAvg ?? 0).toFixed(2)}/${net?.inputsDrainedMax ?? 0} ` +
            `seq=${net?.lastProcessedInputSeq ?? 0}/${net?.lastEnqueuedInputSeq ?? 0} dup=${net?.duplicateOrOutOfOrderInputs ?? 0} staleReset=${net?.staleResetInputs ?? 0} ` +
            `ackAgeEst=${formatNullableMs(net?.ackAgeEstimateMs ?? null)} inputAge=${Math.round(net?.lastInputAgeMs ?? 0)}ms ` +
            `snap=${snapshotRate.toFixed(1)}/s skip=${snapshotSkipRate.toFixed(1)}/s ` +
            `snapBytes~=${snapshotBytesPerSecond}B/s ws=${wsBufferedAvg}/${wsBufferedMax}B colyseusSeenMax=${snapshots?.colyseusMessagesPerSecondMax ?? 0}/s}`);
    })
        .join(' ');
}
function formatNullableMs(value) {
    return value === null ? 'n/a' : `${Math.round(value)}ms`;
}
function stableNumberRecord(record) {
    return Object.entries(record)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}:${value}`)
        .join(',');
}
function identity(value) {
    return value;
}
