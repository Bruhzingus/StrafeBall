import { GAME_CONSTANTS } from '../../../shared/constants';
import { DEBUG_DEFAULTS, SERVER_INPUT_QUEUE_LIMIT, SERVER_TICK_RATE, type DebugFlags } from '../../../shared/netConfig';
import type {
  BallState,
  HandSide,
  PlayerInput,
  PlayerState,
  RoomState,
  SpawnSide,
  Vec3
} from '../../../shared/types';
import type { ServerSnapshot, ThrowEvent } from '../../../shared/protocol';
import { TimeRing, type BallSample, type DefenseSample } from './DefenseHistory';
import {
  advanceBall,
  applyBallBounce,
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
  lerp,
  normalize,
  scale,
  sweptBallHitsBody,
  sweptSegmentInCone,
  vec3
} from '../../../shared/simulation/CollisionMath';
import {
  beginCharge,
  cancelCharge,
  dropBallFromHand,
  heldBallCount,
  tickHands,
  throwBallFromHand,
  tryPickupBall
} from '../../../shared/simulation/HandSim';
import { createResetVoteState, createRoomState, registerPlayerHit } from '../../../shared/simulation/MatchSim';
import { createPlayerState } from '../../../shared/simulation/PlayerSim';
import { advanceNoBoundariesTimer, applyHalfCourtRule, createMatchState } from '../../../shared/simulation/RuleSim';
import {
  MAT_SPECS,
  createBallCollisionBoxes,
  createPlayerCollisionBoxes,
  matCollisionBox,
  type AABB
} from '../../../shared/simulation/MapGeometry';
import { facingFromAngles, stepMovement } from '../../../shared/simulation/MovementSim';
import { clampLookPitch } from '../../../shared/simulation/AimMath';
import { computePlayerHandAnchor } from '../../../shared/simulation/HandAnchors';
import { curveAccelForThrow, isCurveThrow, backflipQteSpeed } from '../../../shared/simulation/ThrowMath';
import { playerBallHitRadius, playerHitCapsule } from '../../../shared/simulation/PlayerHitbox';

export interface ServerGameLoopOptions {
  tickRate?: number;
  logger?: (message: string) => void;
  /** Per-channel debug flags. All default OFF — a real playtest produces zero per-tick logging. */
  debug?: Partial<DebugFlags>;
  /**
   * Backward-compat shim for the old constructor shape. `debugInput: true` maps to NET_DEBUG so
   * existing callers (and tests) keep compiling. Prefer `debug` for new code.
   */
  debugInput?: boolean;
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
  resolved: boolean;
}

/** Reason a catch attempt failed to land — surfaced under CATCH_DEBUG (Phase 13). */
type CatchFailReason =
  | 'no-empty-hand'
  | 'wrong-hand'
  | 'dashing'
  | 'ball-not-live'
  | 'out-of-range'
  | 'angle-too-wide'
  | 'too-early'
  | 'too-late'
  | 'cooldown'
  | 'owner-invalid'
  | 'stale-attempt';

/** Reason an auto-parry failed — surfaced under PARRY_DEBUG (Phase 13). */
type ParryFailReason =
  | 'no-two-balls'
  | 'cooldown'
  | 'ball-not-live'
  | 'owner-invalid'
  | 'out-of-range'
  | 'angle-too-wide';

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

const TEAM_BY_SIDE: Record<SpawnSide, string> = {
  negativeZ: 'blue',
  positiveZ: 'red'
};

const SPAWN_BY_SIDE: Record<SpawnSide, { position: Vec3; yawRadians: number }> = {
  negativeZ: { position: vec3(0, 0, -12), yawRadians: 0 },
  positiveZ: { position: vec3(0, 0, 12), yawRadians: Math.PI }
};

const TEAM_IDS = ['blue', 'red'];
// Max inputs buffered per player before we drop the oldest. Driven by netConfig so the buffer
// scales with the active tick rate (~1 s of headroom) instead of a hardcoded 30Hz assumption.
const MAX_INPUT_QUEUE = SERVER_INPUT_QUEUE_LIMIT;
// If no fresh input arrives for this long, the player's input is treated as neutral (so a
// backgrounded/frozen tab doesn't keep walking or charging on the last-held input).
const STALE_INPUT_MS = 1000;
const RESET_VOTE_TTL_MS = GAME_CONSTANTS.match.resetVoteSeconds * 1000;

export class ServerGameLoop {
  public readonly tickRate: number;
  public state: RoomState;

  private readonly roomId: string;
  private readonly tickSeconds: number;
  private readonly logger: (message: string) => void;
  private readonly debug: DebugFlags;
  // Players AND balls collide with bleachers + STANDING mats; both sets are rebuilt whenever a mat
  // is knocked over so a downed mat becomes walkable AND lets balls pass over it.
  private playerCollisionBoxes = createPlayerCollisionBoxes();
  private ballCollisionBoxes = createBallCollisionBoxes();
  private readonly knockedOverMatIds = new Set<string>();

  private readonly inputQueueByPlayerId = new Map<string, QueuedInput[]>();
  private readonly lastInputByPlayerId = new Map<string, PlayerInput>();
  private readonly previousInputByPlayerId = new Map<string, PlayerInput>();
  private readonly lastInputAtByPlayerId = new Map<string, number>();
  private readonly lastEnqueuedSeqByPlayerId = new Map<string, number>();
  private readonly parryCooldownByPlayerId = new Map<string, number>();
  private readonly lastInputDebugAtByPlayerId = new Map<string, number>();
  private readonly resetVotesByPlayerId = new Map<string, number>();
  private resetSerial = 0;

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
  // Monotonic throw identity — assigned to each new live throw/deflect (see BallState.throwId).
  private throwCounter = 0;
  // Throw events accepted this step, drained by the room and broadcast before the next snapshot.
  private pendingThrowEvents: ThrowEvent[] = [];
  // Wall-clock time of the current step, captured once at the top of step() for history timestamps.
  private stepNowMs = 0;

  constructor(roomId: string, options: ServerGameLoopOptions = {}) {
    this.roomId = roomId;
    this.tickRate = options.tickRate ?? SERVER_TICK_RATE;
    this.tickSeconds = 1 / this.tickRate;
    this.logger = options.logger ?? (() => undefined);
    // All flags default OFF. The legacy `debugInput` boolean maps to NET_DEBUG for compat; an
    // explicit `debug.NET_DEBUG` (if provided) wins over it.
    this.debug = {
      ...DEBUG_DEFAULTS,
      NET_DEBUG: options.debug?.NET_DEBUG ?? options.debugInput ?? DEBUG_DEFAULTS.NET_DEBUG,
      PERF_DEBUG: options.debug?.PERF_DEBUG ?? DEBUG_DEFAULTS.PERF_DEBUG,
      BALL_DEBUG: options.debug?.BALL_DEBUG ?? DEBUG_DEFAULTS.BALL_DEBUG,
      PICKUP_DEBUG: options.debug?.PICKUP_DEBUG ?? DEBUG_DEFAULTS.PICKUP_DEBUG,
      THROW_DEBUG: options.debug?.THROW_DEBUG ?? DEBUG_DEFAULTS.THROW_DEBUG,
      COLLISION_DEBUG: options.debug?.COLLISION_DEBUG ?? DEBUG_DEFAULTS.COLLISION_DEBUG,
      CATCH_DEBUG: options.debug?.CATCH_DEBUG ?? DEBUG_DEFAULTS.CATCH_DEBUG,
      PARRY_DEBUG: options.debug?.PARRY_DEBUG ?? DEBUG_DEFAULTS.PARRY_DEBUG,
      BALL_PREDICT_DEBUG: options.debug?.BALL_PREDICT_DEBUG ?? DEBUG_DEFAULTS.BALL_PREDICT_DEBUG
    };
    this.state = this.createFreshRoomState();
  }

  addPlayer(playerId: string, rawName?: string): PlayerState | null {
    if (Object.keys(this.state.players).length >= 2) return null;
    if (this.state.players[playerId]) return this.state.players[playerId];

    const spawnSide = this.nextSpawnSide();
    if (!spawnSide) return null;

    const spawn = SPAWN_BY_SIDE[spawnSide];
    const name = sanitizeName(rawName, Object.keys(this.state.players).length + 1);
    const player = createPlayerState(playerId, TEAM_BY_SIDE[spawnSide], spawnSide, {
      name,
      spawnSide,
      movement: this.spawnMovement(spawnSide)
    });

    this.state.players[playerId] = player;
    this.seedInputTracking(playerId, spawn.yawRadians);
    this.syncPlayerScores();

    // Warmup → playing once two players are present; (re)start the match clock fresh.
    if (Object.keys(this.state.players).length === 2 && this.state.match.status !== 'complete') {
      this.startMatch();
    }
    this.syncResetVoteState();
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
    this.lastEnqueuedSeqByPlayerId.delete(playerId);
    this.parryCooldownByPlayerId.delete(playerId);
    this.lastInputDebugAtByPlayerId.delete(playerId);
    this.defenseHistoryByPlayerId.delete(playerId);
    this.catchAttemptByKey.delete(`${playerId}:left`);
    this.catchAttemptByKey.delete(`${playerId}:right`);
    this.lastCatchAttemptIdByKey.delete(`${playerId}:left`);
    this.lastCatchAttemptIdByKey.delete(`${playerId}:right`);
    this.resetVotesByPlayerId.delete(playerId);
    this.resolveResetVotesAfterRosterChange();
  }

  /** Mark a player connected/disconnected (drives match pause + the connected flag). */
  setConnected(playerId: string, connected: boolean): void {
    const player = this.state.players[playerId];
    if (!player) return;
    player.connected = connected;
    if (connected) this.lastInputAtByPlayerId.set(playerId, Date.now());
    this.resolveResetVotesAfterRosterChange();
  }

  /**
   * Handle a player abandoning (a non-consented leave that didn't reconnect in time). If a match
   * is in progress, the remaining player wins by forfeit. Then the player is removed.
   */
  abandon(playerId: string): void {
    const player = this.state.players[playerId];
    if (!player) return;
    const others = Object.values(this.state.players).filter((p) => p.id !== playerId);
    // A match "in progress" includes the pre-round countdown — leaving during it still forfeits.
    const matchInProgress = this.state.match.status === 'playing' || this.state.match.status === 'countdown';
    if (matchInProgress && others.length === 1) {
      this.forfeitTo(others[0].teamId);
      if (this.debug.NET_DEBUG) this.logger(`forfeit win team=${others[0].teamId} (opponent abandoned)`);
    }
    this.removePlayer(playerId);
  }

  dispose(): void {
    this.inputQueueByPlayerId.clear();
    this.lastInputByPlayerId.clear();
    this.previousInputByPlayerId.clear();
    this.lastInputAtByPlayerId.clear();
    this.lastEnqueuedSeqByPlayerId.clear();
    this.parryCooldownByPlayerId.clear();
    this.lastInputDebugAtByPlayerId.clear();
    this.defenseHistoryByPlayerId.clear();
    this.ballHistoryById.clear();
    this.catchAttemptByKey.clear();
    this.lastCatchAttemptIdByKey.clear();
    this.resetVotesByPlayerId.clear();
  }

  /** Enqueue a client input. `seq` lets the client reconcile; out-of-order/dupes are ignored. */
  handleInput(playerId: string, rawInput: Partial<PlayerInput> = {}, seq = 0): boolean {
    const player = this.state.players[playerId];
    if (!player) return false;

    const lastSeq = this.lastEnqueuedSeqByPlayerId.get(playerId) ?? 0;
    const sequence = Number.isFinite(seq) ? seq : 0;
    if (sequence > 0 && sequence <= lastSeq) return true; // stale/duplicate
    if (sequence > 0) this.lastEnqueuedSeqByPlayerId.set(playerId, sequence);

    const fallback = this.lastInputByPlayerId.get(playerId);
    const input = normalizeInput({ ...rawInput, sequence }, fallback);
    this.lastInputByPlayerId.set(playerId, input);
    this.lastInputAtByPlayerId.set(playerId, Date.now());

    const queue = this.inputQueueByPlayerId.get(playerId) ?? [];
    queue.push({ seq: sequence || lastSeq, input });
    while (queue.length > MAX_INPUT_QUEUE) queue.shift();
    this.inputQueueByPlayerId.set(playerId, queue);
    return true;
  }

  handlePickup(playerId: string): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };

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

    const hand = requestedHand ?? preferredDropHand(player);
    if (!hand) return { ok: false, reason: 'empty-hands' };

    const ballId = player.hands[hand].heldBallId;
    if (!ballId) return { ok: false, reason: 'empty-hand' };

    const ball = this.state.balls[ballId];
    if (!ball) return { ok: false, reason: 'missing-ball' };

    const result = dropBallFromHand(player.hands, hand, ball, heldBallPosition(player, hand));
    if (!result.ok) return result;

    this.state.players[playerId] = { ...player, hands: result.hands };
    this.state.balls[ball.id] = result.ball;
    return { ok: true };
  }

  handleThrow(playerId: string, request: ThrowRequestPayload): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };
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
    const backflipTier = clamp(Math.trunc(request.backflipTier ?? 0), 0, GAME_CONSTANTS.backflip.qte.tierCount);
    const backflipRecent = player.movementInternal.backflipCooldown >
      GAME_CONSTANTS.backflip.cooldownSeconds - (GAME_CONSTANTS.backflip.durationSeconds + GAME_CONSTANTS.backflip.qte.durationSeconds + 0.3);
    const isBackflipThrow = backflipTier >= 1 && player.movement.grounded && backflipRecent;
    const isSuper = isBackflipThrow;

    const baseSpeed = charge01 <= 0.05
      ? GAME_CONSTANTS.ball.quickThrowSpeed
      : lerp(GAME_CONSTANTS.ball.quickThrowSpeed, GAME_CONSTANTS.ball.chargedThrowSpeed, charge01);
    const speed = isBackflipThrow ? backflipQteSpeed(backflipTier) : baseSpeed;
    const velocity = add(scale(forward, speed), scale(player.movement.velocity, GAME_CONSTANTS.ball.movementThrowScale));
    const origin = add(computePlayerHandAnchor(player, request.hand), scale(forward, 0.16));
    // Deterministic crouch-curve (Phase 6): curves perpendicular to AIM (not world axes), opposite
    // the throwing hand. Server-computed so the client can replay the exact same curve for prediction.
    const crouching = player.movement.crouching || player.movement.sliding;
    const curveAccel = curveAccelForThrow(forward, request.hand, crouching);
    const dropScale = isSuper ? GAME_CONSTANTS.ball.chargedDropScale : lerp(GAME_CONSTANTS.ball.quickDropScale, GAME_CONSTANTS.ball.chargedDropScale, charge01);
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

    this.state.players[playerId] = { ...player, hands: result.hands };
    this.state.balls[ball.id] = result.ball;

    // Emit an authoritative throw event so the client can start deterministic visual prediction
    // immediately (before the next snapshot). Drained + broadcast by the room each loop wake.
    this.pendingThrowEvents.push({
      type: 'throw-event',
      throwId,
      ballId: ball.id,
      ownerId: playerId,
      hand: request.hand,
      serverTick: this.state.tick,
      serverTimeMs: Date.now(),
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
        ` charge=${charge01.toFixed(2)} crouchCurve=${Number(crouching)} super=${Number(isSuper)}` +
        ` yaw=${player.movement.yawRadians.toFixed(3)} pitch=${player.movement.pitchRadians.toFixed(3)}` +
        ` origin=(${origin.x.toFixed(2)},${origin.y.toFixed(2)},${origin.z.toFixed(2)})` +
        ` vel=(${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)})` +
        ` curve=(${curveAccel.x.toFixed(2)},${curveAccel.y.toFixed(2)},${curveAccel.z.toFixed(2)})`
      );
    }
    return { ok: true, log: `throw accepted player=${playerId} ball=${ball.id} hand=${request.hand} charge=${charge01.toFixed(2)}${isSuper ? ' SUPER' : ''}` };
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

  handleReset(playerId: string): ActionResult {
    if (!this.state.players[playerId]) return { ok: false, reason: 'unknown-player' };

    this.pruneResetVotes(Date.now());
    this.resetVotesByPlayerId.set(playerId, Date.now() + RESET_VOTE_TTL_MS);
    this.syncResetVoteState();

    const vote = this.state.resetVote;
    if (this.debug.NET_DEBUG) this.logger(`reset vote player=${playerId} votes=${vote.voteCount}/${vote.requiredVotes}`);
    if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes) {
      this.performRoomReset(playerId);
      return { ok: true, log: `room reset approved player=${playerId}` };
    }

    return { ok: true, log: `reset vote pending player=${playerId} votes=${vote.voteCount}/${vote.requiredVotes}` };
  }

  step(): ServerSnapshot {
    const fixedDt = this.tickSeconds;
    this.state.tick += 1;
    // One wall-clock read per step, reused for all history timestamps + attempt windows so every
    // sample/attempt in this tick shares a consistent "now".
    this.stepNowMs = Date.now();
    this.pruneResetVotes(this.stepNowMs);

    // Advance the pre-round countdown. While counting down, players are frozen (look only) and no
    // combat resolves; when it elapses, flip to 'playing' so this tick already runs live.
    this.advanceCountdown(fixedDt);

    const counting = this.state.match.status === 'countdown';
    const active = this.connectedCount() >= 2 && this.state.match.status === 'playing';

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
      const preVelocity = player.movement.velocity;
      this.updatePlayer(player, fixedDt, command.input, command.seq);
      // Mat knock-over uses the player's PRE-resolution velocity: the collision solver zeros the
      // component pushing into the mat, so post-resolution speed can be ~0 on a head-on walk-in.
      this.knockOverMatsForPlayer(player, preVelocity);
      // Record this player's post-update defensive state for lag-compensated catch/parry rewind.
      this.recordDefenseSample(player);
    }

    // Move balls, record their swept positions, and resolve combat per live ball in the correct
    // order (parry → catch → hit). Scoring/hit only counts while the match is active; catch/parry
    // need an opponent's live ball, which only exists with two players present anyway. During the
    // countdown balls are still settled (so loose balls rest) but no combat is resolved.
    this.updateBalls(fixedDt, active);

    if (active) {
      this.updateRules(fixedDt);
    }

    this.syncPlayerScores();
    return this.snapshot();
  }

  /** Tick the pre-round countdown timer; flip to 'playing' once it reaches 0. */
  private advanceCountdown(dt: number): void {
    if (this.state.match.status !== 'countdown') return;
    const remaining = this.state.match.countdownSeconds - dt;
    if (remaining > 0) {
      this.state.match = { ...this.state.match, countdownSeconds: remaining };
      return;
    }
    // Countdown finished → live play. Reset the no-boundaries clock so the round starts fresh.
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
    const spawn = SPAWN_BY_SIDE[player.spawnSide];
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
    player.lastProcessedInputSeq = seq;
    this.previousInputByPlayerId.set(player.id, input);
  }

  /** Drain authoritative throw events accepted since the last drain (room broadcasts them). */
  drainThrowEvents(): ThrowEvent[] {
    if (this.pendingThrowEvents.length === 0) return [];
    const events = this.pendingThrowEvents;
    this.pendingThrowEvents = [];
    return events;
  }

  snapshot(): ServerSnapshot {
    // No deep clone (#17): Colyseus serializes the message when broadcasting, so each client
    // already gets its own copy over the wire — cloning here just burned GC every tick.
    return {
      type: 'snapshot',
      tick: this.state.tick,
      serverTimeMs: Date.now(),
      room: this.state
    };
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
      this.playerCollisionBoxes,
      catchStanceActive
    );
    player.movement = result.movement;
    player.movementInternal = result.internal;
    player.dash = result.dash;

    player.hands = updateHandCharging(player.hands, input, prevInput);
    player.hands = tickHands(player.hands, dt);
    player.lastProcessedInputSeq = seq;

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
    const now = Date.now();
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
  private updateBalls(dt: number, scoringActive: boolean): void {
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

      // (1) previous position before the move; (2) move; (3) swept segment is [prevPos, curr].
      const prevPos = cloneVec3(ball.position);
      const advanced = advanceBall(ball, dt);
      let resolved = advanced;

      // (4-6) Ball combat against the swept segment, in order. A 'live' ball can be parried, caught,
      // or hit; a 'dead' ball that just bounced (still fast, ≤1 bounce) can still be CAUGHT out of the
      // air (it can no longer score, so parry/hit self-skip it). Each helper, on success, returns the
      // new ball state (deflected/held/dead) and we stop further combat on this ball this tick.
      if (isBallCatchableInFlight(resolved)) {
        const segPrev = prevPos;
        const segCurr = resolved.position;
        const tickStartMs = this.stepNowMs;

        // Parry/hit self-gate to 'live' inside, so they no-op on a bounced 'dead' ball.
        const parried = this.tryAutoParry(resolved, segPrev, segCurr, dt, tickStartMs);
        if (parried) {
          resolved = parried;
        } else {
          const caught = this.tryCatchAttempts(resolved, segPrev, segCurr, dt, tickStartMs);
          if (caught) {
            resolved = caught;
          } else if (scoringActive) {
            const hit = this.tryHit(resolved, segPrev, segCurr);
            if (hit) resolved = hit;
          }
        }
      }

      // (7) world collision / bounce / settle on whatever survived combat.
      const bounded = resolveBallBounds(resolved);
      const collided = resolveBallStaticBoxes(bounded, this.ballCollisionBoxes, this.debug.COLLISION_DEBUG ? this.logger : undefined);
      const finalBall = settleBallIfSlow(collided);
      this.state.balls[ball.id] = finalBall;

      // Record swept position history for lag-comp (only live/deflected balls are interaction-relevant).
      this.recordBallSample(finalBall);
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
    const radius = playerBallHitRadius();

    for (const targetId in this.state.players) {
      const target = this.state.players[targetId];
      if (target.id === ownerId) continue;
      const hitbox = playerHitCapsule(target);
      if (!sweptBallHitsBody(segPrev, segCurr, hitbox.base, hitbox.top, radius)) continue;

      const scorer = this.state.players[ownerId];
      const previousScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : 0;
      const previousWinner = this.state.match.winnerTeamId;
      const dead = markBallDead(ball);
      this.state = registerPlayerHit(this.state, ownerId);
      const nextScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : previousScore;
      if (this.debug.NET_DEBUG) {
        this.logger(`hit confirmed scorer=${ownerId} target=${target.id} ball=${ball.id}`);
        if (nextScore !== previousScore) this.logger(`score changed team=${scorer?.teamId ?? 'unknown'} score=${nextScore}`);
        if (!previousWinner && this.state.match.winnerTeamId) this.logger(`match ended winner=${this.state.match.winnerTeamId}`);
      }
      return dead;
    }
    return null;
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

    for (const spec of MAT_SPECS) {
      if (this.knockedOverMatIds.has(spec.id)) continue;
      const box = matCollisionBox(spec);
      // Vertical band: the player's body must overlap the mat height (feet below top, head above base).
      if (pos.y > box.maxY || pos.y + GAME_CONSTANTS.player.height < box.minY) continue;
      // Closest point on the mat footprint to the player; contact if within radius + margin.
      const dx = pos.x - clamp(pos.x, box.minX, box.maxX);
      const dz = pos.z - clamp(pos.z, box.minZ, box.maxZ);
      if (dx * dx + dz * dz > reachSq) continue;

      // knockDirection = the player's horizontal heading (normalized); fall back to mat→player so it
      // always tips away from the player. No impulse is applied anywhere — the mat simply falls.
      const dir = normalize(
        vec3(preVelocity.x, 0, preVelocity.z),
        normalize(vec3(pos.x - spec.x, 0, pos.z - spec.z), vec3(0, 0, 1))
      );
      this.state.mats[spec.id] = { ...this.state.mats[spec.id], knockedOver: true, knockDirection: dir };
      this.knockedOverMatIds.add(spec.id);
      knockedAny = true;
      if (this.debug.COLLISION_DEBUG) this.logger(`mat knocked over id=${spec.id} by player=${player.id}`);
    }

    // Rebuild both collision sets once if anything changed, so a downed mat becomes walkable AND
    // stops blocking balls.
    if (knockedAny) {
      this.playerCollisionBoxes = createPlayerCollisionBoxes(this.knockedOverMatIds);
      this.ballCollisionBoxes = createBallCollisionBoxes(this.knockedOverMatIds);
    }
  }

  private updateRules(dt: number): void {
    this.state.match = advanceNoBoundariesTimer(this.state.match, dt);
    for (const playerId in this.state.players) {
      const player = this.state.players[playerId];
      this.state.match = applyHalfCourtRule(
        this.state.match,
        player.id,
        player.teamId,
        player.legalHalf,
        player.movement.position
      );
    }
  }

  // ===========================================================================================
  //  Server-authoritative combat: defensive history, catch attempts, auto-parry, swept resolution
  // ===========================================================================================

  /** Record this player's post-update defensive state into their history ring (lag-comp source). */
  private recordDefenseSample(player: PlayerState): void {
    let ring = this.defenseHistoryByPlayerId.get(player.id);
    if (!ring) {
      ring = new TimeRing<DefenseSample>(GAME_CONSTANTS.combat.defenseHistoryMs);
      this.defenseHistoryByPlayerId.set(player.id, ring);
    }
    const m = player.movement;
    const forward = normalize(m.facing, facingFromAngles(m.yawRadians, m.pitchRadians));
    ring.push({
      serverTimeMs: this.stepNowMs,
      tick: this.state.tick,
      eye: vec3(m.position.x, m.position.y + GAME_CONSTANTS.player.eyeHeight, m.position.z),
      forward,
      yaw: m.yawRadians,
      pitch: m.pitchRadians,
      leftHandEmpty: !player.hands.left.heldBallId,
      rightHandEmpty: !player.hands.right.heldBallId,
      leftHeldBallId: player.hands.left.heldBallId,
      rightHeldBallId: player.hands.right.heldBallId,
      heldBallCount: heldBallCount(player.hands),
      dashing: m.dashingThisFrame
    });
  }

  /** Record an interaction-relevant ball's position so a rewound click can reconstruct its swept
   * path. Covers live/deflected balls AND freshly-bounced (catchable) dead balls. */
  private recordBallSample(ball: BallState): void {
    if (!isBallCatchableInFlight(ball)) {
      // Non-interaction phases don't need history; drop any stale ring so memory stays bounded.
      this.ballHistoryById.delete(ball.id);
      return;
    }
    let ring = this.ballHistoryById.get(ball.id);
    if (!ring) {
      ring = new TimeRing<BallSample>(GAME_CONSTANTS.combat.defenseHistoryMs);
      this.ballHistoryById.set(ball.id, ring);
    }
    ring.push({ serverTimeMs: this.stepNowMs, tick: this.state.tick, position: cloneVec3(ball.position) });
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
    if (attemptId <= lastId) return; // stale/duplicate latched re-send — already consumed.
    this.lastCatchAttemptIdByKey.set(key, attemptId);
    // Acknowledge on the hand state so the client knows the attempt was received (whether or not it
    // ultimately catches — the catch resolves over the active window below).
    player.hands = setHandLastCatchAttemptId(player.hands, hand, attemptId);

    const now = this.stepNowMs;
    const existing = this.catchAttemptByKey.get(key);
    if (existing && now < existing.cooldownUntilMs) {
      if (this.debug.CATCH_DEBUG) {
        this.logger(`catch attempt player=${player.id} hand=${hand} id=${attemptId} result=fail reason=cooldown remainingMs=${Math.round(existing.cooldownUntilMs - now)}`);
      }
      return;
    }

    // Anchor the rewind to when the client actually clicked. Prefer the input's client timestamp
    // mapped to server time via our ping estimate; fall back to "now" if unavailable. Clamp the
    // rewind so we never look further back than the configured max.
    const clickTimeMs = this.estimateClickServerTime(player.id, input, now);
    this.catchAttemptByKey.set(key, {
      hand,
      attemptId,
      openedAtMs: now,
      activeUntilMs: now + GAME_CONSTANTS.combat.catchStartupMs + GAME_CONSTANTS.combat.catchActiveMs,
      cooldownUntilMs: now + GAME_CONSTANTS.combat.catchCooldownMs,
      clickTimeMs,
      resolved: false
    });
    if (this.debug.CATCH_DEBUG) {
      this.logger(`catch attempt OPEN player=${player.id} hand=${hand} id=${attemptId} clickAgeMs=${Math.round(now - clickTimeMs)}`);
    }
  }

  /**
   * Estimate the SERVER time at which a client click happened, for lag-comp rewind. We don't have a
   * synced clock, so approximate: now − (one input-transit ≈ half the player's measured RTT). The
   * result is clamped to [now − maxRewind, now]. With no RTT estimate it returns `now` (no rewind),
   * which degrades gracefully to "evaluate against present state".
   */
  private estimateClickServerTime(_playerId: string, _input: PlayerInput, now: number): number {
    // Half-RTT is not tracked server-side here; the active window (catchActiveMs) already gives the
    // attempt time to overlap the ball crossing. Anchor at the window's recent past bounded by max
    // rewind + input grace so the swept-history sampling has slack on both sides of the click.
    const rewind = Math.min(GAME_CONSTANTS.combat.defenseMaxRewindMs, GAME_CONSTANTS.combat.defenseInputGraceMs);
    return now - rewind;
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
      if (ball.isSuper) this.dropOneHeldBall(defender); // super-parry drops a defender ball
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
    const twoBalls = sample ? sample.heldBallCount >= GAME_CONSTANTS.ball.maxHeldBalls : heldBallCount(defender.hands) >= GAME_CONSTANTS.ball.maxHeldBalls;
    if (!twoBalls) return 'no-two-balls';
    const cooldown = this.parryCooldownByPlayerId.get(defender.id) ?? 0;
    if (cooldown > 0) return 'cooldown';
    if (ball.phase !== 'live') return 'ball-not-live';
    if (ball.ownerId === defender.id) return 'owner-invalid';
    const origin = sample ? sample.eye : add(defender.movement.position, vec3(0, GAME_CONSTANTS.player.eyeHeight, 0));
    const forward = sample ? sample.forward : defender.movement.facing;
    const coneDegrees = ball.isSuper ? GAME_CONSTANTS.catch.superParryConeDegrees : GAME_CONSTANTS.parry.coneDegrees;
    // Range check on the closest swept approach, then cone.
    const closest = closestPointOnSegment(segPrev, segCurr, origin);
    if (distance(origin, closest) > GAME_CONSTANTS.parry.rangeMeters) return 'out-of-range';
    if (!sweptSegmentInCone(origin, forward, segPrev, segCurr, coneDegrees, GAME_CONSTANTS.parry.rangeMeters)) return 'angle-too-wide';
    return null;
  }

  /**
   * Resolve catch attempts (Phase 10) against this live ball's swept segment. For each defender with
   * an OPEN, unresolved attempt whose hand matches, evaluate the gates against their rewound defense
   * sample. On success the ball becomes held (velocity 0) in that hand and the attempt is consumed.
   */
  private tryCatchAttempts(ball: BallState, segPrev: Vec3, segCurr: Vec3, _dt: number, tickStartMs: number): BallState | null {
    // A live/deflected ball OR a freshly-bounced (now 'dead') ball that's still fast can be caught.
    // (A bounced ball has its owner cleared, so it's catchable by either player.)
    if (!isBallCatchableInFlight(ball)) return null;
    const now = this.stepNowMs;

    for (const defenderId in this.state.players) {
      // Can't catch your own still-owned ball (live throw); a bounced/dead ball has no owner.
      if (ball.ownerId !== null && defenderId === ball.ownerId) continue;
      const defender = this.state.players[defenderId];

      for (const hand of ['left', 'right'] as const) {
        const key = `${defenderId}:${hand}`;
        const attempt = this.catchAttemptByKey.get(key);
        if (!attempt || attempt.resolved) continue;
        // Expire windows that have fully elapsed.
        if (now > attempt.activeUntilMs) continue;

        const sample = this.sampleDefenseAt(defenderId, attempt.clickTimeMs);
        const fail = this.catchFailReason(defender, hand, sample, ball, segPrev, segCurr, attempt, now);
        if (fail) {
          if (this.debug.CATCH_DEBUG) this.logCatch(defenderId, hand, ball, sample, segPrev, segCurr, attempt, fail);
          continue;
        }

        // Success — consume the attempt and give the ball to this hand.
        attempt.resolved = true;
        this.catchAttemptByKey.set(key, attempt);
        const caught = catchBall(ball, defenderId, hand);
        this.state.balls[ball.id] = caught;
        // Assign the hand + small forward catch boost (mirrors the old behavior).
        const facing = sample ? sample.forward : defender.movement.facing;
        const boostDir = normalize(vec3(facing.x, 0, facing.z), vec3(0, 0, 1));
        this.state.players[defenderId] = {
          ...defender,
          hands: assignCaughtHand(defender.hands, hand, ball.id),
          movement: { ...defender.movement, velocity: add(defender.movement.velocity, scale(boostDir, GAME_CONSTANTS.catch.catchBoostSpeed)) },
          movementInternal: { ...defender.movementInternal, catchBoostTimer: GAME_CONSTANTS.catch.catchBoostDuration }
        };
        if (this.debug.CATCH_DEBUG || this.debug.NET_DEBUG) {
          this.logger(`catch SUCCESS defender=${defenderId} hand=${hand} ball=${ball.id} id=${attempt.attemptId}`);
        }
        return caught;
      }
    }
    return null;
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
    // Timing window: too-early before startup elapses, too-late after the active window.
    if (now < attempt.openedAtMs + GAME_CONSTANTS.combat.catchStartupMs) return 'too-early';
    if (now > attempt.activeUntilMs) return 'too-late';
    // Eligibility from the rewound sample (fall back to present state if no history yet).
    const handEmpty = sample
      ? (hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty)
      : !defender.hands[hand].heldBallId;
    if (!handEmpty) return 'no-empty-hand';
    const dashing = sample ? sample.dashing : defender.movement.dashingThisFrame;
    if (dashing) return 'dashing';
    // Catchable = a live/deflected ball OR a freshly-bounced (still-fast, ≤1 bounce) dead ball.
    if (!isBallCatchableInFlight(ball)) return 'ball-not-live';
    if (ball.ownerId !== null && ball.ownerId === defender.id) return 'owner-invalid';
    const origin = sample ? sample.eye : add(defender.movement.position, vec3(0, GAME_CONSTANTS.player.eyeHeight, 0));
    const forward = sample ? sample.forward : defender.movement.facing;
    const closest = closestPointOnSegment(segPrev, segCurr, origin);
    if (distance(origin, closest) > GAME_CONSTANTS.catch.rangeMeters) return 'out-of-range';
    if (!sweptSegmentInCone(origin, forward, segPrev, segCurr, GAME_CONSTANTS.catch.coneDegrees, GAME_CONSTANTS.catch.rangeMeters)) return 'angle-too-wide';
    return null;
  }

  /** Defensive sample nearest the requested time, clamped to the max-rewind window. */
  private sampleDefenseAt(playerId: string, atServerTimeMs: number): DefenseSample | null {
    const ring = this.defenseHistoryByPlayerId.get(playerId);
    if (!ring) return null;
    const minTime = this.stepNowMs - GAME_CONSTANTS.combat.defenseMaxRewindMs - GAME_CONSTANTS.combat.defenseInputGraceMs;
    const target = Math.max(minTime, atServerTimeMs);
    return ring.nearest(target);
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

  private performRoomReset(triggerPlayerId: string): void {
    const players = Object.values(this.state.players).map((player) =>
      createPlayerState(player.id, player.teamId, player.legalHalf, {
        name: player.name,
        spawnSide: player.spawnSide,
        score: 0,
        connected: player.connected,
        movement: this.spawnMovement(player.spawnSide)
      })
    );

    this.resetSerial += 1;
    this.resetVotesByPlayerId.clear();
    // Preserve the running tick so it stays monotonic across the reset (see createFreshRoomState).
    this.state = this.createFreshRoomState(players, this.state.tick);
    for (const player of players) {
      this.seedInputTracking(player.id, SPAWN_BY_SIDE[player.spawnSide].yawRadians);
    }
    if (players.length === 2) this.startMatch();
    this.syncResetVoteState();
    if (this.debug.NET_DEBUG) this.logger(`room reset by player=${triggerPlayerId} players=${players.length} serial=${this.resetSerial}`);
  }

  private resolveResetVotesAfterRosterChange(): void {
    this.pruneResetVotes(Date.now());
    this.syncResetVoteState();
    const vote = this.state.resetVote;
    if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes && vote.voteCount > 0) {
      const triggerPlayerId = Object.keys(vote.votesByPlayerId)[0] ?? 'roster-change';
      this.performRoomReset(triggerPlayerId);
    }
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

  private syncResetVoteState(): void {
    const votesByPlayerId: Record<string, true> = {};
    let expiresAtMs: number | null = null;

    for (const [playerId, expiry] of this.resetVotesByPlayerId) {
      if (!this.state.players[playerId] || this.state.players[playerId].connected === false) continue;
      votesByPlayerId[playerId] = true;
      expiresAtMs = expiresAtMs === null ? expiry : Math.min(expiresAtMs, expiry);
    }

    this.state.resetVote = createResetVoteState({
      votesByPlayerId,
      voteCount: Object.keys(votesByPlayerId).length,
      requiredVotes: this.connectedCount(),
      expiresAtMs,
      resetSerial: this.resetSerial
    });
  }

  private dropOneHeldBall(player: PlayerState): void {
    const hand = player.hands.right.heldBallId ? 'right' : player.hands.left.heldBallId ? 'left' : null;
    if (!hand) return;
    const ballId = player.hands[hand].heldBallId;
    if (!ballId) return;
    const ball = this.state.balls[ballId];
    if (!ball) return;
    const result = dropBallFromHand(player.hands, hand, ball, heldBallPosition(player, hand));
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
      const result = dropBallFromHand(player.hands, hand, ball, heldBallPosition(player, hand));
      if (!result.ok) continue;
      player.hands = result.hands;
      this.state.balls[ballId] = result.ball;
    }
  }

  private connectedCount(): number {
    let count = 0;
    for (const playerId in this.state.players) {
      if (this.state.players[playerId].connected !== false) count += 1;
    }
    return count;
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

  /** Pull the next input to simulate: queued, else neutral (if stale), else last-held. */
  private nextInputCommand(player: PlayerState): QueuedInput {
    const queue = this.inputQueueByPlayerId.get(player.id);
    if (queue && queue.length > 0) {
      const command = queue.shift() as QueuedInput;
      // After consuming a queued input, strip edge-triggered fields from the held-state fallback
      // so a repeated tick (empty queue) doesn't re-fire jump/dash/pickup/etc.
      const held = this.lastInputByPlayerId.get(player.id);
      if (held) this.lastInputByPlayerId.set(player.id, clearEdges(held));
      return command;
    }

    const seq = player.lastProcessedInputSeq;
    const lastAt = this.lastInputAtByPlayerId.get(player.id) ?? 0;
    const lastInput = this.lastInputByPlayerId.get(player.id) ?? defaultInput(player.movement.yawRadians);

    // Stale (backgrounded tab / dropped connection): freeze movement but keep look angles (#14).
    if (player.connected === false || Date.now() - lastAt > STALE_INPUT_MS) {
      return { seq, input: neutralInput(lastInput) };
    }
    return { seq, input: lastInput };
  }

  private nextSpawnSide(): SpawnSide | null {
    const usedSides = new Set(Object.values(this.state.players).map((player) => player.spawnSide));
    if (!usedSides.has('negativeZ')) return 'negativeZ';
    if (!usedSides.has('positiveZ')) return 'positiveZ';
    return null;
  }

  private spawnMovement(spawnSide: SpawnSide): PlayerState['movement'] {
    const spawn = SPAWN_BY_SIDE[spawnSide];
    return {
      position: spawn.position,
      velocity: vec3(),
      yawRadians: spawn.yawRadians,
      pitchRadians: 0,
      facing: facingFromAngles(spawn.yawRadians, 0),
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
    this.lastInputAtByPlayerId.set(playerId, Date.now());
    this.lastEnqueuedSeqByPlayerId.set(playerId, 0);
    this.parryCooldownByPlayerId.set(playerId, 0);
    // Fresh defense history + cleared catch-attempt state (reset/respawn/rejoin must not reuse old
    // history across a discontinuity — that would lag-comp against pre-reset positions).
    this.defenseHistoryByPlayerId.set(playerId, new TimeRing<DefenseSample>(GAME_CONSTANTS.combat.defenseHistoryMs));
    this.catchAttemptByKey.delete(`${playerId}:left`);
    this.catchAttemptByKey.delete(`${playerId}:right`);
    this.lastCatchAttemptIdByKey.set(`${playerId}:left`, 0);
    this.lastCatchAttemptIdByKey.set(`${playerId}:right`, 0);
  }

  private createFreshRoomState(players: PlayerState[] = [], startTick = 0): RoomState {
    // All mats stand again on a fresh state / reset; rebuild both collision sets to include them.
    this.knockedOverMatIds.clear();
    this.playerCollisionBoxes = createPlayerCollisionBoxes();
    this.ballCollisionBoxes = createBallCollisionBoxes();
    // Combat history is timeline-specific: a reset is a discontinuity, so drop ball history, any
    // open catch attempts, and undelivered throw events so lag-comp never rewinds across the reset.
    this.ballHistoryById.clear();
    this.catchAttemptByKey.clear();
    this.pendingThrowEvents = [];
    const room = createRoomState({
      id: this.roomId,
      // The snapshot tick MUST stay monotonic across a room reset. The client gates reconciliation
      // on `snapshot.tick > lastReconciledTick`; if the tick fell back to 0 here, every post-reset
      // snapshot would fail that guard and the local player would freeze (never re-adopting server
      // state). Carry the running tick forward; resetSerial is what signals a reset to the client.
      tick: startTick,
      players,
      balls: createInitialBalls(),
      resetVote: createResetVoteState({
        requiredVotes: players.filter((player) => player.connected !== false).length,
        resetSerial: this.resetSerial
      })
    });
    const match = createMatchState(this.roomId, TEAM_IDS);
    // Start in warmup until two players are present (#15). With two present we enter the pre-round
    // COUNTDOWN (startMatch is also called by the reset/join paths and re-affirms this); the match
    // clock shouldn't run while the creator waits for an opponent.
    const twoPlayers = players.length >= 2;
    return {
      ...room,
      match: {
        ...match,
        status: twoPlayers ? 'countdown' : 'warmup',
        countdownSeconds: twoPlayers ? GAME_CONSTANTS.match.countdownSeconds : 0
      }
    };
  }
}

function createInitialBalls(): BallState[] {
  const spacing = 2;
  const start = -((GAME_CONSTANTS.map.ballCount - 1) * spacing) / 2;
  const balls: BallState[] = [];
  for (let i = 0; i < GAME_CONSTANTS.map.ballCount; i += 1) {
    balls.push(createBallState(`ball_${i}`, vec3(start + i * spacing, GAME_CONSTANTS.ball.radius + 0.05, 0)));
  }
  return balls;
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
function resolveBallBounds(ball: BallState): BallState {
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
  if (position.x < minX || position.x > maxX) {
    position.x = clamp(position.x, minX, maxX);
    velocity.x *= -e;
    hitWallOrCeiling = true;
  }
  if (position.z < minZ || position.z > maxZ) {
    position.z = clamp(position.z, minZ, maxZ);
    velocity.z *= -e;
    hitKillNow = true;
  }

  if (!hitWallOrCeiling && !hitKillNow) return ball;

  const resolved = { ...ball, position, velocity };
  // A floor / back-wall contact always wins (kills now). Otherwise it was a side-wall/ceiling-only
  // contact: let the ball survive its first such bounce, die on the second.
  if (hitKillNow) return applyBallBounce(resolved);
  return applyWallCeilingBounce(resolved);
}

/**
 * Side-wall / ceiling bounce: a live/deflected ball survives its FIRST such bounce and dies on the
 * SECOND. Implemented by counting wall/ceiling bounces in bounceCount and only killing once the
 * count exceeds 1. Non-live phases just advance the count (mirrors applyBallBounce's tail).
 */
function applyWallCeilingBounce(ball: BallState): BallState {
  if (ball.phase !== 'live' && ball.phase !== 'deflected') {
    return { ...ball, bounceCount: ball.bounceCount + 1 };
  }
  const bounceCount = ball.bounceCount + 1;
  // Allow exactly one wall/ceiling bounce; the second one kills.
  if (bounceCount > 1) {
    return { ...markBallDead(ball), bounceCount };
  }
  return { ...ball, bounceCount };
}

function resolveBallStaticBoxes(ball: BallState, boxes: AABB[], logger?: (message: string) => void): BallState {
  const r = GAME_CONSTANTS.ball.radius;
  const e = GAME_CONSTANTS.ball.bounceRestitution;
  const position = { ...ball.position };
  const velocity = { ...ball.velocity };
  let bounced = false;
  let hitBox: AABB | null = null;

  for (const box of boxes) {
    if (position.x < box.minX - r || position.x > box.maxX + r) continue;
    if (position.y < box.minY - r || position.y > box.maxY + r) continue;
    if (position.z < box.minZ - r || position.z > box.maxZ + r) continue;

    const penX = Math.min(position.x - (box.minX - r), (box.maxX + r) - position.x);
    const penY = Math.min(position.y - (box.minY - r), (box.maxY + r) - position.y);
    const penZ = Math.min(position.z - (box.minZ - r), (box.maxZ + r) - position.z);

    if (penX <= penY && penX <= penZ) {
      position.x = position.x < (box.minX + box.maxX) * 0.5 ? box.minX - r : box.maxX + r;
      velocity.x *= -e;
    } else if (penY <= penZ) {
      position.y = position.y < (box.minY + box.maxY) * 0.5 ? box.minY - r : box.maxY + r;
      velocity.y *= -e;
    } else {
      position.z = position.z < (box.minZ + box.maxZ) * 0.5 ? box.minZ - r : box.maxZ + r;
      velocity.z *= -e;
    }

    bounced = true;
    hitBox = box;
  }

  if (!bounced) return ball;
  const resolved = applyBallBounce({ ...ball, position, velocity });
  if (hitBox?.kind === 'bleacher') {
    logger?.(
      `bleacher collision ball=${ball.id} box=${hitBox.id ?? 'unknown'}` +
      ` pos=(${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})` +
      ` vel=(${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)})`
    );
  }
  return resolved;
}

function canScorePlayerHit(ball: BallState): boolean {
  if (ball.phase !== 'live') return false;
  if (ball.ownerKind !== 'player' || !ball.ownerId) return false;
  if (ball.heldByPlayerId || ball.heldHand) return false;
  if (length(ball.velocity) < GAME_CONSTANTS.ball.liveHitMinSpeed) return false;
  return true;
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
    backflipThrowTier: 0
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
  const dashDirection = sanitizeVec3(input.dashDirection, fallback.dashDirection);

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
    backflipThrowTier: clamp(Math.trunc(finiteNumber(input.backflipThrowTier, 0)), 0, GAME_CONSTANTS.backflip.qte.tierCount)
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
    rightHandReleased: false
  };
}

function sanitizeName(rawName: string | undefined, playerNumber: number): string {
  const trimmed = rawName?.trim();
  if (!trimmed) return `Player ${playerNumber}`;
  return trimmed.slice(0, 24);
}
