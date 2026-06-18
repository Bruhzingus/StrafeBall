import { performance } from 'node:perf_hooks';
import {
  CLIENT_INPUT_RATE,
  SERVER_TICK_RATE,
  SNAPSHOT_RATE,
  USE_COMPACT_SNAPSHOTS
} from '../../shared/netConfig';
import { makeCompactSnapshot } from '../../shared/snapshotCodec';
import type { PlayerInput } from '../../shared/types';
import { buildInboundRateLimits, computeMaxMessagesPerSecondPerClient, expectedPerClientMessagesPerSecond } from '../src/network/NetworkRateLimits';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

function createNeutralInput(sequence: number, tick: number, lane: number): PlayerInput {
  return {
    sequence,
    clientTimeMs: tick * (1000 / SERVER_TICK_RATE),
    moveX: lane % 2 === 0 ? 0.35 : -0.35,
    moveZ: lane < 2 ? 1 : -1,
    dashDirection: { x: 0, y: 0, z: 0 },
    lookYawRadians: lane < 2 ? 0 : Math.PI,
    lookPitchRadians: lane % 2 === 0 ? -0.08 : 0.08,
    jumpPressed: false,
    jumpHeld: false,
    dashPressed: false,
    crouchPressed: false,
    crouchHeld: false,
    slidePressed: false,
    slideHeld: false,
    backflipPressed: false,
    pickupPressed: false,
    dropPressed: false,
    fakeThrowPressed: false,
    fakeThrowHeld: false,
    leftHandPressed: false,
    leftHandHeld: false,
    rightHandPressed: false,
    rightHandHeld: false,
    leftHandReleased: false,
    rightHandReleased: false,
    leftCatchAttemptId: 0,
    rightCatchAttemptId: 0,
    backflipThrowTier: 0,
    resetSerial: 0
  };
}

function consume(bucket: TokenBucket, tokens: number, capacity: number, refillPerSecond: number, nowMs: number): boolean {
  const elapsedSeconds = Math.max(0, nowMs - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
  bucket.lastRefillMs = nowMs;
  if (bucket.tokens < tokens) return false;
  bucket.tokens -= tokens;
  return true;
}

function runScenario(playerCount: number, durationSeconds = 5): void {
  const playerIds = ['a', 'b', 'c', 'd'].slice(0, playerCount);
  const loop = new ServerGameLoop(`network-harness-${playerCount}`, {
    mode: playerCount > 2 ? '2v2' : '1v1',
    playersPerTeam: playerCount > 2 ? 2 : 1
  });
  for (const playerId of playerIds) loop.addPlayer(playerId, playerId.toUpperCase());

  const inputLimit = buildInboundRateLimits(CLIENT_INPUT_RATE).input;
  const perClientCap = computeMaxMessagesPerSecondPerClient(CLIENT_INPUT_RATE);
  const perClientExpected = expectedPerClientMessagesPerSecond(CLIENT_INPUT_RATE);
  const buckets = new Map(
    playerIds.map((playerId) => [
      playerId,
      { tokens: inputLimit.capacity, lastRefillMs: 0 } satisfies TokenBucket
    ])
  );
  const inputSeqByPlayerId = new Map(playerIds.map((playerId) => [playerId, 0]));
  const perSecondMessageCounts = new Map(playerIds.map((playerId) => [playerId, 0]));
  let currentSecond = 0;
  let maxPerClientMessagesSeen = 0;
  let tokenBucketRejects = 0;
  let snapshotBuildMsTotal = 0;
  let snapshotBuildMsMax = 0;
  let fullSnapshotBytesTotal = 0;
  let compactSnapshotBytesTotal = 0;
  let snapshotSamples = 0;
  let tickCostMsTotal = 0;
  let tickCostMsMax = 0;
  let maxInputQueueDepth = 0;
  let roomIncomingMessagesTotal = 0;

  const totalTicks = Math.ceil(durationSeconds * SERVER_TICK_RATE);
  const snapshotEveryTicks = Math.max(1, Math.round(SERVER_TICK_RATE / SNAPSHOT_RATE));

  for (let tick = 0; tick < totalTicks; tick += 1) {
    const nowMs = tick * (1000 / SERVER_TICK_RATE);
    const second = Math.floor(nowMs / 1000);
    if (second !== currentSecond) {
      for (const count of perSecondMessageCounts.values()) maxPerClientMessagesSeen = Math.max(maxPerClientMessagesSeen, count);
      perSecondMessageCounts.clear();
      for (const playerId of playerIds) perSecondMessageCounts.set(playerId, 0);
      currentSecond = second;
    }

    for (let i = 0; i < playerIds.length; i += 1) {
      const playerId = playerIds[i];
      const sequence = (inputSeqByPlayerId.get(playerId) ?? 0) + 1;
      inputSeqByPlayerId.set(playerId, sequence);
      const input = createNeutralInput(sequence, tick, i);
      const bucket = buckets.get(playerId)!;
      if (!consume(bucket, 1, inputLimit.capacity, inputLimit.refillPerSecond, nowMs)) {
        tokenBucketRejects += 1;
      } else {
        loop.handleInput(playerId, input, sequence, 60);
      }
      perSecondMessageCounts.set(playerId, (perSecondMessageCounts.get(playerId) ?? 0) + 1);
      roomIncomingMessagesTotal += 1;

      // Simulate occasional ping and action packets so the observed load is not input-only.
      if (tick > 0 && tick % (SERVER_TICK_RATE * 2) === i % Math.max(1, playerIds.length)) {
        perSecondMessageCounts.set(playerId, (perSecondMessageCounts.get(playerId) ?? 0) + 1);
        roomIncomingMessagesTotal += 1;
      }
      if (tick > 0 && tick % Math.max(8, Math.round(SERVER_TICK_RATE / 3)) === i % Math.max(1, playerIds.length)) {
        perSecondMessageCounts.set(playerId, (perSecondMessageCounts.get(playerId) ?? 0) + 1);
        roomIncomingMessagesTotal += 1;
      }
    }

    const tickStartedAt = performance.now();
    loop.advance();
    const tickCostMs = performance.now() - tickStartedAt;
    tickCostMsTotal += tickCostMs;
    tickCostMsMax = Math.max(tickCostMsMax, tickCostMs);
    maxInputQueueDepth = Math.max(maxInputQueueDepth, loop.getDebugBufferStats().maxInputQueue);

    if (tick % snapshotEveryTicks === 0) {
      const snapshotStartedAt = performance.now();
      const snapshot = loop.snapshot();
      snapshotBuildMsTotal += performance.now() - snapshotStartedAt + loop.getLastSnapshotBuildMs();
      snapshotBuildMsMax = Math.max(snapshotBuildMsMax, loop.getLastSnapshotBuildMs());
      fullSnapshotBytesTotal += JSON.stringify(snapshot).length;
      compactSnapshotBytesTotal += JSON.stringify(makeCompactSnapshot(snapshot)).length;
      snapshotSamples += 1;
    }
  }

  for (const count of perSecondMessageCounts.values()) maxPerClientMessagesSeen = Math.max(maxPerClientMessagesSeen, count);

  const avgTickCostMs = tickCostMsTotal / Math.max(1, totalTicks);
  const avgSnapshotBuildMs = snapshotBuildMsTotal / Math.max(1, snapshotSamples);
  const avgFullSnapshotBytes = Math.round(fullSnapshotBytesTotal / Math.max(1, snapshotSamples));
  const avgCompactSnapshotBytes = Math.round(compactSnapshotBytesTotal / Math.max(1, snapshotSamples));

  console.log(
    `[net-harness] players=${playerCount}` +
    ` duration=${durationSeconds}s` +
    ` inputRate=${CLIENT_INPUT_RATE}Hz` +
    ` snapshots=${SNAPSHOT_RATE}Hz` +
    ` expectedPerClient=${perClientExpected}/s` +
    ` capPerClient=${perClientCap}/s` +
    ` maxPerClientSeen=${maxPerClientMessagesSeen}/s` +
    ` roomIncoming=${(roomIncomingMessagesTotal / durationSeconds).toFixed(1)}/s` +
    ` tokenBucketRejects=${tokenBucketRejects}` +
    ` maxInputQueue=${maxInputQueueDepth}` +
    ` tickMs avg=${avgTickCostMs.toFixed(3)} max=${tickCostMsMax.toFixed(3)}` +
    ` snapshotBuildMs avg=${avgSnapshotBuildMs.toFixed(3)} max=${snapshotBuildMsMax.toFixed(3)}` +
    ` snapshotBytes full=${avgFullSnapshotBytes} compact=${avgCompactSnapshotBytes}` +
    ` activeEncoding=${USE_COMPACT_SNAPSHOTS ? 'compact' : 'full'}`
  );
}

for (const players of [3, 4]) runScenario(players);
