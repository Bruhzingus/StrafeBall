"use strict";
/**
 * Centralized netcode configuration — the single source of truth for every timing path in the
 * game. Server simulation, manual snapshot broadcast, client input send, client prediction, and
 * reconciliation replay all derive their rates and fixed timesteps from here so they can never
 * silently drift apart (the bug class behind "intended 30Hz became ~22Hz").
 *
 * IMPORTANT: derive dt from the rate (`1 / rate`), never hardcode `0.033` / `0.016` literals.
 * Prediction and the server must use compatible fixed dt; with SERVER_TICK_RATE === CLIENT_INPUT_RATE
 * they are identical, which is the only configuration that makes reconciliation residual ≈ 0.
 *
 * To switch test configs, change DEFAULT_NET_MODE below and rebuild, or set NET_MODE on the
 * server. The browser build validates VITE_NET_MODE but does not hot-swap rates after compile.
 * The supported modes:
 *   A. 90 sim / 90 input / 60 snapshots   (stable public-playtest default)
 *   B. 128 sim / 128 input / 96 snapshots (high-rate LAN/strong-connection target)
 *   C. 60 sim / 60 input / 60 snapshots   (legacy full-rate fallback)
 *   D. 60 sim / 60 input / 30 snapshots   (bandwidth fallback)
 *   E. 30 sim / 30 input / 30 snapshots   (baseline for constrained hosts)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIVE_BALL_COMBAT_SUBSTEPS = exports.PERF_REPORT_INTERVAL_MS = exports.DEBUG_DEFAULTS = exports.USE_TIERED_SNAPSHOTS = exports.SNAPSHOT_TIER_MODE = exports.SNAPSHOT_BACKPRESSURE_BYTES = exports.USE_COMPACT_SNAPSHOTS = exports.SNAPSHOT_ENCODING = exports.HUGE_ERROR_SNAP_METERS = exports.EXTRAPOLATION_LIMIT_MS = exports.SNAPSHOT_BUFFER_LIMIT_MS = exports.SERVER_INPUT_QUEUE_LIMIT = exports.PENDING_INPUT_LIMIT = exports.MAX_ACCUMULATOR_CLAMP_MS = exports.MAX_ACCUMULATOR_STEPS = exports.ROOM_LOOP_WAKE_INTERVAL_MS = exports.ROOM_LOOP_WAKE_RATE = exports.ADAPTIVE_INTERP_UNDERRUN_TOLERANCE = exports.ADAPTIVE_INTERP_GAP_MARGIN_MS = exports.ADAPTIVE_INTERP_SHRINK_PER_WINDOW_MS = exports.ADAPTIVE_INTERP_GAP_DECAY_PER_WINDOW = exports.ADAPTIVE_INTERP_MAX_DELAY_MS = exports.ADAPTIVE_INTERP_MIN_DELAY_MS = exports.ADAPTIVE_INTERP_ENABLED = exports.INTERPOLATION_DELAY_MS = exports.SERVER_STEP_MS = exports.SNAPSHOT_INTERVAL_MS = exports.CLIENT_FIXED_DT = exports.SERVER_FIXED_DT = exports.SNAPSHOT_RATE = exports.CLIENT_INPUT_RATE = exports.SERVER_TICK_RATE = exports.ACTIVE_NET_MODE = exports.DEFAULT_NET_MODE = void 0;
exports.netModeConfig = netModeConfig;
exports.describeSnapshotProfile = describeSnapshotProfile;
exports.resolveServerDebugFlags = resolveServerDebugFlags;
exports.describeNetConfig = describeNetConfig;
const MODES = {
    // 180Hz sim/input with 96Hz snapshots. Snapshot interval ~10.4ms; 45ms interp covers ~4 snapshots.
    A_180_180_96: { serverTickRate: 180, clientInputRate: 180, snapshotRate: 96, interpolationDelayMs: 45 },
    // 180Hz sim/input with 128Hz snapshots. Snapshot interval ~7.8ms; 40ms interp covers ~5 snapshots.
    A_180_180_128: { serverTickRate: 180, clientInputRate: 180, snapshotRate: 128, interpolationDelayMs: 40 },
    // 144Hz sim/input with 96Hz snapshots. Snapshot interval ~10.4ms; 45ms interp covers ~4 snapshots.
    A_144_144_96: { serverTickRate: 144, clientInputRate: 144, snapshotRate: 96, interpolationDelayMs: 45 },
    // Ultra-high rate for high-refresh monitors. Snapshot interval ~7.8ms.
    // 40ms interp delay covers ~5 snapshots of jitter headroom.
    A_144_144_128: { serverTickRate: 144, clientInputRate: 144, snapshotRate: 128, interpolationDelayMs: 40 },
    A_144_144_100: { serverTickRate: 144, clientInputRate: 144, snapshotRate: 100, interpolationDelayMs: 45 },
    // Phase 5 preferred 2v2 target. Snapshot interval ~10.4ms; 50ms interp covers ~5 snapshots.
    A_128_128_96: { serverTickRate: 128, clientInputRate: 128, snapshotRate: 96, interpolationDelayMs: 50 },
    // A — 128Hz sim/input with 90Hz snapshots. Sim dt ~7.8ms; snapshot interval ~11.1ms.
    // With LIVE_BALL_COMBAT_SUBSTEPS=2 effective combat checks run at ~256Hz.
    // 50ms interp covers ~4.5 snapshots at the nominal 90Hz rate.
    A_128_128_90: { serverTickRate: 128, clientInputRate: 128, snapshotRate: 90, interpolationDelayMs: 50 },
    // Phase 5 fallback 2v2 target. Snapshot interval ~13.9ms; 60ms interp covers ~4 snapshots.
    A_120_120_72: { serverTickRate: 120, clientInputRate: 120, snapshotRate: 72, interpolationDelayMs: 60 },
    // A — 90Hz sim/input with 60Hz snapshots. Sim/input dt ~11.1ms; snapshot interval ~16.7ms (interp
    // delay tracks the SNAPSHOT rate, not the sim rate, so 75ms still covers ~4 snapshots of jitter).
    A_90_90_60: { serverTickRate: 90, clientInputRate: 90, snapshotRate: 60, interpolationDelayMs: 75 },
    // 72Hz sim/input with 60Hz snapshots. Snapshot interval ~16.7ms; 75ms covers ~4 snapshots.
    A_72_72_60: { serverTickRate: 72, clientInputRate: 72, snapshotRate: 60, interpolationDelayMs: 75 },
    // Legacy full 60Hz. Snapshot interval ~16.7ms; a 75ms delay covers ~4 snapshots of jitter headroom.
    A_60_60_60: { serverTickRate: 60, clientInputRate: 60, snapshotRate: 60, interpolationDelayMs: 75 },
    // B — 60 sim/input, 30 snapshots. Snapshot interval ~33ms; 110ms delay covers ~3 snapshots.
    B_60_60_30: { serverTickRate: 60, clientInputRate: 60, snapshotRate: 30, interpolationDelayMs: 110 },
    // C — classic 30Hz everything. Snapshot interval ~33ms; 110ms delay covers ~3 snapshots.
    C_30_30_30: { serverTickRate: 30, clientInputRate: 30, snapshotRate: 30, interpolationDelayMs: 110 }
};
/**
 * Resolve the active mode from an env override if present, else the compiled default. The override
 * lets local-vs-deployed tests pick a mode without editing this constant:
 *   - server: NET_MODE=B_60_60_30 (process.env, read here)
 *   - client: VITE_NET_MODE=B_60_60_30 is validated in src/main.ts; rebuild the client with the
 *     matching default mode before using it. Keeping the import.meta reference OUT of shared code
 *     is what lets the same file build for both browser and Node targets.
 */
/**
 * Read process.env via globalThis so this file type-checks under BOTH builds: the client tsconfig
 * does not include @types/node (so a bare `process` is an error TS2580), and the server compiles
 * shared as CommonJS. Going through `globalThis` with a local typed shim avoids needing the Node
 * type while still reading env on the server at runtime; on the client `process` is simply absent
 * and this returns {}.
 */
function processEnv() {
    const g = globalThis;
    return g.process?.env ?? {};
}
function resolveProcessMode() {
    const fromProcess = processEnv().NET_MODE;
    if (fromProcess && fromProcess in MODES)
        return fromProcess;
    return exports.DEFAULT_NET_MODE;
}
/** Compiled default mode. Stable public-playtest baseline: 90 sim/input, 60 snapshots. */
exports.DEFAULT_NET_MODE = 'A_90_90_60';
/**
 * Active mode resolved at module load from process.env (server) or the compiled default (client).
 * Client and server rates are resolved eagerly from this mode. The browser warns if VITE_NET_MODE
 * disagrees with the compiled mode; it does not mutate these constants at runtime.
 */
exports.ACTIVE_NET_MODE = resolveProcessMode();
/**
 * Client-side hook to validate a VITE_NET_MODE value against the known modes. This keeps the
 * import.meta token in client-only code, never in this shared CommonJS-compiled file.
 */
function netModeConfig(mode) {
    return mode && mode in MODES ? MODES[mode] : null;
}
const active = MODES[exports.ACTIVE_NET_MODE];
exports.SERVER_TICK_RATE = active.serverTickRate;
exports.CLIENT_INPUT_RATE = active.clientInputRate;
exports.SNAPSHOT_RATE = active.snapshotRate;
/** Exact fixed timesteps (seconds). Derived from rate — never a rounded literal. */
exports.SERVER_FIXED_DT = 1 / exports.SERVER_TICK_RATE;
exports.CLIENT_FIXED_DT = 1 / exports.CLIENT_INPUT_RATE;
/** Milliseconds between snapshot broadcasts. The room loop broadcasts on this cadence. */
exports.SNAPSHOT_INTERVAL_MS = 1000 / exports.SNAPSHOT_RATE;
/** Milliseconds between server fixed sim steps. */
exports.SERVER_STEP_MS = 1000 / exports.SERVER_TICK_RATE;
exports.INTERPOLATION_DELAY_MS = active.interpolationDelayMs;
/**
 * Adaptive interpolation delay (client). Instead of every client paying the mode's fixed
 * INTERPOLATION_DELAY_MS, each client sizes its own buffer from MEASURED snapshot delivery:
 * smooth connections shrink toward the floor (less remote-render latency), jittery connections
 * widen toward the ceiling (spikes absorbed instead of rendered). The controller starts at the
 * mode's static delay, widens immediately when a delivery gap/underrun proves the buffer too
 * small, and shrinks slowly (SHRINK_PER_WINDOW each ~1s window) so it never oscillates.
 * Set ADAPTIVE_INTERP_ENABLED = false to restore the fixed-delay behavior (one-line revert).
 */
exports.ADAPTIVE_INTERP_ENABLED = true;
/** Floor: two snapshot intervals + frame-timing slack. Below this even a perfect link underruns. */
exports.ADAPTIVE_INTERP_MIN_DELAY_MS = Math.max(Math.ceil(exports.SNAPSHOT_INTERVAL_MS * 2) + 8, 30);
/** Ceiling: cap how much delay a terrible connection can accumulate (playability bound). */
exports.ADAPTIVE_INTERP_MAX_DELAY_MS = Math.max(150, exports.INTERPOLATION_DELAY_MS * 2);
/** Decay applied to the tracked peak delivery gap per ~1s window (halves in ~8 windows). */
exports.ADAPTIVE_INTERP_GAP_DECAY_PER_WINDOW = 0.92;
/** Max ms the delay may shrink per ~1s window. Widening is immediate; shrinking is gradual. */
exports.ADAPTIVE_INTERP_SHRINK_PER_WINDOW_MS = 5;
/** Safety margin added on top of the tracked peak gap when computing the target delay. */
exports.ADAPTIVE_INTERP_GAP_MARGIN_MS = Math.ceil(exports.SNAPSHOT_INTERVAL_MS * 0.5) + 4;
/** Extrapolated frames per window tolerated before underruns force the buffer wider. */
exports.ADAPTIVE_INTERP_UNDERRUN_TOLERANCE = 2;
/**
 * How frequently the room loop wakes to drain the fixed-step accumulator. Wake faster than the sim
 * rate so timer jitter can't starve a step. 200Hz wake (5ms) comfortably feeds the high-rate modes
 * with headroom.
 */
exports.ROOM_LOOP_WAKE_RATE = 200;
exports.ROOM_LOOP_WAKE_INTERVAL_MS = 1000 / exports.ROOM_LOOP_WAKE_RATE;
/**
 * Max fixed sim steps to run per wake. Prevents a spiral-of-death after a long pause: instead of
 * trying to "catch up" hundreds of frames we cap and discard the backlog. Sized so a single wake
 * can absorb a couple of missed steps without ever simulating a visible time-warp.
 */
exports.MAX_ACCUMULATOR_STEPS = 5;
/** Clamp on elapsed time fed into the accumulator (ms). Caps the damage of an alt-tab / GC pause. */
exports.MAX_ACCUMULATOR_CLAMP_MS = 250;
/** Max sent inputs the client buffers for reconciliation. Scales to ~1.5s at the active input rate. */
exports.PENDING_INPUT_LIMIT = Math.ceil(exports.CLIENT_INPUT_RATE * 1.5);
/** Max inputs the server queues per player before dropping the oldest. ~1s of buffer at the rate. */
exports.SERVER_INPUT_QUEUE_LIMIT = Math.max(30, Math.ceil(exports.SERVER_TICK_RATE));
/** Max snapshots the client interpolation buffer keeps (by age, ms). */
exports.SNAPSHOT_BUFFER_LIMIT_MS = 1000;
/** How long the client may extrapolate a remote entity past the newest snapshot on buffer underrun. */
exports.EXTRAPOLATION_LIMIT_MS = 120;
/** Position error (m) above which interpolation snaps instead of lerping (reset/teleport/glitch). */
exports.HUGE_ERROR_SNAP_METERS = 5;
function resolveSnapshotEncoding(env = processEnv()) {
    const explicit = env.SNAPSHOT_ENCODING?.toLowerCase();
    if (explicit === 'compact' || explicit === 'full')
        return explicit;
    const compactFlag = env.USE_COMPACT_SNAPSHOTS?.toLowerCase();
    if (compactFlag === '0' || compactFlag === 'false')
        return 'full';
    if (compactFlag === '1' || compactFlag === 'true')
        return 'compact';
    return 'compact';
}
/** Server-side snapshot payload encoding. Override with SNAPSHOT_ENCODING=full for debugging. */
exports.SNAPSHOT_ENCODING = resolveSnapshotEncoding();
exports.USE_COMPACT_SNAPSHOTS = exports.SNAPSHOT_ENCODING === 'compact';
/**
 * Skip snapshot sends to a client whose socket buffer exceeds this. Sized in TIME, not just
 * bytes: at ~60Hz × ~500B frames, 16KB is ~0.5s of queued snapshots. The old 64KB allowed a
 * stalled TCP connection to accumulate 2+ SECONDS of stale snapshots that then had to flush
 * through the recovering link before any fresh data — the main reason a jitter spike lasted
 * long after the network recovered. Skipping sooner is safe: the client drops stale snapshots
 * anyway, events broadcast separately, and tiered lanes re-include on cadence.
 */
exports.SNAPSHOT_BACKPRESSURE_BYTES = 16 * 1024;
function resolveSnapshotTierMode(env = processEnv()) {
    const explicit = env.SNAPSHOT_TIER_MODE?.toLowerCase();
    if (explicit === 'tiered_v1')
        return 'tiered_v1';
    return 'baseline';
}
/** Reversible snapshot payload tiering mode. Baseline is the default and preserves current shape. */
exports.SNAPSHOT_TIER_MODE = resolveSnapshotTierMode();
exports.USE_TIERED_SNAPSHOTS = exports.SNAPSHOT_TIER_MODE === 'tiered_v1';
function describeSnapshotProfile() {
    return `${exports.ACTIVE_NET_MODE}_${exports.SNAPSHOT_TIER_MODE === 'tiered_v1' ? 'TIERED_V1' : 'BASELINE'}`;
}
/**
 * PERF_DEBUG defaults ON: it only drives the throttled (every PERF_REPORT_INTERVAL_MS) server
 * [perf] report, which is cheap and is the one diagnostic worth keeping during a real playtest.
 * Every other channel defaults OFF — they gate per-tick/per-frame logging that would dominate
 * CPU and GC if left on. A normal 1v1 must not spam the terminal or browser console.
 */
exports.DEBUG_DEFAULTS = {
    NET_DEBUG: false,
    PERF_DEBUG: true,
    SOAK_DEBUG: false,
    BALL_DEBUG: false,
    PICKUP_DEBUG: false,
    THROW_DEBUG: false,
    COLLISION_DEBUG: false,
    CATCH_DEBUG: false,
    CATCH_TRACE_DEBUG: false,
    PARRY_DEBUG: false,
    BALL_PREDICT_DEBUG: false
};
/** Throttle for the periodic server [perf] report (and client perf line). 5 s per the spec. */
exports.PERF_REPORT_INTERVAL_MS = 5000;
/** Resolve server-side debug flags from env (1/true enables). Returns all-off if env is absent. */
function resolveServerDebugFlags(env = processEnv()) {
    const on = (v) => v === '1' || v === 'true';
    const off = (v) => v === '0' || v === 'false';
    // DEBUG_GAMEPLAY=1 is a convenience switch that turns the gameplay-related channels on at once.
    const all = on(env.DEBUG_GAMEPLAY);
    return {
        NET_DEBUG: all || on(env.NET_DEBUG),
        // PERF_DEBUG defaults ON (cheap throttled report); allow PERF_DEBUG=0 to silence it explicitly.
        PERF_DEBUG: (all || on(env.PERF_DEBUG) || exports.DEBUG_DEFAULTS.PERF_DEBUG) && !off(env.PERF_DEBUG),
        SOAK_DEBUG: all || on(env.SOAK_DEBUG),
        BALL_DEBUG: all || on(env.BALL_DEBUG),
        PICKUP_DEBUG: all || on(env.PICKUP_DEBUG),
        THROW_DEBUG: all || on(env.THROW_DEBUG),
        COLLISION_DEBUG: all || on(env.COLLISION_DEBUG),
        CATCH_DEBUG: all || on(env.CATCH_DEBUG),
        CATCH_TRACE_DEBUG: all || on(env.CATCH_TRACE_DEBUG),
        PARRY_DEBUG: all || on(env.PARRY_DEBUG),
        BALL_PREDICT_DEBUG: all || on(env.BALL_PREDICT_DEBUG)
    };
}
/**
 * Combat sub-steps per live ball per server tick. Each sub-step advances the ball dt/N and runs
 * the full parry→catch→hit pipeline against that sub-tick segment. At 128Hz × 2 = 256Hz effective
 * live-ball interaction checks. Only affects live/deflected balls; held and loose balls skip it.
 */
exports.LIVE_BALL_COMBAT_SUBSTEPS = 2;
/** Human-readable summary of the active config, for the one-time room-created log line. */
function describeNetConfig() {
    return (`mode=${exports.ACTIVE_NET_MODE} sim=${exports.SERVER_TICK_RATE}Hz input=${exports.CLIENT_INPUT_RATE}Hz ` +
        `snapshots=${exports.SNAPSHOT_RATE}Hz interpDelay=${exports.INTERPOLATION_DELAY_MS}ms ` +
        `snapshotTier=${exports.SNAPSHOT_TIER_MODE} snapshotProfile=${describeSnapshotProfile()} ` +
        `combatSubsteps=${exports.LIVE_BALL_COMBAT_SUBSTEPS} effectiveCombat=${exports.SERVER_TICK_RATE * exports.LIVE_BALL_COMBAT_SUBSTEPS}Hz ` +
        `loopWake=${exports.ROOM_LOOP_WAKE_RATE}Hz`);
}
