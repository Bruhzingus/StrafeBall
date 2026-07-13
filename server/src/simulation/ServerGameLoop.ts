import { GAME_CONSTANTS, deriveCombatTimingConstants, type CombatTiming } from '../../../shared/constants';
import { performance } from 'node:perf_hooks';
import {
  ACTIVE_NET_MODE,
  DEBUG_DEFAULTS,
  LIVE_BALL_COMBAT_SUBSTEPS,
  netModeConfig,
  type DebugFlags,
  type NetMode,
  type NetModeConfig
} from '../../../shared/netConfig';
import type {
  BallState,
  DashState,
  HandSide,
  MatchFormat,
  MatchSettings,
  MatchState,
  MatchMode,
  MatchStatus,
  PlayerCombatState,
  PlayerInput,
  PlayerState,
  RoomState,
  RoomSettings,
  SpawnSide,
  Vec3
} from '../../../shared/types';
import type { CatchEvent, HitEvent, HitRevertEvent, ParryEvent, RoomSettingsPatch, ServerSnapshot, ThrowEvent } from '../../../shared/protocol';
import {
  canonicalizeRoomSettings,
  defaultRoomSettings,
  isAllowedFormat,
  resolveMatchSettings,
  roomPhaseFromMatchStatus,
  validateRoomSettingsPatch,
  votesRequiredForPass
} from '../../../shared/roomSettings';
import type { BounceRule } from '../../../shared/simulation/BallSim';
import { TimeRing, type BallSample, type DefenseSample } from './DefenseHistory';
import {
  advanceBall,
  applyBallBounce,
  applyMatBounce,
  catchBall,
  createBallState,
  deflectBall,
  isBallCatchableInFlight,
  markBallDead,
  settleBallIfSlow
} from '../../../shared/simulation/BallSim';
import {
  add,
  clamp,
  cloneVec3,
  closestPointOnSegment,
  distance,
  length,
  normalize,
  scale,
  sweptBallHitsBody,
  vec3
} from '../../../shared/simulation/CollisionMath';
import {
  beginCharge,
  cancelCharge,
  createHands,
  dropBallFromHand,
  heldBallCount,
  sweptCatchFailReason,
  sweptParryFailReason,
  tickHands,
  throwBallFromHand,
  tryPickupBall,
  type SweptCatchFailReason,
  type SweptParryFailReason
} from '../../../shared/simulation/HandSim';
import { createEndVoteState, createIntermissionVoteState, createMatStates, createResetVoteState, createRoomState, createStartVoteState } from '../../../shared/simulation/MatchSim';
import { createDashState, createMovementInternalState, createPlayerState, grantDashCharge } from '../../../shared/simulation/PlayerSim';
import { advanceNoBoundariesTimer, applyHalfCourtRule, createMatchState, matchWinnerFromRounds } from '../../../shared/simulation/RuleSim';
import {
  BLEACHER_LAYOUT,
  createBallCollisionBoxes,
  createPlayerCollisionBoxes,
  matFallDirection,
  matCollisionBox,
  matSpecsForPreset,
  type AABB,
  type MatSpec
} from '../../../shared/simulation/MapGeometry';
import { facingFromAngles, stepMovement } from '../../../shared/simulation/MovementSim';
import { clampLookPitch } from '../../../shared/simulation/AimMath';
import { computePlayerHandAnchor } from '../../../shared/simulation/HandAnchors';
import { calculateThrow, isCurveThrow } from '../../../shared/simulation/ThrowMath';
import { playerBallHitRadius, playerHitCapsule } from '../../../shared/simulation/PlayerHitbox';
import { BATTLE_MUSIC_TRACKS } from '../../../shared/music/generatedBattleMusicManifest';
import {
  createBattleMusicSessionSeed,
  createInactiveBattleMusicSyncState,
  type BattleMusicSyncState
} from '../../../shared/music/BattleMusic';

export interface ServerGameLoopOptions {
  /**
   * The room's net mode, resolved once at creation from the host's tick preset (shared/tickPresets).
   * Drives the sim tick rate AND the combat lag-comp window derivation, and is echoed on
   * RoomState.netMode so clients adopt the matching rates. Omitted → the process-wide active mode
   * (legacy callers/tests), which is byte-identical to the old global-constant behavior.
   */
  netMode?: NetMode;
  /** Explicit tick-rate override; wins over netMode's rate. Test-only escape hatch. */
  tickRate?: number;
  mode?: MatchMode;
  playersPerTeam?: number;
  teamIds?: string[];
  /**
   * Authoritative host settings the room was created with. When provided, the team geometry and every
   * per-round rule the loop uses are derived from these. When omitted, defaults are built from `mode`/
   * `playersPerTeam` (the recommended preset for that format), preserving the legacy constructor.
   */
  settings?: RoomSettings;
  logger?: (message: string) => void;
  battleMusicTrackCount?: number;
  /** Per-channel debug flags. All default OFF — a real playtest produces zero per-tick logging. */
  debug?: Partial<DebugFlags>;
  /**
   * Backward-compat shim for the old constructor shape. `debugInput: true` maps to NET_DEBUG so
   * existing callers (and tests) keep compiling. Prefer `debug` for new code.
   */
  debugInput?: boolean;
  /**
   * Wall-clock source (ms). Defaults to Date.now. Injectable so combat timing (catch windows,
   * defensive/ball history timestamps, stale-input detection) can be driven by a deterministic
   * virtual clock in tests — the only way to exercise the real fixed tick spacing + network latency
   * without sleeping. Production passes nothing and gets Date.now.
   */
  now?: () => number;
}

export interface ThrowRequestPayload {
  hand?: HandSide;
  direction?: Vec3;
  charge01?: number;
  // Backflip QTE success tier (1..tierCount) carried from the client's landing event; 0/undefined
  // for a normal throw. Validated server-side before it affects speed.
  backflipTier?: number;
}

export interface CatchParryPayload {
  hand?: HandSide;
  facing?: Vec3;
}

type ActionResult = { ok: true; log?: string } | { ok: false; reason: string };

interface QueuedInput {
  seq: number;
  input: PlayerInput;
}

export interface PlayerNetworkDebugStats {
  playerId: string;
  lastProcessedInputSeq: number;
  lastEnqueuedInputSeq: number;
  duplicateOrOutOfOrderInputs: number;
  staleResetInputs: number;
  inputQueueDepthCurrent: number;
  inputQueueDepthAvg: number;
  inputQueueDepthMax: number;
  inputsDrainedAvg: number;
  inputsDrainedMax: number;
  lastInputAgeMs: number;
  ackAgeEstimateMs: number | null;
}

interface PlayerSlot {
  teamId: string;
  spawnSide: SpawnSide;
  teamSlotIndex: number;
  position: Vec3;
  yawRadians: number;
}

interface PlayerNetWindowStats {
  inputQueueDepthTotal: number;
  inputQueueDepthSamples: number;
  inputQueueDepthMax: number;
  inputsDrainedTotal: number;
  inputsDrainedSamples: number;
  inputsDrainedMax: number;
  duplicateOrOutOfOrderInputs: number;
  staleResetInputs: number;
}

const EMPTY_THROW_EVENTS: ReadonlyArray<ThrowEvent> = [];
const EMPTY_COMBAT_EVENTS: ReadonlyArray<CatchEvent | ParryEvent | HitEvent | HitRevertEvent> = [];

/**
 * An in-flight server-authoritative catch attempt opened by one client click. The attempt evaluates
 * each live-ball tick while `nowMs` is within [openedAtMs+startup, openedAtMs+active]; it blocks a
 * new attempt for the same hand until `cooldownUntilMs`. `clickTimeMs` anchors the lag-comp rewind.
 */
interface CatchAttempt {
  hand: HandSide;
  attemptId: number;
  openedAtMs: number;
  activeUntilMs: number;
  cooldownUntilMs: number;
  /** Server time we rewind defense+ball history to (derived from the input's client/seq timing). */
  clickTimeMs: number;
  /** Lag-comp rewind (ms) applied when evaluating this attempt against ball/defense history. */
  rewindMs: number;
  /** Raw client timestamp of the click (sub-tick precision anchor for future RTT-aware rewind). */
  clientClickMs: number;
  resolved: boolean;
}

/**
 * A hit the server applied this recently. If a lag-compensated catch from the SAME defender
 * legitimately claims that ball within `catchHitGraceMs`, the hit's score is reverted (the
 * high-ping defender's well-timed catch arrived after the server had already scored the hit).
 */
/** Report-card hit classification captured at impact (direct/bounce are mutually exclusive). */
interface HitStatBreakdown {
  direct: boolean;
  bounce: boolean;
  curve: boolean;
  backflip: boolean;
}

interface RecentHit {
  ballId: string;
  defenderId: string;
  throwerId: string;
  throwerTeamId: string;
  value: number;
  /** Amount added to the 1v1 hit-tally scoreByTeamId stat (0 for 2v2); reverted with the hit. */
  scoreDelta?: number;
  /** Hit-type breakdown stats recorded for the thrower; reverted with the hit. */
  statBreakdown?: HitStatBreakdown;
  atMs: number;
  kind: 'score' | 'life';
  defenderLivesBefore?: number;
  defenderCombatStateBefore?: PlayerCombatState;
  defenderEliminatedAtMsBefore?: number | null;
  matchStatusBefore?: MatchState['status'];
  winnerTeamIdBefore?: string | null;
  /** Round bookkeeping BEFORE the hit, so a lag-comp revert can undo a round it just decided. */
  currentRoundBefore?: number;
  roundsWonByTeamIdBefore?: Record<string, number>;
  countdownSecondsBefore?: number;
  roundRebuildPendingBefore?: boolean;
  /** Thrower's dash state BEFORE the hit granted them a charge (restored on revert). */
  throwerDashBefore: DashState;
}

/** Reason a catch attempt failed to land — surfaced under CATCH_DEBUG (Phase 13). */
type CatchFailReason = SweptCatchFailReason;

/** Reason an auto-parry failed — surfaced under PARRY_DEBUG (Phase 13). */
type ParryFailReason = SweptParryFailReason;

interface LegacyPlayerInput {
  jump: boolean;
  crouch: boolean;
  slide: boolean;
  dash: boolean;
  backflip: boolean;
  interact: boolean;
  drop: boolean;
  fakeThrow: boolean;
  leftHand: boolean;
  rightHand: boolean;
}

const SPAWN_BASE_BY_SIDE: Record<SpawnSide, { position: Vec3; yawRadians: number }> = {
  negativeZ: { position: vec3(0, 0, -12), yawRadians: 0 },
  positiveZ: { position: vec3(0, 0, 12), yawRadians: Math.PI }
};

// Max inputs buffered per player before we drop the oldest. Driven by netConfig so the buffer
// scales with the active tick rate (~1 s of headroom) instead of a hardcoded 30Hz assumption.
// If no fresh input arrives for this long, the player's input is treated as neutral (so a
// backgrounded/frozen tab doesn't keep walking or charging on the last-held input).
const STALE_INPUT_MS = 1000;
// A landing-QTE packet can reach the server on the same tick the authoritative sim crosses the
// ground plane, before MovementSim has flipped `grounded` back to true. Keep this cushion tight so
// high airborne or wall-run spoof attempts still downgrade to a normal throw.
const BACKFLIP_QTE_LANDING_GRACE_HEIGHT = 0.55;
const BACKFLIP_QTE_MAX_UPWARD_GRACE_SPEED = 0.5;
// Default dashDirection for an input whose dashDirection was trimmed from the wire (zero vector).
// MUST be zero, not the previous input, so the sim derives the dash dir from the wish/facing — see
// normalizeInput. Frozen so it can't be mutated by a downstream consumer.
const ZERO_DASH_DIRECTION: Readonly<Vec3> = Object.freeze(vec3());
const START_VOTE_TTL_MS = GAME_CONSTANTS.match.startVoteSeconds * 1000;
const RESET_VOTE_TTL_MS = GAME_CONSTANTS.match.resetVoteSeconds * 1000;
const END_VOTE_TTL_MS = GAME_CONSTANTS.match.resetVoteSeconds * 1000;
// How long a between-rounds intermission lingers on the report card before auto-starting the next
// round, if the players haven't voted to continue or to return to the lobby first.
const INTERMISSION_TIMEOUT_MS = 30_000;
const LAST_PLAYER_BUFF_MS = GAME_CONSTANTS.match.lastPlayerBuffSeconds * 1000;

export class ServerGameLoop {
  public readonly tickRate: number;
  /** The room's net mode (creation-time tick preset), echoed on RoomState for clients to adopt. */
  public readonly netMode: NetMode;
  // Combat lag-comp windows derived from THIS room's tick/snapshot/interp timing — never read
  // GAME_CONSTANTS.combat here, it is frozen to the compiled default mode.
  private readonly combatTiming: CombatTiming;
  // ~1s of input buffer at this room's tick rate (was the process-global SERVER_INPUT_QUEUE_LIMIT).
  private readonly maxInputQueue: number;
  public state: RoomState;

  private readonly roomId: string;
  private readonly tickSeconds: number;
  private readonly logger: (message: string) => void;
  private readonly debug: DebugFlags;
  private readonly matchMode: MatchMode;
  private readonly teamIds: readonly string[];
  private readonly playersPerTeam: number;
  private readonly maxPlayers: number;
  private readonly teamsRequiredToPlay: number;
  // Authoritative host settings (intent) + their resolved engine parameters. Mutable so the host can
  // change them between games (handleUpdateRoomSettings). `format` and the derived team geometry stay
  // fixed for the room's life in this stage; in-room format switching is deferred (see that handler).
  private settings: RoomSettings;
  private matchSettings: MatchSettings;
  // Settings-driven live-ball bounce rule, recomputed whenever settings change.
  private bounceRule: BounceRule;
  // The mats that currently exist for this room (host matPreset subset). The authoritative mat state
  // and BOTH collision worlds are derived from this, so visuals + player + ball collision agree.
  private activeMatSpecs: MatSpec[];
  // Set when a round ended and the room is in the inter-round countdown: the new round's world is
  // rebuilt (full lives, fresh balls/mats) only when that countdown flips to 'playing', which is far
  // longer than the lag-comp catch grace — so a hit-revert during the gap cleanly cancels the round.
  private roundRebuildPending = false;
  // Session id of the host (room creator). Reassigned to another connected player on host departure.
  private hostPlayerId: string | null = null;
  private readonly battleMusicTrackCount: number;
  private readonly playerSlots: readonly PlayerSlot[];
  /** Injectable wall-clock (ms). Defaults to Date.now; overridden by a virtual clock in tests. */
  private readonly now: () => number;
  // Players AND balls collide with bleachers + STANDING mats; both sets are rebuilt whenever a mat
  // is knocked over so a downed mat becomes walkable AND lets balls pass over it.
  private playerCollisionBoxes = createPlayerCollisionBoxes();
  private ballCollisionBoxes = createBallCollisionBoxes();
  private readonly playerCollisionScratch: AABB[] = [];
  private readonly ballCollisionScratch: AABB[] = [];
  private readonly knockedOverMatIds = new Set<string>();
  // Hold-E mat restore: per-player CONSECUTIVE HELD TICKS toward standing the nearest knocked-over
  // mat back up. Resets when E is released or the player moves out of reach. Tick count, not
  // accumulated dt seconds: summing float dts lands just below the threshold at rates whose dt
  // isn't dyadic (e.g. 180Hz: 63 × fl(1/180) = 0.34999999999999976 < fl(0.35)), demanding a
  // spurious extra tick — the same boundary bug class as the knock-immunity timer below.
  private readonly matRestoreHoldTicksByPlayerId = new Map<string, number>();
  // Brief per-mat grace after a reset so the restoring player can step clear before contact
  // knock-over is allowed again. Keyed by ABSOLUTE expiry tick (not seconds-remaining decremented
  // per step): a decrementing-float timer loses exactly one tick of grace whenever
  // ticks * dt lands past the target with no slack, which floating-point rounding masked at some
  // tick rates (90Hz) and exposed at others (128Hz, where dt is exactly dyadic) — same duration,
  // different apparent behavior depending on server tick rate. Tick-count comparison is exact at
  // any rate, which matters once tick rate is player-selectable.
  private readonly matPostResetKnockImmunityUntilTickById = new Map<string, number>();
  private static readonly MAT_RESTORE_HOLD_SECONDS = GAME_CONSTANTS.mat.restoreHoldSeconds;
  private static readonly MAT_RESTORE_REACH = GAME_CONSTANTS.mat.restoreReach;
  private static readonly MAT_POST_RESET_KNOCK_IMMUNITY_SECONDS = GAME_CONSTANTS.mat.postResetKnockImmunitySeconds;

  private readonly inputQueueByPlayerId = new Map<string, QueuedInput[]>();
  private readonly lastInputByPlayerId = new Map<string, PlayerInput>();
  private readonly previousInputByPlayerId = new Map<string, PlayerInput>();
  private readonly lastInputAtByPlayerId = new Map<string, number>();
  private readonly lastProcessedInputAtByPlayerId = new Map<string, number>();
  private readonly lastEnqueuedSeqByPlayerId = new Map<string, number>();
  private readonly inputRttMsByPlayerId = new Map<string, number>();
  private readonly parryCooldownByPlayerId = new Map<string, number>();
  private readonly lastInputDebugAtByPlayerId = new Map<string, number>();
  private readonly playerNetWindowStatsByPlayerId = new Map<string, PlayerNetWindowStats>();
  private readonly teamChoicesByPlayerId = new Set<string>();
  private readonly startVotesByPlayerId = new Map<string, number>();
  private readonly resetVotesByPlayerId = new Map<string, number>();
  // Early-end vote: connected players who have agreed to abort the live game, plus who opened it.
  private readonly endVotesByPlayerId = new Map<string, number>();
  private endVoteInitiatorId: string | null = null;
  // Between-rounds / post-match intermission vote: who picked "next round" vs "back to lobby", plus
  // the deadline at which an undecided intermission auto-advances to the next round.
  private readonly intermissionNextVotes = new Set<string>();
  private readonly intermissionLobbyVotes = new Set<string>();
  private intermissionDeadlineAtMs: number | null = null;
  // Anti "2-ball technique": tracks each player's most recent throw so a second throw landing
  // within `doubleThrowWindowSeconds` of the first gets BOTH balls slowed (see handleThrow).
  private readonly lastThrowByPlayerId = new Map<string, { atMs: number; ballId: string }>();
  private resetSerial = 0;

  // Cheap combat counters for the throttled server [perf] report (verify the lag-comp catch fix in
  // production). Plain integers, no allocations; drained + reset each report window by the room.
  private readonly combatMetrics = {
    catchAttemptsOpened: 0, // distinct catch clicks accepted
    catches: 0,             // catches that landed (present-time OR lag-comp reclaim)
    reclaimCatches: 0,      // of those, ones the lag-comp reclaim pass claimed (high-ping saves)
    parries: 0,
    hits: 0,
    hitReverts: 0           // hits undone because a lag-comp catch superseded them
  };
  // Windowed input-drain counters for the throttled [perf] line. These make packet bunching visible
  // without per-tick logging: healthy steady-state is max/avg near 1, backlog drain shows >1.
  private readonly inputDrainMetrics = {
    samples: 0,
    inputsDrainedTotal: 0,
    maxInputsDrainedThisTick: 0,
    maxInputQueueBeforeDrain: 0
  };

  // --- Server-authoritative combat (catch attempts + lag-compensated defense) ---
  // Per-player defensive-state history (eye/aim/hands/dashing per tick), rewound to the click
  // moment when validating a catch/parry so a high-ping defender is judged fairly. Capped by age.
  private readonly defenseHistoryByPlayerId = new Map<string, TimeRing<DefenseSample>>();
  // Per-ball position history, used to reconstruct the ball's swept segment around a rewound click.
  private readonly ballHistoryById = new Map<string, TimeRing<BallSample>>();
  // Open catch windows per player+hand. A click opens one; it evaluates during its active span,
  // then blocks re-attempts until its cooldown elapses. Keyed `${playerId}:${hand}`.
  private readonly catchAttemptByKey = new Map<string, CatchAttempt>();
  // Highest catch-attempt id consumed per player+hand (dedupe latched re-sends). Keyed as above.
  private readonly lastCatchAttemptIdByKey = new Map<string, number>();
  // De-spam catch trace evaluation lines: one line per player/hand/attempt/ball/reason.
  private readonly catchTraceEvalSeen = new Set<string>();
  // Hits applied in the last ~catchHitGraceMs, keyed by ballId. A lag-compensated catch from the
  // hit defender can revert the score if their well-timed catch arrived after the server scored.
  private readonly recentHitByBallId = new Map<string, RecentHit>();
  // Monotonic throw identity — assigned to each new live throw/deflect (see BallState.throwId).
  private throwCounter = 0;
  // Throw events accepted this step, drained by the room and broadcast before the next snapshot.
  private pendingThrowEvents: ThrowEvent[] = [];
  // Immediate combat events (catch/parry/hit/revert) queued each step, broadcast before snapshot.
  private pendingCombatEvents: Array<CatchEvent | ParryEvent | HitEvent | HitRevertEvent> = [];
  // Wall-clock time of the current step, captured once at the top of step() for history timestamps.
  private stepNowMs = 0;
  private lastSnapshotBuildMs = 0;
  private battleMusicSyncState: BattleMusicSyncState = createInactiveBattleMusicSyncState();
  private battleMusicSyncDirty = false;
  private nextBattleMusicSessionId = 0;

  constructor(roomId: string, options: ServerGameLoopOptions = {}) {
    this.roomId = roomId;
    this.netMode = options.netMode ?? ACTIVE_NET_MODE;
    // Every NetMode key resolves; the cast documents that invariant (tickPresets only maps to keys).
    const netTiming = netModeConfig(this.netMode) as NetModeConfig;
    this.tickRate = options.tickRate ?? netTiming.serverTickRate;
    this.tickSeconds = 1 / this.tickRate;
    this.maxInputQueue = Math.max(30, Math.ceil(this.tickRate));
    this.combatTiming = deriveCombatTimingConstants({
      serverStepMs: this.tickSeconds * 1000,
      interpolationDelayMs: netTiming.interpolationDelayMs,
      snapshotIntervalMs: 1000 / netTiming.snapshotRate
    });
    this.logger = options.logger ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.teamIds = options.teamIds?.length ? [...options.teamIds] : [...GAME_CONSTANTS.match.teamIds];
    // Resolve the authoritative host settings ONCE up front. The team geometry (playersPerTeam/
    // maxPlayers) and every per-round rule below are derived from them rather than from loose
    // constructor args. Legacy callers that pass only `mode`/`playersPerTeam` get the recommended
    // preset for the implied format, so behavior is unchanged.
    this.settings = options.settings
      ? canonicalizeRoomSettings(options.settings)
      : defaultRoomSettings(resolveConstructorFormat(options));
    this.matchSettings = resolveMatchSettings(this.settings);
    this.bounceRule = bounceRuleFromSettings(this.matchSettings);
    this.activeMatSpecs = matSpecsForPreset(this.matchSettings.matPreset);
    this.matchMode = this.settings.format;
    this.playersPerTeam = Math.max(1, this.matchSettings.teamSize);
    this.maxPlayers = this.teamIds.length * this.playersPerTeam;
    this.teamsRequiredToPlay = Math.min(2, this.teamIds.length);
    this.battleMusicTrackCount = Math.max(0, Math.trunc(options.battleMusicTrackCount ?? BATTLE_MUSIC_TRACKS.length));
    this.playerSlots = buildPlayerSlots(this.teamIds, this.playersPerTeam);
    // All flags default OFF. The legacy `debugInput` boolean maps to NET_DEBUG for compat; an
    // explicit `debug.NET_DEBUG` (if provided) wins over it.
    this.debug = {
      ...DEBUG_DEFAULTS,
      NET_DEBUG: options.debug?.NET_DEBUG ?? options.debugInput ?? DEBUG_DEFAULTS.NET_DEBUG,
      PERF_DEBUG: options.debug?.PERF_DEBUG ?? DEBUG_DEFAULTS.PERF_DEBUG,
      SOAK_DEBUG: options.debug?.SOAK_DEBUG ?? DEBUG_DEFAULTS.SOAK_DEBUG,
      BALL_DEBUG: options.debug?.BALL_DEBUG ?? DEBUG_DEFAULTS.BALL_DEBUG,
      PICKUP_DEBUG: options.debug?.PICKUP_DEBUG ?? DEBUG_DEFAULTS.PICKUP_DEBUG,
      THROW_DEBUG: options.debug?.THROW_DEBUG ?? DEBUG_DEFAULTS.THROW_DEBUG,
      COLLISION_DEBUG: options.debug?.COLLISION_DEBUG ?? DEBUG_DEFAULTS.COLLISION_DEBUG,
      CATCH_DEBUG: options.debug?.CATCH_DEBUG ?? DEBUG_DEFAULTS.CATCH_DEBUG,
      CATCH_TRACE_DEBUG: options.debug?.CATCH_TRACE_DEBUG ?? DEBUG_DEFAULTS.CATCH_TRACE_DEBUG,
      PARRY_DEBUG: options.debug?.PARRY_DEBUG ?? DEBUG_DEFAULTS.PARRY_DEBUG,
      BALL_PREDICT_DEBUG: options.debug?.BALL_PREDICT_DEBUG ?? DEBUG_DEFAULTS.BALL_PREDICT_DEBUG
    };
    this.state = this.createFreshRoomState();
  }

  addPlayer(playerId: string, rawName?: string): PlayerState | null {
    if (this.playerCount() >= this.maxPlayers) return null;
    if (this.state.players[playerId]) return this.state.players[playerId];

    const slot = this.nextPlayerSlot();
    if (!slot) return null;

    const name = sanitizeName(rawName, this.playerCount() + 1);
    // Mid-match late join: a player who joins (fresh sessionId) while a match is already in
    // countdown/playing must NOT enter as a full-lives fighter — otherwise someone can leave after
    // being eliminated and rejoin to "respawn" with a full life count. They join as a spectator
    // (eliminated, 0 lives); the next room reset rebuilds every roster member with full lives, so
    // they fight normally in the following match. (A genuine drop+reconnect keeps its state via the
    // framework's reconnection window and never reaches addPlayer.)
    const matchInProgress = this.state.match.status === 'countdown' || this.state.match.status === 'playing';
    const player = createPlayerState(playerId, slot.teamId, slot.spawnSide, {
      name,
      spawnSide: slot.spawnSide,
      teamSlotIndex: slot.teamSlotIndex,
      movement: this.spawnMovement(slot),
      ...(matchInProgress
        ? { lives: 0, combatState: 'eliminated' as const, eliminatedAtMs: this.now() }
        // Starting lives come from the host setting, not the bare constant.
        : { lives: this.matchSettings.livesPerPlayer })
    });

    this.state.players[playerId] = player;
    this.seedInputTracking(playerId, slot.yawRadians);
    this.syncPlayerScores();
    this.ensureHostAssignment();
    this.markAutoAssignedTeamChoice(player);
    this.reconcilePregameState('join');
    this.syncRoomPhase();
    return player;
  }

  removePlayer(playerId: string): void {
    const player = this.state.players[playerId];
    if (!player) return;

    this.dropAllHeldBalls(player);
    delete this.state.players[playerId];
    this.inputQueueByPlayerId.delete(playerId);
    this.lastInputByPlayerId.delete(playerId);
    this.previousInputByPlayerId.delete(playerId);
    this.lastInputAtByPlayerId.delete(playerId);
    this.lastProcessedInputAtByPlayerId.delete(playerId);
    this.lastEnqueuedSeqByPlayerId.delete(playerId);
    this.inputRttMsByPlayerId.delete(playerId);
    this.parryCooldownByPlayerId.delete(playerId);
    this.lastInputDebugAtByPlayerId.delete(playerId);
    this.playerNetWindowStatsByPlayerId.delete(playerId);
    this.defenseHistoryByPlayerId.delete(playerId);
    this.lastThrowByPlayerId.delete(playerId);
    this.catchAttemptByKey.delete(`${playerId}:left`);
    this.catchAttemptByKey.delete(`${playerId}:right`);
    this.lastCatchAttemptIdByKey.delete(`${playerId}:left`);
    this.lastCatchAttemptIdByKey.delete(`${playerId}:right`);
    this.teamChoicesByPlayerId.delete(playerId);
    this.startVotesByPlayerId.delete(playerId);
    this.resetVotesByPlayerId.delete(playerId);
    this.endVotesByPlayerId.delete(playerId);
    this.intermissionNextVotes.delete(playerId);
    this.intermissionLobbyVotes.delete(playerId);
    this.ensureHostAssignment();
    this.reconcilePregameState('remove');
    this.pruneEndVotes(this.now());
    this.syncRoomPhase();
  }

  /** Mark a player connected/disconnected (drives match pause + the connected flag). */
  setConnected(playerId: string, connected: boolean, reconnectDeadlineAtMs: number | null = null): void {
    const player = this.state.players[playerId];
    if (!player) return;
    if (!connected) this.dropAllHeldBalls(player);
    player.connected = connected;
    player.reconnectDeadlineAtMs = connected ? null : reconnectDeadlineAtMs;
    if (connected) this.lastInputAtByPlayerId.set(playerId, this.now());
    this.ensureHostAssignment();
    this.reconcilePregameState(connected ? 'reconnect' : 'disconnect');
    this.syncRoomPhase();
  }

  /**
   * Handle a player abandoning (a non-consented leave that didn't reconnect in time). If that leaves
   * only one connected team in an active match, the remaining team wins by forfeit.
   */
  abandon(playerId: string): void {
    const player = this.state.players[playerId];
    if (!player) return;
    this.removePlayer(playerId);
    this.resolveForfeitIfNeeded('abandon');
  }

  dispose(): void {
    this.inputQueueByPlayerId.clear();
    this.lastInputByPlayerId.clear();
    this.previousInputByPlayerId.clear();
    this.lastInputAtByPlayerId.clear();
    this.lastProcessedInputAtByPlayerId.clear();
    this.lastEnqueuedSeqByPlayerId.clear();
    this.inputRttMsByPlayerId.clear();
    this.parryCooldownByPlayerId.clear();
    this.lastInputDebugAtByPlayerId.clear();
    this.playerNetWindowStatsByPlayerId.clear();
    this.defenseHistoryByPlayerId.clear();
    this.lastThrowByPlayerId.clear();
    this.ballHistoryById.clear();
    this.catchAttemptByKey.clear();
    this.lastCatchAttemptIdByKey.clear();
    this.catchTraceEvalSeen.clear();
    this.recentHitByBallId.clear();
    this.teamChoicesByPlayerId.clear();
    this.startVotesByPlayerId.clear();
    this.resetVotesByPlayerId.clear();
    this.endVotesByPlayerId.clear();
    this.clearIntermissionVotes();
  }

  /** Enqueue a client input. `seq` lets the client reconcile; out-of-order/dupes are ignored. */
  handleInput(playerId: string, rawInput: Partial<PlayerInput> = {}, seq = 0, rttMs?: number): boolean {
    const player = this.state.players[playerId];
    if (!player) return false;

    // Reject inputs from BEFORE the latest room reset. After a reset the client restarts its input
    // sequence at 0, but pre-reset packets (high seq) may still be in flight; if accepted, they bump
    // lastEnqueuedSeq back to a stale-high value and every fresh post-reset input is then dropped as
    // a "duplicate" — freezing the player at spawn. A MISSING resetSerial (undefined) means a legacy
    // client that predates the field and is allowed through; a present value (including 0, the
    // pre-first-reset baseline) is gated strictly against the current timeline.
    if (rawInput.resetSerial !== undefined) {
      const inputResetSerial = Math.max(0, Math.trunc(Number(rawInput.resetSerial) || 0));
      if (inputResetSerial < this.resetSerial) {
        this.playerNetWindowStats(playerId).staleResetInputs += 1;
        if ((rawInput.leftCatchAttemptId ?? 0) > 0 || (rawInput.rightCatchAttemptId ?? 0) > 0) {
          this.catchTrace(
            `input-received player=${playerId} seq=${seq} resetSerial=${inputResetSerial}/${this.resetSerial}` +
            ` left=${rawInput.leftCatchAttemptId ?? 0} right=${rawInput.rightCatchAttemptId ?? 0} result=drop reason=stale-reset`
          );
        }
        return true; // stale timeline → drop
      }
    }

    const lastSeq = this.lastEnqueuedSeqByPlayerId.get(playerId) ?? 0;
    const sequence = Number.isFinite(seq) ? seq : 0;
    if (sequence > 0 && sequence <= lastSeq) {
      this.playerNetWindowStats(playerId).duplicateOrOutOfOrderInputs += 1;
      if ((rawInput.leftCatchAttemptId ?? 0) > 0 || (rawInput.rightCatchAttemptId ?? 0) > 0) {
        this.catchTrace(
          `input-received player=${playerId} seq=${sequence} lastSeq=${lastSeq}` +
          ` left=${rawInput.leftCatchAttemptId ?? 0} right=${rawInput.rightCatchAttemptId ?? 0} result=drop reason=stale-seq`
        );
      }
      return true; // stale/duplicate
    }
    if (sequence > 0) this.lastEnqueuedSeqByPlayerId.set(playerId, sequence);
    this.updateInputRttEstimate(playerId, rttMs);

    const fallback = this.lastInputByPlayerId.get(playerId);
    const input = normalizeInput({ ...rawInput, sequence }, fallback);
    if (input.leftCatchAttemptId > 0 || input.rightCatchAttemptId > 0) {
      this.catchTrace(
        `input-received player=${playerId} seq=${sequence || lastSeq} resetSerial=${input.resetSerial}` +
        ` left=${input.leftCatchAttemptId} right=${input.rightCatchAttemptId}` +
        ` clientTimeMs=${Math.round(input.clientTimeMs)} queueBefore=${this.inputQueueByPlayerId.get(playerId)?.length ?? 0}`
      );
    }
    this.lastInputByPlayerId.set(playerId, input);
    this.lastInputAtByPlayerId.set(playerId, this.now());

    const queue = this.inputQueueByPlayerId.get(playerId) ?? [];
    queue.push({ seq: sequence || lastSeq, input });
    while (queue.length > this.maxInputQueue) queue.shift();
    this.inputQueueByPlayerId.set(playerId, queue);
    return true;
  }

  private updateInputRttEstimate(playerId: string, rttMs: number | undefined): void {
    if (typeof rttMs !== 'number' || !Number.isFinite(rttMs)) return;
    const clamped = clamp(
      rttMs,
      0,
      this.combatTiming.catchMaxRttMs
    );
    const previous = this.inputRttMsByPlayerId.get(playerId);
    this.inputRttMsByPlayerId.set(playerId, previous === undefined ? clamped : previous * 0.85 + clamped * 0.15);
  }

  private catchRewindMsForPlayer(playerId: string): number {
    const rttMs = this.inputRttMsByPlayerId.get(playerId) ?? this.combatTiming.catchDefaultRttMs;
    const raw = this.combatTiming.catchRewindMs + (rttMs - this.combatTiming.catchDefaultRttMs);
    return clamp(raw, this.combatTiming.defenseInputGraceMs, this.combatTiming.defenseMaxRewindMs);
  }

  private catchTrace(message: string): void {
    if (!this.debug.CATCH_TRACE_DEBUG && !this.debug.CATCH_DEBUG) return;
    this.logger(`[catch/trace] ${message}`);
  }

  handlePickup(playerId: string): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (!this.isPlayerAlive(player)) return { ok: false, reason: 'eliminated' };

    const pp = player.movement.position;
    const allBalls = Object.values(this.state.balls);
    const candidates = allBalls
      .map((ball) => ({ ball, distance: distance(ball.position, pp) }))
      .sort((a, b) => a.distance - b.distance);

    if (this.debug.PICKUP_DEBUG) {
      this.logger(
        `pickup attempt player=${playerId} pos=(${pp.x.toFixed(2)},${pp.y.toFixed(2)},${pp.z.toFixed(2)}) balls=${allBalls.length}`
      );
      for (const { ball, distance: dist } of candidates.slice(0, 4)) {
        this.logger(
          `  ball=${ball.id} phase=${ball.phase} owner=${ball.ownerId ?? 'none'}` +
          ` pos=(${ball.position.x.toFixed(2)},${ball.position.y.toFixed(2)},${ball.position.z.toFixed(2)})` +
          ` dist=${dist.toFixed(2)} pickupRadius=${GAME_CONSTANTS.ball.pickupRadius}`
        );
      }
    }

    for (const { ball } of candidates) {
      const result = tryPickupBall(player, player.hands, ball);
      if (!result.ok) continue;

      this.state.players[playerId] = { ...player, hands: result.hands };
      this.state.balls[ball.id] = result.ball;
      return { ok: true, log: `pickup accepted player=${playerId} ball=${ball.id} hand=${result.hand}` };
    }

    return { ok: false, reason: heldBallCount(player.hands) >= GAME_CONSTANTS.ball.maxHeldBalls ? 'hands-full' : 'no-pickup-candidate' };
  }

  handleDrop(playerId: string, requestedHand?: HandSide): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (!this.isPlayerAlive(player)) return { ok: false, reason: 'eliminated' };

    const hand = requestedHand ?? preferredDropHand(player);
    if (!hand) return { ok: false, reason: 'empty-hands' };

    const ballId = player.hands[hand].heldBallId;
    if (!ballId) return { ok: false, reason: 'empty-hand' };

    const ball = this.state.balls[ballId];
    if (!ball) return { ok: false, reason: 'missing-ball' };

    const result = dropBallFromHand(player.hands, hand, ball, heldBallPosition(player, hand), dropReleaseVelocity(player.movement.velocity));
    if (!result.ok) return result;

    this.state.players[playerId] = { ...player, hands: result.hands };
    this.state.balls[ball.id] = result.ball;
    return { ok: true };
  }

  handleThrow(playerId: string, request: ThrowRequestPayload): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (!this.isPlayerAlive(player)) return { ok: false, reason: 'eliminated' };
    if (!request.hand) return { ok: false, reason: 'missing-hand' };

    const ballId = player.hands[request.hand].heldBallId;
    if (!ballId) return { ok: false, reason: 'empty-hand' };

    const ball = this.state.balls[ballId];
    if (!ball) return { ok: false, reason: 'missing-ball' };

    // Charge is taken from the SERVER-tracked hand state, never trusted from the client (#7).
    const handState = player.hands[request.hand];
    const charge01 = handState.mode === 'charging'
      ? clamp(handState.chargeSeconds / GAME_CONSTANTS.ball.maxChargeSeconds, 0, 1)
      : 0;

    // Direction is the SERVER's known facing (derived from validated look angles), so a client
    // can't throw anywhere but where it is actually aiming (#7 — anti-aimbot).
    const forward = normalize(player.movement.facing, facingFromAngles(player.movement.yawRadians, player.movement.pitchRadians));

    // Backflip landing throw: the client reports the QTE success tier (1..5). The server only honors
    // it when the throw genuinely follows a backflip — the player must be grounded AND have flipped
    // recently (cooldown still high). This bounds abuse: a client can't claim a backflip throw it
    // didn't earn. A valid tier sets the speed (tier 1 = quick, top tier = fastest) and marks super.
    // The QTE is landing-only, so a wall-running player can never be mid-QTE here.
    // `canHonorBackflipQteThrow` also accepts a tight near-ground descent grace for online packets
    // that arrive on the authoritative crossing-ground tick.
    const backflipTier = clamp(Math.trunc(request.backflipTier ?? 0), 0, GAME_CONSTANTS.backflip.qte.tierCount);
    const backflipRecent = player.movementInternal.backflipCooldown >
      GAME_CONSTANTS.backflip.cooldownSeconds - (GAME_CONSTANTS.backflip.durationSeconds + GAME_CONSTANTS.backflip.qte.durationSeconds + 0.3);
    const isBackflipThrow = backflipTier >= 1 && backflipRecent && this.canHonorBackflipQteThrow(player);
    const origin = add(computePlayerHandAnchor(player, request.hand), scale(forward, 0.16));

    // Anti "2-ball technique": a second throw landing within doubleThrowWindowSeconds of this
    // player's previous throw slows BOTH balls down, instead of only the new client-side throw.
    const now = this.now();
    const priorThrow = this.lastThrowByPlayerId.get(playerId);
    const isDoubleThrow = !!priorThrow && (now - priorThrow.atMs) <= GAME_CONSTANTS.ball.doubleThrowWindowSeconds * 1000;
    if (isDoubleThrow && priorThrow) {
      const priorBall = this.state.balls[priorThrow.ballId];
      if (priorBall && priorBall.phase === 'live' && priorBall.ownerId === playerId) {
        this.state.balls[priorBall.id] = {
          ...priorBall,
          velocity: scale(priorBall.velocity, GAME_CONSTANTS.ball.doubleThrowSpeedPenalty)
        };
      }
    }

    // Deterministic crouch-curve (Phase 6): curves perpendicular to AIM (not world axes), opposite
    // the throwing hand. Server-computed so the client can replay the exact same curve for prediction.
    const throwCalc = calculateThrow({
      hand: request.hand,
      forward,
      playerVelocity: player.movement.velocity,
      charge01,
      crouching: player.movement.crouching || player.movement.sliding,
      backflipTier: isBackflipThrow ? backflipTier : 0
    });
    const { velocity: rawVelocity, curveAccel, dropScale, isSuper } = throwCalc;
    const velocity = isDoubleThrow ? scale(rawVelocity, GAME_CONSTANTS.ball.doubleThrowSpeedPenalty) : rawVelocity;
    // Fresh throw identity — assigned here so it lands on the live ball AND the throw event together.
    this.throwCounter += 1;
    const throwId = this.throwCounter;

    const result = throwBallFromHand(player, player.hands, request.hand, ball, {
      origin,
      velocity,
      isSuper,
      dropScale,
      curveAccel,
      throwId
    });
    if (!result.ok) return result;

    this.lastThrowByPlayerId.set(playerId, { atMs: now, ballId: ball.id });
    this.adjustPlayerMatchStat(playerId, 'throws', 1); // report card: accuracy = hits / throws

    const dash = isBackflipThrow && backflipTier === GAME_CONSTANTS.backflip.qte.tierCount
      ? grantDashCharge(player.dash)
      : player.dash;

    this.state.players[playerId] = { ...player, hands: result.hands, dash };
    this.state.balls[ball.id] = result.ball;

    // Attach backflip tier to the ball state for defensive logic
    (this.state.balls[ball.id] as any).backflipTier = isBackflipThrow ? backflipTier : 0;

    // Emit an authoritative throw event so the client can start deterministic visual prediction
    // immediately (before the next snapshot). Drained + broadcast by the room each loop wake.
    this.pendingThrowEvents.push({
      type: 'throw-event',
      throwId,
      ballId: ball.id,
      ownerId: playerId,
      hand: request.hand,
      serverTick: this.state.tick,
      serverTimeMs: this.now(),
      origin: cloneVec3(origin),
      velocity: cloneVec3(velocity),
      curveAccel: cloneVec3(curveAccel),
      dropScale,
      isSuper,
      isCurve: isCurveThrow(curveAccel),
      charge01,
      resetSerial: this.resetSerial
    });

    if (this.debug.THROW_DEBUG) {
      this.logger(
        `throw accepted player=${playerId} ball=${ball.id} hand=${request.hand} throwId=${throwId}` +
        ` charge=${charge01.toFixed(2)} crouchCurve=${Number(player.movement.crouching || player.movement.sliding)} super=${Number(isSuper)}` +
        ` yaw=${player.movement.yawRadians.toFixed(3)} pitch=${player.movement.pitchRadians.toFixed(3)}` +
        ` origin=(${origin.x.toFixed(2)},${origin.y.toFixed(2)},${origin.z.toFixed(2)})` +
        ` vel=(${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)})` +
        ` curve=(${curveAccel.x.toFixed(2)},${curveAccel.y.toFixed(2)},${curveAccel.z.toFixed(2)})`
      );
    }
    return { ok: true, log: `throw accepted player=${playerId} ball=${ball.id} hand=${request.hand} charge=${charge01.toFixed(2)}${isSuper ? ' SUPER' : ''}` };
  }

  private canHonorBackflipQteThrow(player: PlayerState): boolean {
    if (player.movementInternal.backflipActive) return false;
    if (player.movement.grounded) return true;
    if (player.movement.wallRunning) return false;

    const groundHeight = Number.isFinite(player.movementInternal.groundHeight)
      ? player.movementInternal.groundHeight
      : 0;
    const heightAboveGround = player.movement.position.y - groundHeight;
    return heightAboveGround <= BACKFLIP_QTE_LANDING_GRACE_HEIGHT &&
      player.movement.velocity.y <= BACKFLIP_QTE_MAX_UPWARD_GRACE_SPEED;
  }

  /**
   * Legacy discrete catch/parry request. Catch is now driven by the input-stream attempt model
   * (ingestCatchAttempts) and parry is automatic (tryAutoParry), both resolved server-side in the
   * live-ball tick. A client click also opens an attempt locally, so this message is a harmless
   * no-op kept only so older clients don't get a hard rejection. Returns ok without doing anything.
   */
  handleCatchParry(_playerId: string): ActionResult {
    return { ok: true };
  }

  handleReset(playerId: string, mode: 'same-teams' | 'reset-teams' = 'same-teams'): ActionResult {
    if (!this.state.players[playerId]) return { ok: false, reason: 'unknown-player' };
    if (mode === 'reset-teams' && this.matchMode !== '2v2') return { ok: false, reason: 'unsupported-mode' };

    this.pruneResetVotes(this.now());
    if (this.state.resetVote.mode !== mode && this.resetVotesByPlayerId.size > 0) {
      this.resetVotesByPlayerId.clear();
    }
    this.resetVotesByPlayerId.set(playerId, this.now() + RESET_VOTE_TTL_MS);
    this.syncResetVoteState(mode);

    const vote = this.state.resetVote;
    if (this.debug.NET_DEBUG) this.logger(`reset vote player=${playerId} mode=${mode} votes=${vote.voteCount}/${vote.requiredVotes}`);
    if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes) {
      this.performRoomReset(playerId, mode);
      return { ok: true, log: `room reset approved player=${playerId} mode=${mode}` };
    }

    return { ok: true, log: `reset vote pending player=${playerId} mode=${mode} votes=${vote.voteCount}/${vote.requiredVotes}` };
  }

  handleStartVote(playerId: string): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (this.state.match.status !== 'warmup') return { ok: false, reason: 'match-already-started' };
    if (this.matchMode === '2v2' && !this.allConnectedPlayersChoseTeams()) return { ok: false, reason: 'teams-not-chosen' };
    if (!this.canVoteStart()) return { ok: false, reason: 'start-not-available' };

    this.pruneStartVotes(this.now());
    this.startVotesByPlayerId.set(playerId, this.now() + START_VOTE_TTL_MS);
    this.syncStartVoteState();

    const vote = this.state.startVote;
    if (this.debug.NET_DEBUG) this.logger(`start vote player=${playerId} votes=${vote.voteCount}/${vote.requiredVotes}`);
    if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes) {
      this.beginPregameCountdown('vote');
      return { ok: true, log: `start vote approved player=${playerId}` };
    }
    return { ok: true, log: `start vote pending player=${playerId} votes=${vote.voteCount}/${vote.requiredVotes}` };
  }

  /**
   * Host-only "start the configured match now" from the lobby. Works for both formats: begins the
   * pre-round countdown when enough players are present (and, for 2v2, teams are chosen). This is the
   * lobby's host start button — and the way to begin a new match after an early-end returns to lobby.
   */
  handleStartMatch(playerId: string): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (this.hostPlayerId !== playerId) return { ok: false, reason: 'not-host' };
    if (this.state.match.status !== 'warmup') return { ok: false, reason: 'match-already-started' };
    if (!this.hasEnoughConnectedTeamsToPlay()) return { ok: false, reason: 'not-enough-players' };
    if (this.matchMode === '2v2' && !this.allConnectedPlayersChoseTeams()) return { ok: false, reason: 'teams-not-chosen' };
    this.beginPregameCountdown('host');
    return { ok: true, log: `match started by host=${playerId}` };
  }

  /**
   * Early-end vote. The host opens it during a live round (their send counts as a yes); it passes
   * on the shared 70% supermajority rule, at which point the room returns to the lobby (a reset
   * that intentionally does NOT auto-start, so both formats land in a configurable lobby).
   */
  handleEndVote(playerId: string): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (player.connected === false) return { ok: false, reason: 'disconnected' };
    const live = this.state.match.status === 'playing' || this.state.match.status === 'countdown';
    if (!live) return { ok: false, reason: 'not-live' };

    this.pruneEndVotes(this.now());
    if (!this.state.endVote.active) {
      // Only the host may OPEN the vote; once open any connected player may cast a yes.
      if (this.hostPlayerId !== playerId) return { ok: false, reason: 'not-host' };
      this.endVoteInitiatorId = playerId;
    }
    this.endVotesByPlayerId.set(playerId, this.now() + END_VOTE_TTL_MS);
    this.syncEndVoteState();

    const vote = this.state.endVote;
    if (this.debug.NET_DEBUG) this.logger(`end vote player=${playerId} votes=${vote.voteCount}/${vote.requiredVotes}`);
    if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes) {
      this.endGameEarly(playerId);
      return { ok: true, log: `early end approved initiator=${this.endVoteInitiatorId ?? playerId}` };
    }
    return { ok: true, log: `end vote pending player=${playerId} votes=${vote.voteCount}/${vote.requiredVotes}` };
  }

  private endGameEarly(playerId: string): void {
    this.returnToLobby(`early-end:${playerId}`);
  }

  /**
   * Between-rounds / post-match vote cast over the report card. Any connected player may vote;
   * 'next-round' (intermission only) starts the next round and 'to-lobby' ends the match, each on a
   * 70% supermajority. A player's vote is exclusive — switching choices moves their vote.
   */
  handleIntermissionVote(playerId: string, choice: 'next-round' | 'to-lobby'): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (player.connected === false) return { ok: false, reason: 'disconnected' };
    const status = this.state.match.status;
    if (status !== 'intermission' && status !== 'complete') return { ok: false, reason: 'not-intermission' };
    if (choice === 'next-round') {
      if (status !== 'intermission') return { ok: false, reason: 'match-complete' };
      this.intermissionNextVotes.add(playerId);
      this.intermissionLobbyVotes.delete(playerId);
    } else {
      this.intermissionLobbyVotes.add(playerId);
      this.intermissionNextVotes.delete(playerId);
    }
    this.resolveIntermissionVotes(this.now());
    return { ok: true, log: `intermission vote player=${playerId} choice=${choice}` };
  }

  /** Per-tick intermission upkeep: keep the vote state live, auto-advance on timeout, resolve passes. */
  private tickIntermission(nowMs: number): void {
    const status = this.state.match.status;
    const active = status === 'intermission' || status === 'complete';
    if (!active) {
      if (this.intermissionDeadlineAtMs !== null || this.intermissionNextVotes.size > 0 || this.intermissionLobbyVotes.size > 0 || this.state.intermissionVote.active) {
        this.clearIntermissionVotes();
        this.syncIntermissionVoteState();
      }
      return;
    }
    if (status === 'intermission' && this.intermissionDeadlineAtMs === null) {
      this.intermissionDeadlineAtMs = nowMs + INTERMISSION_TIMEOUT_MS;
    }
    this.resolveIntermissionVotes(nowMs);
  }

  private resolveIntermissionVotes(nowMs: number): void {
    const status = this.state.match.status;
    if (status !== 'intermission' && status !== 'complete') return;
    this.pruneIntermissionVoters();
    const required = votesRequiredForPass(this.connectedCount());
    this.syncIntermissionVoteState();
    if (required > 0) {
      if (status === 'intermission' && this.liveVoteCount(this.intermissionNextVotes) >= required) {
        this.beginNextRound('vote');
        return;
      }
      if (this.liveVoteCount(this.intermissionLobbyVotes) >= required) {
        this.returnToLobby('vote');
        return;
      }
    }
    // Fallback so an undecided intermission never stalls: auto-start the next round on timeout.
    if (status === 'intermission' && this.intermissionDeadlineAtMs !== null && nowMs >= this.intermissionDeadlineAtMs) {
      this.beginNextRound('timeout');
    }
  }

  private pruneIntermissionVoters(): void {
    for (const set of [this.intermissionNextVotes, this.intermissionLobbyVotes]) {
      for (const pid of set) {
        const p = this.state.players[pid];
        if (!p || p.connected === false) set.delete(pid);
      }
    }
  }

  private liveVoteCount(set: Set<string>): number {
    let count = 0;
    for (const pid of set) {
      const p = this.state.players[pid];
      if (p && p.connected !== false) count += 1;
    }
    return count;
  }

  private syncIntermissionVoteState(): void {
    const status = this.state.match.status;
    const active = status === 'intermission' || status === 'complete';
    const tally = (set: Set<string>): Record<string, true> => {
      const out: Record<string, true> = {};
      for (const pid of set) {
        const p = this.state.players[pid];
        if (p && p.connected !== false) out[pid] = true;
      }
      return out;
    };
    const nextRoundByPlayerId = tally(this.intermissionNextVotes);
    const toLobbyByPlayerId = tally(this.intermissionLobbyVotes);
    this.state.intermissionVote = createIntermissionVoteState({
      active,
      allowsNextRound: status === 'intermission',
      nextRoundByPlayerId,
      nextRoundCount: Object.keys(nextRoundByPlayerId).length,
      toLobbyByPlayerId,
      toLobbyCount: Object.keys(toLobbyByPlayerId).length,
      requiredVotes: active ? votesRequiredForPass(this.connectedCount()) : 0,
      nextRoundDeadlineAtMs: status === 'intermission' ? this.intermissionDeadlineAtMs : null
    });
  }

  private pruneEndVotes(now: number): void {
    if (this.endVotesByPlayerId.size === 0) {
      if (this.state.endVote.active) this.syncEndVoteState();
      return;
    }
    const live = this.state.match.status === 'playing' || this.state.match.status === 'countdown';
    let changed = false;
    for (const [pid, expiresAtMs] of this.endVotesByPlayerId) {
      const p = this.state.players[pid];
      if (!live || !p || p.connected === false || expiresAtMs <= now) {
        this.endVotesByPlayerId.delete(pid);
        changed = true;
      }
    }
    if (!live || this.endVotesByPlayerId.size === 0) {
      this.endVoteInitiatorId = null;
    }
    if (changed) this.syncEndVoteState();
  }

  private syncEndVoteState(): void {
    const votesByPlayerId: Record<string, true> = {};
    let expiresAtMs: number | null = null;
    for (const [pid, expiry] of this.endVotesByPlayerId) {
      const p = this.state.players[pid];
      if (!p || p.connected === false) continue;
      votesByPlayerId[pid] = true;
      expiresAtMs = expiresAtMs === null ? expiry : Math.min(expiresAtMs, expiry);
    }
    const voteCount = Object.keys(votesByPlayerId).length;
    const active = voteCount > 0;
    this.state.endVote = createEndVoteState({
      active,
      initiatedByPlayerId: active ? this.endVoteInitiatorId : null,
      votesByPlayerId,
      voteCount,
      requiredVotes: active ? votesRequiredForPass(this.connectedCount()) : 0,
      expiresAtMs
    });
  }

  handleTeamSwitch(playerId: string, targetTeamId: string, requestedSlotIndex?: number): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (this.matchMode !== '2v2') return { ok: false, reason: 'unsupported-mode' };
    if (this.state.match.status !== 'warmup') return { ok: false, reason: 'teams-locked' };
    if (!this.teamIds.includes(targetTeamId)) return { ok: false, reason: 'invalid-team' };

    const currentSlot = this.slotForPlayer(player);
    if (
      currentSlot.teamId === targetTeamId &&
      (requestedSlotIndex === undefined || requestedSlotIndex === currentSlot.teamSlotIndex)
    ) {
      const wasChosen = this.teamChoicesByPlayerId.has(player.id);
      this.teamChoicesByPlayerId.add(player.id);
      if (wasChosen) {
        this.syncStartVoteState();
      } else {
        this.clearVotesForPregameChange();
      }
      return { ok: true, log: `team confirmed player=${playerId} team=${currentSlot.teamId} slot=${currentSlot.teamSlotIndex + 1}` };
    }

    const slot = this.resolveRequestedSlot(targetTeamId, requestedSlotIndex);
    if (!slot) return { ok: false, reason: 'invalid-slot' };

    const occupant = Object.values(this.state.players).find((candidate) =>
      candidate.id !== playerId &&
      candidate.teamId === slot.teamId &&
      candidate.teamSlotIndex === slot.teamSlotIndex
    );
    const sourceSlot = currentSlot;

    if (occupant) {
      this.dropAllHeldBalls(occupant);
      occupant.teamId = sourceSlot.teamId;
      occupant.spawnSide = sourceSlot.spawnSide;
      occupant.legalHalf = sourceSlot.spawnSide;
      occupant.teamSlotIndex = sourceSlot.teamSlotIndex;
      occupant.movement = this.spawnMovement(sourceSlot);
      occupant.movementInternal = createMovementInternalState();
      occupant.hands = createHands();
      occupant.dash = createDashState();
      occupant.lastPlayerBuffUntilMs = null;
      this.seedInputTracking(occupant.id, sourceSlot.yawRadians);
    }

    this.dropAllHeldBalls(player);
    player.teamId = slot.teamId;
    player.spawnSide = slot.spawnSide;
    player.legalHalf = slot.spawnSide;
    player.teamSlotIndex = slot.teamSlotIndex;
    player.movement = this.spawnMovement(slot);
    player.movementInternal = createMovementInternalState();
    player.hands = createHands();
    player.dash = createDashState();
    player.lastPlayerBuffUntilMs = null;
    this.seedInputTracking(player.id, slot.yawRadians);

    this.teamChoicesByPlayerId.add(player.id);
    if (occupant) this.teamChoicesByPlayerId.add(occupant.id);
    this.clearVotesForPregameChange();
    this.syncPlayerScores();
    return { ok: true, log: `team switch player=${playerId} team=${slot.teamId} slot=${slot.teamSlotIndex + 1}` };
  }

  /**
   * Host-only settings mutation. Enforces (in order): the player exists, the player is the host,
   * the room is between games (warmup/complete — never mid-countdown or live), and the patch passes
   * strict value validation. Format changes are rejected here (`format-locked`) because the team
   * geometry is fixed for the room's life in this stage; the host chooses the format at creation.
   * On success the canonical settings are stored and the derived match fields are re-applied.
   */
  handleUpdateRoomSettings(playerId: string, patch: RoomSettingsPatch | undefined): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (this.hostPlayerId !== playerId) return { ok: false, reason: 'not-host' };
    if (this.state.match.status !== 'warmup' && this.state.match.status !== 'complete') {
      return { ok: false, reason: 'settings-locked' };
    }
    if (patch?.format !== undefined && !isAllowedFormat(patch.format)) {
      return { ok: false, reason: 'invalid-format' };
    }
    if (patch?.format !== undefined && patch.format !== this.settings.format) {
      return { ok: false, reason: 'format-locked' };
    }

    const validation = validateRoomSettingsPatch(this.settings, patch);
    if (!validation.ok) return { ok: false, reason: validation.reason };
    // A preset patch can imply a different format without an explicit `format` field; reject that too
    // so the room's team geometry can never change out from under the loop.
    if (validation.settings.format !== this.settings.format) {
      return { ok: false, reason: 'format-locked' };
    }

    this.applyRoomSettings(validation.settings);
    if (this.debug.NET_DEBUG) {
      this.logger(`settings updated host=${playerId} preset=${validation.settings.preset} ` +
        `lives=${this.matchSettings.livesPerPlayer} balls=${this.matchSettings.dodgeballCount} ` +
        `bounces=${this.matchSettings.maxLiveBallBounces} mats=${this.matchSettings.matPreset} ` +
        `rounds=${this.matchSettings.roundCount} halfTimer=${this.matchSettings.halfCourtTimerSeconds}`);
    }
    return { ok: true, log: `settings updated host=${playerId} preset=${validation.settings.preset}` };
  }

  /**
   * Apply already-validated settings to authoritative state. The bounce rule and half-court timer
   * take effect immediately (read every tick); the dodgeball COUNT and per-player starting lives are
   * applied at the next match start (createFreshRoomState / performRoomReset rebuilds the ball set and
   * fighters from matchSettings) to avoid disturbing balls a warmup player may be holding. Waiting
   * fighters get their displayed lives refreshed now so the lobby reflects the change.
   */
  private applyRoomSettings(next: RoomSettings): void {
    this.settings = next;
    this.matchSettings = resolveMatchSettings(next);
    this.bounceRule = bounceRuleFromSettings(this.matchSettings);
    this.activeMatSpecs = matSpecsForPreset(this.matchSettings.matPreset);
    this.state.settings = next;
    this.state.match = {
      ...this.state.match,
      scoreLimit: this.matchSettings.scoreLimit,
      maxPlayers: this.maxPlayers,
      playersPerTeam: this.playersPerTeam,
      roundCount: this.matchSettings.roundCount
    };
    if (this.state.match.status === 'warmup') {
      // In the lobby we can safely re-seed the world to the new settings: starting lives for waiting
      // fighters and the active mat layout (with its collision). The dodgeball COUNT is applied at the
      // next match start to avoid disturbing a ball a warmup player may be holding.
      for (const id in this.state.players) {
        const waiting = this.state.players[id];
        if (waiting.combatState !== 'eliminated') waiting.lives = this.matchSettings.livesPerPlayer;
      }
      this.knockedOverMatIds.clear();
      this.matPostResetKnockImmunityUntilTickById.clear();
      this.state.mats = createMatStates(this.activeMatSpecs);
      this.rebuildCollisionBoxes();
    }
    this.syncRoomPhase();
  }

  /** Current authoritative host settings (intent). */
  getSettings(): RoomSettings {
    return this.settings;
  }

  /** Resolved engine parameters derived from the current settings. */
  getMatchSettings(): MatchSettings {
    return this.matchSettings;
  }

  /** Session id of the current host, or null when the room is empty. */
  getHostPlayerId(): string | null {
    return this.hostPlayerId;
  }

  /**
   * Ensure the host role points at a present, connected player. Keeps the current host while they are
   * connected; otherwise hands it to the first remaining connected player (stable order), or null
   * when the room is empty. Mirrors the chosen id onto snapshot-visible state.
   */
  private ensureHostAssignment(): void {
    const current = this.hostPlayerId ? this.state.players[this.hostPlayerId] : undefined;
    if (!current || current.connected === false) {
      const next = Object.values(this.state.players).find((p) => p.connected !== false)
        ?? Object.values(this.state.players)[0]
        ?? null;
      this.hostPlayerId = next ? next.id : null;
    }
    this.state.hostPlayerId = this.hostPlayerId;
  }

  /** Keep the unified lifecycle phase in lock-step with the legacy match status (Stage 1 mapping). */
  private syncRoomPhase(): void {
    this.state.phase = roomPhaseFromMatchStatus(this.state.match.status);
  }

  /**
   * Rebuild both collision worlds from the active mat preset. Standing mats are upright cover; each
   * knocked-over mat becomes a low flat panel (placed via its recorded knockDirection) that players
   * step onto and balls bounce off — so fallen mats are no longer fully walkable / pass-through.
   */
  private rebuildCollisionBoxes(): void {
    const knockedOverMatDirections = new Map<string, { x: number; z: number }>();
    for (const id of this.knockedOverMatIds) {
      const dir = this.state.mats[id]?.knockDirection;
      if (dir) knockedOverMatDirections.set(id, { x: dir.x, z: dir.z });
    }
    this.playerCollisionBoxes = createPlayerCollisionBoxes(this.knockedOverMatIds, this.activeMatSpecs, knockedOverMatDirections);
    this.ballCollisionBoxes = createBallCollisionBoxes(this.knockedOverMatIds, this.activeMatSpecs, knockedOverMatDirections);
  }

  step(): ServerSnapshot {
    this.advance();
    return this.snapshot();
  }

  advance(): void {
    const fixedDt = this.tickSeconds;
    const previousMatchStatus = this.state.match.status;
    this.state.tick += 1;
    // One wall-clock read per step, reused for all history timestamps + attempt windows so every
    // sample/attempt in this tick shares a consistent "now".
    this.stepNowMs = this.now();
    this.pruneExpiredReconnects(this.stepNowMs);
    this.pruneStartVotes(this.stepNowMs);
    this.pruneResetVotes(this.stepNowMs);
    this.pruneEndVotes(this.stepNowMs);

    // Advance the pre-round countdown. While counting down, players are frozen (look only) and no
    // combat resolves; when it elapses, flip to 'playing' so this tick already runs live.
    this.advanceCountdown(fixedDt);

    const counting = this.state.match.status === 'countdown';
    const active = this.hasEnoughConnectedTeamsToPlay() && this.state.match.status === 'playing';

    for (const playerId in this.state.players) {
      const player = this.state.players[playerId];
      const command = this.nextInputCommand(player);
      if (counting) {
        // Frozen at spawn: adopt look angles only, pin position/velocity, still ack the input seq
        // (so client reconciliation stays in lock-step) and record defense history.
        this.updatePlayerLookOnly(player, command.input, command.seq);
        this.recordDefenseSample(player);
        continue;
      }
      if (!this.isPlayerAlive(player)) {
        this.updateEliminatedPlayer(player, command.input, command.seq);
        this.recordDefenseSample(player);
        continue;
      }
      const preVelocity = player.movement.velocity;
      this.updatePlayer(player, fixedDt, command.input, command.seq);
      // Mat knock-over uses the player's PRE-resolution velocity: the collision solver zeros the
      // component pushing into the mat, so post-resolution speed can be ~0 on a head-on walk-in.
      this.knockOverMatsForPlayer(player, preVelocity);
      this.updateMatRestoreForPlayer(player, command.input);
      // Record this player's post-update defensive state for lag-compensated catch/parry rewind.
      this.recordDefenseSample(player);
    }

    // Move balls, record their swept positions, and resolve combat per live ball in the correct
    // order (parry → catch → hit). Scoring/hit only counts while the match is active; catch/parry
    // need an opponent's live ball, which only exists once opposing teams are present. During the
    // countdown balls are still settled (so loose balls rest) but no combat is resolved.
    this.updateBalls(fixedDt, active);

    if (active) {
      // Lag-compensated catch reclaim: a high-ping defender's well-timed click may only arrive after
      // the server already applied a hit/let the ball pass. Re-evaluate open catch attempts against
      // BALL HISTORY rewound to what the defender saw; a legitimate catch claims the ball and reverts
      // a hit it just superseded. Runs after updateBalls so this tick's swept history is recorded.
      this.resolveCatchReclaim(this.stepNowMs);
      this.pruneRecentHits(this.stepNowMs);
      this.updateRules(fixedDt);
    }

    this.repairBallHandConsistency();
    this.syncPlayerScores();
    this.tickIntermission(this.stepNowMs);
    this.syncRoomPhase();
    this.syncBattleMusicForMatchTransition(previousMatchStatus, this.stepNowMs);
    this.pruneExpiredMatPostResetKnockImmunity();
  }

  /** Tick the pre-round countdown timer; flip to 'playing' once it reaches 0. */
  private advanceCountdown(dt: number): void {
    if (this.state.match.status !== 'countdown') return;
    const remaining = this.state.match.countdownSeconds - dt;
    if (remaining > 0) {
      this.state.match = { ...this.state.match, countdownSeconds: remaining };
      return;
    }
    // Countdown finished → live play. If this was an inter-round countdown, rebuild the round world
    // now (deferred from resolveRoundOutcome so a same-tick hit-revert could still cancel the round).
    if (this.roundRebuildPending) {
      this.startRoundWorld();
      this.roundRebuildPending = false;
    }
    // Reset the no-boundaries clock so the round starts fresh.
    this.state.match = {
      ...this.state.match,
      status: 'playing',
      countdownSeconds: 0,
      boundary: { ...this.state.match.boundary, elapsedSeconds: 0, noBoundaries: false, lastEvent: { type: 'none' } }
    };
  }

  /**
   * Countdown-frozen player update: keep the player pinned at their spawn (no movement integration,
   * zero velocity) but DO adopt the freshest look angles from input and advance hand cooldown timers
   * a touch, and ack the input sequence so the client's reconciliation cursor keeps advancing (this
   * is what keeps the local player from wedging after a reset). No throws/catches/pickups/drops.
   */
  private updatePlayerLookOnly(player: PlayerState, input: PlayerInput, seq: number): void {
    const spawn = this.slotForPlayer(player);
    player.movement = {
      ...player.movement,
      position: { ...spawn.position },
      velocity: vec3(),
      yawRadians: input.lookYawRadians,
      pitchRadians: input.lookPitchRadians,
      facing: facingFromAngles(input.lookYawRadians, input.lookPitchRadians),
      grounded: true,
      crouching: false,
      sliding: false,
      wallRunning: false,
      dashingThisFrame: false,
      speed: 0
    };
    this.recordProcessedInputSeq(player, seq);
    this.previousInputByPlayerId.set(player.id, input);
  }

  /** Eliminated players become seated cover: no locomotion or combat, but look/acks still update. */
  private updateEliminatedPlayer(player: PlayerState, input: PlayerInput, seq: number): void {
    player.movement = {
      ...player.movement,
      velocity: vec3(),
      yawRadians: input.lookYawRadians,
      pitchRadians: input.lookPitchRadians,
      facing: facingFromAngles(input.lookYawRadians, input.lookPitchRadians),
      grounded: true,
      crouching: true,
      sliding: false,
      wallRunning: false,
      dashingThisFrame: false,
      speed: 0
    };
    this.recordProcessedInputSeq(player, seq);
    this.previousInputByPlayerId.set(player.id, input);
  }

  /**
   * Read + reset the combat counters for the throttled server [perf] report. Returns a compact
   * snapshot (one window's worth of catches/parries/hits) so the room can verify the lag-comp catch
   * fix in production without per-tick logging. Resets so each report covers one window.
   */
  drainCombatMetrics(): { catchAttemptsOpened: number; catches: number; reclaimCatches: number; parries: number; hits: number; hitReverts: number } {
    const m = { ...this.combatMetrics };
    this.combatMetrics.catchAttemptsOpened = 0;
    this.combatMetrics.catches = 0;
    this.combatMetrics.reclaimCatches = 0;
    this.combatMetrics.parries = 0;
    this.combatMetrics.hits = 0;
    this.combatMetrics.hitReverts = 0;
    return m;
  }

  /** Drain authoritative throw events accepted since the last drain (room broadcasts them). */
  drainThrowEvents(): ReadonlyArray<ThrowEvent> {
    if (this.pendingThrowEvents.length === 0) return EMPTY_THROW_EVENTS;
    const events = this.pendingThrowEvents;
    this.pendingThrowEvents = [];
    return events;
  }

  /** Drain immediate combat events accepted since the last drain (room broadcasts them). */
  drainCombatEvents(): ReadonlyArray<CatchEvent | ParryEvent | HitEvent | HitRevertEvent> {
    if (this.pendingCombatEvents.length === 0) return EMPTY_COMBAT_EVENTS;
    const events = this.pendingCombatEvents;
    this.pendingCombatEvents = [];
    return events;
  }

  getBattleMusicSyncState(): BattleMusicSyncState {
    return this.battleMusicSyncState;
  }

  drainBattleMusicSyncDirty(): BattleMusicSyncState | null {
    if (!this.battleMusicSyncDirty) return null;
    this.battleMusicSyncDirty = false;
    return this.battleMusicSyncState;
  }

  getLastSnapshotBuildMs(): number {
    return this.lastSnapshotBuildMs;
  }

  private historyMaxSamples(): number {
    return Math.max(16, Math.ceil(this.tickRate * ((this.combatTiming.defenseHistoryMs / 1000) + 0.25)));
  }

  getDebugBufferStats(): {
    inputQueues: number;
    maxInputQueue: number;
    inputsDrainedAvg: number;
    inputsDrainedMax: number;
    maxInputQueueBeforeDrain: number;
    pendingThrowEvents: number;
    pendingCombatEvents: number;
    defenseHistoryEntries: number;
    maxDefenseHistoryEntries: number;
    ballHistoryEntries: number;
    maxBallHistoryEntries: number;
    catchAttempts: number;
    recentHits: number;
  } {
    let inputQueues = 0;
    let maxInputQueue = 0;
    for (const queue of this.inputQueueByPlayerId.values()) {
      inputQueues += queue.length;
      if (queue.length > maxInputQueue) maxInputQueue = queue.length;
    }

    let defenseHistoryEntries = 0;
    let maxDefenseHistoryEntries = 0;
    for (const ring of this.defenseHistoryByPlayerId.values()) {
      defenseHistoryEntries += ring.size;
      if (ring.size > maxDefenseHistoryEntries) maxDefenseHistoryEntries = ring.size;
    }

    let ballHistoryEntries = 0;
    let maxBallHistoryEntries = 0;
    for (const ring of this.ballHistoryById.values()) {
      ballHistoryEntries += ring.size;
      if (ring.size > maxBallHistoryEntries) maxBallHistoryEntries = ring.size;
    }

    const inputsDrainedAvg = this.inputDrainMetrics.samples > 0
      ? this.inputDrainMetrics.inputsDrainedTotal / this.inputDrainMetrics.samples
      : 0;
    const inputsDrainedMax = this.inputDrainMetrics.maxInputsDrainedThisTick;
    const maxInputQueueBeforeDrain = this.inputDrainMetrics.maxInputQueueBeforeDrain;
    this.inputDrainMetrics.samples = 0;
    this.inputDrainMetrics.inputsDrainedTotal = 0;
    this.inputDrainMetrics.maxInputsDrainedThisTick = 0;
    this.inputDrainMetrics.maxInputQueueBeforeDrain = 0;

    return {
      inputQueues,
      maxInputQueue,
      inputsDrainedAvg,
      inputsDrainedMax,
      maxInputQueueBeforeDrain,
      pendingThrowEvents: this.pendingThrowEvents.length,
      pendingCombatEvents: this.pendingCombatEvents.length,
      defenseHistoryEntries,
      maxDefenseHistoryEntries,
      ballHistoryEntries,
      maxBallHistoryEntries,
      catchAttempts: this.catchAttemptByKey.size,
      recentHits: this.recentHitByBallId.size
    };
  }

  drainPlayerNetworkStats(nowMs = this.now()): PlayerNetworkDebugStats[] {
    const stats = this.collectPlayerNetworkStats(nowMs);
    this.playerNetWindowStatsByPlayerId.clear();
    return stats;
  }

  getPlayerNetworkStats(nowMs = this.now()): PlayerNetworkDebugStats[] {
    return this.collectPlayerNetworkStats(nowMs);
  }

  private collectPlayerNetworkStats(nowMs: number): PlayerNetworkDebugStats[] {
    const players = Object.values(this.state.players);
    return players.map((player) => {
      const window = this.playerNetWindowStatsByPlayerId.get(player.id);
      const queueDepthCurrent = this.inputQueueByPlayerId.get(player.id)?.length ?? 0;
      const lastInputAt = this.lastInputAtByPlayerId.get(player.id) ?? nowMs;
      const lastProcessedAt = this.lastProcessedInputAtByPlayerId.get(player.id);
      return {
        playerId: player.id,
        lastProcessedInputSeq: player.lastProcessedInputSeq,
        lastEnqueuedInputSeq: this.lastEnqueuedSeqByPlayerId.get(player.id) ?? 0,
        duplicateOrOutOfOrderInputs: window?.duplicateOrOutOfOrderInputs ?? 0,
        staleResetInputs: window?.staleResetInputs ?? 0,
        inputQueueDepthCurrent: queueDepthCurrent,
        inputQueueDepthAvg: window && window.inputQueueDepthSamples > 0
          ? window.inputQueueDepthTotal / window.inputQueueDepthSamples
          : queueDepthCurrent,
        inputQueueDepthMax: window?.inputQueueDepthMax ?? queueDepthCurrent,
        inputsDrainedAvg: window && window.inputsDrainedSamples > 0
          ? window.inputsDrainedTotal / window.inputsDrainedSamples
          : 0,
        inputsDrainedMax: window?.inputsDrainedMax ?? 0,
        lastInputAgeMs: Math.max(0, nowMs - lastInputAt),
        ackAgeEstimateMs: lastProcessedAt === undefined ? null : Math.max(0, nowMs - lastProcessedAt)
      } satisfies PlayerNetworkDebugStats;
    });
  }

  snapshot(): ServerSnapshot {
    const startedAt = performance.now();
    // No deep clone (#17): Colyseus serializes the message when broadcasting, so each client
    // already gets its own copy over the wire — cloning here just burned GC every tick.
    const snapshot: ServerSnapshot = {
      type: 'snapshot',
      tick: this.state.tick,
      serverTimeMs: this.now(),
      room: this.state
    };
    this.lastSnapshotBuildMs = performance.now() - startedAt;
    return snapshot;
  }

  private playerNetWindowStats(playerId: string): PlayerNetWindowStats {
    let stats = this.playerNetWindowStatsByPlayerId.get(playerId);
    if (!stats) {
      stats = {
        inputQueueDepthTotal: 0,
        inputQueueDepthSamples: 0,
        inputQueueDepthMax: 0,
        inputsDrainedTotal: 0,
        inputsDrainedSamples: 0,
        inputsDrainedMax: 0,
        duplicateOrOutOfOrderInputs: 0,
        staleResetInputs: 0
      };
      this.playerNetWindowStatsByPlayerId.set(playerId, stats);
    }
    return stats;
  }

  private recordProcessedInputSeq(player: PlayerState, seq: number): void {
    if (seq !== player.lastProcessedInputSeq) this.lastProcessedInputAtByPlayerId.set(player.id, this.stepNowMs || this.now());
    player.lastProcessedInputSeq = seq;
  }

  private updatePlayer(player: PlayerState, dt: number, input: PlayerInput, seq: number): void {
    const prevInput = this.previousInputByPlayerId.get(player.id) ?? defaultInput(player.movement.yawRadians);
    const catchStanceActive = computeCatchStance(player.hands, input);

    const preVelocity = player.movement.velocity;
    const preGrounded = player.movement.grounded;

    const result = stepMovement(
      player.movement,
      player.movementInternal,
      player.dash,
      input,
      prevInput,
      dt,
      this.collisionBoxesForPlayer(player.id),
      catchStanceActive,
      GAME_CONSTANTS,
      this.playerMovementScale(player),
      this.playerCooldownRateScale(player)
    );
    player.movement = result.movement;
    player.movementInternal = result.internal;
    player.dash = result.dash;

    player.hands = updateHandCharging(player.hands, input, prevInput);
    player.hands = tickHands(player.hands, dt);
    this.recordProcessedInputSeq(player, seq);

    // Open any fresh catch attempts carried by this input (latched ids; dedup by last-processed).
    this.ingestCatchAttempts(player, input);

    if (input.dropPressed) {
      const result = this.handleDrop(player.id);
      if (!result.ok && this.debug.NET_DEBUG) this.logger(`drop rejected player=${player.id} reason=${result.reason}`);
    }

    if (input.pickupPressed) {
      const result = this.handlePickup(player.id);
      if (this.debug.PICKUP_DEBUG) {
        if (!result.ok) {
          this.logger(`pickup rejected player=${player.id} reason=${result.reason}`);
        } else if (result.log) {
          this.logger(result.log);
        }
      }
    }

    this.handleInputThrows(player.id, input);

    this.logInputDebug(player.id, input, preVelocity, preGrounded, player.movement);

    this.previousInputByPlayerId.set(player.id, input);

    const cooldown = this.parryCooldownByPlayerId.get(player.id) ?? 0;
    this.parryCooldownByPlayerId.set(player.id, Math.max(0, cooldown - dt));
  }

  private handleInputThrows(playerId: string, input: PlayerInput): void {
    if (input.fakeThrowPressed || input.fakeThrowHeld) return;
    const tier = input.backflipThrowTier;
    if (input.leftHandReleased) this.handleInputThrow(playerId, 'left', tier);
    if (input.rightHandReleased) this.handleInputThrow(playerId, 'right', tier);
  }

  private handleInputThrow(playerId: string, hand: HandSide, backflipTier = 0): void {
    const player = this.state.players[playerId];
    // A normal throw requires a charging hand. A backflip QTE throw is released by the landing event
    // (not a charge), so it fires from a holding hand too — handleThrow re-validates the backflip.
    if (!player) return;
    const mode = player.hands[hand].mode;
    if (mode !== 'charging' && !(backflipTier >= 1 && mode === 'holding')) return;

    const result = this.handleThrow(playerId, { hand, backflipTier });
    if (!result.ok && this.debug.THROW_DEBUG) {
      this.logger(`throw rejected player=${playerId} hand=${hand} reason=${result.reason}`);
    }
  }

  private logInputDebug(
    playerId: string,
    input: PlayerInput,
    preVelocity: { x: number; y: number; z: number },
    preGrounded: boolean,
    postMovement: PlayerState['movement']
  ): void {
    if (!this.debug.NET_DEBUG) return;
    const now = this.now();
    const previous = this.lastInputDebugAtByPlayerId.get(playerId) ?? 0;

    // Always log when an edge-triggered action fires so they are never hidden by throttle.
    const hasEdge = input.jumpPressed || input.dashPressed || input.slidePressed ||
      input.backflipPressed || input.pickupPressed || input.dropPressed;
    if (!hasEdge && now - previous < 500) return;
    this.lastInputDebugAtByPlayerId.set(playerId, now);

    const pv = preVelocity;
    const mv = postMovement.velocity;
    this.logger(
      `input player=${playerId} seq=${input.sequence}` +
      ` move=(${input.moveX.toFixed(2)},${input.moveZ.toFixed(2)})` +
      ` jump=${Number(input.jumpPressed)}/${Number(input.jumpHeld)}` +
      ` dash=${Number(input.dashPressed)} slide=${Number(input.slidePressed)}` +
      ` crouch=${Number(input.crouchHeld)} backflip=${Number(input.backflipPressed)}` +
      ` pickup=${Number(input.pickupPressed)} drop=${Number(input.dropPressed)}` +
      ` yaw=${input.lookYawRadians.toFixed(2)} pitch=${input.lookPitchRadians.toFixed(2)}` +
      ` storedYaw=${postMovement.yawRadians.toFixed(2)} storedPitch=${postMovement.pitchRadians.toFixed(2)}` +
      ` facing=(${postMovement.facing.x.toFixed(2)},${postMovement.facing.y.toFixed(2)},${postMovement.facing.z.toFixed(2)})`
    );
    this.logger(
      `veloc player=${playerId}` +
      ` pre=(${pv.x.toFixed(2)},${pv.y.toFixed(2)},${pv.z.toFixed(2)}) grounded=${preGrounded}` +
      ` post=(${mv.x.toFixed(2)},${mv.y.toFixed(2)},${mv.z.toFixed(2)}) grounded=${postMovement.grounded}` +
      ` sliding=${postMovement.sliding} speed=${postMovement.speed.toFixed(2)}`
    );
  }

  /**
   * Advance balls and resolve live-ball combat with the correct interaction order (Phase 8/9):
   *   1. preserve previous position  2. move ball  3. build swept segment
   *   4. auto-parry  5. catch  6. hit  7. world collision/bounce/settle.
   * Parry/catch/hit each consume the ball — once one fires, later checks skip it that tick, so a
   * valid defense can never be bypassed by hit detection running first.
   */
  private updateBalls(dt: number, combatActive: boolean): void {
    const subDt = dt / LIVE_BALL_COMBAT_SUBSTEPS;

    for (const ballId in this.state.balls) {
      const ball = this.state.balls[ballId];
      if (ball.phase === 'held' && ball.heldByPlayerId && ball.heldHand) {
        const owner = this.state.players[ball.heldByPlayerId];
        this.state.balls[ball.id] = owner
          ? { ...ball, position: heldBallPosition(owner, ball.heldHand), velocity: vec3() }
          : markBallDead(ball);
        continue;
      }

      if (ball.phase === 'loose') continue;

      // Run LIVE_BALL_COMBAT_SUBSTEPS sub-steps per tick. Each sub-step advances the ball by
      // subDt, then runs the full parry→catch→hit pipeline against that sub-tick swept segment.
      // At 128Hz × 2 substeps = 256Hz effective live-ball combat checks — fast balls that would
      // tunnel through catch/hit range between two 128Hz ticks are still caught/registered.
      let current = ball;
      let combatDone = false;

      for (let sub = 0; sub < LIVE_BALL_COMBAT_SUBSTEPS && !combatDone; sub++) {
        const prevPos = cloneVec3(current.position);
        const advanced = advanceBall(current, subDt);
        let resolved = advanced;

        if (combatActive && isBallCatchableInFlight(resolved)) {
          const segPrev = prevPos;
          const segCurr = resolved.position;

          const parried = this.tryAutoParry(resolved, segPrev, segCurr, subDt, this.stepNowMs);
          if (parried) {
            resolved = parried;
            // Deflected ball stays in flight — continue remaining substeps.
          } else {
            const caught = this.tryCatchAttempts(resolved, segPrev, segCurr, subDt, this.stepNowMs);
            if (caught) {
              resolved = caught;
              combatDone = true;
            } else {
              const friendlyDeflect = this.tryFriendlyDeflect(resolved, segPrev, segCurr);
              if (friendlyDeflect) {
                resolved = friendlyDeflect;
              }
              const hit = this.tryHit(resolved, segPrev, segCurr);
              if (hit) { resolved = hit; combatDone = true; }
            }
          }
        }

        // World collision per substep so fast balls bounce correctly at sub-tick positions. The
        // settings-driven bounce rule decides when a live/deflected ball dies on these contacts.
        const bounded = resolveBallBounds(resolved, this.bounceRule);
        const collided = resolveBallStaticBoxes(bounded, this.ballCollisionBoxesWithEliminatedCover(),
          this.debug.COLLISION_DEBUG ? this.logger : undefined, this.bounceRule);
        current = settleBallIfSlow(collided);

        if (
          !combatDone &&
          (current.phase === 'loose' || (current.phase === 'dead' && !isBallCatchableInFlight(current)))
        ) {
          combatDone = true;
        }
      }

      this.state.balls[ball.id] = current;
      this.recordBallSample(current);
    }
  }

  /**
   * (6) Swept hit detection. The ball's path this tick (prev→curr) is tested against each opponent's
   * vertical body axis (feet→head): registers headshots and stops fast throws tunnelling between
   * ticks. Returns the dead ball on a hit (and registers the score), else null. Catch/parry already
   * had their chance this tick before this runs, so a valid defense is never bypassed.
   */
  private tryHit(ball: BallState, segPrev: Vec3, segCurr: Vec3): BallState | null {
    if (!canScorePlayerHit(ball)) return null;
    const ownerId = ball.ownerId;
    if (!ownerId) return null;
    const scorer = this.state.players[ownerId];
    if (!scorer) return null;
    const radius = playerBallHitRadius();
    const radiusSq = radius * radius;

    for (const targetId in this.state.players) {
      const target = this.state.players[targetId];
      if (targetId === ownerId) continue;
      if (!this.isPlayerActiveFighter(target)) continue;
      if (!this.isOpponent(scorer, target)) continue;
      if (horizontalDistanceSqToSegment(target.movement.position, segPrev, segCurr) > radiusSq) continue;
      const hitbox = playerHitCapsule(target);
      if (!sweptBallHitsBody(segPrev, segCurr, hitbox.base, hitbox.top, radius)) continue;

      const backflipTier = Math.max(0, Math.trunc((ball as any).backflipTier ?? 0));
      const breaksParryGuard = backflipTier >= 3 && heldBallCount(target.hands) >= GAME_CONSTANTS.ball.maxHeldBalls;
      if (breaksParryGuard) {
        this.scatterHeldBalls(target);
        // Nice/Great (tiers 3/4) only shatter the defender's two-ball guard. Only a Perfect (tier 5)
        // is allowed to continue through the guard and register the player hit as well.
        if (backflipTier < GAME_CONSTANTS.backflip.qte.tierCount) {
          return markBallDead(ball);
        }
      }

      const previousScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : 0;
      const previousWinner = this.state.match.winnerTeamId;
      // Capture the thrower's pre-hit dash so a lag-comp catch that supersedes this hit can restore
      // it (registerPlayerHit grants the scorer a dash charge).
      const throwerDashBefore = scorer ? { ...scorer.dash } : null;
      // Report-card hit breakdown, classified from the ball AT impact: a mat bounce is the only way
      // a live ball has bounceCount > 0 here, curve rides the throw's curveAccel, and isSuper is set
      // exclusively by backflip-QTE throws (ThrowMath). Reverted with the hit on a lag-comp catch.
      const statBreakdown = {
        direct: ball.bounceCount === 0,
        bounce: ball.bounceCount > 0,
        curve: isCurveThrow(ball.curveAccel),
        backflip: ball.isSuper
      };
      const dead = markBallDead(ball);
      const recentHit = scorer && throwerDashBefore
        ? this.applyPlayerHit(ownerId, target, throwerDashBefore, statBreakdown)
        : null;
      this.combatMetrics.hits += 1;
      const nextScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : previousScore;
      // Remember this hit briefly: a high-ping defender's well-timed catch may arrive after this and
      // legitimately claim the ball (resolveCatchReclaim), reverting the score it superseded.
      if (recentHit) {
        this.recentHitByBallId.set(ball.id, {
          ...recentHit,
          ballId: ball.id,
          defenderId: target.id,
          throwerId: ownerId,
          atMs: this.stepNowMs
        });
      }
      this.pendingCombatEvents.push({ type: 'hit-event', ballId: ball.id, throwerId: ownerId, targetId: target.id, serverTick: this.state.tick, serverTimeMs: this.stepNowMs });
      if (this.debug.NET_DEBUG) {
        this.logger(`hit confirmed scorer=${ownerId} target=${target.id} ball=${ball.id}`);
        if (nextScore !== previousScore) this.logger(`score changed team=${scorer?.teamId ?? 'unknown'} score=${nextScore}`);
        if (!previousWinner && this.state.match.winnerTeamId) this.logger(`match ended winner=${this.state.match.winnerTeamId}`);
      }
      return dead;
    }
    return null;
  }

  private tryFriendlyDeflect(ball: BallState, segPrev: Vec3, segCurr: Vec3): BallState | null {
    if (ball.phase !== 'live' || ball.ownerKind !== 'player' || !ball.ownerId) return null;
    const owner = this.state.players[ball.ownerId];
    if (!owner) return null;
    const radius = playerBallHitRadius();
    const radiusSq = radius * radius;

    for (const targetId in this.state.players) {
      const target = this.state.players[targetId];
      if (target.id === owner.id) continue;
      if (!this.isPlayerActiveFighter(target)) continue;
      if (!this.isSameTeam(owner, target)) continue;
      if (horizontalDistanceSqToSegment(target.movement.position, segPrev, segCurr) > radiusSq) continue;
      const hitbox = playerHitCapsule(target);
      if (!sweptBallHitsBody(segPrev, segCurr, hitbox.base, hitbox.top, radius)) continue;

      const away = normalize(
        vec3(segCurr.x - target.movement.position.x, 0.15, segCurr.z - target.movement.position.z),
        normalize(scale(ball.velocity, -1), target.movement.facing)
      );
      this.throwCounter += 1;
      const deflected = deflectBall(ball, target.id, away, GAME_CONSTANTS, this.throwCounter);
      this.state.balls[ball.id] = deflected;
      if (this.debug.NET_DEBUG) this.logger(`friendly deflect player=${target.id} ball=${ball.id} owner=${owner.id}`);
      return deflected;
    }

    return null;
  }

  private applyPlayerHit(
    throwerId: string,
    target: PlayerState,
    throwerDashBefore: DashState,
    statBreakdown: HitStatBreakdown
  ): Omit<RecentHit, 'ballId' | 'defenderId' | 'throwerId' | 'atMs'> | null {
    const scorer = this.state.players[throwerId];
    if (!scorer) return null;

    // Unified lives model (Stage 3): a hit costs the target a life for BOTH formats; a fully
    // eliminated team loses the round (resolveRoundOutcome). 1v1 additionally keeps a per-team hit
    // tally in scoreByTeamId purely as a stat/display — it NEVER decides victory now (lives/rounds
    // do). 2v2 leaves scoreByTeamId at 0 and shows lives. The win is no longer score-to-5.
    const targetLive = this.state.players[target.id];
    if (!targetLive || !this.isPlayerAlive(targetLive)) return null;

    const defenderLivesBefore = targetLive.lives;
    const defenderCombatStateBefore = targetLive.combatState;
    const defenderEliminatedAtMsBefore = targetLive.eliminatedAtMs;
    const matchStatusBefore = this.state.match.status;
    const winnerTeamIdBefore = this.state.match.winnerTeamId;
    const currentRoundBefore = this.state.match.currentRound;
    const roundsWonByTeamIdBefore = { ...this.state.match.roundsWonByTeamId };
    const countdownSecondsBefore = this.state.match.countdownSeconds;
    const roundRebuildPendingBefore = this.roundRebuildPending;

    const scoreDelta = this.matchSettings.format === '1v1' ? 1 : 0;
    this.state.players[throwerId] = { ...scorer, dash: grantDashCharge(scorer.dash) };
    if (scoreDelta > 0) this.bumpTeamHitScore(scorer.teamId, scoreDelta);
    this.adjustPlayerMatchStat(throwerId, 'hits', 1);
    this.adjustPlayerMatchStat(target.id, 'hitsTaken', 1);
    this.adjustHitBreakdownStats(throwerId, statBreakdown, 1);
    targetLive.lives = Math.max(0, targetLive.lives - 1);
    if (targetLive.lives <= 0) this.eliminatePlayer(targetLive.id);
    this.refreshLastPlayerBuffs(this.stepNowMs);
    this.resolveRoundOutcome();

    return {
      kind: 'life',
      throwerTeamId: scorer.teamId,
      value: 1,
      scoreDelta,
      statBreakdown,
      defenderLivesBefore,
      defenderCombatStateBefore,
      defenderEliminatedAtMsBefore,
      matchStatusBefore,
      winnerTeamIdBefore,
      currentRoundBefore,
      roundsWonByTeamIdBefore,
      countdownSecondsBefore,
      roundRebuildPendingBefore,
      throwerDashBefore
    };
  }

  /** Direct, non-victory hit-tally bump for 1v1's legacy scoreByTeamId stat (clamped at 0). */
  private bumpTeamHitScore(teamId: string, delta: number): void {
    const current = this.state.match.scoreByTeamId[teamId] ?? 0;
    this.state.match = {
      ...this.state.match,
      scoreByTeamId: { ...this.state.match.scoreByTeamId, [teamId]: Math.max(0, current + delta) }
    };
  }

  private eliminatePlayer(playerId: string): void {
    const player = this.state.players[playerId];
    if (!player || player.combatState === 'eliminated') return;
    this.dropAllHeldBalls(player);
    player.lives = 0;
    player.combatState = 'eliminated';
    player.eliminatedAtMs = this.stepNowMs;
    player.lastPlayerBuffUntilMs = null;
    player.movement = {
      ...player.movement,
      velocity: vec3(),
      grounded: true,
      crouching: true,
      sliding: false,
      wallRunning: false,
      dashingThisFrame: false,
      speed: 0
    };
    this.catchAttemptByKey.delete(`${playerId}:left`);
    this.catchAttemptByKey.delete(`${playerId}:right`);
    this.parryCooldownByPlayerId.set(playerId, 0);
  }

  /**
   * Unified round resolution (Stage 3): when one team is fully eliminated, award the round to the
   * survivors, then either END THE MATCH (a team clinched the best-of-roundCount series, or all rounds
   * are played → 'complete') or pause on the between-rounds report card ('intermission'). From the
   * intermission, players vote to start the next round or to return to the lobby (handleIntermission
   * Vote / tickIntermission). It does NOT touch currentRound or rebuild the world here — that happens
   * when the next round's countdown begins (beginNextRound) — so a same-tick lag-comp hit-revert that
   * un-eliminates the deciding player cleanly cancels the round (revertHit restores 'playing').
   */
  private resolveRoundOutcome(): void {
    if (this.state.match.status !== 'playing') return;
    const losingTeamId = this.state.match.teamIds.find((teamId) => {
      const teamPlayers = Object.values(this.state.players).filter((player) => player.teamId === teamId);
      return this.teamHasNoActiveFighter(teamPlayers);
    });
    if (!losingTeamId) return;
    const roundWinnerTeamId = this.state.match.teamIds.find((teamId) => teamId !== losingTeamId) ?? null;
    if (!roundWinnerTeamId) return;

    const roundsWonByTeamId = {
      ...this.state.match.roundsWonByTeamId,
      [roundWinnerTeamId]: (this.state.match.roundsWonByTeamId[roundWinnerTeamId] ?? 0) + 1
    };
    const matchWithRound: MatchState = { ...this.state.match, roundsWonByTeamId };
    const matchWinnerTeamId = matchWinnerFromRounds(matchWithRound);

    this.state.match = matchWinnerTeamId
      // Series clinched (or all rounds played): final report card. Players then vote back to the lobby.
      ? { ...matchWithRound, status: 'complete', winnerTeamId: matchWinnerTeamId, countdownSeconds: 0 }
      // Round over, match continues: between-rounds report card + next-round / to-lobby votes.
      : { ...matchWithRound, status: 'intermission', winnerTeamId: null, countdownSeconds: 0 };
    this.refreshLastPlayerBuffs(this.stepNowMs);
    if (this.debug.NET_DEBUG) {
      this.logger(`round won team=${roundWinnerTeamId} rounds=${JSON.stringify(roundsWonByTeamId)} ` +
        `status=${this.state.match.status}`);
    }
  }

  /** Begin the next round's pre-round countdown from the intermission (vote passed or timed out). */
  private beginNextRound(kind: 'vote' | 'timeout'): void {
    this.clearIntermissionVotes();
    this.state.match = {
      ...this.state.match,
      status: 'countdown',
      countdownSeconds: GAME_CONSTANTS.match.countdownSeconds,
      currentRound: this.state.match.currentRound + 1,
      winnerTeamId: null,
      boundary: { ...this.state.match.boundary, elapsedSeconds: 0, noBoundaries: false, lastEvent: { type: 'none' } }
    };
    // Rebuild the world (full lives, racked balls, upright mats) the moment the countdown BEGINS —
    // scattered balls teleport to their start rack immediately instead of at timer-zero. Safe here:
    // the lag-comp hit-revert window (the reason resolveRoundOutcome defers) closed long before a
    // vote/timeout could start the next round. advanceCountdown keeps a pending-flag fallback.
    this.startRoundWorld();
    this.roundRebuildPending = false;
    this.syncIntermissionVoteState();
    this.refreshLastPlayerBuffs(this.now());
    if (this.debug.NET_DEBUG) this.logger(`next round=${this.state.match.currentRound} via=${kind}`);
  }

  /** Return the room to the pregame lobby (warmup), preserving membership + settings. */
  private returnToLobby(kind: string): void {
    this.clearIntermissionVotes();
    this.endVotesByPlayerId.clear();
    this.endVoteInitiatorId = null;
    // A reset that intentionally does NOT auto-start, so both formats land in a configurable lobby.
    this.performRoomReset(`to-lobby:${kind}`, 'same-teams', false);
  }

  private clearIntermissionVotes(): void {
    this.intermissionNextVotes.clear();
    this.intermissionLobbyVotes.clear();
    this.intermissionDeadlineAtMs = null;
  }

  /**
   * Rebuild the world for a new round: every connected fighter back to full lives at spawn (cleared
   * hands/dash/buffs), fresh dodgeballs + mats, collision rebuilt, combat history dropped. The match
   * identity and round tally are preserved (this is between rounds, NOT a room reset, so resetSerial
   * and votes are untouched).
   */
  private startRoundWorld(): void {
    for (const id in this.state.players) {
      const player = this.state.players[id];
      if (player.connected === false) continue;
      const slot = this.slotForPlayer(player);
      player.lives = this.matchSettings.livesPerPlayer;
      player.combatState = 'alive';
      player.eliminatedAtMs = null;
      player.lastPlayerBuffUntilMs = null;
      player.movement = this.spawnMovement(slot);
      player.movementInternal = createMovementInternalState();
      player.hands = createHands();
      player.dash = createDashState();
      this.seedInputTracking(player.id, slot.yawRadians);
    }
    this.knockedOverMatIds.clear();
    this.matRestoreHoldTicksByPlayerId.clear();
    this.matPostResetKnockImmunityUntilTickById.clear();
    this.state.mats = createMatStates(this.activeMatSpecs);
    this.rebuildCollisionBoxes();
    const balls: Record<string, BallState> = {};
    for (const ball of createInitialBalls(this.matchSettings.dodgeballCount)) balls[ball.id] = ball;
    this.state.balls = balls;
    this.ballHistoryById.clear();
    this.catchAttemptByKey.clear();
    this.recentHitByBallId.clear();
    this.pendingThrowEvents = [];
  }

  private refreshLastPlayerBuffs(nowMs: number): void {
    if (this.state.match.mode !== '2v2') {
      for (const player of Object.values(this.state.players)) player.lastPlayerBuffUntilMs = null;
      return;
    }

    for (const teamId of this.state.match.teamIds) {
      const teamPlayers = Object.values(this.state.players).filter((player) => player.teamId === teamId);
      const activeFighters = teamPlayers.filter((player) => this.isPlayerActiveFighter(player));
      const unavailableCount = Math.max(0, this.playersPerTeam - activeFighters.length);
      const buffedPlayer = this.state.match.status === 'playing' && activeFighters.length === 1 && unavailableCount >= 1
        ? activeFighters[0]
        : null;

      for (const player of teamPlayers) {
        if (buffedPlayer && player.id === buffedPlayer.id) {
          if (!player.lastPlayerBuffUntilMs || player.lastPlayerBuffUntilMs <= nowMs) {
            player.lastPlayerBuffUntilMs = nowMs + LAST_PLAYER_BUFF_MS;
          }
        } else {
          player.lastPlayerBuffUntilMs = null;
        }
      }
    }
  }

  private hasRecentHitAgainst(playerId: string): boolean {
    for (const hit of this.recentHitByBallId.values()) {
      if (hit.defenderId === playerId) return true;
    }
    return false;
  }

  private isSameTeam(a: PlayerState, b: PlayerState): boolean {
    return a.teamId === b.teamId;
  }

  private isOpponent(a: PlayerState, b: PlayerState): boolean {
    return a.teamId !== b.teamId;
  }

  private canBallDamagePlayer(ball: BallState, target: PlayerState): boolean {
    if (!canScorePlayerHit(ball)) return false;
    if (!this.isPlayerActiveFighter(target)) return false;
    if (!ball.ownerId || target.id === ball.ownerId) return false;
    const owner = this.state.players[ball.ownerId];
    if (!owner) return false;
    return this.isOpponent(owner, target);
  }

  private canPlayerCatchBall(player: PlayerState, ball: BallState): boolean {
    if (!this.isPlayerActiveFighter(player)) return false;
    if (!isBallCatchableInFlight(ball)) return false;
    if (ball.ownerId !== null && ball.ownerId === player.id && ball.bounceCount <= 0) return false;
    return true;
  }

  private canPlayerParryBall(player: PlayerState, ball: BallState): boolean {
    if (!this.isPlayerActiveFighter(player)) return false;
    if (ball.phase !== 'live' || ball.ownerKind !== 'player' || !ball.ownerId) return false;
    return ball.ownerId !== player.id;
  }

  private isPlayerAlive(player: PlayerState): boolean {
    return player.combatState !== 'eliminated' && player.lives > 0;
  }

  private isPlayerActiveFighter(player: PlayerState): boolean {
    return player.connected !== false && this.isPlayerAlive(player);
  }

  private playerMovementScale(player: PlayerState): number {
    if (
      this.state.match.mode === '2v2' &&
      this.isPlayerAlive(player) &&
      (player.lastPlayerBuffUntilMs ?? 0) > this.stepNowMs
    ) {
      return GAME_CONSTANTS.match.lastPlayerBuffMultiplier;
    }
    return 1;
  }

  private playerCooldownRateScale(player: PlayerState): number {
    if (
      this.state.match.mode === '2v2' &&
      this.isPlayerAlive(player) &&
      (player.lastPlayerBuffUntilMs ?? 0) > this.stepNowMs
    ) {
      return GAME_CONSTANTS.match.lastPlayerBuffCooldownRateMultiplier;
    }
    return 1;
  }

  private collisionBoxesForPlayer(playerId: string): AABB[] {
    this.playerCollisionScratch.length = 0;
    for (const box of this.playerCollisionBoxes) this.playerCollisionScratch.push(box);
    this.pushEliminatedCoverBoxes(this.playerCollisionScratch, playerId);
    return this.playerCollisionScratch;
  }

  private ballCollisionBoxesWithEliminatedCover(): AABB[] {
    if (!this.hasEliminatedPlayers()) return this.ballCollisionBoxes;
    this.ballCollisionScratch.length = 0;
    for (const box of this.ballCollisionBoxes) this.ballCollisionScratch.push(box);
    this.pushEliminatedCoverBoxes(this.ballCollisionScratch);
    return this.ballCollisionScratch;
  }

  private pushEliminatedCoverBoxes(target: AABB[], exceptPlayerId?: string): void {
    for (const player of Object.values(this.state.players)) {
      if (player.id === exceptPlayerId) continue;
      if (player.connected === false) continue;
      if (player.combatState !== 'eliminated') continue;
      const pos = player.movement.position;
      const radius = GAME_CONSTANTS.player.radius * 0.95;
      const height = GAME_CONSTANTS.player.height * GAME_CONSTANTS.player.crouchHeightMultiplier;
      target.push({
        minX: pos.x - radius,
        maxX: pos.x + radius,
        minY: pos.y,
        maxY: pos.y + height,
        minZ: pos.z - radius,
        maxZ: pos.z + radius,
        id: `eliminated_${player.id}`
      });
    }
  }

  private hasEliminatedPlayers(): boolean {
    for (const player of Object.values(this.state.players)) {
      if (player.connected === false) continue;
      if (player.combatState === 'eliminated') return true;
    }
    return false;
  }

  /**
   * Knock a standing mat flat when a player walks into it. Balls never touch mats. Detection is
   * contact-based: the player's body circle (radius) must reach the mat footprint (small contact
   * margin) within the mat's height band, and the player must be moving INTO the mat. A knocked
   * mat is removed from the player collision set (becomes walkable) and stays down until reset; the
   * recorded knockDirection is the player's horizontal motion so the client tips it the right way
   * (no impulse is applied to anything — the mat just falls, nothing goes flying).
   */
  private knockOverMatsForPlayer(player: PlayerState, preVelocity: Vec3): void {
    // Only an actively-walking player knocks a mat over (not someone resting against it). Use the
    // pre-resolution velocity since the collision solver zeros the into-mat component.
    const horizSpeedSq = preVelocity.x * preVelocity.x + preVelocity.z * preVelocity.z;
    if (horizSpeedSq <= 0.04) return; // ~0.2 m/s threshold

    const r = GAME_CONSTANTS.player.radius;
    const reach = r + 0.18; // body radius + a small contact margin past the wall push-out line
    const reachSq = reach * reach;
    const pos = player.movement.position;
    let knockedAny = false;

    for (const spec of this.activeMatSpecs) {
      if (this.knockedOverMatIds.has(spec.id)) continue;
      if ((this.matPostResetKnockImmunityUntilTickById.get(spec.id) ?? 0) >= this.state.tick) continue;
      const box = matCollisionBox(spec);
      // Vertical band: the player's body must overlap the mat height (feet below top, head above base).
      if (pos.y > box.maxY || pos.y + GAME_CONSTANTS.player.height < box.minY) continue;
      // Closest point on the mat footprint to the player; contact if within radius + margin.
      const dx = pos.x - clamp(pos.x, box.minX, box.maxX);
      const dz = pos.z - clamp(pos.z, box.minZ, box.maxZ);
      if (dx * dx + dz * dz > reachSq) continue;

      // knockDirection = the player's horizontal heading (normalized); fall back to mat→player so it
      // always tips away from the player. No impulse is applied anywhere — the mat simply falls.
      const pushDir = normalize(
        vec3(preVelocity.x, 0, preVelocity.z),
        normalize(vec3(pos.x - spec.x, 0, pos.z - spec.z), vec3(0, 0, 1))
      );
      const fallDir = matFallDirection(pushDir);
      const dir = vec3(fallDir.x, 0, fallDir.z);
      this.state.mats[spec.id] = { ...this.state.mats[spec.id], knockedOver: true, knockDirection: dir };
      this.knockedOverMatIds.add(spec.id);
      knockedAny = true;
      if (this.debug.COLLISION_DEBUG) this.logger(`mat knocked over id=${spec.id} by player=${player.id}`);
    }

    // Rebuild both collision sets once if anything changed, so a downed mat becomes walkable AND
    // stops blocking balls.
    if (knockedAny) {
      this.rebuildCollisionBoxes();
    }
  }

  /**
   * Hold E next to a knocked-over mat to stand it back up online. Mirrors the offline client's
   * restore behavior so the mechanic actually works in multiplayer (the server is authoritative for
   * mat state, so the client-only restore never reached other players). Picks the nearest downed mat
   * within reach; releasing E or stepping out of reach resets the hold timer.
   */
  private updateMatRestoreForPlayer(player: PlayerState, input: PlayerInput): void {
    if (!input.interactHeld || this.knockedOverMatIds.size === 0) {
      this.matRestoreHoldTicksByPlayerId.delete(player.id);
      return;
    }

    const pos = player.movement.position;
    const reachSq = ServerGameLoop.MAT_RESTORE_REACH * ServerGameLoop.MAT_RESTORE_REACH;
    let nearestId: string | null = null;
    let nearestDistSq = Infinity;

    for (const spec of this.activeMatSpecs) {
      if (!this.knockedOverMatIds.has(spec.id)) continue;
      const dx = pos.x - spec.x;
      const dz = pos.z - spec.z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= reachSq && distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestId = spec.id;
      }
    }

    if (!nearestId) {
      this.matRestoreHoldTicksByPlayerId.delete(player.id);
      return;
    }

    // Tick counting, not dt accumulation — exact at every selectable tick rate (see field comment).
    const heldTicks = (this.matRestoreHoldTicksByPlayerId.get(player.id) ?? 0) + 1;
    const requiredTicks = Math.max(1, Math.ceil(ServerGameLoop.MAT_RESTORE_HOLD_SECONDS * this.tickRate));
    if (heldTicks < requiredTicks) {
      this.matRestoreHoldTicksByPlayerId.set(player.id, heldTicks);
      return;
    }

    this.matRestoreHoldTicksByPlayerId.delete(player.id);
    this.state.mats[nearestId] = { ...this.state.mats[nearestId], knockedOver: false, knockDirection: vec3() };
    this.knockedOverMatIds.delete(nearestId);
    const immunityTicks = Math.max(1, Math.ceil(ServerGameLoop.MAT_POST_RESET_KNOCK_IMMUNITY_SECONDS * this.tickRate));
    this.matPostResetKnockImmunityUntilTickById.set(nearestId, this.state.tick + immunityTicks);
    this.rebuildCollisionBoxes();
    if (this.debug.COLLISION_DEBUG) this.logger(`mat restored id=${nearestId} by player=${player.id}`);
  }

  /** Drop expired grace entries so the map doesn't grow unboundedly over a long match. */
  private pruneExpiredMatPostResetKnockImmunity(): void {
    for (const [matId, expiryTick] of this.matPostResetKnockImmunityUntilTickById) {
      if (expiryTick < this.state.tick) this.matPostResetKnockImmunityUntilTickById.delete(matId);
    }
  }

  private updateRules(dt: number): void {
    // Half-court drop timing is sourced from the host setting, not the bare constant.
    this.state.match = advanceNoBoundariesTimer(this.state.match, dt, this.matchSettings.halfCourtTimerSeconds);
    for (const playerId in this.state.players) {
      const player = this.state.players[playerId];
      if (!this.isPlayerAlive(player)) continue;
      this.state.match = applyHalfCourtRule(
        this.state.match,
        player.id,
        player.teamId,
        player.legalHalf,
        player.movement.position,
        dt,
        GAME_CONSTANTS,
        // Unified lives model: boundary penalties cost the OFFENDER lives (applyHalfCourtPenalty),
        // never opponent score — so a half-court abuse can no longer "win" a 1v1 by score.
        false
      );
      if (this.state.match.boundary.lastEvent.type === 'half-court-elimination') {
        this.eliminatePlayer(player.id);
        this.refreshLastPlayerBuffs(this.stepNowMs);
        this.resolveRoundOutcome();
      } else if (this.state.match.boundary.lastEvent.type === 'half-court-penalty') {
        this.applyHalfCourtPenalty(player.id, this.state.match.boundary.lastEvent.value);
      }
    }
  }

  private applyHalfCourtPenalty(playerId: string, value: number): void {
    // Unified across formats: a half-court penalty costs the offender lives (1v1 + 2v2).
    const player = this.state.players[playerId];
    if (!player || !this.isPlayerAlive(player)) return;

    player.lives = Math.max(0, player.lives - value);
    this.adjustPlayerMatchStat(player.id, 'hitsTaken', value);
    if (player.lives <= 0) this.eliminatePlayer(player.id);
    this.refreshLastPlayerBuffs(this.stepNowMs);
    this.resolveRoundOutcome();
  }

  // ===========================================================================================
  //  Server-authoritative combat: defensive history, catch attempts, auto-parry, swept resolution
  // ===========================================================================================

  /** Record this player's post-update defensive state into their history ring (lag-comp source). */
  private recordDefenseSample(player: PlayerState): void {
    let ring = this.defenseHistoryByPlayerId.get(player.id);
    if (!ring) {
      ring = new TimeRing<DefenseSample>(this.combatTiming.defenseHistoryMs, this.historyMaxSamples());
      this.defenseHistoryByPlayerId.set(player.id, ring);
    }
    const m = player.movement;
    const forward = normalize(m.facing, facingFromAngles(m.yawRadians, m.pitchRadians));
    const active = this.isPlayerAlive(player);
    ring.push({
      serverTimeMs: this.stepNowMs,
      tick: this.state.tick,
      eye: vec3(m.position.x, m.position.y + GAME_CONSTANTS.player.eyeHeight, m.position.z),
      forward,
      yaw: m.yawRadians,
      pitch: m.pitchRadians,
      leftHandEmpty: active && !player.hands.left.heldBallId,
      rightHandEmpty: active && !player.hands.right.heldBallId,
      leftHeldBallId: player.hands.left.heldBallId,
      rightHeldBallId: player.hands.right.heldBallId,
      heldBallCount: active ? heldBallCount(player.hands) : 0,
      dashing: m.dashingThisFrame
    });
  }

  /** Record an interaction-relevant ball's position so a rewound click can reconstruct its swept
   * path. Covers live/deflected balls and moving bounced balls that remain catchable. */
  private recordBallSample(ball: BallState): void {
    // Keep history while the ball is catchable in flight OR a hit on it is still inside the catch-undo
    // grace — a lag-comp catch reclaim needs the ball's PRE-hit (live) samples even after the present
    // ball has died/bounced past the defender. Once neither holds, drop the ring (bounded memory).
    if (!isBallCatchableInFlight(ball) && !this.recentHitByBallId.has(ball.id)) {
      this.ballHistoryById.delete(ball.id);
      return;
    }
    let ring = this.ballHistoryById.get(ball.id);
    if (!ring) {
      ring = new TimeRing<BallSample>(this.combatTiming.defenseHistoryMs, this.historyMaxSamples());
      this.ballHistoryById.set(ball.id, ring);
    }
    ring.push({
      serverTimeMs: this.stepNowMs,
      tick: this.state.tick,
      position: cloneVec3(ball.position),
      velocity: cloneVec3(ball.velocity),
      phase: ball.phase,
      ownerId: ball.ownerId,
      bounceCount: ball.bounceCount
    });
  }

  /**
   * Open catch windows for any FRESH catch-attempt ids carried by this player's input. A new id
   * (strictly greater than the last processed for that player+hand) acknowledges immediately (stored
   * in hand.lastCatchAttemptId so the client stops re-latching) and, if the hand is eligible and not
   * on cooldown, opens an active window anchored at the click's server time (lag-comp rewind target).
   */
  private ingestCatchAttempts(player: PlayerState, input: PlayerInput): void {
    this.ingestCatchAttemptForHand(player, input, 'left', input.leftCatchAttemptId);
    this.ingestCatchAttemptForHand(player, input, 'right', input.rightCatchAttemptId);
  }

  private ingestCatchAttemptForHand(player: PlayerState, input: PlayerInput, hand: HandSide, attemptId: number): void {
    if (attemptId <= 0) return;
    const key = `${player.id}:${hand}`;
    const lastId = this.lastCatchAttemptIdByKey.get(key) ?? 0;
    const handEmptyAtIngest = !player.hands[hand].heldBallId;
    const handCooldownSeconds = player.hands[hand].cooldownSeconds;
    if (attemptId <= lastId) {
      this.catchTrace(
        `attempt-ingest player=${player.id} hand=${hand} id=${attemptId} result=deduped` +
        ` last=${lastId} handEmpty=${Number(handEmptyAtIngest)} cooldown=${handCooldownSeconds.toFixed(3)}`
      );
      return; // stale/duplicate latched re-send — already consumed.
    }
    this.lastCatchAttemptIdByKey.set(key, attemptId);
    // Acknowledge on the hand state so the client knows the attempt was received (whether or not it
    // ultimately catches — the catch resolves over the active window below).
    player.hands = setHandLastCatchAttemptId(player.hands, hand, attemptId);
    if (!this.isPlayerAlive(player)) {
      this.catchTrace(
        `attempt-ingest player=${player.id} hand=${hand} id=${attemptId} result=rejected reason=not-alive` +
        ` last=${lastId} handEmpty=${Number(handEmptyAtIngest)} cooldown=${handCooldownSeconds.toFixed(3)}`
      );
      return;
    }

    const now = this.stepNowMs;
    const existing = this.catchAttemptByKey.get(key);
    if (existing && now < existing.cooldownUntilMs) {
      this.catchTrace(
        `attempt-ingest player=${player.id} hand=${hand} id=${attemptId} result=rejected reason=cooldown` +
        ` last=${lastId} handEmpty=${Number(handEmptyAtIngest)} cooldownRemainingMs=${Math.round(existing.cooldownUntilMs - now)}` +
        ` openedAtMs=${Math.round(existing.openedAtMs)} activeUntilMs=${Math.round(existing.activeUntilMs)}`
      );
      if (this.debug.CATCH_DEBUG) {
        this.logger(`catch attempt player=${player.id} hand=${hand} id=${attemptId} result=fail reason=cooldown remainingMs=${Math.round(existing.cooldownUntilMs - now)}`);
      }
      return;
    }

    // Judge the catch against the world the defender saw. Required history is roughly render
    // interpolation delay + measured RTT + tick slop; clamp so bogus/missing latency cannot request
    // unlimited history. The active window scans a span of recent history, so a click a touch
    // early/late around the in-cone moment still lands.
    const rewindMs = this.catchRewindMsForPlayer(player.id);
    // Sub-tick anchor: clamp clientTimeMs offset to one tick window so clock skew can't corrupt it.
    const clientClickMs = input.clientTimeMs ?? 0;
    const subTickOffset = clientClickMs > 0 ? clamp(now - clientClickMs, 0, this.tickSeconds * 1000) : 0;
    const openedAtMs = now - subTickOffset;
    this.catchAttemptByKey.set(key, {
      hand,
      attemptId,
      openedAtMs,
      activeUntilMs: openedAtMs + this.combatTiming.catchStartupMs + this.combatTiming.catchActiveMs,
      cooldownUntilMs: openedAtMs + this.combatTiming.catchCooldownMs,
      clickTimeMs: openedAtMs - rewindMs,
      rewindMs,
      clientClickMs,
      resolved: false
    });
    this.combatMetrics.catchAttemptsOpened += 1;
    this.catchTrace(
      `attempt-ingest player=${player.id} hand=${hand} id=${attemptId} result=accepted` +
      ` last=${lastId} handEmpty=${Number(handEmptyAtIngest)} cooldown=${handCooldownSeconds.toFixed(3)}` +
      ` openedAtMs=${Math.round(openedAtMs)} activeUntilMs=${Math.round(openedAtMs + this.combatTiming.catchStartupMs + this.combatTiming.catchActiveMs)}` +
      ` clickTimeMs=${Math.round(openedAtMs - rewindMs)} rewindMs=${Math.round(rewindMs)} clientClickMs=${Math.round(clientClickMs)}`
    );
  }

  /**
   * Auto-parry (Phase 11): a defender holding two balls and aiming within the parry cone of a live
   * incoming ball deflects it automatically. Evaluated against the swept segment + the defender's
   * rewound aim. Returns the deflected ball on success, else null (and logs the reason under PARRY_DEBUG).
   */
  private tryAutoParry(ball: BallState, segPrev: Vec3, segCurr: Vec3, _dt: number, tickStartMs: number): BallState | null {
    const ownerId = ball.ownerId;
    if (ball.phase !== 'live' || ball.ownerKind !== 'player' || !ownerId) return null;

    for (const defenderId in this.state.players) {
      if (defenderId === ownerId) continue;
      const defender = this.state.players[defenderId];
      if (!this.canPlayerParryBall(defender, ball)) continue;
      const sample = this.sampleDefenseAt(defenderId, tickStartMs);
      const fail = this.parryFailReason(defender, sample, ball, segPrev, segCurr);
      if (fail) {
        if (this.debug.PARRY_DEBUG) this.logParry(defenderId, ball, sample, segPrev, segCurr, fail);
        continue;
      }

      // Success. Deflect using the defender's rewound aim; new throw identity so clients snap.
      const aim = sample ? sample.forward : defender.movement.facing;
      this.throwCounter += 1;
      this.state.balls[ball.id] = deflectBall(ball, defenderId, aim, GAME_CONSTANTS, this.throwCounter);
      this.parryCooldownByPlayerId.set(defenderId, GAME_CONSTANTS.parry.cooldownSeconds);
      this.combatMetrics.parries += 1;
      this.adjustPlayerMatchStat(defenderId, 'parries', 1);
      if (ball.isSuper) this.dropOneHeldBall(defender); // super-parry drops a defender ball
      this.pendingCombatEvents.push({ type: 'parry-event', ballId: ball.id, deflectorId: defenderId, serverTick: this.state.tick, serverTimeMs: this.stepNowMs });
      if (this.debug.PARRY_DEBUG || this.debug.NET_DEBUG) {
        this.logger(`parry SUCCESS defender=${defenderId} ball=${ball.id} super=${ball.isSuper} throwId=${this.throwCounter}`);
      }
      return this.state.balls[ball.id];
    }
    return null;
  }

  /** Returns a fail reason, or null if this defender would parry the ball this tick. */
  private parryFailReason(
    defender: PlayerState,
    sample: DefenseSample | null,
    ball: BallState,
    segPrev: Vec3,
    segCurr: Vec3
  ): ParryFailReason | null {
    return sweptParryFailReason({
      heldBallCount: sample ? sample.heldBallCount : heldBallCount(defender.hands),
      parryCooldownSeconds: this.parryCooldownByPlayerId.get(defender.id) ?? 0,
      defenderPlayerId: defender.id,
      ball,
      origin: sample ? sample.eye : add(defender.movement.position, vec3(0, GAME_CONSTANTS.player.eyeHeight, 0)),
      forward: sample ? sample.forward : defender.movement.facing,
      segmentStart: segPrev,
      segmentEnd: segCurr
    });
  }

  /**
   * Resolve catch attempts (Phase 10) against this live ball's swept segment. For each defender with
   * an OPEN, unresolved attempt whose hand matches, evaluate the gates against their rewound defense
   * sample. On success the ball becomes held (velocity 0) in that hand and the attempt is consumed.
   */
  private tryCatchAttempts(ball: BallState, segPrev: Vec3, segCurr: Vec3, _dt: number, tickStartMs: number): BallState | null {
    // A live/deflected ball OR a bounced dead ball that's still fast can be caught.
    // (A bounced ball has its owner cleared, so it's catchable by either player.)
    if (!isBallCatchableInFlight(ball)) return null;
    const now = this.stepNowMs;

    for (const defenderId in this.state.players) {
      // Can't catch your own direct throw before it touches anything. Once it bounces, rebounds are playable.
      if (ball.ownerId !== null && defenderId === ball.ownerId && ball.bounceCount <= 0) continue;
      const defender = this.state.players[defenderId];
      if (!this.canPlayerCatchBall(defender, ball)) continue;

      for (const hand of ['left', 'right'] as const) {
        const key = `${defenderId}:${hand}`;
        const attempt = this.catchAttemptByKey.get(key);
        if (!attempt || attempt.resolved) continue;
        // Expire windows that have fully elapsed.
        if (now > attempt.activeUntilMs) continue;

        // Defender's OWN state (aim/eye/dash/hand) is authoritative at the CLICK frame (client-
        // predicted, not delayed) — sample at openedAtMs, not the rewound ball time. Only the BALL is
        // rewound (present segment here; lag-comp history in resolveCatchReclaim).
        const sample = this.sampleDefenseAt(defenderId, attempt.openedAtMs);
        const fail = this.catchFailReason(defender, hand, sample, ball, segPrev, segCurr, attempt, now);
        if (fail) {
          this.logCatchTraceEval(defenderId, hand, ball, sample, segPrev, segCurr, attempt, fail);
          if (this.debug.CATCH_DEBUG) this.logCatch(defenderId, hand, ball, sample, segPrev, segCurr, attempt, fail);
          continue;
        }

        // Success — consume the attempt and give the ball to this hand.
        const facing = sample ? sample.forward : defender.movement.facing;
        const caught = this.applyCatch(defenderId, hand, ball.id, facing, attempt, now);
        this.logCatchTraceEval(defenderId, hand, ball, sample, segPrev, segCurr, attempt, null);
        if (this.debug.CATCH_DEBUG || this.debug.NET_DEBUG) {
          this.logger(`catch SUCCESS defender=${defenderId} hand=${hand} ball=${ball.id} id=${attempt.attemptId}`);
        }
        return caught;
      }
    }
    return null;
  }

  /**
   * Lag-compensated catch RECLAIM. The present-time tryCatchAttempts only catches a ball that is
   * still live/in-range right now — which fails for a high-ping defender whose well-timed click only
   * reaches the server after the ball already hit them or flew past. This pass re-evaluates every
   * OPEN, unresolved attempt against the ball's HISTORY rewound to what the defender saw (now −
   * attempt.rewindMs). A legitimate catch (same cone/range/empty-hand gates, just rewound) claims the
   * ball and reverts a hit it superseded. Cheap: only runs while an attempt window is open.
   */
  private resolveCatchReclaim(nowMs: number): void {
    const minTime = nowMs - this.combatTiming.defenseMaxRewindMs - this.combatTiming.defenseInputGraceMs;
    for (const defenderId in this.state.players) {
      const defender = this.state.players[defenderId];
      if (defender.connected === false) continue;
      const recentHitForDefender = this.hasRecentHitAgainst(defenderId);
      if (!this.isPlayerAlive(defender) && !recentHitForDefender) continue;
      for (const hand of ['left', 'right'] as const) {
        const attempt = this.catchAttemptByKey.get(`${defenderId}:${hand}`);
        if (!attempt || attempt.resolved) continue;
        if (nowMs < attempt.openedAtMs + this.combatTiming.catchStartupMs) continue; // startup
        if (nowMs > attempt.activeUntilMs) continue;                                      // expired

        // Ball is rewound to what the defender SAW (now − rewind, scanning forward as the window
        // stays open). The defender's OWN state is sampled at the click frame (openedAtMs), since
        // they see themselves in real time — only the world (ball) is delayed.
        const evalTime = clamp(nowMs - attempt.rewindMs, minTime, nowMs);
        const sample = this.sampleDefenseAt(defenderId, attempt.openedAtMs);
        // The hand must be empty at the click moment to even consider a reclaim (skip the scan if not).
        const handEmpty = sample ? (hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty) : !defender.hands[hand].heldBallId;
        if (!handEmpty) continue;

        for (const ballId in this.state.balls) {
          // A ball already in someone's hand can't be reclaimed.
          if (this.state.balls[ballId].phase === 'held') continue;
          const ring = this.ballHistoryById.get(ballId);
          if (!ring) {
            this.logCatchTraceReclaimSkip(defenderId, hand, attempt, ballId, 'ball-history-missing', evalTime);
            continue;
          }
          const bracket = ring.bracket(evalTime);
          if (!bracket) {
            this.logCatchTraceReclaimSkip(defenderId, hand, attempt, ballId, 'ball-history-bracket-missing', evalTime);
            continue;
          }
          const at = ring.nearest(evalTime);
          if (!at) {
            this.logCatchTraceReclaimSkip(defenderId, hand, attempt, ballId, 'ball-history-nearest-missing', evalTime);
            continue;
          }
          // Reconstruct the ball as the defender saw it at evalTime (phase/velocity/owner/bounce from
          // history) and test the swept segment that straddles that moment.
          const fail = sweptCatchFailReason({
            handEmpty: true,
            dashing: sample ? sample.dashing : defender.movement.dashingThisFrame,
            defenderPlayerId: defenderId,
            ball: { phase: at.phase, velocity: at.velocity, bounceCount: at.bounceCount, ownerId: at.ownerId },
            origin: sample ? sample.eye : add(defender.movement.position, vec3(0, GAME_CONSTANTS.player.eyeHeight, 0)),
            forward: sample ? sample.forward : defender.movement.facing,
            segmentStart: bracket[0].position,
            segmentEnd: bracket[1].position
            // No `timing` block: the server-time window is already gated above; the rewound history
            // sample carries its own (past) time.
          });
          if (fail) {
            this.logCatchTraceReclaimSkip(defenderId, hand, attempt, ballId, fail, evalTime, at, bracket);
            continue;
          }

          const facing = sample ? sample.forward : defender.movement.facing;
          this.applyCatch(defenderId, hand, ballId, facing, attempt, nowMs, true);
          this.combatMetrics.reclaimCatches += 1;
          if (this.debug.CATCH_DEBUG || this.debug.NET_DEBUG) {
            this.logger(`catch RECLAIM defender=${defenderId} hand=${hand} ball=${ballId} id=${attempt.attemptId} rewindMs=${attempt.rewindMs}`);
          }
          break; // one ball per attempt
        }
      }
    }
  }

  /**
   * Commit a successful catch: ball → held in this hand, catch boost + dash charge, attempt consumed,
   * any hit this catch superseded reverted, and the ball's swept history dropped. Shared by the
   * present-time path (tryCatchAttempts) and the lag-comp reclaim (resolveCatchReclaim).
   */
  private applyCatch(defenderId: string, hand: HandSide, ballId: string, facing: Vec3, attempt: CatchAttempt, nowMs: number, reclaim = false): BallState {
    attempt.resolved = true;
    this.catchAttemptByKey.set(`${defenderId}:${hand}`, attempt);
    const defender = this.state.players[defenderId];
    const present = this.state.balls[ballId];
    const absorbedSpeed = length(present.velocity);
    const incomingVelocity = cloneVec3(present.velocity);
    const caught = catchBall(present, defenderId, hand);
    this.state.balls[ballId] = caught;
    const boostDir = normalize(vec3(facing.x, 0, facing.z), vec3(0, 0, 1));
    this.state.players[defenderId] = {
      ...defender,
      dash: grantDashCharge(defender.dash),
      hands: assignCaughtHand(defender.hands, hand, ballId),
      movement: { ...defender.movement, velocity: add(defender.movement.velocity, scale(boostDir, GAME_CONSTANTS.catch.catchBoostSpeed)) },
      movementInternal: { ...defender.movementInternal, catchBoostTimer: GAME_CONSTANTS.catch.catchBoostDuration }
    };
    this.adjustPlayerMatchStat(defenderId, 'catches', 1);
    if (reclaim) this.adjustPlayerMatchStat(defenderId, 'saves', 1);
    this.undoRecentHitIfClaimed(ballId, defenderId, nowMs);
    this.ballHistoryById.delete(ballId);
    this.combatMetrics.catches += 1;
    this.pendingCombatEvents.push({
      type: 'catch-event',
      ballId,
      catcherId: defenderId,
      hand,
      absorbedSpeed,
      incomingVelocity,
      serverTick: this.state.tick,
      serverTimeMs: nowMs,
      reclaim
    });
    this.catchTrace(
      `catch-apply player=${defenderId} hand=${hand} id=${attempt.attemptId}` +
      ` ball=${ballId} result=held heldBy=${caught.heldByPlayerId ?? 'none'} heldHand=${caught.heldHand ?? 'none'}` +
      ` event=catch-event snapshotHandBall=${this.state.players[defenderId]?.hands[hand].heldBallId ?? 'none'} reclaim=${Number(reclaim)}`
    );
    return caught;
  }

  /**
   * If a hit was applied on `defenderId` for `ballId` within the grace window, revert it — a
   * lag-compensated catch from that defender legitimately claimed the ball that scored on them.
   */
  private undoRecentHitIfClaimed(ballId: string, defenderId: string, nowMs: number): void {
    const hit = this.recentHitByBallId.get(ballId);
    if (!hit) return;
    if (hit.defenderId !== defenderId) return; // a catch only cancels a hit that landed on this defender
    if (nowMs - hit.atMs > this.combatTiming.catchHitGraceMs) return;
    this.revertHit(hit);
    this.recentHitByBallId.delete(ballId);
  }

  /** Revert a scored hit: decrement the thrower team's score, restore their dash, recompute outcome. */
  private revertHit(hit: RecentHit): void {
    this.adjustPlayerMatchStat(hit.throwerId, 'hits', -hit.value);
    this.adjustPlayerMatchStat(hit.defenderId, 'hitsTaken', -hit.value);
    this.adjustHitBreakdownStats(hit.throwerId, hit.statBreakdown, -1);
    // Restore the defender's life/elimination, the 1v1 hit-tally stat, and any round/match transition
    // this hit caused (round award + inter-round countdown), so a lag-comp catch cleanly supersedes it.
    const defender = this.state.players[hit.defenderId];
    if (defender) {
      defender.lives = Math.max(1, hit.defenderLivesBefore ?? defender.lives);
      defender.combatState = hit.defenderCombatStateBefore ?? 'alive';
      defender.eliminatedAtMs = hit.defenderEliminatedAtMsBefore ?? null;
    }
    const scoreDelta = hit.scoreDelta ?? 0;
    const scoreByTeamId = scoreDelta > 0
      ? { ...this.state.match.scoreByTeamId, [hit.throwerTeamId]: Math.max(0, (this.state.match.scoreByTeamId[hit.throwerTeamId] ?? 0) - scoreDelta) }
      : this.state.match.scoreByTeamId;
    this.state.match = {
      ...this.state.match,
      scoreByTeamId,
      status: hit.matchStatusBefore ?? this.state.match.status,
      winnerTeamId: hit.winnerTeamIdBefore ?? null,
      currentRound: hit.currentRoundBefore ?? this.state.match.currentRound,
      roundsWonByTeamId: hit.roundsWonByTeamIdBefore ? { ...hit.roundsWonByTeamIdBefore } : this.state.match.roundsWonByTeamId,
      countdownSeconds: hit.countdownSecondsBefore ?? this.state.match.countdownSeconds
    };
    this.roundRebuildPending = hit.roundRebuildPendingBefore ?? this.roundRebuildPending;
    this.refreshLastPlayerBuffs(this.stepNowMs);
    const thrower = this.state.players[hit.throwerId];
    if (thrower) this.state.players[hit.throwerId] = { ...thrower, dash: hit.throwerDashBefore };
    this.combatMetrics.hitReverts += 1;
    this.pendingCombatEvents.push({ type: 'hit-revert-event', ballId: hit.ballId, throwerId: hit.throwerId, targetId: hit.defenderId, serverTick: this.state.tick, serverTimeMs: this.stepNowMs });
    this.syncPlayerScores();
    if (this.debug.CATCH_DEBUG || this.debug.NET_DEBUG) {
      this.logger(`hit reverted (lag-comp catch) thrower=${hit.throwerId} defender=${hit.defenderId} ball=${hit.ballId}`);
    }
  }

  /** Drop recorded hits older than the catch-undo grace so the map stays bounded. */
  private pruneRecentHits(nowMs: number): void {
    for (const [ballId, hit] of this.recentHitByBallId) {
      if (nowMs - hit.atMs > this.combatTiming.catchHitGraceMs) this.recentHitByBallId.delete(ballId);
    }
  }

  /** Returns a catch fail reason, or null if this defender+hand would catch the ball this tick. */
  private catchFailReason(
    defender: PlayerState,
    hand: HandSide,
    sample: DefenseSample | null,
    ball: BallState,
    segPrev: Vec3,
    segCurr: Vec3,
    attempt: CatchAttempt,
    now: number
  ): CatchFailReason | null {
    {
      const handEmpty = sample
        ? (hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty)
        : !defender.hands[hand].heldBallId;
      return sweptCatchFailReason({
        handEmpty,
        dashing: sample ? sample.dashing : defender.movement.dashingThisFrame,
        defenderPlayerId: defender.id,
        ball,
        origin: sample ? sample.eye : add(defender.movement.position, vec3(0, GAME_CONSTANTS.player.eyeHeight, 0)),
        forward: sample ? sample.forward : defender.movement.facing,
        segmentStart: segPrev,
        segmentEnd: segCurr,
        timing: {
          nowMs: now,
          openedAtMs: attempt.openedAtMs,
          startupMs: this.combatTiming.catchStartupMs,
          activeUntilMs: attempt.activeUntilMs
        }
      });
    }
    /*
    // Timing window: too-early before startup elapses, too-late after the active window.
    if (now < attempt.openedAtMs + this.combatTiming.catchStartupMs) return 'too-early';
    if (now > attempt.activeUntilMs) return 'too-late';
    // Eligibility from the rewound sample (fall back to present state if no history yet).
    const handEmpty = sample
      ? (hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty)
      : !defender.hands[hand].heldBallId;
    if (!handEmpty) return 'no-empty-hand';
    const dashing = sample ? sample.dashing : defender.movement.dashingThisFrame;
    if (dashing) return 'dashing';
    // Catchable = a live/deflected ball OR a moving bounced dead ball.
    if (!isBallCatchableInFlight(ball)) return 'ball-not-live';
    if (ball.ownerId !== null && ball.ownerId === defender.id && ball.bounceCount <= 0) return 'owner-invalid';
    const origin = sample ? sample.eye : add(defender.movement.position, vec3(0, GAME_CONSTANTS.player.eyeHeight, 0));
    const forward = sample ? sample.forward : defender.movement.facing;
    const closest = closestPointOnSegment(segPrev, segCurr, origin);
    if (distance(origin, closest) > GAME_CONSTANTS.catch.rangeMeters) return 'out-of-range';
    if (!sweptSegmentInCone(origin, forward, segPrev, segCurr, GAME_CONSTANTS.catch.coneDegrees, GAME_CONSTANTS.catch.rangeMeters)) return 'angle-too-wide';
    return null;
    */
  }

  /** Defensive sample nearest the requested time, clamped to the max-rewind window. */
  private sampleDefenseAt(playerId: string, atServerTimeMs: number): DefenseSample | null {
    const ring = this.defenseHistoryByPlayerId.get(playerId);
    if (!ring) return null;
    const minTime = this.stepNowMs - this.combatTiming.defenseMaxRewindMs - this.combatTiming.defenseInputGraceMs;
    const target = Math.max(minTime, atServerTimeMs);
    return ring.nearest(target);
  }

  private logCatchTraceEval(
    defenderId: string,
    hand: HandSide,
    ball: BallState,
    sample: DefenseSample | null,
    segPrev: Vec3,
    segCurr: Vec3,
    attempt: CatchAttempt,
    reason: CatchFailReason | null
  ): void {
    if (!this.debug.CATCH_TRACE_DEBUG && !this.debug.CATCH_DEBUG) return;
    const result = reason ? 'fail' : 'success';
    const key = `${defenderId}:${hand}:${attempt.attemptId}:${ball.id}:${result}:${reason ?? 'ok'}`;
    if (reason && this.catchTraceEvalSeen.has(key)) return;
    this.catchTraceEvalSeen.add(key);

    const origin = sample ? sample.eye : add(this.state.players[defenderId]?.movement.position ?? vec3(), vec3(0, GAME_CONSTANTS.player.eyeHeight, 0));
    const closest = closestPointOnSegment(segPrev, segCurr, origin);
    const range = distance(origin, closest);
    const handEmpty = sample ? (hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty) : !this.state.players[defenderId]?.hands[hand].heldBallId;
    const dashing = sample ? sample.dashing : Boolean(this.state.players[defenderId]?.movement.dashingThisFrame);
    const sampleAgeMs = sample ? Math.round(Math.abs(sample.serverTimeMs - attempt.openedAtMs)) : 'missing';

    this.catchTrace(
      `catch-eval result=${result}${reason ? ` reason=${reason}` : ''}` +
      ` player=${defenderId} hand=${hand} id=${attempt.attemptId}` +
      ` ball=${ball.id} phase=${ball.phase} speed=${length(ball.velocity).toFixed(2)}` +
      ` bounce=${ball.bounceCount} owner=${ball.ownerId ?? 'none'}` +
      ` heldBy=${ball.heldByPlayerId ?? 'none'} heldHand=${ball.heldHand ?? 'none'} throwId=${ball.throwId}` +
      ` catchable=${Number(isBallCatchableInFlight(ball))}` +
      ` range=${range.toFixed(2)}/${GAME_CONSTANTS.catch.rangeMeters}` +
      ` handEmpty=${Number(handEmpty)} dashing=${Number(dashing)} sampleAgeMs=${sampleAgeMs}` +
      ` nowMs=${Math.round(this.stepNowMs)} openedAtMs=${Math.round(attempt.openedAtMs)}` +
      ` activeUntilMs=${Math.round(attempt.activeUntilMs)}` +
      ` segStart=(${segPrev.x.toFixed(2)},${segPrev.y.toFixed(2)},${segPrev.z.toFixed(2)})` +
      ` segEnd=(${segCurr.x.toFixed(2)},${segCurr.y.toFixed(2)},${segCurr.z.toFixed(2)})`
    );
  }

  private logCatchTraceReclaimSkip(
    defenderId: string,
    hand: HandSide,
    attempt: CatchAttempt,
    ballId: string,
    reason: string,
    evalTime: number,
    sample?: BallSample,
    bracket?: [BallSample, BallSample]
  ): void {
    if (!this.debug.CATCH_TRACE_DEBUG && !this.debug.CATCH_DEBUG) return;
    const key = `${defenderId}:${hand}:${attempt.attemptId}:${ballId}:reclaim:${reason}`;
    if (this.catchTraceEvalSeen.has(key)) return;
    this.catchTraceEvalSeen.add(key);
    this.catchTrace(
      `catch-reclaim result=fail reason=${reason}` +
      ` player=${defenderId} hand=${hand} id=${attempt.attemptId} ball=${ballId}` +
      ` evalTimeMs=${Math.round(evalTime)} clickTimeMs=${Math.round(attempt.clickTimeMs)}` +
      ` rewindMs=${Math.round(attempt.rewindMs)}` +
      ` historySample=${sample ? `${sample.phase}/speed=${length(sample.velocity).toFixed(2)}/bounce=${sample.bounceCount}` : 'missing'}` +
      ` bracket=${bracket ? `${bracket[0].tick}->${bracket[1].tick}` : 'missing'}`
    );
  }

  private logCatch(
    defenderId: string,
    hand: HandSide,
    ball: BallState,
    sample: DefenseSample | null,
    segPrev: Vec3,
    segCurr: Vec3,
    attempt: CatchAttempt,
    reason: CatchFailReason
  ): void {
    const origin = sample ? sample.eye : vec3();
    const closest = closestPointOnSegment(segPrev, segCurr, origin);
    const range = sample ? distance(origin, closest) : -1;
    this.logger(
      `catch FAIL defender=${defenderId} hand=${hand} ball=${ball.id} phase=${ball.phase}` +
      ` owner=${ball.ownerId ?? 'none'} id=${attempt.attemptId}` +
      ` range=${range.toFixed(2)}/${GAME_CONSTANTS.catch.rangeMeters}` +
      ` historyAgeMs=${sample ? Math.round(Math.abs(sample.serverTimeMs - attempt.clickTimeMs)) : 'n/a'}` +
      ` reason=${reason}`
    );
  }

  private logParry(
    defenderId: string,
    ball: BallState,
    sample: DefenseSample | null,
    segPrev: Vec3,
    segCurr: Vec3,
    reason: ParryFailReason
  ): void {
    const origin = sample ? sample.eye : vec3();
    const closest = closestPointOnSegment(segPrev, segCurr, origin);
    const range = sample ? distance(origin, closest) : -1;
    this.logger(
      `parry FAIL defender=${defenderId} ball=${ball.id} isSuper=${ball.isSuper}` +
      ` range=${range.toFixed(2)}/${GAME_CONSTANTS.parry.rangeMeters} reason=${reason}`
    );
  }

  private syncPlayerScores(): void {
    for (const playerId in this.state.players) {
      const player = this.state.players[playerId];
      player.score = this.state.match.scoreByTeamId[player.teamId] ?? 0;
    }
  }

  private adjustPlayerMatchStat(playerId: string, key: keyof PlayerState['matchStats'], delta: number): void {
    if (delta === 0) return;
    const player = this.state.players[playerId];
    if (!player) return;
    const current = player.matchStats[key] ?? 0;
    player.matchStats = {
      ...player.matchStats,
      [key]: Math.max(0, current + delta)
    };
  }

  /** Apply (+1) or revert (-1) a hit's report-card breakdown stats on the thrower. */
  private adjustHitBreakdownStats(throwerId: string, breakdown: HitStatBreakdown | undefined, sign: 1 | -1): void {
    if (!breakdown) return;
    if (breakdown.direct) this.adjustPlayerMatchStat(throwerId, 'directHits', sign);
    if (breakdown.bounce) this.adjustPlayerMatchStat(throwerId, 'bounceHits', sign);
    if (breakdown.curve) this.adjustPlayerMatchStat(throwerId, 'curveHits', sign);
    if (breakdown.backflip) this.adjustPlayerMatchStat(throwerId, 'backflipHits', sign);
  }

  private syncBattleMusicForMatchTransition(previousStatus: MatchStatus, nowMs: number): void {
    const nextStatus = this.state.match.status;
    if (previousStatus !== 'playing' && nextStatus === 'playing') {
      this.startBattleMusicSession(nowMs);
      return;
    }
    if (previousStatus === 'playing' && nextStatus !== 'playing') {
      this.stopBattleMusic();
    }
  }

  private startBattleMusicSession(nowMs: number): void {
    if (this.battleMusicTrackCount === 0) {
      this.stopBattleMusic();
      return;
    }
    this.nextBattleMusicSessionId += 1;
    this.setBattleMusicSyncState({
      active: true,
      sessionId: this.nextBattleMusicSessionId,
      shuffleSeed: createBattleMusicSessionSeed(this.nextBattleMusicSessionId, nowMs),
      playlistStartedAtServerTimeMs: nowMs
    });
  }

  private stopBattleMusic(): void {
    if (!this.battleMusicSyncState.active) return;
    this.setBattleMusicSyncState({
      ...this.battleMusicSyncState,
      active: false
    });
  }

  private setBattleMusicSyncState(nextState: BattleMusicSyncState): void {
    if (
      this.battleMusicSyncState.active === nextState.active &&
      this.battleMusicSyncState.sessionId === nextState.sessionId &&
      this.battleMusicSyncState.shuffleSeed === nextState.shuffleSeed &&
      this.battleMusicSyncState.playlistStartedAtServerTimeMs === nextState.playlistStartedAtServerTimeMs
    ) {
      return;
    }
    this.battleMusicSyncState = nextState;
    this.battleMusicSyncDirty = true;
  }

  private performRoomReset(triggerPlayerId: string, mode: 'same-teams' | 'reset-teams' = 'same-teams', autoStart = true): void {
    const previousMatchStatus = this.state.match.status;
    const players = Object.values(this.state.players)
      .filter((player) => player.connected !== false)
      .map((player) =>
      createPlayerState(player.id, player.teamId, player.legalHalf, {
        name: player.name,
        spawnSide: player.spawnSide,
        teamSlotIndex: player.teamSlotIndex,
        score: 0,
        // Each new match rebuilds every fighter with the host-configured starting lives.
        lives: this.matchSettings.livesPerPlayer,
        connected: true,
        reconnectDeadlineAtMs: null,
        movement: this.spawnMovement(this.slotForPlayer(player))
      })
    );

    this.resetSerial += 1;
    this.startVotesByPlayerId.clear();
    this.resetVotesByPlayerId.clear();
    this.endVotesByPlayerId.clear();
    this.endVoteInitiatorId = null;
    this.clearIntermissionVotes();
    // Preserve the running tick so it stays monotonic across the reset (see createFreshRoomState).
    this.state = this.createFreshRoomState(players, this.state.tick);
    this.ensureHostAssignment();
    this.teamChoicesByPlayerId.clear();
    for (const player of players) {
      this.seedInputTracking(player.id, this.slotForPlayer(player).yawRadians);
    }
    if (autoStart) {
      if (mode === 'same-teams' && this.matchMode === '2v2') {
        for (const player of players) this.teamChoicesByPlayerId.add(player.id);
        if (this.canVoteStart(players)) this.beginPregameCountdown('reset');
      } else if (this.matchMode === '1v1' && this.shouldAutoStart(players)) {
        this.beginPregameCountdown('auto');
      }
    }
    this.syncStartVoteState();
    this.syncResetVoteState();
    this.syncRoomPhase();
    this.syncBattleMusicForMatchTransition(previousMatchStatus, this.now());
    if (this.debug.NET_DEBUG) this.logger(`room reset by player=${triggerPlayerId} mode=${mode} players=${players.length} serial=${this.resetSerial}`);
  }

  private pruneResetVotes(now: number): void {
    let changed = false;
    for (const [playerId, expiresAtMs] of this.resetVotesByPlayerId) {
      const player = this.state.players[playerId];
      if (!player || player.connected === false || expiresAtMs <= now) {
        this.resetVotesByPlayerId.delete(playerId);
        changed = true;
      }
    }
    if (changed) this.syncResetVoteState();
  }

  private syncResetVoteState(mode = this.state.resetVote.mode): void {
    const votesByPlayerId: Record<string, true> = {};
    let expiresAtMs: number | null = null;

    for (const [playerId, expiry] of this.resetVotesByPlayerId) {
      if (!this.state.players[playerId] || this.state.players[playerId].connected === false) continue;
      votesByPlayerId[playerId] = true;
      expiresAtMs = expiresAtMs === null ? expiry : Math.min(expiresAtMs, expiry);
    }

    this.state.resetVote = createResetVoteState({
      mode,
      votesByPlayerId,
      voteCount: Object.keys(votesByPlayerId).length,
      requiredVotes: votesRequiredForPass(this.connectedCount()),
      expiresAtMs,
      resetSerial: this.resetSerial
    });
  }

  private pruneStartVotes(now: number): void {
    let changed = false;
    for (const [playerId, expiresAtMs] of this.startVotesByPlayerId) {
      const player = this.state.players[playerId];
      if (!player || player.connected === false || expiresAtMs <= now || this.state.match.status !== 'warmup') {
        this.startVotesByPlayerId.delete(playerId);
        changed = true;
      }
    }
    if (changed) this.syncStartVoteState();
  }

  private syncStartVoteState(): void {
    const votesByPlayerId: Record<string, true> = {};
    let expiresAtMs: number | null = null;

    for (const [playerId, expiry] of this.startVotesByPlayerId) {
      if (!this.state.players[playerId] || this.state.players[playerId].connected === false) continue;
      votesByPlayerId[playerId] = true;
      expiresAtMs = expiresAtMs === null ? expiry : Math.min(expiresAtMs, expiry);
    }

    this.state.startVote = createStartVoteState({
      votesByPlayerId,
      voteCount: Object.keys(votesByPlayerId).length,
      requiredVotes: this.canVoteStart() ? votesRequiredForPass(this.connectedCount()) : 0,
      expiresAtMs,
      teamChoicesByPlayerId: this.teamChoicesSnapshot(),
      teamChoiceCount: this.teamChoiceCount(),
      requiredTeamChoices: this.matchMode === '2v2' ? this.connectedCount() : 0
    });
  }

  private reconcilePregameState(reason: 'join' | 'remove' | 'disconnect' | 'reconnect'): void {
    const previousMatchStatus = this.state.match.status;
    this.pruneStartVotes(this.now());
    this.pruneResetVotes(this.now());
    this.resolveResetVotesAfterRosterChange();
    this.startVotesByPlayerId.clear();
    this.syncStartVoteState();
    this.refreshLastPlayerBuffs(this.now());

    if (this.state.match.status === 'complete') {
      this.performRoomReset(`post-complete:${reason}`);
      return;
    }

    if (this.state.match.status === 'countdown' || this.state.match.status === 'playing') {
      this.resolveForfeitIfNeeded(reason);
    } else {
      this.state.match = { ...this.state.match, status: 'warmup', countdownSeconds: 0, winnerTeamId: null };
      this.syncStartVoteState();
      this.syncResetVoteState();
    }
    this.syncBattleMusicForMatchTransition(previousMatchStatus, this.now());
  }

  private clearVotesForPregameChange(): void {
    this.startVotesByPlayerId.clear();
    this.resetVotesByPlayerId.clear();
    this.syncStartVoteState();
    this.syncResetVoteState();
  }

  private markAutoAssignedTeamChoice(player: PlayerState): void {
    if (this.matchMode !== '2v2') return;
    if (this.state.match.status !== 'warmup') return;
    if (player.connected === false) return;
    this.teamChoicesByPlayerId.add(player.id);
  }

  private resolveResetVotesAfterRosterChange(): void {
    this.syncResetVoteState();
    const vote = this.state.resetVote;
    if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes && vote.voteCount > 0) {
      const triggerPlayerId = Object.keys(vote.votesByPlayerId)[0] ?? 'roster-change';
      this.performRoomReset(triggerPlayerId, vote.mode);
    }
  }

  private pruneExpiredReconnects(nowMs: number): void {
    const expired: string[] = [];
    for (const player of Object.values(this.state.players)) {
      if (player.connected !== false) continue;
      if ((player.reconnectDeadlineAtMs ?? 0) > nowMs) continue;
      expired.push(player.id);
    }
    for (const playerId of expired) this.abandon(playerId);
  }

  private canVoteStart(players: PlayerState[] = Object.values(this.state.players)): boolean {
    const connectedPlayers = players.filter((player) => player.connected !== false);
    if (connectedPlayers.length < 2) return false;
    if (this.matchMode === '2v2' && !this.allConnectedPlayersChoseTeams(connectedPlayers)) return false;
    return this.connectedTeamCount(connectedPlayers) >= this.teamsRequiredToPlay;
  }

  private allConnectedPlayersChoseTeams(players: PlayerState[] = Object.values(this.state.players)): boolean {
    const connectedPlayers = players.filter((player) => player.connected !== false);
    return connectedPlayers.length > 0 && connectedPlayers.every((player) => this.teamChoicesByPlayerId.has(player.id));
  }

  private teamChoiceCount(): number {
    let count = 0;
    for (const playerId of this.teamChoicesByPlayerId) {
      const player = this.state.players[playerId];
      if (player && player.connected !== false) count += 1;
    }
    return count;
  }

  private teamChoicesSnapshot(): Record<string, true> {
    const choices: Record<string, true> = {};
    for (const playerId of this.teamChoicesByPlayerId) {
      const player = this.state.players[playerId];
      if (player && player.connected !== false) choices[playerId] = true;
    }
    return choices;
  }

  private shouldAutoStart(players: PlayerState[] = Object.values(this.state.players)): boolean {
    if (this.matchMode === '2v2') return false;
    if (!this.hasFullRoster(players)) return false;
    return this.teamIds.every((teamId) => players.filter((player) => player.connected !== false && player.teamId === teamId).length >= this.playersPerTeam);
  }

  private beginPregameCountdown(kind: 'auto' | 'vote' | 'reset' | 'host'): void {
    this.startVotesByPlayerId.clear();
    this.syncStartVoteState();
    this.state.match = {
      ...this.state.match,
      status: 'countdown',
      countdownSeconds: GAME_CONSTANTS.match.countdownSeconds,
      elapsedSeconds: 0,
      winnerTeamId: null,
      boundary: { ...this.state.match.boundary, elapsedSeconds: 0, noBoundaries: false, lastEvent: { type: 'none' } }
    };
    // Rack the balls (and reset players/mats) immediately on match start — the countdown plays out
    // over the ready-to-go court instead of the warmup scatter snapping only at timer-zero.
    this.startRoundWorld();
    this.roundRebuildPending = false;
    if (this.debug.NET_DEBUG) this.logger(`match start ${kind} players=${this.connectedCount()}/${this.maxPlayers}`);
  }

  private resolveForfeitIfNeeded(reason: string): void {
    if (this.state.match.status !== 'countdown' && this.state.match.status !== 'playing') return;

    const activeTeams = this.state.match.teamIds.filter((teamId) =>
      Object.values(this.state.players).some((player) => player.teamId === teamId && this.isPlayerActiveFighter(player))
    );

    if (activeTeams.length === 1) {
      this.forfeitTo(activeTeams[0]);
      if (this.debug.NET_DEBUG) this.logger(`forfeit win team=${activeTeams[0]} reason=${reason}`);
      return;
    }

    if (activeTeams.length === 0) {
      this.state.match = { ...this.state.match, status: 'warmup', countdownSeconds: 0, winnerTeamId: null };
      this.syncStartVoteState();
    }
  }

  private resolveRequestedSlot(teamId: string, requestedSlotIndex?: number): PlayerSlot | null {
    if (requestedSlotIndex !== undefined) {
      return this.playerSlots.find((slot) => slot.teamId === teamId && slot.teamSlotIndex === requestedSlotIndex) ?? null;
    }
    return this.playerSlots.find((slot) =>
      slot.teamId === teamId &&
      !Object.values(this.state.players).some((player) => player.teamId === slot.teamId && player.teamSlotIndex === slot.teamSlotIndex)
    ) ?? this.playerSlots.find((slot) => slot.teamId === teamId) ?? null;
  }

  private teamHasNoActiveFighter(players: PlayerState[]): boolean {
    const activeCount = players.filter((player) => this.isPlayerActiveFighter(player)).length;
    return activeCount === 0 && players.length > 0;
  }

  private dropOneHeldBall(player: PlayerState): void {
    const hand = player.hands.right.heldBallId ? 'right' : player.hands.left.heldBallId ? 'left' : null;
    if (!hand) return;
    const ballId = player.hands[hand].heldBallId;
    if (!ballId) return;
    const ball = this.state.balls[ballId];
    if (!ball) return;
    const result = dropBallFromHand(player.hands, hand, ball, heldBallPosition(player, hand), dropReleaseVelocity(player.movement.velocity));
    if (!result.ok) return;
    this.state.players[player.id] = { ...player, hands: result.hands };
    this.state.balls[ballId] = result.ball;
  }

  private dropAllHeldBalls(player: PlayerState): void {
    for (const hand of ['left', 'right'] as const) {
      const ballId = player.hands[hand].heldBallId;
      if (!ballId) continue;
      const ball = this.state.balls[ballId];
      if (!ball) continue;
      const result = dropBallFromHand(player.hands, hand, ball, heldBallPosition(player, hand), dropReleaseVelocity(player.movement.velocity));
      if (!result.ok) continue;
      player.hands = result.hands;
      this.state.balls[ballId] = result.ball;
    }
  }

  /** Force drops all held balls with a scattering impulse. */
  private scatterHeldBalls(player: PlayerState): void {
    for (const hand of ['left', 'right'] as const) {
      const ballId = player.hands[hand].heldBallId;
      if (!ballId) continue;
      const ball = this.state.balls[ballId];
      if (!ball) continue;
      const res = dropBallFromHand(player.hands, hand, ball, heldBallPosition(player, hand));
      if (!res.ok) continue;
      player.hands = res.hands;
      const angle = Math.random() * Math.PI * 2;
      const speed = 6 + Math.random() * 4;
      res.ball.velocity = vec3(Math.cos(angle) * speed, 5, Math.sin(angle) * speed);
      this.state.balls[ballId] = res.ball;
    }
  }

  /**
   * Defensive invariant repair: hands and held balls must agree on ownership. Under very spammy
   * throw/catch races we can otherwise strand a ball in `phase=held` after the hand that owned it
   * already moved on, which shows up as a persistent visual "ghost" ball. We prefer the player hand
   * as the source of truth for control, then either realign the ball to that claim or drop orphaned
   * held balls back into the world.
   */
  private repairBallHandConsistency(): void {
    const claims = new Map<string, { playerId: string; hand: HandSide }>();
    const duplicateClaims = new Set<string>();

    for (const playerId in this.state.players) {
      const player = this.state.players[playerId];
      for (const hand of ['left', 'right'] as const) {
        const ballId = player.hands[hand].heldBallId;
        if (!ballId) continue;
        if (claims.has(ballId)) {
          duplicateClaims.add(ballId);
          continue;
        }
        claims.set(ballId, { playerId, hand });
      }
    }

    for (const playerId in this.state.players) {
      const player = this.state.players[playerId];
      let hands = player.hands;
      let changed = false;

      for (const hand of ['left', 'right'] as const) {
        const ballId = hands[hand].heldBallId;
        if (!ballId) continue;
        const ball = this.state.balls[ballId];
        const duplicated = duplicateClaims.has(ballId);
        const valid =
          !duplicated &&
          !!ball &&
          ball.phase === 'held' &&
          ball.heldByPlayerId === playerId &&
          ball.heldHand === hand;
        if (valid) continue;
        hands = clearHeldHand(hands, hand);
        changed = true;
        if (this.debug.NET_DEBUG) {
          this.logger(
            `repair cleared hand player=${playerId} hand=${hand} ball=${ballId}` +
            ` duplicated=${Number(duplicated)} phase=${ball?.phase ?? 'missing'}`
          );
        }
      }

      if (changed) this.state.players[playerId] = { ...player, hands };
    }

    for (const ballId in this.state.balls) {
      const ball = this.state.balls[ballId];
      const claim = claims.get(ballId);

      if (ball.phase !== 'held') {
        if (claim) {
          const player = this.state.players[claim.playerId];
          const hand = player?.hands[claim.hand];
          if (player && hand?.heldBallId === ballId) {
            this.state.players[claim.playerId] = { ...player, hands: clearHeldHand(player.hands, claim.hand) };
            if (this.debug.NET_DEBUG) {
              this.logger(`repair cleared stale claim player=${claim.playerId} hand=${claim.hand} ball=${ballId} phase=${ball.phase}`);
            }
          }
        }
        continue;
      }

      if (!claim || duplicateClaims.has(ballId)) {
        this.state.balls[ballId] = markBallDead(ball);
        if (this.debug.NET_DEBUG) {
          this.logger(
            `repair dropped orphan held-ball ball=${ballId} owner=${ball.heldByPlayerId ?? '-'} hand=${ball.heldHand ?? '-'} duplicated=${Number(duplicateClaims.has(ballId))}`
          );
        }
        continue;
      }

      if (ball.heldByPlayerId === claim.playerId && ball.heldHand === claim.hand) continue;
      this.state.balls[ballId] = catchBall(ball, claim.playerId, claim.hand);
      if (this.debug.NET_DEBUG) {
        this.logger(`repair realigned held-ball ball=${ballId} owner=${claim.playerId} hand=${claim.hand}`);
      }
    }
  }

  private connectedCount(): number {
    let count = 0;
    for (const playerId in this.state.players) {
      if (this.state.players[playerId].connected !== false) count += 1;
    }
    return count;
  }

  private playerCount(players: PlayerState[] = Object.values(this.state.players)): number {
    return players.length;
  }

  private connectedTeamIds(exceptPlayerId?: string, players: PlayerState[] = Object.values(this.state.players)): string[] {
    const teams = new Set<string>();
    for (const player of players) {
      if (player.id === exceptPlayerId || player.connected === false) continue;
      teams.add(player.teamId);
    }
    return [...teams];
  }

  private connectedTeamCount(players?: PlayerState[]): number {
    return this.connectedTeamIds(undefined, players).length;
  }

  private hasEnoughConnectedTeamsToPlay(players?: PlayerState[]): boolean {
    return this.connectedTeamCount(players) >= this.teamsRequiredToPlay;
  }

  private hasFullRoster(players: PlayerState[] = Object.values(this.state.players)): boolean {
    return players.length >= this.maxPlayers;
  }

  private startMatch(): void {
    // Begin with a pre-round COUNTDOWN rather than jumping straight to 'playing'. During it the
    // server pins players to spawn (see pinPlayersToSpawn / step) so the round starts cleanly and
    // identically every time — this is also the deterministic post-reset state that fixes the old
    // "everyone stuck after a 1v1 reset" freeze.
    this.state.match = {
      ...this.state.match,
      status: 'countdown',
      countdownSeconds: GAME_CONSTANTS.match.countdownSeconds,
      elapsedSeconds: 0,
      winnerTeamId: null,
      boundary: { ...this.state.match.boundary, elapsedSeconds: 0, noBoundaries: false, lastEvent: { type: 'none' } }
    };
  }

  private forfeitTo(winnerTeamId: string): void {
    const scoreByTeamId = {
      ...this.state.match.scoreByTeamId,
      [winnerTeamId]: Math.max(this.state.match.scoreByTeamId[winnerTeamId] ?? 0, this.state.match.scoreLimit)
    };
    this.state.match = { ...this.state.match, status: 'complete', winnerTeamId, scoreByTeamId };
  }

  /** Pull the next input to simulate: drained queued batch, else neutral (if stale), else last-held. */
  private nextInputCommand(player: PlayerState): QueuedInput {
    const queue = this.inputQueueByPlayerId.get(player.id);
    const queuedCount = queue?.length ?? 0;
    const playerWindow = this.playerNetWindowStats(player.id);
    this.inputDrainMetrics.samples += 1;
    if (queuedCount > this.inputDrainMetrics.maxInputQueueBeforeDrain) {
      this.inputDrainMetrics.maxInputQueueBeforeDrain = queuedCount;
    }
    playerWindow.inputQueueDepthTotal += queuedCount;
    playerWindow.inputQueueDepthSamples += 1;
    if (queuedCount > playerWindow.inputQueueDepthMax) playerWindow.inputQueueDepthMax = queuedCount;

    if (queue && queuedCount > 0) {
      const drained = queue.splice(0, queuedCount);
      const command = coalesceQueuedInputs(drained);
      if (
        command.input.leftCatchAttemptId > 0 ||
        command.input.rightCatchAttemptId > 0 ||
        drained.some((entry) => entry.input.leftCatchAttemptId > 0 || entry.input.rightCatchAttemptId > 0)
      ) {
        const newest = drained[drained.length - 1]?.input;
        this.catchTrace(
          `input-coalesce player=${player.id} drained=${queuedCount} seq=${command.seq}` +
          ` resultLeft=${command.input.leftCatchAttemptId} resultRight=${command.input.rightCatchAttemptId}` +
          ` newestLeft=${newest?.leftCatchAttemptId ?? 0} newestRight=${newest?.rightCatchAttemptId ?? 0}` +
          ` resultClientTimeMs=${Math.round(command.input.clientTimeMs)}`
        );
      }
      this.inputDrainMetrics.inputsDrainedTotal += queuedCount;
      if (queuedCount > this.inputDrainMetrics.maxInputsDrainedThisTick) {
        this.inputDrainMetrics.maxInputsDrainedThisTick = queuedCount;
      }
      playerWindow.inputsDrainedTotal += queuedCount;
      playerWindow.inputsDrainedSamples += 1;
      if (queuedCount > playerWindow.inputsDrainedMax) playerWindow.inputsDrainedMax = queuedCount;
      // After consuming queued inputs, strip edge-triggered fields from the coalesced held-state
      // fallback so empty-queue ticks keep movement/look/held state without re-firing actions.
      this.lastInputByPlayerId.set(player.id, clearEdges(command.input));
      return command;
    }

    const seq = player.lastProcessedInputSeq;
    const lastAt = this.lastInputAtByPlayerId.get(player.id) ?? 0;
    const lastInput = this.lastInputByPlayerId.get(player.id) ?? defaultInput(player.movement.yawRadians);

    // Stale (backgrounded tab / dropped connection): freeze movement but keep look angles (#14).
    if (player.connected === false || this.now() - lastAt > STALE_INPUT_MS) {
      return { seq, input: neutralInput(lastInput) };
    }
    return { seq, input: lastInput };
  }

  private slotForPlayer(player: Pick<PlayerState, 'teamId' | 'teamSlotIndex' | 'spawnSide'>): PlayerSlot {
    const slot = this.playerSlots.find((candidate) =>
      candidate.teamId === player.teamId && candidate.teamSlotIndex === player.teamSlotIndex
    );
    if (slot) return slot;
    const fallback = SPAWN_BASE_BY_SIDE[player.spawnSide];
    return {
      teamId: player.teamId,
      spawnSide: player.spawnSide,
      teamSlotIndex: player.teamSlotIndex,
      position: { ...fallback.position },
      yawRadians: fallback.yawRadians
    };
  }

  private nextPlayerSlot(): PlayerSlot | null {
    const usedSlots = new Set(
      Object.values(this.state.players).map((player) => `${player.teamId}:${player.teamSlotIndex}`)
    );
    for (const slot of this.playerSlots) {
      if (!usedSlots.has(`${slot.teamId}:${slot.teamSlotIndex}`)) return slot;
    }
    return null;
  }

  private spawnMovement(slot: PlayerSlot): PlayerState['movement'] {
    return {
      position: { ...slot.position },
      velocity: vec3(),
      yawRadians: slot.yawRadians,
      pitchRadians: 0,
      facing: facingFromAngles(slot.yawRadians, 0),
      grounded: true,
      crouching: false,
      sliding: false,
      wallRunning: false,
      dashingThisFrame: false,
      speed: 0
    };
  }

  private seedInputTracking(playerId: string, yawRadians: number): void {
    this.inputQueueByPlayerId.set(playerId, []);
    this.lastInputByPlayerId.set(playerId, defaultInput(yawRadians));
    this.previousInputByPlayerId.set(playerId, defaultInput(yawRadians));
    const now = this.now();
    this.lastInputAtByPlayerId.set(playerId, now);
    this.lastProcessedInputAtByPlayerId.set(playerId, now);
    this.lastEnqueuedSeqByPlayerId.set(playerId, 0);
    this.parryCooldownByPlayerId.set(playerId, 0);
    this.playerNetWindowStatsByPlayerId.delete(playerId);
    // CRITICAL: the client restarts its input sequence at 0 on a reset (resetPrediction). The player
    // object is REUSED across a room reset, so its lastProcessedInputSeq still holds the pre-reset
    // (high) value. If we don't clear it, the server acks that stale-high seq, the client's
    // reconcile filters EVERY fresh input as "already acked" (seq <= ack), replays nothing, and the
    // local player gets snapped back to spawn each frame — the "stuck after reset" freeze. Reset it
    // so the server's ack stream restarts from 0 in lock-step with the client.
    const player = this.state.players[playerId];
    if (player) player.lastProcessedInputSeq = 0;
    // Fresh defense history + cleared catch-attempt state (reset/respawn/rejoin must not reuse old
    // history across a discontinuity — that would lag-comp against pre-reset positions).
    this.defenseHistoryByPlayerId.set(playerId, new TimeRing<DefenseSample>(this.combatTiming.defenseHistoryMs, this.historyMaxSamples()));
    this.catchAttemptByKey.delete(`${playerId}:left`);
    this.catchAttemptByKey.delete(`${playerId}:right`);
    this.lastCatchAttemptIdByKey.set(`${playerId}:left`, 0);
    this.lastCatchAttemptIdByKey.set(`${playerId}:right`, 0);
  }

  private createFreshRoomState(players: PlayerState[] = [], startTick = 0): RoomState {
    // All active mats stand again on a fresh state / reset; rebuild both collision sets from the
    // current host mat preset so the rebuilt world matches the authoritative mat state.
    this.knockedOverMatIds.clear();
    this.matRestoreHoldTicksByPlayerId.clear();
    this.matPostResetKnockImmunityUntilTickById.clear();
    this.roundRebuildPending = false;
    this.activeMatSpecs = matSpecsForPreset(this.matchSettings.matPreset);
    this.rebuildCollisionBoxes();
    // Combat history is timeline-specific: a reset is a discontinuity, so drop ball history, any
    // open catch attempts, and undelivered throw events so lag-comp never rewinds across the reset.
    this.ballHistoryById.clear();
    this.catchAttemptByKey.clear();
    this.catchTraceEvalSeen.clear();
    this.recentHitByBallId.clear();
    this.pendingThrowEvents = [];
    // Fresh room state always returns to warmup. Joins / explicit start votes / auto-start checks
    // drive the next countdown transition so resets and post-game roster changes land in a clean
    // pre-game waiting state instead of silently re-entering the round. Legacy match fields are
    // derived from the resolved host settings; the ball count comes straight from the settings.
    const match = createMatchState(this.roomId, [...this.teamIds], {
      mode: this.matchMode,
      scoreLimit: this.matchSettings.scoreLimit,
      playersPerTeam: this.playersPerTeam,
      maxPlayers: this.maxPlayers,
      roundCount: this.matchSettings.roundCount,
      currentRound: 1,
      status: 'warmup',
      countdownSeconds: 0
    });
    return createRoomState({
      id: this.roomId,
      // The snapshot tick MUST stay monotonic across a room reset. The client gates reconciliation
      // on `snapshot.tick > lastReconciledTick`; if the tick fell back to 0 here, every post-reset
      // snapshot would fail that guard and the local player would freeze (never re-adopting server
      // state). Carry the running tick forward; resetSerial is what signals a reset to the client.
      tick: startTick,
      players,
      balls: createInitialBalls(this.matchSettings.dodgeballCount),
      settings: this.settings,
      netMode: this.netMode,
      hostPlayerId: this.hostPlayerId,
      phase: roomPhaseFromMatchStatus('warmup'),
      mats: createMatStates(this.activeMatSpecs),
      match,
      startVote: createStartVoteState(),
      resetVote: createResetVoteState({
        requiredVotes: votesRequiredForPass(players.filter((player) => player.connected !== false).length),
        resetSerial: this.resetSerial
      })
    });
  }
}

function createInitialBalls(ballCount: number = GAME_CONSTANTS.map.ballCount): BallState[] {
  const spacing = 2;
  const start = -((ballCount - 1) * spacing) / 2;
  const balls: BallState[] = [];
  for (let i = 0; i < ballCount; i += 1) {
    balls.push(createBallState(`ball_${i}`, vec3(start + i * spacing, GAME_CONSTANTS.ball.radius + 0.05, 0)));
  }
  return balls;
}

function horizontalDistanceSqToSegment(point: Vec3, a: Vec3, b: Vec3): number {
  const abX = b.x - a.x;
  const abZ = b.z - a.z;
  const apX = point.x - a.x;
  const apZ = point.z - a.z;
  const lenSq = abX * abX + abZ * abZ;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (apX * abX + apZ * abZ) / lenSq)) : 0;
  const closestX = a.x + abX * t;
  const closestZ = a.z + abZ * t;
  const dx = point.x - closestX;
  const dz = point.z - closestZ;
  return dx * dx + dz * dz;
}

/** Pick the room's format from legacy constructor args (settings.format wins, then mode, then size). */
function resolveConstructorFormat(options: ServerGameLoopOptions): MatchFormat {
  const requested = options.settings?.format ?? options.mode ?? ((options.playersPerTeam ?? 1) >= 2 ? '2v2' : '1v1');
  return isAllowedFormat(requested) ? requested : '1v1';
}

/**
 * Live-ball bounce rule sourced from the host setting. One knob (`maxLiveBallBounces`) drives both the
 * live and deflected death thresholds — the separate side-wall/ceiling "one bounce" mechanic is left
 * to its dedicated rule (applyWallCeilingBounce) and is intentionally not overridden here.
 */
function bounceRuleFromSettings(matchSettings: MatchSettings): BounceRule {
  return {
    deadAfterBounces: matchSettings.maxLiveBallBounces,
    deflectedDeadAfterBounces: matchSettings.maxLiveBallBounces
  };
}

function buildPlayerSlots(teamIds: readonly string[], playersPerTeam: number): PlayerSlot[] {
  const slots: PlayerSlot[] = [];
  const clampedPerTeam = Math.max(1, playersPerTeam);
  const laneOffsets = clampedPerTeam <= 1
    ? [0]
    : [-1.9, 1.9];

  for (let teamSlotIndex = 0; teamSlotIndex < clampedPerTeam; teamSlotIndex += 1) {
    for (let teamIndex = 0; teamIndex < teamIds.length; teamIndex += 1) {
      const spawnSide: SpawnSide = teamIndex % 2 === 0 ? 'negativeZ' : 'positiveZ';
      const base = SPAWN_BASE_BY_SIDE[spawnSide];
      const x = laneOffsets[Math.min(teamSlotIndex, laneOffsets.length - 1)] ?? 0;
      slots.push({
        teamId: teamIds[teamIndex],
        spawnSide,
        teamSlotIndex,
        position: vec3(x, base.position.y, base.position.z),
        yawRadians: base.yawRadians
      });
    }
  }

  return slots;
}

/**
 * Resolve a ball against the arena bounds.
 *
 * Step 7 — the direct side walls (±X) and the ceiling (+Y) let a live/deflected ball SURVIVE one
 * bounce (for variety: you can play a ball off the wall once). The ball dies on its SECOND such
 * wall/ceiling bounce. Every OTHER surface keeps the original behavior of killing on the first
 * bounce: the floor (−Y) must NOT keep the ball alive, and the back walls (±Z) and static objects
 * (bleachers/mats, handled in resolveBallStaticBoxes) are unchanged. Dead/loose balls just reflect.
 */
function resolveBallBounds(ball: BallState, bounceRule?: BounceRule): BallState {
  const r = GAME_CONSTANTS.ball.radius;
  const e = GAME_CONSTANTS.ball.bounceRestitution;
  const minX = -GAME_CONSTANTS.map.halfWidth + r;
  const maxX = GAME_CONSTANTS.map.halfWidth - r;
  const minZ = -GAME_CONSTANTS.map.halfLength + r;
  const maxZ = GAME_CONSTANTS.map.halfLength - r;
  const maxY = GAME_CONSTANTS.map.wallHeight - r;
  const position = { ...ball.position };
  const velocity = { ...ball.velocity };
  // Side walls (±X) + ceiling (+Y): the ball may survive ONE of these bounces.
  let hitWallOrCeiling = false;
  // Floor (−Y) + back walls (±Z): kill on first bounce, exactly as before.
  let hitKillNow = false;

  if (position.y < r) {
    position.y = r;
    velocity.y = Math.abs(velocity.y) * e;
    hitKillNow = true;
  }
  if (position.y > maxY) {
    position.y = maxY;
    velocity.y = -Math.abs(velocity.y) * e;
    hitWallOrCeiling = true;
  }
  if (position.x < minX) {
    position.x = minX;
    velocity.x = Math.abs(velocity.x) * e;
    hitWallOrCeiling = true;
  } else if (position.x > maxX) {
    position.x = maxX;
    velocity.x = -Math.abs(velocity.x) * e;
    hitWallOrCeiling = true;
  }
  if (position.z < minZ) {
    position.z = minZ;
    velocity.z = Math.abs(velocity.z) * e;
    hitWallOrCeiling = true;
  } else if (position.z > maxZ) {
    position.z = maxZ;
    velocity.z = -Math.abs(velocity.z) * e;
    hitWallOrCeiling = true;
  }

  if (!hitWallOrCeiling && !hitKillNow) return ball;

  const resolved = { ...ball, position, velocity };
  // A floor / back-wall contact always wins (kills now). Otherwise it was a side-wall/ceiling-only
  // contact: let the ball survive its first such bounce, die on the second.
  if (hitKillNow) return applySurfaceKillingBounce(resolved);
  return applyWallCeilingBounce(resolved, bounceRule);
}

function applySurfaceKillingBounce(ball: BallState): BallState {
  if (ball.phase !== 'live' && ball.phase !== 'deflected') {
    return { ...ball, bounceCount: ball.bounceCount + 1 };
  }
  return { ...markBallDead(ball), bounceCount: ball.bounceCount + 1 };
}

/**
 * Side-wall / ceiling bounce: a live/deflected ball survives its FIRST such bounce and dies on the
 * SECOND. Implemented by counting wall/ceiling bounces in bounceCount and only killing once the
 * count exceeds 1. Non-live phases just advance the count (mirrors applyBallBounce's tail).
 */
function applyWallCeilingBounce(ball: BallState, bounceRule?: BounceRule): BallState {
  if (ball.phase !== 'live' && ball.phase !== 'deflected') {
    return { ...ball, bounceCount: ball.bounceCount + 1 };
  }
  const bounceCount = ball.bounceCount + 1;
  const deadAfterBounces = ball.phase === 'deflected'
    ? bounceRule?.deflectedDeadAfterBounces ?? GAME_CONSTANTS.ball.deflectedDeadAfterBounces
    : bounceRule?.deadAfterBounces ?? GAME_CONSTANTS.ball.deadAfterBounces;
  if (bounceCount > deadAfterBounces) {
    return { ...markBallDead(ball), bounceCount };
  }
  return { ...ball, bounceCount };
}

function resolveBallStaticBoxes(ball: BallState, boxes: AABB[], logger?: (message: string) => void, bounceRule?: BounceRule): BallState {
  const r = GAME_CONSTANTS.ball.radius;
  const e = GAME_CONSTANTS.ball.bounceRestitution;
  const position = { ...ball.position };
  const velocity = { ...ball.velocity };
  let bounced = false;
  let hitBox: AABB | null = null;
  let hitAxis: 'x' | 'y' | 'z' | null = null;

  for (const box of boxes) {
    if (position.x < box.minX - r || position.x > box.maxX + r) continue;
    if (position.y < box.minY - r || position.y > box.maxY + r) continue;
    if (position.z < box.minZ - r || position.z > box.maxZ + r) continue;

    // The side bleachers form the low side-wall lane. For a horizontal BANK SHOT (|vx| ≥ |vy|) model
    // the stepped tiers as a single FLAT vertical side wall: reflect in X back toward the court and
    // survive one bounce, whether the discrete step grazed a tier front face (X) or a step top (Y).
    // Without this, a low bank shot that clips a (taller) step top reflects upward and dies on the
    // first bounce instead of banking — see isSideWallLikeStaticBounce / the side-wall one-bounce
    // rule. Vertical drops onto the bleachers (|vy| > |vx|) fall through to the normal per-axis bounce.
    if (box.kind === 'bleacher' && box.id?.startsWith('bleacher_tier_') === true && Math.abs(velocity.x) >= Math.abs(velocity.y)) {
      position.x = sideBleacherCourtFaceX(box);
      velocity.x = ((box.minX + box.maxX) * 0.5 >= 0 ? -1 : 1) * Math.abs(velocity.x) * e;
      hitAxis = 'x';
      bounced = true;
      hitBox = box;
      break;
    }

    const penX = Math.min(position.x - (box.minX - r), (box.maxX + r) - position.x);
    const penY = Math.min(position.y - (box.minY - r), (box.maxY + r) - position.y);
    const penZ = Math.min(position.z - (box.minZ - r), (box.maxZ + r) - position.z);

    if (penX <= penY && penX <= penZ) {
      position.x = position.x < (box.minX + box.maxX) * 0.5 ? box.minX - r : box.maxX + r;
      velocity.x = (position.x < (box.minX + box.maxX) * 0.5 ? -1 : 1) * Math.abs(velocity.x) * e;
      hitAxis = 'x';
    } else if (penY <= penZ) {
      position.y = position.y < (box.minY + box.maxY) * 0.5 ? box.minY - r : box.maxY + r;
      velocity.y = (position.y < (box.minY + box.maxY) * 0.5 ? -1 : 1) * Math.abs(velocity.y) * e;
      hitAxis = 'y';
    } else {
      position.z = position.z < (box.minZ + box.maxZ) * 0.5 ? box.minZ - r : box.maxZ + r;
      velocity.z = (position.z < (box.minZ + box.maxZ) * 0.5 ? -1 : 1) * Math.abs(velocity.z) * e;
      hitAxis = 'z';
    }

    bounced = true;
    hitBox = box;
    if (isSideWallLikeStaticBounce(hitBox, hitAxis)) {
      position.x = sideBleacherCourtFaceX(hitBox);
      break;
    }
  }

  if (!bounced) return ball;
  const resolvedBall = { ...ball, position, velocity };
  // A mat (standing cover OR a fallen mat lying flat) reflects the ball but keeps it live; the side
  // bleachers act like a side wall (survive one); everything else dies on first bounce as before.
  const resolved = isSideWallLikeStaticBounce(hitBox, hitAxis)
    ? applyWallCeilingBounce(resolvedBall, bounceRule)
    : hitBox?.kind === 'mat'
      ? applyMatBounce(resolvedBall)
      : applyBallBounce(resolvedBall, bounceRule);
  if (hitBox?.kind === 'bleacher') {
    logger?.(
      `bleacher collision ball=${ball.id} box=${hitBox.id ?? 'unknown'}` +
      ` axis=${hitAxis ?? 'unknown'}` +
      ` pos=(${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})` +
      ` vel=(${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)})`
    );
  }
  return resolved;
}

function isSideWallLikeStaticBounce(box: AABB | null, axis: 'x' | 'y' | 'z' | null): boolean {
  // In the actual gym, the side bleachers occupy the low side-wall lane. A low bank shot hits
  // those X faces before it can reach the arena bounds, so classify that impact like a side wall.
  return axis === 'x' && box?.kind === 'bleacher' && box.id?.startsWith('bleacher_tier_') === true;
}

const SIDE_BLEACHER_COURT_FACE_X =
  GAME_CONSTANTS.map.halfWidth -
  BLEACHER_LAYOUT.wallInset -
  BLEACHER_LAYOUT.tierCount * BLEACHER_LAYOUT.tierRun -
  GAME_CONSTANTS.ball.radius;

function sideBleacherCourtFaceX(box: AABB): number {
  const centerX = (box.minX + box.maxX) * 0.5;
  return centerX >= 0 ? SIDE_BLEACHER_COURT_FACE_X : -SIDE_BLEACHER_COURT_FACE_X;
}


function canScorePlayerHit(ball: BallState): boolean {
  if (ball.phase !== 'live') return false;
  if (ball.ownerKind !== 'player' || !ball.ownerId) return false;
  if (ball.heldByPlayerId || ball.heldHand) return false;
  if (length(ball.velocity) < GAME_CONSTANTS.ball.liveHitMinSpeed) return false;
  return true;
}

function coalesceQueuedInputs(commands: readonly QueuedInput[]): QueuedInput {
  const newest = commands[commands.length - 1];
  const input: PlayerInput = {
    ...newest.input,
    sequence: newest.seq,
    dashDirection: { ...newest.input.dashDirection },
    jumpPressed: false,
    dashPressed: false,
    crouchPressed: false,
    slidePressed: false,
    backflipPressed: false,
    pickupPressed: false,
    dropPressed: false,
    fakeThrowPressed: false,
    leftHandPressed: false,
    rightHandPressed: false,
    leftHandReleased: false,
    rightHandReleased: false,
    leftCatchAttemptId: 0,
    rightCatchAttemptId: 0,
    backflipThrowTier: 0
  };

  let leftCatchClientTimeMs: number | null = null;
  let rightCatchClientTimeMs: number | null = null;
  for (const command of commands) {
    const next = command.input;
    input.jumpPressed ||= next.jumpPressed;
    input.dashPressed ||= next.dashPressed;
    input.crouchPressed ||= next.crouchPressed;
    input.slidePressed ||= next.slidePressed;
    input.backflipPressed ||= next.backflipPressed;
    input.pickupPressed ||= next.pickupPressed;
    input.dropPressed ||= next.dropPressed;
    input.fakeThrowPressed ||= next.fakeThrowPressed;
    input.leftHandPressed ||= next.leftHandPressed;
    input.rightHandPressed ||= next.rightHandPressed;
    input.leftHandReleased ||= next.leftHandReleased;
    input.rightHandReleased ||= next.rightHandReleased;

    if (next.leftCatchAttemptId > input.leftCatchAttemptId) {
      input.leftCatchAttemptId = next.leftCatchAttemptId;
      leftCatchClientTimeMs = next.clientTimeMs;
    } else if (
      next.leftCatchAttemptId === input.leftCatchAttemptId &&
      next.leftCatchAttemptId > 0 &&
      leftCatchClientTimeMs === 0 &&
      next.clientTimeMs > 0
    ) {
      leftCatchClientTimeMs = next.clientTimeMs;
    }
    if (next.rightCatchAttemptId > input.rightCatchAttemptId) {
      input.rightCatchAttemptId = next.rightCatchAttemptId;
      rightCatchClientTimeMs = next.clientTimeMs;
    } else if (
      next.rightCatchAttemptId === input.rightCatchAttemptId &&
      next.rightCatchAttemptId > 0 &&
      rightCatchClientTimeMs === 0 &&
      next.clientTimeMs > 0
    ) {
      rightCatchClientTimeMs = next.clientTimeMs;
    }
    if (next.backflipThrowTier > 0) input.backflipThrowTier = next.backflipThrowTier;
  }

  // `clientTimeMs` is only used server-side to sub-tick anchor catch attempts. If a catch id came
  // from an earlier packet in the drained batch, keep that earlier click timing rather than the
  // newest movement packet's timestamp.
  const catchTimes = [leftCatchClientTimeMs, rightCatchClientTimeMs].filter((time): time is number => time !== null);
  if (catchTimes.length > 0) input.clientTimeMs = Math.min(...catchTimes);

  return { seq: newest.seq, input };
}

function defaultInput(yawRadians = 0): PlayerInput {
  return {
    sequence: 0,
    clientTimeMs: 0,
    moveX: 0,
    moveZ: 0,
    dashDirection: vec3(),
    lookYawRadians: yawRadians,
    lookPitchRadians: 0,
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
    resetSerial: 0,
    interactHeld: false
  };
}

/** Neutral input that preserves only the look angles (movement/buttons cleared). */
function neutralInput(source: PlayerInput): PlayerInput {
  return { ...defaultInput(source.lookYawRadians), lookPitchRadians: source.lookPitchRadians };
}

function normalizeInput(input: Partial<PlayerInput>, fallback: PlayerInput = defaultInput()): PlayerInput {
  const legacy = input as Partial<PlayerInput> & Partial<LegacyPlayerInput>;
  const jumpHeld = boolOr(input.jumpHeld, legacy.jump, fallback.jumpHeld);
  const crouchHeld = boolOr(input.crouchHeld, legacy.crouch, fallback.crouchHeld);
  const slideHeld = boolOr(input.slideHeld, legacy.slide, fallback.slideHeld);
  const leftHandHeld = boolOr(input.leftHandHeld, legacy.leftHand, fallback.leftHandHeld);
  const rightHandHeld = boolOr(input.rightHandHeld, legacy.rightHand, fallback.rightHandHeld);
  const fakeThrowHeld = boolOr(input.fakeThrowHeld, legacy.fakeThrow, fallback.fakeThrowHeld);
  // dashDirection is trimmed from the wire when zero (see toWireInput): an ABSENT dashDirection must
  // default to a ZERO vector, NOT the previous input's value. The sim only reads it on the dash tick
  // and a zero vector makes it fall through to the wish/facing direction — exactly what the client
  // predicted locally. Falling back to `fallback.dashDirection` would leak a stale earlier dash dir
  // into a later dash-with-no-movement tick and diverge from the client (reconciliation would fight).
  const dashDirection = sanitizeVec3(input.dashDirection, ZERO_DASH_DIRECTION);

  return {
    ...fallback,
    sequence: Math.max(0, Math.trunc(finiteNumber(input.sequence, fallback.sequence))),
    clientTimeMs: Math.max(0, finiteNumber(input.clientTimeMs, fallback.clientTimeMs)),
    moveX: clampNumber(input.moveX, -1, 1, fallback.moveX),
    moveZ: clampNumber(input.moveZ, -1, 1, fallback.moveZ),
    dashDirection,
    lookYawRadians: finiteNumber(input.lookYawRadians, fallback.lookYawRadians),
    lookPitchRadians: clampLookPitch(finiteNumber(input.lookPitchRadians, fallback.lookPitchRadians)),
    jumpPressed: Boolean(input.jumpPressed) || legacyPressed(legacy.jump, fallback.jumpHeld),
    jumpHeld,
    dashPressed: Boolean(input.dashPressed) || Boolean(legacy.dash),
    crouchPressed: Boolean(input.crouchPressed) || legacyPressed(legacy.crouch, fallback.crouchHeld),
    crouchHeld,
    slidePressed: Boolean(input.slidePressed) || legacyPressed(legacy.slide, fallback.slideHeld),
    slideHeld,
    backflipPressed: Boolean(input.backflipPressed) || Boolean(legacy.backflip),
    pickupPressed: Boolean(input.pickupPressed) || legacyPressed(legacy.interact, false),
    dropPressed: Boolean(input.dropPressed) || legacyPressed(legacy.drop, false),
    fakeThrowPressed: Boolean(input.fakeThrowPressed) || legacyPressed(legacy.fakeThrow, fallback.fakeThrowHeld),
    fakeThrowHeld,
    leftHandPressed: Boolean(input.leftHandPressed) || legacyPressed(legacy.leftHand, fallback.leftHandHeld),
    leftHandHeld,
    rightHandPressed: Boolean(input.rightHandPressed) || legacyPressed(legacy.rightHand, fallback.rightHandHeld),
    rightHandHeld,
    leftHandReleased: Boolean(input.leftHandReleased),
    rightHandReleased: Boolean(input.rightHandReleased),
    // Catch-attempt ids are latched values (not one-frame edges): carry the freshest non-negative
    // integer, falling back to the previous input's value so a re-send keeps the same attempt id.
    leftCatchAttemptId: Math.max(0, Math.trunc(finiteNumber(input.leftCatchAttemptId, fallback.leftCatchAttemptId))),
    rightCatchAttemptId: Math.max(0, Math.trunc(finiteNumber(input.rightCatchAttemptId, fallback.rightCatchAttemptId))),
    // Backflip QTE tier is a one-shot value carried on the release packet; clamp to [0, tierCount].
    backflipThrowTier: clamp(Math.trunc(finiteNumber(input.backflipThrowTier, 0)), 0, GAME_CONSTANTS.backflip.qte.tierCount),
    resetSerial: Math.max(0, Math.trunc(finiteNumber(input.resetSerial, fallback.resetSerial))),
    interactHeld: Boolean(input.interactHeld) || legacyPressed(legacy.interact, false)
  };
}

function computeCatchStance(hands: PlayerState['hands'], input: PlayerInput): boolean {
  return (!hands.left.heldBallId && input.leftHandHeld) || (!hands.right.heldBallId && input.rightHandHeld);
}

function updateHandCharging(hands: PlayerState['hands'], input: PlayerInput, previousInput: PlayerInput): PlayerState['hands'] {
  let next = hands;
  next = updateHandCharge(next, 'left', input.leftHandPressed || (input.leftHandHeld && !previousInput.leftHandHeld), input.fakeThrowPressed || input.fakeThrowHeld);
  next = updateHandCharge(next, 'right', input.rightHandPressed || (input.rightHandHeld && !previousInput.rightHandHeld), input.fakeThrowPressed || input.fakeThrowHeld);
  return next;
}

function updateHandCharge(hands: PlayerState['hands'], side: HandSide, pressed: boolean, fakeThrow: boolean): PlayerState['hands'] {
  const hand = hands[side];
  if (!hand.heldBallId) return hands;
  if (fakeThrow) return cancelCharge(hands, side);
  if (pressed) return beginCharge(hands, side);
  return hands;
}

function heldBallPosition(player: PlayerState, hand: HandSide): Vec3 {
  return computePlayerHandAnchor(player, hand);
}

function dropReleaseVelocity(velocity: Vec3): Vec3 {
  return {
    x: velocity.x,
    y: Math.min(velocity.y, 0) - 1.4,
    z: velocity.z
  };
}

/** Return hands with the given hand's lastCatchAttemptId bumped (ack of a received attempt). */
function setHandLastCatchAttemptId(hands: PlayerState['hands'], hand: HandSide, attemptId: number): PlayerState['hands'] {
  return {
    ...hands,
    [hand]: { ...hands[hand], lastCatchAttemptId: attemptId }
  };
}

/** Assign a caught ball to a hand (holding, charge cleared, catch cooldown applied). */
function assignCaughtHand(hands: PlayerState['hands'], hand: HandSide, ballId: string): PlayerState['hands'] {
  return {
    ...hands,
    [hand]: {
      ...hands[hand],
      heldBallId: ballId,
      mode: 'holding',
      chargeSeconds: 0,
      cooldownSeconds: GAME_CONSTANTS.catch.cooldownSeconds
    }
  };
}

function clearHeldHand(hands: PlayerState['hands'], hand: HandSide): PlayerState['hands'] {
  return {
    ...hands,
    [hand]: {
      ...hands[hand],
      heldBallId: null,
      mode: 'empty',
      chargeSeconds: 0,
      catchTrackingSecondsByBallId: {}
    }
  };
}

function preferredDropHand(player: PlayerState): HandSide | null {
  if (player.hands.right.heldBallId) return 'right';
  if (player.hands.left.heldBallId) return 'left';
  return null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return clamp(finiteNumber(value, fallback), min, max);
}

function boolOr(primary: unknown, legacy: unknown, fallback: boolean): boolean {
  if (typeof primary === 'boolean') return primary;
  if (typeof legacy === 'boolean') return legacy;
  return fallback;
}

function legacyPressed(legacyHeld: unknown, previousHeld: boolean): boolean {
  return typeof legacyHeld === 'boolean' ? legacyHeld && !previousHeld : false;
}

function sanitizeVec3(value: Vec3 | undefined, fallback: Vec3): Vec3 {
  if (!value) return { ...fallback };
  return {
    x: finiteNumber(value.x, fallback.x),
    y: finiteNumber(value.y, fallback.y),
    z: finiteNumber(value.z, fallback.z)
  };
}

/** Clear one-shot edge fields from a held input so fallback ticks don't re-fire them. */
function clearEdges(input: PlayerInput): PlayerInput {
  return {
    ...input,
    jumpPressed: false,
    dashPressed: false,
    slidePressed: false,
    crouchPressed: false,
    backflipPressed: false,
    pickupPressed: false,
    dropPressed: false,
    fakeThrowPressed: false,
    leftHandPressed: false,
    rightHandPressed: false,
    leftHandReleased: false,
    rightHandReleased: false,
    backflipThrowTier: 0
  };
}

function sanitizeName(rawName: string | undefined, playerNumber: number): string {
  const trimmed = rawName?.trim();
  if (!trimmed) return `Player ${playerNumber}`;
  return trimmed.slice(0, 24);
}
