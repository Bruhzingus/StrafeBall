import { SNAPSHOT_RATE } from '../../../shared/netConfig';
import {
  NET_FLIGHT_RECORDER_ACK_AGE_THRESHOLD_MS,
  NET_FLIGHT_RECORDER_CLIENT_COOLDOWN_MS,
  NET_FLIGHT_RECORDER_CLIENT_REPORT_TTL_MS,
  NET_FLIGHT_RECORDER_DURATION_SECONDS,
  NET_FLIGHT_RECORDER_FRAME_JANK_COUNT_THRESHOLD,
  NET_FLIGHT_RECORDER_FRAME_JANK_THRESHOLD_MS,
  NET_FLIGHT_RECORDER_FRAME_STALL_THRESHOLD_MS,
  NET_FLIGHT_RECORDER_MAX_REPORT_BYTES,
  NET_FLIGHT_RECORDER_PENDING_INPUT_THRESHOLD,
  NET_FLIGHT_RECORDER_PING_BASELINE_JUMP_MS,
  NET_FLIGHT_RECORDER_PING_THRESHOLD_MS,
  NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT,
  NET_FLIGHT_RECORDER_RING_SIZE,
  NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS,
  NET_FLIGHT_RECORDER_SNAPSHOT_GAP_THRESHOLD_MS,
  NET_FLIGHT_RECORDER_SNAPSHOT_INTERVAL_THRESHOLD_MS,
  NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES,
  shortSessionId,
  type NetFlightRecorderClientReport,
  type NetFlightRecorderClientSample,
  type NetFlightRecorderClientTrigger
} from '../../../shared/netFlightRecorder';
import type { MultiplayerClient } from './MultiplayerClient';
import type { NetworkRendererDebugStats } from './NetworkRenderer';

export interface NetFlightRecorderContext {
  multiplayer: MultiplayerClient;
  renderStats: NetworkRendererDebugStats;
  pendingInputs: number;
  ackAgeMs: number | null;
  lastAckedInputSeq: number;
  lastAuthoritativeTick: number;
  activePlayers: number;
  activeBalls: number;
  localPlayerAlive: boolean | null;
  graphicsPreset: string;
  matchPhase: string;
}

export class NetFlightRecorder {
  private readonly samples = new FixedRingBuffer<NetFlightRecorderClientSample>(NET_FLIGHT_RECORDER_RING_SIZE);
  private seq = 0;
  private nextSampleAtMs = 0;
  private lastReportAtMs = 0;
  private pendingReport: { report: NetFlightRecorderClientReport; expiresAtMs: number } | null = null;
  private wsBufferedMaxBytes = 0;
  private readonly frameTimesMs: number[] = [];
  private framesOver50Ms = 0;
  private framesOver100Ms = 0;
  private framesOver250Ms = 0;

  reset(): void {
    this.seq = 0;
    this.nextSampleAtMs = 0;
    this.lastReportAtMs = 0;
    this.pendingReport = null;
    this.wsBufferedMaxBytes = 0;
    this.frameTimesMs.length = 0;
    this.framesOver50Ms = 0;
    this.framesOver100Ms = 0;
    this.framesOver250Ms = 0;
  }

  recordFrame(frameMs: number): void {
    this.frameTimesMs.push(frameMs);
    if (frameMs > 50) this.framesOver50Ms += 1;
    if (frameMs > 100) this.framesOver100Ms += 1;
    if (frameMs > 250) this.framesOver250Ms += 1;
  }

  update(context: NetFlightRecorderContext): void {
    if (!context.multiplayer.flightRecorderEnabled) {
      this.reset();
      return;
    }

    const now = Date.now();
    this.wsBufferedMaxBytes = Math.max(this.wsBufferedMaxBytes, context.multiplayer.getConnectionDebug().socketBufferedAmount);
    this.flushPendingReport(context.multiplayer, now);
    if (this.nextSampleAtMs === 0) this.nextSampleAtMs = now + NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS;
    if (now < this.nextSampleAtMs) {
      this.maybeTriggerImmediateReport(context, now);
      return;
    }

    this.nextSampleAtMs += NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS;
    const sample = this.buildSample(context, now);
    this.samples.push(sample);
    this.maybeTriggerImmediateReport(context, now, sample);
    this.resetSecondWindow();
  }

  private buildSample(context: NetFlightRecorderContext, now: number): NetFlightRecorderClientSample {
    this.seq += 1;
    const connection = context.multiplayer.getConnectionDebug();
    const pingWindow = recentNumericSamples(this.samples.toArray().map((sample) => sample.pingMs));
    const avgFrameMs = average(this.frameTimesMs);
    return {
      atMs: now,
      seq: this.seq,
      room: shortSessionId(context.multiplayer.roomId),
      client: shortSessionId(context.multiplayer.localPlayerId),
      pingMs: context.multiplayer.pingMs,
      pingAvgMs: pingWindow.length > 0 ? average(pingWindow) : context.multiplayer.pingMs,
      jitterMs: Math.round(connection.pingJitterMs),
      lastPongAgeMs: connection.lastPongAgeMs,
      reconnectCount: context.multiplayer.reconnectAttempts,
      wsReadyState: context.multiplayer.wsReadyState,
      wsBufferedBytes: connection.socketBufferedAmount,
      wsBufferedMaxBytes: Math.round(this.wsBufferedMaxBytes),
      snapshotsReceived: Math.round(context.multiplayer.snapshotDebug.receivedPerSecond),
      expectedSnapshotRate: SNAPSHOT_RATE,
      avgSnapshotIntervalMs: Number(context.multiplayer.snapshotDebug.averageMsBetweenSnapshots.toFixed(2)),
      maxSnapshotIntervalMs: Number(context.multiplayer.snapshotDebug.maxMsBetweenSnapshots.toFixed(2)),
      latestSnapshotAgeMs: connection.lastSnapshotAgeMs,
      duplicateOrOutOfOrderSnapshots: context.multiplayer.snapshotDebug.duplicateOrOutOfOrder,
      staleDroppedSnapshots: context.multiplayer.snapshotDebug.staleDropped,
      interpolationBufferSize: context.renderStats.remoteInterpolationBufferSize,
      interpolationUnderruns: Math.round(context.renderStats.bufferUnderrunsPerSec),
      interpolationOverruns: Math.round(context.renderStats.bufferOverrunsPerSec),
      pendingInputs: context.pendingInputs,
      ackAgeMs: context.ackAgeMs,
      lastAuthoritativeTick: context.lastAuthoritativeTick,
      lastAckedInputSeq: context.lastAckedInputSeq,
      fps: avgFrameMs > 0 ? Number((1000 / avgFrameMs).toFixed(1)) : 0,
      avgFrameMs: Number(avgFrameMs.toFixed(2)),
      p95FrameMs: Number(percentile(this.frameTimesMs, 0.95).toFixed(2)),
      maxFrameMs: Number((Math.max(0, ...this.frameTimesMs)).toFixed(2)),
      framesOver50Ms: this.framesOver50Ms,
      framesOver100Ms: this.framesOver100Ms,
      framesOver250Ms: this.framesOver250Ms,
      jsHeapUsedBytes: readJsHeapUsedBytes(),
      jsHeapTotalBytes: readJsHeapTotalBytes(),
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'hidden',
      focused: typeof document !== 'undefined' ? document.hasFocus() : false,
      activePlayers: context.activePlayers,
      activeBalls: context.activeBalls,
      localPlayerAlive: context.localPlayerAlive,
      graphicsPreset: context.graphicsPreset,
      matchPhase: context.matchPhase
    };
  }

  private maybeTriggerImmediateReport(
    context: NetFlightRecorderContext,
    now: number,
    latestSample = this.samples.toArray()[this.samples.toArray().length - 1]
  ): void {
    if (now - this.lastReportAtMs < NET_FLIGHT_RECORDER_CLIENT_COOLDOWN_MS) return;
    const sample = latestSample ?? this.buildSample(context, now);
    const baselinePing = baselineFromSamples(this.samples.toArray().map((entry) => entry.pingMs));
    const trigger = firstTruthy<NetFlightRecorderClientTrigger>([
      sample.pingMs !== null && sample.pingMs > NET_FLIGHT_RECORDER_PING_THRESHOLD_MS
        ? { kind: 'high_ping', pingMs: sample.pingMs }
        : null,
      sample.pingMs !== null && baselinePing !== null && sample.pingMs - baselinePing >= NET_FLIGHT_RECORDER_PING_BASELINE_JUMP_MS
        ? { kind: 'ping_baseline_jump', pingMs: sample.pingMs, pingBaselineDeltaMs: sample.pingMs - baselinePing }
        : null,
      (sample.latestSnapshotAgeMs ?? 0) > NET_FLIGHT_RECORDER_SNAPSHOT_GAP_THRESHOLD_MS && context.matchPhase === 'playing'
        ? { kind: 'snapshot_gap', snapshotGapMs: sample.latestSnapshotAgeMs, pingMs: sample.pingMs }
        : null,
      sample.maxSnapshotIntervalMs > NET_FLIGHT_RECORDER_SNAPSHOT_INTERVAL_THRESHOLD_MS
        ? { kind: 'snapshot_interval_spike', snapshotIntervalMs: sample.maxSnapshotIntervalMs, pingMs: sample.pingMs }
        : null,
      sample.wsBufferedMaxBytes >= NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES
        ? { kind: 'client_socket_backpressure', wsBufferedBytes: sample.wsBufferedMaxBytes, pingMs: sample.pingMs }
        : null,
      sample.pendingInputs >= NET_FLIGHT_RECORDER_PENDING_INPUT_THRESHOLD
        ? { kind: 'pending_input_backlog', pendingInputs: sample.pendingInputs, ackAgeMs: sample.ackAgeMs }
        : null,
      (sample.ackAgeMs ?? 0) > NET_FLIGHT_RECORDER_ACK_AGE_THRESHOLD_MS
        ? { kind: 'input_ack_backlog', pendingInputs: sample.pendingInputs, ackAgeMs: sample.ackAgeMs }
        : null,
      sample.maxFrameMs > NET_FLIGHT_RECORDER_FRAME_STALL_THRESHOLD_MS
        ? { kind: 'browser_frame_stall', maxFrameMs: sample.maxFrameMs }
        : null,
      sample.framesOver100Ms >= NET_FLIGHT_RECORDER_FRAME_JANK_COUNT_THRESHOLD
        ? { kind: 'browser_frame_jank', framesOver100Ms: sample.framesOver100Ms, maxFrameMs: sample.maxFrameMs }
        : null,
      sample.wsReadyState !== WebSocket.OPEN && context.matchPhase === 'playing'
        ? { kind: 'socket_state_change', wsReadyState: sample.wsReadyState }
        : null,
      sample.reconnectCount > 0 && context.matchPhase === 'playing'
        ? { kind: 'client_reconnect', reconnectCount: sample.reconnectCount, wsReadyState: sample.wsReadyState }
        : null
    ]);
    if (!trigger) return;
    const report = this.buildReport(trigger, sample);
    this.lastReportAtMs = now;
    if (!context.multiplayer.sendNetAnomalyReport(report)) {
      this.pendingReport = { report, expiresAtMs: now + NET_FLIGHT_RECORDER_CLIENT_REPORT_TTL_MS };
    }
  }

  private buildReport(trigger: NetFlightRecorderClientTrigger, latestSample: NetFlightRecorderClientSample): NetFlightRecorderClientReport {
    const recentClientSamples = this.samples.toArray().slice(-NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT);
    const report: NetFlightRecorderClientReport = {
      type: 'net-anomaly-report',
      reportId: `${latestSample.room}-${latestSample.client}-${latestSample.atMs}`,
      clientEventAtMs: latestSample.atMs,
      room: latestSample.room,
      client: latestSample.client,
      trigger,
      lastSnapshotTick: latestSample.lastAuthoritativeTick,
      lastAckedInputSeq: latestSample.lastAckedInputSeq,
      recentClientSamples
    };
    return trimReportBytes(report);
  }

  private flushPendingReport(multiplayer: MultiplayerClient, now: number): void {
    if (!this.pendingReport) return;
    if (now > this.pendingReport.expiresAtMs) {
      this.pendingReport = null;
      return;
    }
    if (multiplayer.sendNetAnomalyReport(this.pendingReport.report)) this.pendingReport = null;
  }

  private resetSecondWindow(): void {
    this.wsBufferedMaxBytes = 0;
    this.frameTimesMs.length = 0;
    this.framesOver50Ms = 0;
    this.framesOver100Ms = 0;
    this.framesOver250Ms = 0;
  }
}

class FixedRingBuffer<T> {
  private readonly items: Array<T | undefined>;
  private nextIndex = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    this.items[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const index = (this.nextIndex - this.count + i + this.capacity) % this.capacity;
      const item = this.items[index];
      if (item !== undefined) result.push(item);
    }
    return result;
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function baselineFromSamples(values: Array<number | null>): number | null {
  const filtered = recentNumericSamples(values).slice(-10);
  if (filtered.length === 0) return null;
  return average(filtered);
}

function recentNumericSamples(values: Array<number | null>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function firstTruthy<T>(values: Array<T | null>): T | null {
  for (const value of values) {
    if (value) return value;
  }
  return null;
}

function readJsHeapUsedBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
}

function readJsHeapTotalBytes(): number | null {
  const memory = (performance as Performance & { memory?: { totalJSHeapSize?: number } }).memory;
  return typeof memory?.totalJSHeapSize === 'number' ? memory.totalJSHeapSize : null;
}

function trimReportBytes(report: NetFlightRecorderClientReport): NetFlightRecorderClientReport {
  const json = JSON.stringify(report);
  if (json.length <= NET_FLIGHT_RECORDER_MAX_REPORT_BYTES) return report;
  return {
    ...report,
    recentClientSamples: report.recentClientSamples.slice(-Math.max(8, Math.floor(NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT / 2)))
  };
}

export function defaultFlightRecorderGraphicsPreset(): string {
  try {
    return window.localStorage.getItem('strafeball.graphicsPreset') ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function defaultFlightRecorderDurationSeconds(): number {
  return NET_FLIGHT_RECORDER_DURATION_SECONDS;
}
