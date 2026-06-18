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
 *   A. 128 sim / 128 input / 96 snapshots (current smooth 1v1/2v2 target)
 *   B. 90 sim / 90 input / 60 snapshots   (stable lower-bandwidth fallback)
 *   C. 60 sim / 60 input / 60 snapshots   (legacy full-rate fallback)
 *   D. 60 sim / 60 input / 30 snapshots   (bandwidth fallback)
 *   E. 30 sim / 30 input / 30 snapshots   (baseline for constrained hosts)
 */

export type NetMode = 'A_180_180_96' | 'A_180_180_128' | 'A_144_144_96' | 'A_144_144_100' | 'A_144_144_128' | 'A_128_128_96' | 'A_128_128_90' | 'A_120_120_72' | 'A_90_90_60' | 'A_72_72_60' | 'A_60_60_60' | 'B_60_60_30' | 'C_30_30_30';

export interface NetModeConfig {
  /** Server fixed simulation steps per second. */
  serverTickRate: number;
  /** Client input send + local prediction steps per second. Must equal serverTickRate for residual≈0. */
  clientInputRate: number;
  /** Manual snapshot broadcasts per second. May be lower than serverTickRate (fallback mode). */
  snapshotRate: number;
  /**
   * How far behind real time remote players/balls are rendered, in ms. Sized to absorb one to two
   * snapshot intervals plus delivery jitter. Higher snapshot rate → shorter delay is safe.
   *   60Hz snapshots: ~75ms   30Hz snapshots: ~110ms
   */
  interpolationDelayMs: number;
}

const MODES: Record<NetMode, NetModeConfig> = {
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
function processEnv(): Record<string, string | undefined> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
}

function resolveProcessMode(): NetMode {
  const fromProcess = processEnv().NET_MODE as NetMode | undefined;
  if (fromProcess && fromProcess in MODES) return fromProcess;
  return DEFAULT_NET_MODE;
}

/** Compiled default mode. Smooth 1v1/2v2 baseline: 128 sim / 128 input / 96 snapshots. */
export const DEFAULT_NET_MODE: NetMode = 'A_128_128_96';

/**
 * Active mode resolved at module load from process.env (server) or the compiled default (client).
 * Client and server rates are resolved eagerly from this mode. The browser warns if VITE_NET_MODE
 * disagrees with the compiled mode; it does not mutate these constants at runtime.
 */
export const ACTIVE_NET_MODE: NetMode = resolveProcessMode();

/**
 * Client-side hook to validate a VITE_NET_MODE value against the known modes. This keeps the
 * import.meta token in client-only code, never in this shared CommonJS-compiled file.
 */
export function netModeConfig(mode: string | undefined): NetModeConfig | null {
  return mode && mode in MODES ? MODES[mode as NetMode] : null;
}

const active = MODES[ACTIVE_NET_MODE];

export const SERVER_TICK_RATE = active.serverTickRate;
export const CLIENT_INPUT_RATE = active.clientInputRate;
export const SNAPSHOT_RATE = active.snapshotRate;

/** Exact fixed timesteps (seconds). Derived from rate — never a rounded literal. */
export const SERVER_FIXED_DT = 1 / SERVER_TICK_RATE;
export const CLIENT_FIXED_DT = 1 / CLIENT_INPUT_RATE;

/** Milliseconds between snapshot broadcasts. The room loop broadcasts on this cadence. */
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_RATE;
/** Milliseconds between server fixed sim steps. */
export const SERVER_STEP_MS = 1000 / SERVER_TICK_RATE;

export const INTERPOLATION_DELAY_MS = active.interpolationDelayMs;

/**
 * How frequently the room loop wakes to drain the fixed-step accumulator. Wake faster than the sim
 * rate so timer jitter can't starve a step. 200Hz wake (5ms) comfortably feeds a 128Hz sim
 * (~1.56 wakes per step of headroom).
 */
export const ROOM_LOOP_WAKE_RATE = 200;
export const ROOM_LOOP_WAKE_INTERVAL_MS = 1000 / ROOM_LOOP_WAKE_RATE;

/**
 * Max fixed sim steps to run per wake. Prevents a spiral-of-death after a long pause: instead of
 * trying to "catch up" hundreds of frames we cap and discard the backlog. Sized so a single wake
 * can absorb a couple of missed steps without ever simulating a visible time-warp.
 */
export const MAX_ACCUMULATOR_STEPS = 5;

/** Clamp on elapsed time fed into the accumulator (ms). Caps the damage of an alt-tab / GC pause. */
export const MAX_ACCUMULATOR_CLAMP_MS = 250;

/** Max sent inputs the client buffers for reconciliation. Scales to ~1.5s at the active input rate. */
export const PENDING_INPUT_LIMIT = Math.ceil(CLIENT_INPUT_RATE * 1.5);

/** Max inputs the server queues per player before dropping the oldest. ~1s of buffer at the rate. */
export const SERVER_INPUT_QUEUE_LIMIT = Math.max(30, Math.ceil(SERVER_TICK_RATE));

/** Max snapshots the client interpolation buffer keeps (by age, ms). */
export const SNAPSHOT_BUFFER_LIMIT_MS = 1000;

/** How long the client may extrapolate a remote entity past the newest snapshot on buffer underrun. */
export const EXTRAPOLATION_LIMIT_MS = 120;

/** Position error (m) above which interpolation snaps instead of lerping (reset/teleport/glitch). */
export const HUGE_ERROR_SNAP_METERS = 5;

export type SnapshotEncoding = 'compact' | 'full';

function resolveSnapshotEncoding(env: Record<string, string | undefined> = processEnv()): SnapshotEncoding {
  const explicit = env.SNAPSHOT_ENCODING?.toLowerCase();
  if (explicit === 'compact' || explicit === 'full') return explicit;

  const compactFlag = env.USE_COMPACT_SNAPSHOTS?.toLowerCase();
  if (compactFlag === '0' || compactFlag === 'false') return 'full';
  if (compactFlag === '1' || compactFlag === 'true') return 'compact';

  return 'compact';
}

/** Server-side snapshot payload encoding. Override with SNAPSHOT_ENCODING=full for debugging. */
export const SNAPSHOT_ENCODING: SnapshotEncoding = resolveSnapshotEncoding();
export const USE_COMPACT_SNAPSHOTS = SNAPSHOT_ENCODING === 'compact';
export const SNAPSHOT_BACKPRESSURE_BYTES = 64 * 1024;

/**
 * Debug flags. Chatty per-tick/per-frame channels default off because they dominate CPU and GC.
 * PERF_DEBUG is the one exception: it drives only throttled 5s aggregate reports and defaults on.
 * Each may be enabled out-of-band:
 *   - server: env vars (NET_DEBUG=1, PERF_DEBUG=1, BALL_DEBUG=1, PICKUP_DEBUG=1, THROW_DEBUG=1)
 *   - client: localStorage (strafeball.debug.net, .perf, .ball, .pickup, .throw)
 * PERF_DEBUG additionally controls the every-5s [rates] line, which is the one log worth keeping
 * occasionally during a playtest; it is still off unless explicitly enabled.
 */
export interface DebugFlags {
  NET_DEBUG: boolean;
  PERF_DEBUG: boolean;
  SOAK_DEBUG: boolean;
  BALL_DEBUG: boolean;
  PICKUP_DEBUG: boolean;
  THROW_DEBUG: boolean;
  COLLISION_DEBUG: boolean;
  // Combat correctness channels (Phase 13). All per-tick; default OFF for real playtests.
  CATCH_DEBUG: boolean;
  CATCH_TRACE_DEBUG: boolean;
  PARRY_DEBUG: boolean;
  BALL_PREDICT_DEBUG: boolean;
}

/**
 * PERF_DEBUG defaults ON: it only drives the throttled (every PERF_REPORT_INTERVAL_MS) server
 * [perf] report, which is cheap and is the one diagnostic worth keeping during a real playtest.
 * Every other channel defaults OFF — they gate per-tick/per-frame logging that would dominate
 * CPU and GC if left on. A normal 1v1 must not spam the terminal or browser console.
 */
export const DEBUG_DEFAULTS: DebugFlags = {
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
export const PERF_REPORT_INTERVAL_MS = 5000;

/** Resolve server-side debug flags from env (1/true enables). Returns all-off if env is absent. */
export function resolveServerDebugFlags(env: Record<string, string | undefined> = processEnv()): DebugFlags {
  const on = (v: string | undefined): boolean => v === '1' || v === 'true';
  const off = (v: string | undefined): boolean => v === '0' || v === 'false';
  // DEBUG_GAMEPLAY=1 is a convenience switch that turns the gameplay-related channels on at once.
  const all = on(env.DEBUG_GAMEPLAY);
  return {
    NET_DEBUG: all || on(env.NET_DEBUG),
    // PERF_DEBUG defaults ON (cheap throttled report); allow PERF_DEBUG=0 to silence it explicitly.
    PERF_DEBUG: (all || on(env.PERF_DEBUG) || DEBUG_DEFAULTS.PERF_DEBUG) && !off(env.PERF_DEBUG),
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
export const LIVE_BALL_COMBAT_SUBSTEPS = 2;

/** Human-readable summary of the active config, for the one-time room-created log line. */
export function describeNetConfig(): string {
  return (
    `mode=${ACTIVE_NET_MODE} sim=${SERVER_TICK_RATE}Hz input=${CLIENT_INPUT_RATE}Hz ` +
    `snapshots=${SNAPSHOT_RATE}Hz interpDelay=${INTERPOLATION_DELAY_MS}ms ` +
    `combatSubsteps=${LIVE_BALL_COMBAT_SUBSTEPS} effectiveCombat=${SERVER_TICK_RATE * LIVE_BALL_COMBAT_SUBSTEPS}Hz ` +
    `loopWake=${ROOM_LOOP_WAKE_RATE}Hz`
  );
}
