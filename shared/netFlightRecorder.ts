export const NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS = 1000;
export const NET_FLIGHT_RECORDER_DURATION_SECONDS = 45;
export const NET_FLIGHT_RECORDER_RING_SIZE = NET_FLIGHT_RECORDER_DURATION_SECONDS;
export const NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT = 25;
export const NET_FLIGHT_RECORDER_MAX_REPORT_BYTES = 16 * 1024;
export const NET_FLIGHT_RECORDER_CLIENT_REPORT_TTL_MS = 60_000;
export const NET_FLIGHT_RECORDER_CLIENT_COOLDOWN_MS = 15_000;
export const NET_FLIGHT_RECORDER_SERVER_COOLDOWN_MS = 10_000;
export const NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES = 64 * 1024;
export const NET_FLIGHT_RECORDER_PENDING_INPUT_THRESHOLD = 64;
export const NET_FLIGHT_RECORDER_ACK_AGE_THRESHOLD_MS = 500;
export const NET_FLIGHT_RECORDER_SNAPSHOT_GAP_THRESHOLD_MS = 500;
export const NET_FLIGHT_RECORDER_SNAPSHOT_INTERVAL_THRESHOLD_MS = 250;
export const NET_FLIGHT_RECORDER_PING_THRESHOLD_MS = 500;
export const NET_FLIGHT_RECORDER_PING_BASELINE_JUMP_MS = 300;
export const NET_FLIGHT_RECORDER_FRAME_STALL_THRESHOLD_MS = 250;
export const NET_FLIGHT_RECORDER_FRAME_JANK_THRESHOLD_MS = 100;
export const NET_FLIGHT_RECORDER_FRAME_JANK_COUNT_THRESHOLD = 3;
export const NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS = 100;
export const NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_SEVERE_THRESHOLD_MS = 250;
export const NET_FLIGHT_RECORDER_SERVER_CPU_THRESHOLD_PCT = 85;
export const NET_FLIGHT_RECORDER_SERVER_INPUT_AGE_THRESHOLD_MS = 500;
export const NET_FLIGHT_RECORDER_SERVER_HEAP_GROWTH_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const NET_FLIGHT_RECORDER_SERVER_SNAPSHOT_RATE_FLOOR_RATIO = 0.8;

export type NetAnomalyClassification =
  | 'likely_server_event_loop_stall'
  | 'likely_server_cpu_pressure'
  | 'likely_client_browser_stall'
  | 'likely_client_socket_backpressure'
  | 'likely_snapshot_delivery_gap'
  | 'likely_input_ack_backlog'
  | 'likely_client_network_path_or_tcp_hol'
  | 'likely_connection_reconnect_issue'
  | 'mixed_or_inconclusive';

export interface NetFlightRecorderConfigMessage {
  type: 'net-flight-recorder-config';
  enabled: boolean;
  sampleIntervalMs: number;
  durationSeconds: number;
  reportSampleCount: number;
}

export interface NetFlightRecorderClientSample {
  atMs: number;
  seq: number;
  room: string;
  client: string;
  pingMs: number | null;
  pingAvgMs: number | null;
  jitterMs: number;
  lastPongAgeMs: number | null;
  reconnectCount: number;
  wsReadyState: number;
  wsBufferedBytes: number;
  wsBufferedMaxBytes: number;
  snapshotsReceived: number;
  expectedSnapshotRate: number;
  avgSnapshotIntervalMs: number;
  maxSnapshotIntervalMs: number;
  latestSnapshotAgeMs: number | null;
  duplicateOrOutOfOrderSnapshots: number;
  staleDroppedSnapshots: number;
  interpolationBufferSize: number;
  interpolationUnderruns: number;
  interpolationOverruns: number;
  pendingInputs: number;
  ackAgeMs: number | null;
  lastAuthoritativeTick: number;
  lastAckedInputSeq: number;
  fps: number;
  avgFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  framesOver50Ms: number;
  framesOver100Ms: number;
  framesOver250Ms: number;
  jsHeapUsedBytes: number | null;
  jsHeapTotalBytes: number | null;
  visibilityState: string;
  focused: boolean;
  activePlayers: number;
  activeBalls: number;
  localPlayerAlive: boolean | null;
  graphicsPreset: string;
  matchPhase: string;
}

export interface NetFlightRecorderServerClientSample {
  client: string;
  inputAgeMs: number;
  inputMessages: number;
  duplicateOrOutOfOrderInputs: number;
  staleResetInputs: number;
  inputQueueDepth: number;
  inputQueueDepthMax: number;
  lastProcessedSeq: number;
  lastEnqueuedSeq: number;
  wsBufferedBytes: number | null;
  wsBufferedMaxBytes: number;
  estimatedSnapshotsSent: number;
  estimatedOutboundBytes: number;
  connectionState: string;
}

export interface NetFlightRecorderServerSample {
  atMs: number;
  room: string;
  activePlayers: number;
  simTargetHz: number;
  simSteps: number;
  snapshotsSent: number;
  snapshotsSkipped: number;
  outboundBytesPerSec: number;
  snapshotFrameBytesAvg: number;
  snapshotFrameBytesMax: number;
  inputMessages: number;
  cpuPct: number;
  heapUsedBytes: number;
  heapGrowthBytes: number;
  rssBytes: number;
  externalBytes: number;
  eventLoopAvgMs: number;
  eventLoopP95Ms: number;
  eventLoopMaxMs: number;
  loopWakeMaxMs: number;
  loopWakeOver50Ms: number;
  loopWakeOver100Ms: number;
  loopWakeOver500Ms: number;
  clients: NetFlightRecorderServerClientSample[];
}

export interface NetFlightRecorderClientTrigger {
  kind: string;
  pingMs?: number | null;
  pingBaselineDeltaMs?: number | null;
  snapshotGapMs?: number | null;
  snapshotIntervalMs?: number | null;
  wsBufferedBytes?: number;
  pendingInputs?: number;
  ackAgeMs?: number | null;
  maxFrameMs?: number;
  framesOver100Ms?: number;
  wsReadyState?: number;
  reconnectCount?: number;
}

export interface NetFlightRecorderClientReport {
  type: 'net-anomaly-report';
  reportId: string;
  clientEventAtMs: number;
  room: string;
  client: string;
  trigger: NetFlightRecorderClientTrigger;
  lastSnapshotTick: number;
  lastAckedInputSeq: number;
  recentClientSamples: NetFlightRecorderClientSample[];
}

export function resolveNetFlightRecorderEnabled(
  env: Record<string, string | undefined> = readNetFlightRecorderEnv()
): boolean {
  const value = env.NET_FLIGHT_RECORDER;
  return value === '1' || value === 'true';
}

function readNetFlightRecorderEnv(): Record<string, string | undefined> {
  const candidate = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return candidate.process?.env ?? {};
}

export function shortSessionId(value: string | null | undefined): string {
  if (!value) return 'none';
  return value.slice(-6);
}

export function classifyNetAnomaly(args: {
  trigger: NetFlightRecorderClientTrigger | { kind: string };
  server?: Pick<
    NetFlightRecorderServerSample,
    'eventLoopMaxMs' | 'eventLoopP95Ms' | 'loopWakeMaxMs' | 'cpuPct' | 'snapshotsSent'
  > | null;
  clientSample?: Pick<
    NetFlightRecorderClientSample,
    'maxFrameMs' | 'wsBufferedMaxBytes' | 'pendingInputs' | 'ackAgeMs' | 'latestSnapshotAgeMs' | 'snapshotsReceived'
  > | null;
  affectedClientCount?: number;
}): NetAnomalyClassification {
  const { trigger, server, clientSample, affectedClientCount } = args;
  if (trigger.kind.includes('reconnect') || trigger.kind.includes('disconnect') || trigger.kind.includes('closed')) {
    return 'likely_connection_reconnect_issue';
  }
  if ((server?.eventLoopMaxMs ?? 0) >= NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_SEVERE_THRESHOLD_MS || (server?.loopWakeMaxMs ?? 0) >= NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS) {
    return 'likely_server_event_loop_stall';
  }
  if ((server?.cpuPct ?? 0) >= NET_FLIGHT_RECORDER_SERVER_CPU_THRESHOLD_PCT) {
    return 'likely_server_cpu_pressure';
  }
  if ((clientSample?.maxFrameMs ?? 0) >= NET_FLIGHT_RECORDER_FRAME_STALL_THRESHOLD_MS) {
    return 'likely_client_browser_stall';
  }
  if ((clientSample?.wsBufferedMaxBytes ?? 0) >= NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES) {
    return 'likely_client_socket_backpressure';
  }
  if ((clientSample?.pendingInputs ?? 0) >= NET_FLIGHT_RECORDER_PENDING_INPUT_THRESHOLD || (clientSample?.ackAgeMs ?? 0) >= NET_FLIGHT_RECORDER_ACK_AGE_THRESHOLD_MS) {
    return 'likely_input_ack_backlog';
  }
  if ((clientSample?.latestSnapshotAgeMs ?? 0) >= NET_FLIGHT_RECORDER_SNAPSHOT_GAP_THRESHOLD_MS || trigger.kind.includes('snapshot')) {
    if ((server?.eventLoopMaxMs ?? 0) < NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS && (server?.cpuPct ?? 0) < NET_FLIGHT_RECORDER_SERVER_CPU_THRESHOLD_PCT && (affectedClientCount ?? 1) <= 1) {
      return 'likely_client_network_path_or_tcp_hol';
    }
    return 'likely_snapshot_delivery_gap';
  }
  return 'mixed_or_inconclusive';
}
