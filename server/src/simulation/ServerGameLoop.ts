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
import type { ServerSnapshot } from '../../../shared/protocol';
import {
  advanceBall,
  applyBallBounce,
  createBallState,
  markBallDead,
  settleBallIfSlow
} from '../../../shared/simulation/BallSim';
import {
  add,
  clamp,
  distance,
  length,
  lengthSquared,
  lerp,
  normalize,
  scale,
  subtract,
  sweptBallHitsBody,
  sweptSegmentInCone,
  vec3
} from '../../../shared/simulation/CollisionMath';
import {
  autoParryBall,
  beginCharge,
  catchBallInHand,
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
import { facingFromAngles, isSuperThrowWindow, stepMovement } from '../../../shared/simulation/MovementSim';
import { clampLookPitch } from '../../../shared/simulation/AimMath';
import { computePlayerHandAnchor } from '../../../shared/simulation/HandAnchors';
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
  // Players collide with bleachers + STANDING mats; rebuilt whenever a mat is knocked over so a
  // downed mat becomes walkable. Balls collide with bleachers ONLY (mats are immune to balls).
  private playerCollisionBoxes = createPlayerCollisionBoxes();
  private readonly ballCollisionBoxes = createBallCollisionBoxes();
  private readonly knockedOverMatIds = new Set<string>();

  private readonly inputQueueByPlayerId = new Map<string, QueuedInput[]>();
  private readonly lastInputByPlayerId = new Map<string, PlayerInput>();
  private readonly previousInputByPlayerId = new Map<string, PlayerInput>();
  private readonly lastInputAtByPlayerId = new Map<string, number>();
  private readonly lastEnqueuedSeqByPlayerId = new Map<string, number>();
  private readonly parryCooldownByPlayerId = new Map<string, number>();
  private readonly lastInputDebugAtByPlayerId = new Map<string, number>();
  // Per-player, per-ball accumulated aim time (server-authoritative catch tracking — #9).
  private readonly catchTrackingByPlayerId = new Map<string, Record<string, number>>();
  private readonly resetVotesByPlayerId = new Map<string, number>();
  private resetSerial = 0;

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
      COLLISION_DEBUG: options.debug?.COLLISION_DEBUG ?? DEBUG_DEFAULTS.COLLISION_DEBUG
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
    this.catchTrackingByPlayerId.delete(playerId);
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
    if (this.state.match.status === 'playing' && others.length === 1) {
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
    this.catchTrackingByPlayerId.clear();
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
    const isSuper = isSuperThrowWindow(player.movementInternal);
    const baseSpeed = charge01 <= 0.05
      ? GAME_CONSTANTS.ball.quickThrowSpeed
      : lerp(GAME_CONSTANTS.ball.quickThrowSpeed, GAME_CONSTANTS.ball.chargedThrowSpeed, charge01);
    const speed = isSuper ? baseSpeed * GAME_CONSTANTS.backflip.superThrowMultiplier : baseSpeed;
    const velocity = add(scale(forward, speed), scale(player.movement.velocity, GAME_CONSTANTS.ball.movementThrowScale));
    const origin = add(computePlayerHandAnchor(player, request.hand), scale(forward, 0.16));

    const result = throwBallFromHand(player, player.hands, request.hand, ball, {
      origin,
      velocity,
      isSuper,
      dropScale: isSuper ? GAME_CONSTANTS.ball.chargedDropScale : lerp(GAME_CONSTANTS.ball.quickDropScale, GAME_CONSTANTS.ball.chargedDropScale, charge01),
      curveAccel: vec3()
    });
    if (!result.ok) return result;

    this.state.players[playerId] = { ...player, hands: result.hands };
    this.state.balls[ball.id] = result.ball;
    if (this.debug.THROW_DEBUG) {
      this.logger(
        `throw aim player=${playerId}` +
        ` yaw=${player.movement.yawRadians.toFixed(3)} pitch=${player.movement.pitchRadians.toFixed(3)}` +
        ` dir=(${forward.x.toFixed(3)},${forward.y.toFixed(3)},${forward.z.toFixed(3)})` +
        ` origin=(${origin.x.toFixed(2)},${origin.y.toFixed(2)},${origin.z.toFixed(2)})` +
        ` vel=(${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)})`
      );
    }
    return { ok: true, log: `throw accepted player=${playerId} ball=${ball.id} hand=${request.hand} charge=${charge01.toFixed(2)}${isSuper ? ' SUPER' : ''}` };
  }

  handleCatchParry(playerId: string): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };

    // Always use the server's known facing + eye position for cone tests (anti-cheat).
    const facing = player.movement.facing;
    const eye = add(player.movement.position, vec3(0, GAME_CONSTANTS.player.eyeHeight, 0));

    if (heldBallCount(player.hands) >= GAME_CONSTANTS.ball.maxHeldBalls) {
      const threat = this.nearestParryable(player, eye, facing);
      if (!threat) return { ok: false, reason: 'no-live-ball' };
      const cooldown = this.parryCooldownByPlayerId.get(playerId) ?? 0;
      const result = autoParryBall(player, player.hands, threat, facing, cooldown, eye);
      if (!result.ok) {
        if (this.debug.NET_DEBUG) this.logger(`parry rejected player=${playerId} ball=${threat.id} reason=${result.reason}`);
        return result;
      }

      this.state.balls[threat.id] = result.ball;
      this.parryCooldownByPlayerId.set(playerId, result.parryCooldownSeconds);
      if (threat.isSuper) this.dropOneHeldBall(player); // super-parry drops a defender ball
      if (this.debug.NET_DEBUG) this.logger(`parry accepted player=${playerId} ball=${threat.id} super=${threat.isSuper}`);
      return { ok: true };
    }

    // Catching is not allowed while dashing.
    if (player.movement.dashingThisFrame) {
      return { ok: false, reason: 'dashing' };
    }

    const hand = firstEmptyHand(player);
    if (!hand) return { ok: false, reason: 'no-empty-hand' };
    const threat = this.nearestCatchable(player, eye, facing);
    if (!threat) return { ok: false, reason: 'no-live-ball' };

    const tracked = this.catchTrackingByPlayerId.get(playerId)?.[threat.id] ?? 0;
    const result = catchBallInHand(player, player.hands, hand, threat, facing, tracked, eye);
    if (!result.ok) {
      if (this.debug.NET_DEBUG) this.logger(`catch rejected player=${playerId} ball=${threat.id} tracked=${tracked.toFixed(3)}s reason=${result.reason}`);
      return result;
    }

    // Successful catch → possession + a small forward speed boost.
    const boostDir = normalize(vec3(facing.x, 0, facing.z), vec3(0, 0, 1));
    const boostedPlayer: PlayerState = {
      ...player,
      hands: result.hands,
      movement: { ...player.movement, velocity: add(player.movement.velocity, scale(boostDir, GAME_CONSTANTS.catch.catchBoostSpeed)) },
      movementInternal: { ...player.movementInternal, catchBoostTimer: GAME_CONSTANTS.catch.catchBoostDuration }
    };
    this.state.players[playerId] = boostedPlayer;
    this.state.balls[threat.id] = result.ball;
    if (this.debug.NET_DEBUG) this.logger(`catch accepted player=${playerId} ball=${threat.id} hand=${hand} tracked=${tracked.toFixed(3)}s`);
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
    this.pruneResetVotes(Date.now());

    const active = this.connectedCount() >= 2 && this.state.match.status === 'playing';

    for (const playerId in this.state.players) {
      const player = this.state.players[playerId];
      const command = this.nextInputCommand(player);
      const preVelocity = player.movement.velocity;
      this.updatePlayer(player, fixedDt, command.input, command.seq);
      // Mat knock-over uses the player's PRE-resolution velocity: the collision solver zeros the
      // component pushing into the mat, so post-resolution speed can be ~0 on a head-on walk-in.
      this.knockOverMatsForPlayer(player, preVelocity);
      this.updateCatchTracking(player, fixedDt);
    }

    this.updateBalls(fixedDt);

    if (active) {
      this.validateHits(fixedDt);
      this.updateRules(fixedDt);
    }

    this.syncPlayerScores();
    return this.snapshot();
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

    this.logInputDebug(player.id, input, preVelocity, preGrounded, player.movement);

    this.previousInputByPlayerId.set(player.id, input);

    const cooldown = this.parryCooldownByPlayerId.get(player.id) ?? 0;
    this.parryCooldownByPlayerId.set(player.id, Math.max(0, cooldown - dt));
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

  private updateBalls(dt: number): void {
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

      const advanced = advanceBall(ball, dt);
      const bounded = resolveBallBounds(advanced);
      const collided = resolveBallStaticBoxes(bounded, this.ballCollisionBoxes, this.debug.COLLISION_DEBUG ? this.logger : undefined);
      this.state.balls[ball.id] = settleBallIfSlow(collided);
    }
  }

  /**
   * Server-authoritative hit detection with a SWEPT CAPSULE (#4 / hitbox fix). The ball's path
   * this tick (prev→curr) is tested against each opponent's vertical body axis (feet→head). This
   * registers headshots (the axis spans the full height, not one mid-body point) and stops fast
   * throws tunnelling through a player between ticks.
   */
  private validateHits(dt: number): void {
    const radius = playerBallHitRadius();

    for (const ballId in this.state.balls) {
      const ball = this.state.balls[ballId];
      if (!canScorePlayerHit(ball)) continue;
      const ownerId = ball.ownerId;
      if (!ownerId) continue;

      const curr = ball.position;
      const prev = subtract(curr, scale(ball.velocity, dt));

      for (const targetId in this.state.players) {
        const target = this.state.players[targetId];
        if (target.id === ownerId) continue;
        const hitbox = playerHitCapsule(target);
        if (!sweptBallHitsBody(prev, curr, hitbox.base, hitbox.top, radius)) continue;

        const scorer = this.state.players[ownerId];
        const previousScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : 0;
        const previousWinner = this.state.match.winnerTeamId;
        this.state.balls[ball.id] = markBallDead(ball);
        this.state = registerPlayerHit(this.state, ownerId);
        const nextScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : previousScore;
        if (this.debug.NET_DEBUG) {
          this.logger(`hit confirmed scorer=${ownerId} target=${target.id} ball=${ball.id}`);
          if (nextScore !== previousScore) this.logger(`score changed team=${scorer?.teamId ?? 'unknown'} score=${nextScore}`);
          if (!previousWinner && this.state.match.winnerTeamId) this.logger(`match ended winner=${this.state.match.winnerTeamId}`);
        }
        break;
      }
    }
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

    // Rebuild the player collision set once if anything changed, so downed mats become walkable.
    if (knockedAny) {
      this.playerCollisionBoxes = createPlayerCollisionBoxes(this.knockedOverMatIds);
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

  /**
   * Accumulate per-ball aim time while a live ball's swept path passes inside the catch cone.
   * Using the swept segment (ballPrev → ballCurr) instead of only the current position means a
   * fast ball that crosses the entire cone interior in a single tick still accrues tracking time,
   * preventing tunnelling through the catch window. Tracking resets to zero while dashing.
   */
  private updateCatchTracking(player: PlayerState, dt: number): void {
    // Dashing prevents catching — clear all tracking while the dash is active.
    if (player.movement.dashingThisFrame) {
      const existing = this.catchTrackingByPlayerId.get(player.id);
      // Reuse the existing record object when present (cleared in place) to avoid an allocation.
      if (existing) {
        for (const id in existing) delete existing[id];
      } else {
        this.catchTrackingByPlayerId.set(player.id, {});
      }
      return;
    }

    const previous = this.catchTrackingByPlayerId.get(player.id) ?? {};
    const next: Record<string, number> = {};
    const px = player.movement.position;
    const eye = vec3(px.x, px.y + GAME_CONSTANTS.player.eyeHeight, px.z);
    const facing = player.movement.facing;

    for (const ballId in this.state.balls) {
      const ball = this.state.balls[ballId];
      if (ball.phase !== 'live') continue;
      // Reconstruct ball's position one tick ago using current velocity (same as hit detection).
      const ballPrev = subtract(ball.position, scale(ball.velocity, dt));
      if (!sweptSegmentInCone(eye, facing, ballPrev, ball.position, GAME_CONSTANTS.catch.coneDegrees, GAME_CONSTANTS.catch.rangeMeters)) continue;
      next[ball.id] = (previous[ball.id] ?? 0) + dt;
    }

    this.catchTrackingByPlayerId.set(player.id, next);
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

  /** Nearest live ball whose swept path passes inside the catch cone+range. */
  private nearestCatchable(_player: PlayerState, origin: Vec3, facing: Vec3): BallState | null {
    return this.nearestLiveSweptInCone(origin, facing, GAME_CONSTANTS.catch.coneDegrees, GAME_CONSTANTS.catch.rangeMeters);
  }

  /**
   * Nearest live ball whose swept path (ballPrev → ballCurr) passes inside the parry cone.
   * Uses the swept segment so a super-speed ball that crosses the parry window in one tick
   * is still caught by the check.
   */
  private nearestParryable(_player: PlayerState, origin: Vec3, facing: Vec3): BallState | null {
    let best: BallState | null = null;
    // Squared distance for the nearest-of comparison — avoids a sqrt per ball (Step 4).
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    const dt = this.tickSeconds;
    for (const ballId in this.state.balls) {
      const ball = this.state.balls[ballId];
      if (ball.phase !== 'live') continue;
      const cone = ball.isSuper ? GAME_CONSTANTS.catch.superParryConeDegrees : GAME_CONSTANTS.parry.coneDegrees;
      const ballPrev = subtract(ball.position, scale(ball.velocity, dt));
      if (!sweptSegmentInCone(origin, facing, ballPrev, ball.position, cone, GAME_CONSTANTS.parry.rangeMeters)) continue;
      const distSq = lengthSquared(subtract(origin, ball.position));
      if (distSq >= bestDistanceSq) continue;
      best = ball;
      bestDistanceSq = distSq;
    }
    return best;
  }

  private nearestLiveSweptInCone(origin: Vec3, facing: Vec3, coneDegrees: number, range: number): BallState | null {
    let best: BallState | null = null;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    const dt = this.tickSeconds;
    for (const ballId in this.state.balls) {
      const ball = this.state.balls[ballId];
      if (ball.phase !== 'live') continue;
      const ballPrev = subtract(ball.position, scale(ball.velocity, dt));
      if (!sweptSegmentInCone(origin, facing, ballPrev, ball.position, coneDegrees, range)) continue;
      const distSq = lengthSquared(subtract(origin, ball.position));
      if (distSq >= bestDistanceSq) continue;
      best = ball;
      bestDistanceSq = distSq;
    }
    return best;
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
    this.state.match = {
      ...this.state.match,
      status: 'playing',
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
    this.catchTrackingByPlayerId.set(playerId, {});
  }

  private createFreshRoomState(players: PlayerState[] = [], startTick = 0): RoomState {
    // All mats stand again on a fresh state / reset; rebuild the player collision set to include them.
    this.knockedOverMatIds.clear();
    this.playerCollisionBoxes = createPlayerCollisionBoxes();
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
    return {
      ...room,
      // Start in warmup until two players are present (#15) — the match clock shouldn't run while
      // the creator waits for an opponent.
      match: { ...match, status: players.length >= 2 ? 'playing' : 'warmup' }
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
    rightHandReleased: false
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
    rightHandReleased: Boolean(input.rightHandReleased)
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

function preferredDropHand(player: PlayerState): HandSide | null {
  if (player.hands.right.heldBallId) return 'right';
  if (player.hands.left.heldBallId) return 'left';
  return null;
}

function firstEmptyHand(player: PlayerState): HandSide | null {
  if (!player.hands.left.heldBallId) return 'left';
  if (!player.hands.right.heldBallId) return 'right';
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
