import { GAME_CONSTANTS } from '../../../shared/constants';
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
  saturate,
  scale,
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
import { createRoomState, registerPlayerHit } from '../../../shared/simulation/MatchSim';
import { advanceDashState, createPlayerState, tryDash } from '../../../shared/simulation/PlayerSim';
import { advanceNoBoundariesTimer, applyHalfCourtRule, createMatchState, isHitInRange } from '../../../shared/simulation/RuleSim';

export interface ServerGameLoopOptions {
  tickRate?: number;
  logger?: (message: string) => void;
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

const TEAM_BY_SIDE: Record<SpawnSide, string> = {
  negativeZ: 'blue',
  positiveZ: 'red'
};

const SPAWN_BY_SIDE: Record<SpawnSide, { position: Vec3; yawRadians: number }> = {
  negativeZ: { position: vec3(0, 0, -12), yawRadians: 0 },
  positiveZ: { position: vec3(0, 0, 12), yawRadians: Math.PI }
};

const PLAYER_MOVE_SPEED = 8.5;
const CROUCH_MOVE_SPEED = 5.2;
const TEAM_IDS = ['blue', 'red'];

export class ServerGameLoop {
  public readonly tickRate: number;
  public state: RoomState;

  private readonly roomId: string;
  private readonly tickSeconds: number;
  private readonly logger: (message: string) => void;
  private readonly latestInputByPlayerId = new Map<string, PlayerInput>();
  private readonly previousInputByPlayerId = new Map<string, PlayerInput>();
  private readonly parryCooldownByPlayerId = new Map<string, number>();

  constructor(roomId: string, options: ServerGameLoopOptions = {}) {
    this.roomId = roomId;
    this.tickRate = options.tickRate ?? 30;
    this.tickSeconds = 1 / this.tickRate;
    this.logger = options.logger ?? (() => undefined);
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
      movement: {
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
      }
    });

    this.state.players[playerId] = player;
    this.latestInputByPlayerId.set(playerId, defaultInput(spawn.yawRadians));
    this.previousInputByPlayerId.set(playerId, defaultInput(spawn.yawRadians));
    this.parryCooldownByPlayerId.set(playerId, 0);
    this.syncPlayerScores();
    return player;
  }

  removePlayer(playerId: string): void {
    const player = this.state.players[playerId];
    if (!player) return;

    this.dropAllHeldBalls(player);
    delete this.state.players[playerId];
    this.latestInputByPlayerId.delete(playerId);
    this.previousInputByPlayerId.delete(playerId);
    this.parryCooldownByPlayerId.delete(playerId);
  }

  dispose(): void {
    this.latestInputByPlayerId.clear();
    this.previousInputByPlayerId.clear();
    this.parryCooldownByPlayerId.clear();
  }

  handleInput(playerId: string, input: Partial<PlayerInput> = {}): boolean {
    const player = this.state.players[playerId];
    if (!player) return false;
    this.latestInputByPlayerId.set(playerId, normalizeInput(input, this.latestInputByPlayerId.get(playerId)));
    return true;
  }

  handlePickup(playerId: string): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };

    const candidates = Object.values(this.state.balls)
      .map((ball) => ({ ball, distance: distance(ball.position, player.movement.position) }))
      .sort((a, b) => a.distance - b.distance);

    for (const { ball } of candidates) {
      const result = tryPickupBall(player, player.hands, ball);
      if (!result.ok) continue;

      this.state.players[playerId] = {
        ...player,
        hands: result.hands
      };
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

    this.state.players[playerId] = {
      ...player,
      hands: result.hands
    };
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

    const handState = player.hands[request.hand];
    const serverCharge01 = handState.mode === 'charging'
      ? handState.chargeSeconds / GAME_CONSTANTS.ball.maxChargeSeconds
      : 0;
    const clientCharge01 = Number.isFinite(request.charge01) ? request.charge01 ?? 0 : 0;
    const charge01 = saturate(Math.max(serverCharge01, Math.min(clientCharge01, serverCharge01 + 0.15)));
    const forward = normalize(request.direction ?? player.movement.facing, player.movement.facing);
    const speed = charge01 <= 0.05
      ? GAME_CONSTANTS.ball.quickThrowSpeed
      : lerp(GAME_CONSTANTS.ball.quickThrowSpeed, GAME_CONSTANTS.ball.chargedThrowSpeed, charge01);
    const velocity = add(scale(forward, speed), scale(player.movement.velocity, GAME_CONSTANTS.ball.movementThrowScale));
    const origin = add(player.movement.position, add(scale(player.movement.facing, 0.8), vec3(0, 1.35, 0)));

    const result = throwBallFromHand(player, player.hands, request.hand, ball, {
      origin,
      velocity,
      isSuper: false,
      dropScale: lerp(GAME_CONSTANTS.ball.quickDropScale, GAME_CONSTANTS.ball.chargedDropScale, charge01),
      curveAccel: vec3()
    });
    if (!result.ok) return result;

    this.state.players[playerId] = {
      ...player,
      hands: result.hands
    };
    this.state.balls[ball.id] = result.ball;
    return { ok: true, log: `throw accepted player=${playerId} ball=${ball.id} hand=${request.hand} charge=${charge01.toFixed(2)}` };
  }

  handleCatchParry(playerId: string, request: CatchParryPayload): ActionResult {
    const player = this.state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };

    const facing = normalize(request.facing ?? player.movement.facing, player.movement.facing);
    const nearestThreat = this.nearestLiveBall(player);
    if (!nearestThreat) return { ok: false, reason: 'no-live-ball' };

    if (heldBallCount(player.hands) >= GAME_CONSTANTS.ball.maxHeldBalls) {
      const cooldown = this.parryCooldownByPlayerId.get(playerId) ?? 0;
      const result = autoParryBall(player, player.hands, nearestThreat, facing, cooldown);
      if (!result.ok) return result;

      this.state.balls[nearestThreat.id] = result.ball;
      this.parryCooldownByPlayerId.set(playerId, result.parryCooldownSeconds);
      return { ok: true };
    }

    const hand = request.hand ?? firstEmptyHand(player);
    if (!hand) return { ok: false, reason: 'no-empty-hand' };

    const result = catchBallInHand(player, player.hands, hand, nearestThreat, facing, GAME_CONSTANTS.catch.trackingSeconds);
    if (!result.ok) return result;

    this.state.players[playerId] = {
      ...player,
      hands: result.hands
    };
    this.state.balls[nearestThreat.id] = result.ball;
    return { ok: true };
  }

  handleReset(playerId: string): ActionResult {
    if (!this.state.players[playerId]) return { ok: false, reason: 'unknown-player' };

    const players = Object.values(this.state.players).map((player) => {
      const spawn = SPAWN_BY_SIDE[player.spawnSide];
      return createPlayerState(player.id, player.teamId, player.legalHalf, {
        name: player.name,
        spawnSide: player.spawnSide,
        score: 0,
        movement: {
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
        }
      });
    });

    this.state = this.createFreshRoomState(players);
    for (const player of players) {
      this.latestInputByPlayerId.set(player.id, defaultInput(SPAWN_BY_SIDE[player.spawnSide].yawRadians));
      this.previousInputByPlayerId.set(player.id, defaultInput(SPAWN_BY_SIDE[player.spawnSide].yawRadians));
      this.parryCooldownByPlayerId.set(player.id, 0);
    }
    return { ok: true };
  }

  step(dt = this.tickSeconds): ServerSnapshot {
    const fixedDt = this.tickSeconds;
    this.state.tick += 1;

    for (const player of Object.values(this.state.players)) {
      this.updatePlayer(player, fixedDt);
    }

    this.updateBalls(fixedDt);
    this.validateHits();
    this.updateRules(fixedDt);
    this.syncPlayerScores();

    return this.snapshot();
  }

  snapshot(): ServerSnapshot {
    return {
      type: 'snapshot',
      tick: this.state.tick,
      serverTimeMs: Date.now(),
      room: cloneRoomState(this.state)
    };
  }

  private updatePlayer(player: PlayerState, dt: number): void {
    const input = this.latestInputByPlayerId.get(player.id) ?? defaultInput(player.movement.yawRadians);
    const previousInput = this.previousInputByPlayerId.get(player.id) ?? defaultInput(player.movement.yawRadians);
    const yawRadians = input.lookYawRadians;
    const pitchRadians = clamp(input.lookPitchRadians, -Math.PI / 2, Math.PI / 2);
    const facing = facingFromAngles(yawRadians, pitchRadians);
    const wishDirection = movementWishDirection(yawRadians, input.moveX, input.moveZ);
    const requestedSpeed = input.crouch ? CROUCH_MOVE_SPEED : PLAYER_MOVE_SPEED;

    let velocity = lengthSquared(wishDirection) > 0
      ? scale(wishDirection, requestedSpeed)
      : vec3();

    const wantsDash = input.dash && !previousInput.dash;
    let dashedThisFrame = false;
    if (wantsDash) {
      const dashDirection = lengthSquared(wishDirection) > 0 ? wishDirection : vec3(facing.x, 0, facing.z);
      const dashResult = tryDash(player.dash, player.movement.velocity, dashDirection);
      if (dashResult.ok) {
        player.dash = dashResult.dash;
        velocity = dashResult.velocity;
        dashedThisFrame = true;
      }
    }

    player.hands = updateHandCharging(player.hands, input, previousInput);
    player.dash = advanceDashState(player.dash, dt);
    player.hands = tickHands(player.hands, dt);
    player.movement = {
      ...player.movement,
      position: clampPlayerPosition(add(player.movement.position, scale(velocity, dt))),
      velocity,
      yawRadians,
      pitchRadians,
      facing,
      crouching: input.crouch,
      sliding: false,
      wallRunning: false,
      dashingThisFrame: dashedThisFrame,
      speed: horizontalSpeed(velocity)
    };

    this.previousInputByPlayerId.set(player.id, input);

    const cooldown = this.parryCooldownByPlayerId.get(player.id) ?? 0;
    this.parryCooldownByPlayerId.set(player.id, Math.max(0, cooldown - dt));
  }

  private updateBalls(dt: number): void {
    for (const ball of Object.values(this.state.balls)) {
      if (ball.phase === 'held' && ball.heldByPlayerId && ball.heldHand) {
        const owner = this.state.players[ball.heldByPlayerId];
        this.state.balls[ball.id] = owner
          ? { ...ball, position: heldBallPosition(owner, ball.heldHand), velocity: vec3() }
          : markBallDead(ball);
        continue;
      }

      if (ball.phase === 'loose') continue;

      this.state.balls[ball.id] = settleBallIfSlow(resolveBallBounds(advanceBall(ball, dt)));
    }
  }

  private validateHits(): void {
    for (const ball of Object.values(this.state.balls)) {
      if (ball.phase !== 'live' || ball.ownerKind !== 'player' || !ball.ownerId) continue;

      for (const target of Object.values(this.state.players)) {
        if (target.id === ball.ownerId) continue;
        if (!isHitInRange(ball.position, playerHitCenter(target))) continue;

        const scorer = this.state.players[ball.ownerId];
        const previousScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : 0;
        const previousWinner = this.state.match.winnerTeamId;
        this.state.balls[ball.id] = markBallDead(ball);
        this.state = registerPlayerHit(this.state, ball.ownerId);
        const nextScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : previousScore;
        this.logger(`hit confirmed scorer=${ball.ownerId} target=${target.id} ball=${ball.id}`);
        if (nextScore !== previousScore) {
          this.logger(`score changed team=${scorer?.teamId ?? 'unknown'} score=${nextScore}`);
        }
        if (!previousWinner && this.state.match.winnerTeamId) {
          this.logger(`match ended winner=${this.state.match.winnerTeamId}`);
        }
        break;
      }
    }
  }

  private updateRules(dt: number): void {
    this.state.match = advanceNoBoundariesTimer(this.state.match, dt);

    for (const player of Object.values(this.state.players)) {
      this.state.match = applyHalfCourtRule(
        this.state.match,
        player.id,
        player.teamId,
        player.legalHalf,
        player.movement.position
      );
    }
  }

  private syncPlayerScores(): void {
    for (const player of Object.values(this.state.players)) {
      player.score = this.state.match.scoreByTeamId[player.teamId] ?? 0;
    }
  }

  private nearestLiveBall(player: PlayerState): BallState | null {
    let best: BallState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const ball of Object.values(this.state.balls)) {
      if (ball.phase !== 'live') continue;
      const dist = distance(ball.position, player.movement.position);
      if (dist >= bestDistance) continue;
      best = ball;
      bestDistance = dist;
    }

    return best;
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

  private nextSpawnSide(): SpawnSide | null {
    const usedSides = new Set(Object.values(this.state.players).map((player) => player.spawnSide));
    if (!usedSides.has('negativeZ')) return 'negativeZ';
    if (!usedSides.has('positiveZ')) return 'positiveZ';
    return null;
  }

  private createFreshRoomState(players: PlayerState[] = []): RoomState {
    const room = createRoomState({
      id: this.roomId,
      players,
      balls: createInitialBalls()
    });
    return {
      ...room,
      match: createMatchState(this.roomId, TEAM_IDS)
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

function resolveBallBounds(ball: BallState): BallState {
  const r = GAME_CONSTANTS.ball.radius;
  const e = GAME_CONSTANTS.ball.bounceRestitution;
  const minX = -GAME_CONSTANTS.map.halfWidth + r;
  const maxX = GAME_CONSTANTS.map.halfWidth - r;
  const minZ = -GAME_CONSTANTS.map.halfLength + r;
  const maxZ = GAME_CONSTANTS.map.halfLength - r;
  const position = { ...ball.position };
  const velocity = { ...ball.velocity };
  let bounced = false;

  if (position.y < r) {
    position.y = r;
    velocity.y = Math.abs(velocity.y) * e;
    bounced = true;
  }

  if (position.x < minX || position.x > maxX) {
    position.x = clamp(position.x, minX, maxX);
    velocity.x *= -e;
    bounced = true;
  }

  if (position.z < minZ || position.z > maxZ) {
    position.z = clamp(position.z, minZ, maxZ);
    velocity.z *= -e;
    bounced = true;
  }

  const resolved = { ...ball, position, velocity };
  return bounced ? applyBallBounce(resolved) : resolved;
}

function defaultInput(yawRadians = 0): PlayerInput {
  return {
    moveX: 0,
    moveZ: 0,
    lookYawRadians: yawRadians,
    lookPitchRadians: 0,
    jump: false,
    crouch: false,
    slide: false,
    dash: false,
    backflip: false,
    interact: false,
    drop: false,
    fakeThrow: false,
    leftHand: false,
    rightHand: false,
    leftHandPressed: false,
    rightHandPressed: false,
    leftHandReleased: false,
    rightHandReleased: false
  };
}

function normalizeInput(input: Partial<PlayerInput>, fallback: PlayerInput = defaultInput()): PlayerInput {
  return {
    ...fallback,
    moveX: clampNumber(input.moveX, -1, 1, fallback.moveX),
    moveZ: clampNumber(input.moveZ, -1, 1, fallback.moveZ),
    lookYawRadians: finiteNumber(input.lookYawRadians, fallback.lookYawRadians),
    lookPitchRadians: finiteNumber(input.lookPitchRadians, fallback.lookPitchRadians),
    jump: Boolean(input.jump),
    crouch: Boolean(input.crouch),
    slide: Boolean(input.slide),
    dash: Boolean(input.dash),
    backflip: Boolean(input.backflip),
    interact: Boolean(input.interact),
    drop: Boolean(input.drop),
    fakeThrow: Boolean(input.fakeThrow),
    leftHand: Boolean(input.leftHand),
    rightHand: Boolean(input.rightHand),
    leftHandPressed: Boolean(input.leftHandPressed),
    rightHandPressed: Boolean(input.rightHandPressed),
    leftHandReleased: Boolean(input.leftHandReleased),
    rightHandReleased: Boolean(input.rightHandReleased)
  };
}

function updateHandCharging(hands: PlayerState['hands'], input: PlayerInput, previousInput: PlayerInput): PlayerState['hands'] {
  let next = hands;
  next = updateHandCharge(next, 'left', input.leftHand, input.leftHandPressed || (input.leftHand && !previousInput.leftHand), input.fakeThrow);
  next = updateHandCharge(next, 'right', input.rightHand, input.rightHandPressed || (input.rightHand && !previousInput.rightHand), input.fakeThrow);
  return next;
}

function updateHandCharge(
  hands: PlayerState['hands'],
  side: HandSide,
  down: boolean,
  pressed: boolean,
  fakeThrow: boolean
): PlayerState['hands'] {
  const hand = hands[side];
  if (!hand.heldBallId) return hands;
  if (fakeThrow) return cancelCharge(hands, side);
  if (pressed) return beginCharge(hands, side);
  if (!down && hand.mode !== 'charging') return hands;
  return hands;
}

function movementWishDirection(yawRadians: number, moveX: number, moveZ: number): Vec3 {
  const forward = vec3(Math.sin(yawRadians), 0, Math.cos(yawRadians));
  const right = vec3(Math.cos(yawRadians), 0, -Math.sin(yawRadians));
  return normalize(add(scale(right, moveX), scale(forward, moveZ)));
}

function facingFromAngles(yawRadians: number, pitchRadians: number): Vec3 {
  const pitchCos = Math.cos(pitchRadians);
  return normalize(vec3(
    Math.sin(yawRadians) * pitchCos,
    Math.sin(pitchRadians),
    Math.cos(yawRadians) * pitchCos
  ), vec3(0, 0, 1));
}

function heldBallPosition(player: PlayerState, hand: HandSide): Vec3 {
  const sideOffset = hand === 'left' ? -0.35 : 0.35;
  return add(player.movement.position, vec3(sideOffset, 1.15, 0.45 * (player.spawnSide === 'negativeZ' ? 1 : -1)));
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

function playerHitCenter(player: PlayerState): Vec3 {
  return add(player.movement.position, vec3(0, GAME_CONSTANTS.player.height * 0.5, 0));
}

function clampPlayerPosition(position: Vec3): Vec3 {
  const r = GAME_CONSTANTS.player.radius;
  return {
    x: clamp(position.x, -GAME_CONSTANTS.map.halfWidth + r, GAME_CONSTANTS.map.halfWidth - r),
    y: Math.max(0, position.y),
    z: clamp(position.z, -GAME_CONSTANTS.map.halfLength + r, GAME_CONSTANTS.map.halfLength - r)
  };
}

function horizontalSpeed(velocity: Vec3): number {
  return Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return clamp(finiteNumber(value, fallback), min, max);
}

function sanitizeName(rawName: string | undefined, playerNumber: number): string {
  const trimmed = rawName?.trim();
  if (!trimmed) return `Player ${playerNumber}`;
  return trimmed.slice(0, 24);
}

function cloneRoomState(room: RoomState): RoomState {
  return JSON.parse(JSON.stringify(room)) as RoomState;
}
