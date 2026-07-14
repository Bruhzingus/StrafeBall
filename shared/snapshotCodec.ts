import type { ServerSnapshot } from './protocol';
import type { BallState, HandSide, PlayerHandsState, PlayerState, RoomState, Vec3 } from './types';
import { facingFromAngles } from './simulation/AimMath';

export type PlayerRoster = Record<string, { name: string }>;

export interface CompactServerSnapshot {
  type: 'snapshot-compact';
  tick: number;
  serverTimeMs: number;
  // Only `players` and `balls` are positionally packed; everything else in RoomState — including the
  // new `hostPlayerId`, `phase`, and `settings` — rides through verbatim via `Omit<RoomState, ...>`.
  // Those fields are plain JSON scalars (strings + small ints), so they need NO bespoke packing and
  // survive makeLeanSnapshot / makeCompactSnapshot / inflateCompactSnapshot through the room spreads.
  room: Omit<RoomState, 'players' | 'balls'> & {
    players: unknown[][];
    balls: unknown[][];
  };
}

export const TIERED_SNAPSHOT_LANES = {
  FAST_PLAYERS: 1,
  PLAYER: 2,
  BALL: 4,
  WORLD: 8
} as const;

export interface TieredCompactServerSnapshot {
  type: 'snapshot-tiered-v1';
  tick: number;
  serverTimeMs: number;
  /** Compact lane mask. See TIERED_SNAPSHOT_LANES. */
  l: number;
  /** Fast reset serial so reset detection never waits for the world lane. */
  rs: number;
  /**
   * Fast player pose rows for ALL players, every snapshot. The local player merges everything
   * (pose + movementInternal + hands + dash — reconciliation needs it); REMOTE players merge their
   * pose rows too, so remote interpolation runs at the full snapshot rate instead of the half-rate
   * full-player lane (the rows are already paid for — not merging them was pure added remote delay).
   */
  f?: unknown[][];
  /** 48 Hz full player rows. */
  p?: unknown[][];
  /** 96 Hz ball rows. */
  b?: unknown[][];
  /** 24 Hz/dirty room metadata without players or balls. */
  w?: Omit<RoomState, 'players' | 'balls'>;
}

export interface SnapshotLaneInfo {
  mode: 'baseline' | 'tiered_v1';
  tiered: boolean;
  fullState: boolean;
  fastPlayerLane: boolean;
  playerLane: boolean;
  ballLane: boolean;
  worldLane: boolean;
  resetSerial: number;
}

export interface DecodedSnapshotPayload {
  snapshot: ServerSnapshot;
  lanes: SnapshotLaneInfo;
}

export function rosterFromRoom(room: RoomState): PlayerRoster {
  const roster: PlayerRoster = {};
  for (const playerId in room.players) {
    const player = room.players[playerId];
    roster[playerId] = { name: player.name };
  }
  return roster;
}

/**
 * Room metadata (everything but players/balls) with the few per-tick float fields quantized.
 * Player/ball quantization happens INSIDE the pack helpers now (they emit scaled integers), so the
 * packed paths no longer deep-clone every player and ball per snapshot just to round their floats —
 * that lean pre-pass was a meaningful per-broadcast allocation cost at 96Hz on a starved host.
 */
function leanWorld(room: RoomState): Omit<RoomState, 'players' | 'balls'> {
  const { players: _players, balls: _balls, ...world } = room;
  return {
    ...world,
    match: {
      ...world.match,
      elapsedSeconds: q3(world.match.elapsedSeconds),
      countdownSeconds: q3(world.match.countdownSeconds),
      boundary: {
        ...world.match.boundary,
        elapsedSeconds: q3(world.match.boundary.elapsedSeconds)
      }
    }
  };
}

export function makeCompactSnapshot(snapshot: ServerSnapshot): CompactServerSnapshot {
  return {
    type: 'snapshot-compact',
    tick: snapshot.tick,
    serverTimeMs: q0(snapshot.serverTimeMs),
    room: {
      ...leanWorld(snapshot.room),
      players: Object.values(snapshot.room.players).map(packPlayer),
      balls: Object.values(snapshot.room.balls).map(packBall)
    }
  };
}

export interface MakeTieredCompactSnapshotOptions {
  includeFastPlayerLane?: boolean;
  includePlayerLane: boolean;
  includeBallLane?: boolean;
  includeWorldLane: boolean;
}

export function makeTieredCompactSnapshot(
  snapshot: ServerSnapshot,
  options: MakeTieredCompactSnapshotOptions
): TieredCompactServerSnapshot {
  const includePlayerLane = options.includePlayerLane;
  const includeFastPlayerLane = options.includeFastPlayerLane ?? !includePlayerLane;
  const includeBallLane = options.includeBallLane ?? true;
  const includeWorldLane = options.includeWorldLane;
  const lanes =
    (includeFastPlayerLane ? TIERED_SNAPSHOT_LANES.FAST_PLAYERS : 0) |
    (includePlayerLane ? TIERED_SNAPSHOT_LANES.PLAYER : 0) |
    (includeBallLane ? TIERED_SNAPSHOT_LANES.BALL : 0) |
    (includeWorldLane ? TIERED_SNAPSHOT_LANES.WORLD : 0);

  // Lanes pack straight off the live state (the pack helpers quantize inline); the world clone is
  // only paid on the snapshots that actually carry the world lane.
  return {
    type: 'snapshot-tiered-v1',
    tick: snapshot.tick,
    serverTimeMs: q0(snapshot.serverTimeMs),
    l: lanes,
    rs: snapshot.room.resetVote.resetSerial,
    ...(includeFastPlayerLane ? { f: Object.values(snapshot.room.players).map(packFastPlayer) } : {}),
    ...(includePlayerLane ? { p: Object.values(snapshot.room.players).map(packPlayer) } : {}),
    ...(includeBallLane ? { b: Object.values(snapshot.room.balls).map(packBall) } : {}),
    ...(includeWorldLane ? { w: leanWorld(snapshot.room) } : {})
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

export function mergeTieredCompactSnapshot(
  snapshot: TieredCompactServerSnapshot,
  previous: ServerSnapshot | null,
  localPlayerId: string
): DecodedSnapshotPayload | null {
  const lanes = laneInfoFromTieredSnapshot(snapshot);
  const previousRoom = previous?.room ?? null;
  const world = snapshot.w ?? (previousRoom ? roomMeta(previousRoom) : null);
  if (!world) return null;

  const players: RoomState['players'] = snapshot.p
    ? unpackPlayers(snapshot.p)
    : previousRoom
      ? { ...previousRoom.players }
      : {};
  if (!snapshot.p && !previousRoom) return null;

  if (!snapshot.p && snapshot.f) {
    // Merge EVERY fast row that has a base (local for reconciliation, remotes for interpolation) —
    // the rows are on the wire regardless, and merging remotes doubles their effective pose rate
    // (96Hz instead of the 48Hz player lane). A row without a base (player joined since our last
    // full lane) is skipped; the next player lane (≤2 snapshots away) introduces them whole.
    for (const packedPlayer of snapshot.f) {
      const playerId = packedPlayer[0] as string | undefined;
      if (!playerId) continue;
      const base = players[playerId];
      if (base) players[playerId] = mergeFastPlayer(base, packedPlayer);
    }
  }

  const balls: RoomState['balls'] = snapshot.b
    ? unpackBalls(snapshot.b)
    : previousRoom
      ? { ...previousRoom.balls }
      : {};
  if (!snapshot.b && !previousRoom) return null;

  const room: RoomState = {
    ...world,
    tick: snapshot.tick,
    resetVote: {
      ...world.resetVote,
      resetSerial: snapshot.rs
    },
    players,
    balls
  };

  return {
    snapshot: {
      type: 'snapshot',
      tick: snapshot.tick,
      serverTimeMs: snapshot.serverTimeMs,
      room
    },
    lanes
  };
}

export function laneInfoFromFullSnapshot(snapshot: ServerSnapshot): SnapshotLaneInfo {
  return {
    mode: 'baseline',
    tiered: false,
    fullState: true,
    fastPlayerLane: true,
    playerLane: true,
    ballLane: true,
    worldLane: true,
    resetSerial: snapshot.room.resetVote.resetSerial
  };
}

export function laneInfoFromTieredSnapshot(snapshot: TieredCompactServerSnapshot): SnapshotLaneInfo {
  const hasFastPlayerLane = (snapshot.l & TIERED_SNAPSHOT_LANES.FAST_PLAYERS) !== 0;
  const hasPlayerLane = (snapshot.l & TIERED_SNAPSHOT_LANES.PLAYER) !== 0;
  const hasBallLane = (snapshot.l & TIERED_SNAPSHOT_LANES.BALL) !== 0;
  const hasWorldLane = (snapshot.l & TIERED_SNAPSHOT_LANES.WORLD) !== 0;
  return {
    mode: 'tiered_v1',
    tiered: true,
    fullState: hasPlayerLane && hasBallLane && hasWorldLane,
    fastPlayerLane: hasFastPlayerLane,
    playerLane: hasPlayerLane,
    ballLane: hasBallLane,
    worldLane: hasWorldLane,
    resetSerial: snapshot.rs
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
    pq4(player.movement.yawRadians),
    pq4(player.movement.pitchRadians),
    // facing slot: derived from yaw/pitch on unpack (facingFromAngles) — never sent.
    0,
    b(player.movement.grounded),
    b(player.movement.crouching),
    b(player.movement.sliding),
    b(player.movement.wallRunning),
    b(player.movement.dashingThisFrame),
    pq3(player.movement.speed),
    packMovementInternal(player.movementInternal),
    [packHand(player.hands.left), packHand(player.hands.right)],
    [player.dash.charges, pq3(player.dash.rechargeTimerSeconds), pq3(player.dash.cooldownSeconds)],
    player.score,
    [
      player.matchStats.hits,
      player.matchStats.hitsTaken,
      player.matchStats.catches,
      player.matchStats.parries,
      player.matchStats.saves,
      player.matchStats.throws,
      player.matchStats.directHits,
      player.matchStats.bounceHits,
      player.matchStats.curveHits,
      player.matchStats.backflipHits
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

function packFastPlayer(player: PlayerState): unknown[] {
  return [
    player.id,
    packPos(player.movement.position),
    packVel(player.movement.velocity),
    pq4(player.movement.yawRadians),
    pq4(player.movement.pitchRadians),
    // facing slot: derived from yaw/pitch on unpack (facingFromAngles) — never sent.
    0,
    b(player.movement.grounded),
    b(player.movement.crouching),
    b(player.movement.sliding),
    b(player.movement.wallRunning),
    b(player.movement.dashingThisFrame),
    pq3(player.movement.speed),
    packMovementInternal(player.movementInternal),
    [packHand(player.hands.left), packHand(player.hands.right)],
    [player.dash.charges, pq3(player.dash.rechargeTimerSeconds), pq3(player.dash.cooldownSeconds)],
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
      yawRadians: uq4(packed[7]),
      pitchRadians: uq4(packed[8]),
      // The facing slot is a placeholder 0 on the wire; facing is a pure function of yaw/pitch
      // (MovementSim recomputes it every tick the same way), so it is derived here instead of sent.
      facing: facingFromAngles(uq4(packed[7]), uq4(packed[8])),
      grounded: Boolean(packed[10]),
      crouching: Boolean(packed[11]),
      sliding: Boolean(packed[12]),
      wallRunning: Boolean(packed[13]),
      dashingThisFrame: Boolean(packed[14]),
      speed: uq3(packed[15])
    },
    movementInternal: unpackMovementInternal(movementInternal),
    hands: {
      left: unpackHand('left', hands[0]),
      right: unpackHand('right', hands[1])
    },
    dash: {
      charges: dash[0] as number,
      rechargeTimerSeconds: uq3(dash[1]),
      cooldownSeconds: uq3(dash[2])
    },
    score: packed[19] as number,
    matchStats: {
      hits: matchStats[0] as number,
      hitsTaken: matchStats[1] as number,
      catches: matchStats[2] as number,
      parries: matchStats[3] as number,
      saves: matchStats[4] as number,
      // Report-card breakdown stats (appended later): tolerate short arrays from an older server.
      throws: (matchStats[5] as number | undefined) ?? 0,
      directHits: (matchStats[6] as number | undefined) ?? 0,
      bounceHits: (matchStats[7] as number | undefined) ?? 0,
      curveHits: (matchStats[8] as number | undefined) ?? 0,
      backflipHits: (matchStats[9] as number | undefined) ?? 0
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

function mergeFastPlayer(base: PlayerState, packed: unknown[]): PlayerState {
  const hands = packed[13] as [unknown[], unknown[]];
  const dash = packed[14] as unknown[];
  return {
    ...base,
    movement: {
      position: unpackPos(packed[1] as unknown[]),
      velocity: unpackVel(packed[2] as unknown[]),
      yawRadians: uq4(packed[3]),
      pitchRadians: uq4(packed[4]),
      // Facing slot is a placeholder 0 on the wire — derived from yaw/pitch (see unpackPlayer).
      facing: facingFromAngles(uq4(packed[3]), uq4(packed[4])),
      grounded: Boolean(packed[6]),
      crouching: Boolean(packed[7]),
      sliding: Boolean(packed[8]),
      wallRunning: Boolean(packed[9]),
      dashingThisFrame: Boolean(packed[10]),
      speed: uq3(packed[11])
    },
    movementInternal: unpackMovementInternal(packed[12] as unknown[]),
    hands: {
      left: unpackHand('left', hands[0]),
      right: unpackHand('right', hands[1])
    },
    dash: {
      charges: dash[0] as number,
      rechargeTimerSeconds: uq3(dash[1]),
      cooldownSeconds: uq3(dash[2])
    },
    lives: packed[15] as number,
    combatState: packed[16] as PlayerState['combatState'],
    eliminatedAtMs: packed[17] as number | null,
    lastPlayerBuffUntilMs: packed[18] as number | null,
    connected: Boolean(packed[19]),
    reconnectDeadlineAtMs: packed[20] as number | null,
    lastProcessedInputSeq: packed[21] as number
  };
}

function packMovementInternal(movementInternal: PlayerState['movementInternal']): unknown[] {
  return [
    pq3(movementInternal.slideTimer),
    pq3(movementInternal.slideBufferTimer),
    pq3(movementInternal.jumpGraceTimer),
    pq3(movementInternal.wallRunTimer),
    pq3(movementInternal.wallReattachCooldown),
    pq3(movementInternal.dashActiveTimer),
    b(movementInternal.doubleJumpAvailable),
    pq3(movementInternal.catchBoostTimer),
    pq3(movementInternal.groundHeight),
    pq4(movementInternal.lastWallNormalX),
    pq4(movementInternal.lastWallNormalZ),
    b(movementInternal.backflipActive),
    pq3(movementInternal.backflipTimer),
    pq3(movementInternal.backflipCooldown)
  ];
}

function unpackMovementInternal(movementInternal: unknown[]): PlayerState['movementInternal'] {
  return {
    slideTimer: uq3(movementInternal[0]),
    slideBufferTimer: movementInternal.length > 13 ? uq3(movementInternal[1]) : 0,
    jumpGraceTimer: uq3(movementInternal[movementInternal.length > 13 ? 2 : 1]),
    wallRunTimer: uq3(movementInternal[movementInternal.length > 13 ? 3 : 2]),
    wallReattachCooldown: uq3(movementInternal[movementInternal.length > 13 ? 4 : 3]),
    dashActiveTimer: uq3(movementInternal[movementInternal.length > 13 ? 5 : 4]),
    doubleJumpAvailable: Boolean(movementInternal[movementInternal.length > 13 ? 6 : 5]),
    catchBoostTimer: uq3(movementInternal[movementInternal.length > 13 ? 7 : 6]),
    groundHeight: uq3(movementInternal[movementInternal.length > 13 ? 8 : 7]),
    lastWallNormalX: uq4(movementInternal[movementInternal.length > 13 ? 9 : 8]),
    lastWallNormalZ: uq4(movementInternal[movementInternal.length > 13 ? 10 : 9]),
    backflipActive: Boolean(movementInternal[movementInternal.length > 13 ? 11 : 10]),
    backflipTimer: uq3(movementInternal[movementInternal.length > 13 ? 12 : 11]),
    backflipCooldown: uq3(movementInternal[movementInternal.length > 13 ? 13 : 12])
  };
}

function packHand(hand: PlayerHandsState[HandSide]): unknown[] {
  return [
    hand.heldBallId,
    hand.mode,
    pq3(hand.chargeSeconds),
    pq3(hand.cooldownSeconds),
    hand.lastCatchAttemptId
  ];
}

function unpackHand(side: HandSide, packed: unknown[]): PlayerHandsState[HandSide] {
  return {
    side,
    heldBallId: packed[0] as string | null,
    mode: packed[1] as PlayerHandsState[HandSide]['mode'],
    chargeSeconds: uq3(packed[2]),
    cooldownSeconds: uq3(packed[3]),
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
    pq3(ball.dropScale),
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
    dropScale: uq3(packed[10]),
    curveAccel: unpackVel(packed[11] as unknown[]),
    // Not wire-synced: each side (server, client prediction) tracks its own curve ramp distance
    // locally from the throw, so a decoded snapshot ball doesn't need this to drive curve replay.
    curveDistance: 0,
    lastTouchedByPlayerId: packed[12] as string | null,
    throwId: packed[13] as number
  };
}

function unpackPlayers(packedPlayers: unknown[][]): RoomState['players'] {
  const players: RoomState['players'] = {};
  for (const packedPlayer of packedPlayers) {
    const player = unpackPlayer(packedPlayer);
    players[player.id] = player;
  }
  return players;
}

function unpackBalls(packedBalls: unknown[][]): RoomState['balls'] {
  const balls: RoomState['balls'] = {};
  for (const packedBall of packedBalls) {
    const ball = unpackBall(packedBall);
    balls[ball.id] = ball;
  }
  return balls;
}

function roomMeta(room: RoomState): Omit<RoomState, 'players' | 'balls'> {
  const { players: _players, balls: _balls, ...meta } = room;
  return meta;
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

/**
 * Scaled-INTEGER quantizers for the scalar floats in the hot player/ball lanes. Colyseus encodes
 * room messages with msgpack, where any non-integer number costs 9 bytes (float64) but small
 * integers cost 1–3. ×1000 (pq3) / ×10000 (pq4) match the q3/q4 rounding makeLeanSnapshot has
 * always applied, so the DECODED values are identical to before — only the wire bytes shrink.
 * (Math.round(n·s)/s and Math.round(n·s) then /s are the same double.)
 */
function pq3(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}
function uq3(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n / 1000 : 0;
}
function pq4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10000) : 0;
}
function uq4(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n / 10000 : 0;
}

export function isCompactSnapshot(
  snapshot: ServerSnapshot | CompactServerSnapshot | TieredCompactServerSnapshot
): snapshot is CompactServerSnapshot {
  return snapshot.type === 'snapshot-compact';
}

export function isTieredCompactSnapshot(
  snapshot: ServerSnapshot | CompactServerSnapshot | TieredCompactServerSnapshot
): snapshot is TieredCompactServerSnapshot {
  return snapshot.type === 'snapshot-tiered-v1';
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

function q0(n: number): number {
  return Math.round(n);
}

function q3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
