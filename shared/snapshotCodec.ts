import type { ServerSnapshot } from './protocol';
import type { BallState, HandSide, PlayerHandsState, PlayerState, RoomState, Vec3 } from './types';

export type PlayerRoster = Record<string, { name: string }>;

export interface CompactServerSnapshot {
  type: 'snapshot-compact';
  tick: number;
  serverTimeMs: number;
  room: Omit<RoomState, 'players' | 'balls'> & {
    players: unknown[][];
    balls: unknown[][];
  };
}

export function rosterFromRoom(room: RoomState): PlayerRoster {
  const roster: PlayerRoster = {};
  for (const playerId in room.players) {
    const player = room.players[playerId];
    roster[playerId] = { name: player.name };
  }
  return roster;
}

export function makeLeanSnapshot(snapshot: ServerSnapshot): ServerSnapshot {
  const players: RoomState['players'] = {};
  const balls: RoomState['balls'] = {};

  for (const playerId in snapshot.room.players) {
    players[playerId] = leanPlayer(snapshot.room.players[playerId]);
  }
  for (const ballId in snapshot.room.balls) {
    balls[ballId] = leanBall(snapshot.room.balls[ballId]);
  }

  return {
    ...snapshot,
    serverTimeMs: q0(snapshot.serverTimeMs),
    room: {
      ...snapshot.room,
      match: {
        ...snapshot.room.match,
        elapsedSeconds: q3(snapshot.room.match.elapsedSeconds),
        countdownSeconds: q3(snapshot.room.match.countdownSeconds),
        boundary: {
          ...snapshot.room.match.boundary,
          elapsedSeconds: q3(snapshot.room.match.boundary.elapsedSeconds)
        }
      },
      players,
      balls
    }
  };
}

export function makeCompactSnapshot(snapshot: ServerSnapshot): CompactServerSnapshot {
  const lean = makeLeanSnapshot(snapshot);
  return {
    type: 'snapshot-compact',
    tick: lean.tick,
    serverTimeMs: lean.serverTimeMs,
    room: {
      ...lean.room,
      players: Object.values(lean.room.players).map(packPlayer),
      balls: Object.values(lean.room.balls).map(packBall)
    }
  };
}

export function inflateCompactSnapshot(snapshot: CompactServerSnapshot): ServerSnapshot {
  const players: RoomState['players'] = {};
  const balls: RoomState['balls'] = {};
  for (const packedPlayer of snapshot.room.players) {
    const player = unpackPlayer(packedPlayer);
    players[player.id] = player;
  }
  for (const packedBall of snapshot.room.balls) {
    const ball = unpackBall(packedBall);
    balls[ball.id] = ball;
  }
  return {
    type: 'snapshot',
    tick: snapshot.tick,
    serverTimeMs: snapshot.serverTimeMs,
    room: {
      ...snapshot.room,
      players,
      balls
    }
  };
}

function packPlayer(player: PlayerState): unknown[] {
  return [
    player.id,
    player.teamId,
    player.spawnSide,
    player.teamSlotIndex,
    player.legalHalf,
    packPos(player.movement.position),
    packVel(player.movement.velocity),
    player.movement.yawRadians,
    player.movement.pitchRadians,
    packUnit(player.movement.facing),
    b(player.movement.grounded),
    b(player.movement.crouching),
    b(player.movement.sliding),
    b(player.movement.wallRunning),
    b(player.movement.dashingThisFrame),
    player.movement.speed,
    [
      player.movementInternal.slideTimer,
      player.movementInternal.slideBufferTimer,
      player.movementInternal.jumpGraceTimer,
      player.movementInternal.wallRunTimer,
      player.movementInternal.wallReattachCooldown,
      player.movementInternal.dashActiveTimer,
      b(player.movementInternal.doubleJumpAvailable),
      player.movementInternal.catchBoostTimer,
      player.movementInternal.groundHeight,
      player.movementInternal.lastWallNormalX,
      player.movementInternal.lastWallNormalZ,
      b(player.movementInternal.backflipActive),
      player.movementInternal.backflipTimer,
      player.movementInternal.backflipCooldown
    ],
    [packHand(player.hands.left), packHand(player.hands.right)],
    [player.dash.charges, player.dash.rechargeTimerSeconds, player.dash.cooldownSeconds],
    player.score,
    [
      player.matchStats.hits,
      player.matchStats.hitsTaken,
      player.matchStats.catches,
      player.matchStats.parries,
      player.matchStats.saves
    ],
    player.lives,
    player.combatState,
    player.eliminatedAtMs,
    player.lastPlayerBuffUntilMs,
    b(player.connected),
    player.reconnectDeadlineAtMs,
    player.lastProcessedInputSeq
  ];
}

function unpackPlayer(packed: unknown[]): PlayerState {
  const movementInternal = packed[16] as unknown[];
  const hands = packed[17] as [unknown[], unknown[]];
  const dash = packed[18] as unknown[];
  const matchStats = packed[20] as unknown[];
  return {
    id: packed[0] as string,
    name: '',
    teamId: packed[1] as string,
    spawnSide: packed[2] as PlayerState['spawnSide'],
    teamSlotIndex: packed[3] as number,
    legalHalf: packed[4] as PlayerState['legalHalf'],
    movement: {
      position: unpackPos(packed[5] as unknown[]),
      velocity: unpackVel(packed[6] as unknown[]),
      yawRadians: packed[7] as number,
      pitchRadians: packed[8] as number,
      facing: unpackUnit(packed[9] as unknown[]),
      grounded: Boolean(packed[10]),
      crouching: Boolean(packed[11]),
      sliding: Boolean(packed[12]),
      wallRunning: Boolean(packed[13]),
      dashingThisFrame: Boolean(packed[14]),
      speed: packed[15] as number
    },
    movementInternal: {
      slideTimer: movementInternal[0] as number,
      slideBufferTimer: movementInternal.length > 13 ? movementInternal[1] as number : 0,
      jumpGraceTimer: movementInternal[movementInternal.length > 13 ? 2 : 1] as number,
      wallRunTimer: movementInternal[movementInternal.length > 13 ? 3 : 2] as number,
      wallReattachCooldown: movementInternal[movementInternal.length > 13 ? 4 : 3] as number,
      dashActiveTimer: movementInternal[movementInternal.length > 13 ? 5 : 4] as number,
      doubleJumpAvailable: Boolean(movementInternal[movementInternal.length > 13 ? 6 : 5]),
      catchBoostTimer: movementInternal[movementInternal.length > 13 ? 7 : 6] as number,
      groundHeight: movementInternal[movementInternal.length > 13 ? 8 : 7] as number,
      lastWallNormalX: movementInternal[movementInternal.length > 13 ? 9 : 8] as number,
      lastWallNormalZ: movementInternal[movementInternal.length > 13 ? 10 : 9] as number,
      backflipActive: Boolean(movementInternal[movementInternal.length > 13 ? 11 : 10]),
      backflipTimer: movementInternal[movementInternal.length > 13 ? 12 : 11] as number,
      backflipCooldown: movementInternal[movementInternal.length > 13 ? 13 : 12] as number
    },
    hands: {
      left: unpackHand('left', hands[0]),
      right: unpackHand('right', hands[1])
    },
    dash: {
      charges: dash[0] as number,
      rechargeTimerSeconds: dash[1] as number,
      cooldownSeconds: dash[2] as number
    },
    score: packed[19] as number,
    matchStats: {
      hits: matchStats[0] as number,
      hitsTaken: matchStats[1] as number,
      catches: matchStats[2] as number,
      parries: matchStats[3] as number,
      saves: matchStats[4] as number
    },
    lives: packed[21] as number,
    combatState: packed[22] as PlayerState['combatState'],
    eliminatedAtMs: packed[23] as number | null,
    lastPlayerBuffUntilMs: packed[24] as number | null,
    connected: Boolean(packed[25]),
    reconnectDeadlineAtMs: packed[26] as number | null,
    lastProcessedInputSeq: packed[27] as number
  };
}

function packHand(hand: PlayerHandsState[HandSide]): unknown[] {
  return [
    hand.heldBallId,
    hand.mode,
    hand.chargeSeconds,
    hand.cooldownSeconds,
    hand.lastCatchAttemptId
  ];
}

function unpackHand(side: HandSide, packed: unknown[]): PlayerHandsState[HandSide] {
  return {
    side,
    heldBallId: packed[0] as string | null,
    mode: packed[1] as PlayerHandsState[HandSide]['mode'],
    chargeSeconds: packed[2] as number,
    cooldownSeconds: packed[3] as number,
    catchTrackingSecondsByBallId: {},
    lastCatchAttemptId: packed[4] as number
  };
}

function packBall(ball: BallState): unknown[] {
  return [
    ball.id,
    ball.phase,
    packPos(ball.position),
    packVel(ball.velocity),
    ball.ownerKind,
    ball.ownerId,
    ball.heldByPlayerId,
    ball.heldHand,
    ball.bounceCount,
    b(ball.isSuper),
    ball.dropScale,
    packVel(ball.curveAccel),
    ball.lastTouchedByPlayerId,
    ball.throwId
  ];
}

function unpackBall(packed: unknown[]): BallState {
  return {
    id: packed[0] as string,
    phase: packed[1] as BallState['phase'],
    position: unpackPos(packed[2] as unknown[]),
    velocity: unpackVel(packed[3] as unknown[]),
    ownerKind: packed[4] as BallState['ownerKind'],
    ownerId: packed[5] as string | null,
    heldByPlayerId: packed[6] as string | null,
    heldHand: packed[7] as HandSide | null,
    bounceCount: packed[8] as number,
    isSuper: Boolean(packed[9]),
    dropScale: packed[10] as number,
    curveAccel: unpackVel(packed[11] as unknown[]),
    lastTouchedByPlayerId: packed[12] as string | null,
    throwId: packed[13] as number
  };
}

/**
 * Fixed-point vector quantization (Quake/Source-style). World coordinates are sent as integers
 * scaled by a per-domain factor instead of full 8-byte msgpack doubles, roughly halving the bytes
 * for every position/velocity/facing on every player and ball, every snapshot. This is a pure,
 * stateless ENCODING change — no per-client baseline, no delta chain — so a dropped/backpressure-
 * skipped snapshot can never corrupt anything: each snapshot still carries every entity in full.
 *
 * Ranges are sized with generous headroom and CLAMPED (never wrapped) so an out-of-arena glitch ball
 * degrades to a clamped visual position rather than overflowing to a garbage one. The server stays
 * authoritative; these values only drive remote-entity interpolation. Precision at these scales:
 *   position: 1/512 m ≈ 2 mm   velocity: 1/128 (m/s) ≈ 8 mm/s   unit: 1/16384 ≈ 6e-5
 * all far below the interpolation snap thresholds (HUGE_ERROR_SNAP_METERS=5, reconcile 0.5 m).
 *
 * The full-precision encoder path (SNAPSHOT_ENCODING=full → not compact) never calls these, so it
 * remains lossless for debugging.
 */
const INT16_MIN = -32768;
const INT16_MAX = 32767;

/** Position/world coords: ±64 m covers the ±13×±18×8.5 arena plus huge out-of-bounds headroom. */
const POSITION_SCALE = 512; // 32768 / 64
/** Velocities: ±256 m/s covers the fastest super throw (~85 m/s) with 3× headroom. */
const VELOCITY_SCALE = 128; // 32768 / 256
/** Unit-ish vectors (facing) and small accelerations: ±2 range, fine precision. */
const UNIT_SCALE = 16384; // 32768 / 2

function quantizeScalar(n: number, scale: number): number {
  if (!Number.isFinite(n)) return 0;
  const scaled = Math.round(n * scale);
  return scaled < INT16_MIN ? INT16_MIN : scaled > INT16_MAX ? INT16_MAX : scaled;
}

function dequantizeScalar(n: unknown, scale: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n / scale : 0;
}

function packVecScaled(v: Vec3, scale: number): number[] {
  return [quantizeScalar(v.x, scale), quantizeScalar(v.y, scale), quantizeScalar(v.z, scale)];
}

function unpackVecScaled(v: unknown[], scale: number): Vec3 {
  return {
    x: dequantizeScalar(v[0], scale),
    y: dequantizeScalar(v[1], scale),
    z: dequantizeScalar(v[2], scale)
  };
}

function packPos(v: Vec3): number[] {
  return packVecScaled(v, POSITION_SCALE);
}
function unpackPos(v: unknown[]): Vec3 {
  return unpackVecScaled(v, POSITION_SCALE);
}
function packVel(v: Vec3): number[] {
  return packVecScaled(v, VELOCITY_SCALE);
}
function unpackVel(v: unknown[]): Vec3 {
  return unpackVecScaled(v, VELOCITY_SCALE);
}
function packUnit(v: Vec3): number[] {
  return packVecScaled(v, UNIT_SCALE);
}
function unpackUnit(v: unknown[]): Vec3 {
  return unpackVecScaled(v, UNIT_SCALE);
}

function b(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function isCompactSnapshot(snapshot: ServerSnapshot | CompactServerSnapshot): snapshot is CompactServerSnapshot {
  return snapshot.type === 'snapshot-compact';
}

export function hydrateSnapshotRoster(snapshot: ServerSnapshot, roster: PlayerRoster): ServerSnapshot {
  let changed = false;
  const players: RoomState['players'] = {};

  for (const playerId in snapshot.room.players) {
    const player = snapshot.room.players[playerId];
    const known = roster[playerId]?.name;
    if ((player.name === undefined || player.name === '') && known) {
      players[playerId] = { ...player, name: known };
      changed = true;
    } else {
      players[playerId] = player;
      if (player.name) roster[playerId] = { name: player.name };
    }
  }

  return changed
    ? { ...snapshot, room: { ...snapshot.room, players } }
    : snapshot;
}

function leanPlayer(player: PlayerState): PlayerState {
  const { name: _name, ...withoutName } = player;
  return {
    ...withoutName,
    movement: {
      ...player.movement,
      position: qVec(player.movement.position, q3),
      velocity: qVec(player.movement.velocity, q3),
      facing: qVec(player.movement.facing, q4),
      yawRadians: q4(player.movement.yawRadians),
      pitchRadians: q4(player.movement.pitchRadians),
      speed: q3(player.movement.speed)
    },
    movementInternal: {
      ...player.movementInternal,
      slideTimer: q3(player.movementInternal.slideTimer),
      slideBufferTimer: q3(player.movementInternal.slideBufferTimer),
      jumpGraceTimer: q3(player.movementInternal.jumpGraceTimer),
      wallRunTimer: q3(player.movementInternal.wallRunTimer),
      wallReattachCooldown: q3(player.movementInternal.wallReattachCooldown),
      dashActiveTimer: q3(player.movementInternal.dashActiveTimer),
      catchBoostTimer: q3(player.movementInternal.catchBoostTimer),
      groundHeight: q3(player.movementInternal.groundHeight),
      lastWallNormalX: q4(player.movementInternal.lastWallNormalX),
      lastWallNormalZ: q4(player.movementInternal.lastWallNormalZ),
      backflipTimer: q3(player.movementInternal.backflipTimer),
      backflipCooldown: q3(player.movementInternal.backflipCooldown)
    },
    hands: leanHands(player.hands),
    dash: {
      ...player.dash,
      rechargeTimerSeconds: q3(player.dash.rechargeTimerSeconds),
      cooldownSeconds: q3(player.dash.cooldownSeconds)
    },
    eliminatedAtMs: player.eliminatedAtMs === null ? null : q0(player.eliminatedAtMs),
    lastPlayerBuffUntilMs: player.lastPlayerBuffUntilMs === null ? null : q0(player.lastPlayerBuffUntilMs),
    reconnectDeadlineAtMs: player.reconnectDeadlineAtMs === null ? null : q0(player.reconnectDeadlineAtMs)
  } as PlayerState;
}

function leanHands(hands: PlayerHandsState): PlayerHandsState {
  return {
    left: leanHand(hands.left),
    right: leanHand(hands.right)
  };
}

function leanHand(hand: PlayerHandsState[HandSide]): PlayerHandsState[HandSide] {
  return {
    ...hand,
    chargeSeconds: q3(hand.chargeSeconds),
    cooldownSeconds: q3(hand.cooldownSeconds)
  };
}

function leanBall(ball: BallState): BallState {
  return {
    ...ball,
    position: qVec(ball.position, q3),
    velocity: qVec(ball.velocity, q3),
    curveAccel: qVec(ball.curveAccel, q3),
    dropScale: q3(ball.dropScale)
  };
}

function qVec(v: Vec3, quantize: (n: number) => number): Vec3 {
  return {
    x: quantize(v.x),
    y: quantize(v.y),
    z: quantize(v.z)
  };
}

function q0(n: number): number {
  return Math.round(n);
}

function q3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function q4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
