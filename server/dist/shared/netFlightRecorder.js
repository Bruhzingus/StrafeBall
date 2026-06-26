"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NET_FLIGHT_RECORDER_SERVER_SNAPSHOT_RATE_FLOOR_RATIO = exports.NET_FLIGHT_RECORDER_SERVER_HEAP_GROWTH_THRESHOLD_BYTES = exports.NET_FLIGHT_RECORDER_SERVER_INPUT_AGE_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_SERVER_CPU_THRESHOLD_PCT = exports.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_SEVERE_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_FRAME_JANK_COUNT_THRESHOLD = exports.NET_FLIGHT_RECORDER_FRAME_JANK_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_FRAME_STALL_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_PING_BASELINE_JUMP_MS = exports.NET_FLIGHT_RECORDER_PING_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_SNAPSHOT_INTERVAL_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_SNAPSHOT_GAP_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_ACK_AGE_THRESHOLD_MS = exports.NET_FLIGHT_RECORDER_PENDING_INPUT_THRESHOLD = exports.NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES = exports.NET_FLIGHT_RECORDER_SERVER_COOLDOWN_MS = exports.NET_FLIGHT_RECORDER_CLIENT_COOLDOWN_MS = exports.NET_FLIGHT_RECORDER_CLIENT_REPORT_TTL_MS = exports.NET_FLIGHT_RECORDER_MAX_REPORT_BYTES = exports.NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT = exports.NET_FLIGHT_RECORDER_RING_SIZE = exports.NET_FLIGHT_RECORDER_DURATION_SECONDS = exports.NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS = void 0;
exports.resolveNetFlightRecorderEnabled = resolveNetFlightRecorderEnabled;
exports.shortSessionId = shortSessionId;
exports.classifyNetAnomaly = classifyNetAnomaly;
exports.NET_FLIGHT_RECORDER_SAMPLE_INTERVAL_MS = 1000;
exports.NET_FLIGHT_RECORDER_DURATION_SECONDS = 45;
exports.NET_FLIGHT_RECORDER_RING_SIZE = exports.NET_FLIGHT_RECORDER_DURATION_SECONDS;
exports.NET_FLIGHT_RECORDER_REPORT_SAMPLE_COUNT = 25;
exports.NET_FLIGHT_RECORDER_MAX_REPORT_BYTES = 16 * 1024;
exports.NET_FLIGHT_RECORDER_CLIENT_REPORT_TTL_MS = 60_000;
exports.NET_FLIGHT_RECORDER_CLIENT_COOLDOWN_MS = 15_000;
exports.NET_FLIGHT_RECORDER_SERVER_COOLDOWN_MS = 10_000;
exports.NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES = 64 * 1024;
exports.NET_FLIGHT_RECORDER_PENDING_INPUT_THRESHOLD = 64;
exports.NET_FLIGHT_RECORDER_ACK_AGE_THRESHOLD_MS = 500;
exports.NET_FLIGHT_RECORDER_SNAPSHOT_GAP_THRESHOLD_MS = 500;
exports.NET_FLIGHT_RECORDER_SNAPSHOT_INTERVAL_THRESHOLD_MS = 250;
exports.NET_FLIGHT_RECORDER_PING_THRESHOLD_MS = 500;
exports.NET_FLIGHT_RECORDER_PING_BASELINE_JUMP_MS = 300;
exports.NET_FLIGHT_RECORDER_FRAME_STALL_THRESHOLD_MS = 250;
exports.NET_FLIGHT_RECORDER_FRAME_JANK_THRESHOLD_MS = 100;
exports.NET_FLIGHT_RECORDER_FRAME_JANK_COUNT_THRESHOLD = 3;
exports.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS = 100;
exports.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_SEVERE_THRESHOLD_MS = 250;
exports.NET_FLIGHT_RECORDER_SERVER_CPU_THRESHOLD_PCT = 85;
exports.NET_FLIGHT_RECORDER_SERVER_INPUT_AGE_THRESHOLD_MS = 500;
exports.NET_FLIGHT_RECORDER_SERVER_HEAP_GROWTH_THRESHOLD_BYTES = 64 * 1024 * 1024;
exports.NET_FLIGHT_RECORDER_SERVER_SNAPSHOT_RATE_FLOOR_RATIO = 0.8;
function resolveNetFlightRecorderEnabled(env = readNetFlightRecorderEnv()) {
    const value = env.NET_FLIGHT_RECORDER;
    return value === '1' || value === 'true';
}
function readNetFlightRecorderEnv() {
    const candidate = globalThis;
    return candidate.process?.env ?? {};
}
function shortSessionId(value) {
    if (!value)
        return 'none';
    return value.slice(-6);
}
function classifyNetAnomaly(args) {
    const { trigger, server, clientSample, affectedClientCount } = args;
    if (trigger.kind.includes('reconnect') || trigger.kind.includes('disconnect') || trigger.kind.includes('closed')) {
        return 'likely_connection_reconnect_issue';
    }
    if ((server?.eventLoopMaxMs ?? 0) >= exports.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_SEVERE_THRESHOLD_MS || (server?.loopWakeMaxMs ?? 0) >= exports.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS) {
        return 'likely_server_event_loop_stall';
    }
    if ((server?.cpuPct ?? 0) >= exports.NET_FLIGHT_RECORDER_SERVER_CPU_THRESHOLD_PCT) {
        return 'likely_server_cpu_pressure';
    }
    if ((clientSample?.maxFrameMs ?? 0) >= exports.NET_FLIGHT_RECORDER_FRAME_STALL_THRESHOLD_MS) {
        return 'likely_client_browser_stall';
    }
    if ((clientSample?.wsBufferedMaxBytes ?? 0) >= exports.NET_FLIGHT_RECORDER_WS_BUFFER_THRESHOLD_BYTES) {
        return 'likely_client_socket_backpressure';
    }
    if ((clientSample?.pendingInputs ?? 0) >= exports.NET_FLIGHT_RECORDER_PENDING_INPUT_THRESHOLD || (clientSample?.ackAgeMs ?? 0) >= exports.NET_FLIGHT_RECORDER_ACK_AGE_THRESHOLD_MS) {
        return 'likely_input_ack_backlog';
    }
    if ((clientSample?.latestSnapshotAgeMs ?? 0) >= exports.NET_FLIGHT_RECORDER_SNAPSHOT_GAP_THRESHOLD_MS || trigger.kind.includes('snapshot')) {
        if ((server?.eventLoopMaxMs ?? 0) < exports.NET_FLIGHT_RECORDER_SERVER_EVENT_LOOP_THRESHOLD_MS && (server?.cpuPct ?? 0) < exports.NET_FLIGHT_RECORDER_SERVER_CPU_THRESHOLD_PCT && (affectedClientCount ?? 1) <= 1) {
            return 'likely_client_network_path_or_tcp_hol';
        }
        return 'likely_snapshot_delivery_gap';
    }
    return 'mixed_or_inconclusive';
}
