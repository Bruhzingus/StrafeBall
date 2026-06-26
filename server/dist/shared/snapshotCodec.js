"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIERED_SNAPSHOT_LANES = void 0;
exports.rosterFromRoom = rosterFromRoom;
exports.makeLeanSnapshot = makeLeanSnapshot;
exports.makeCompactSnapshot = makeCompactSnapshot;
exports.makeTieredCompactSnapshot = makeTieredCompactSnapshot;
exports.inflateCompactSnapshot = inflateCompactSnapshot;
exports.mergeTieredCompactSnapshot = mergeTieredCompactSnapshot;
exports.laneInfoFromFullSnapshot = laneInfoFromFullSnapshot;
exports.laneInfoFromTieredSnapshot = laneInfoFromTieredSnapshot;
exports.isCompactSnapshot = isCompactSnapshot;
exports.isTieredCompactSnapshot = isTieredCompactSnapshot;
exports.hydrateSnapshotRoster = hydrateSnapshotRoster;
exports.TIERED_SNAPSHOT_LANES = {
    FAST_PLAYERS: 1,
    PLAYER: 2,
    BALL: 4,
    WORLD: 8
};
function rosterFromRoom(room) {
    const roster = {};
    for (const playerId in room.players) {
        const player = room.players[playerId];
        roster[playerId] = { name: player.name };
    }
    return roster;
}
function makeLeanSnapshot(snapshot) {
    const players = {};
    const balls = {};
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
function makeCompactSnapshot(snapshot) {
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
function makeTieredCompactSnapshot(snapshot, options) {
    const lean = makeLeanSnapshot(snapshot);
    const includePlayerLane = options.includePlayerLane;
    const includeFastPlayerLane = options.includeFastPlayerLane ?? !includePlayerLane;
    const includeBallLane = options.includeBallLane ?? true;
    const includeWorldLane = options.includeWorldLane;
    const { players: _players, balls: _balls, ...world } = lean.room;
    const lanes = (includeFastPlayerLane ? exports.TIERED_SNAPSHOT_LANES.FAST_PLAYERS : 0) |
        (includePlayerLane ? exports.TIERED_SNAPSHOT_LANES.PLAYER : 0) |
        (includeBallLane ? exports.TIERED_SNAPSHOT_LANES.BALL : 0) |
        (includeWorldLane ? exports.TIERED_SNAPSHOT_LANES.WORLD : 0);
    return {
        type: 'snapshot-tiered-v1',
        tick: lean.tick,
        serverTimeMs: lean.serverTimeMs,
        l: lanes,
        rs: lean.room.resetVote.resetSerial,
        ...(includeFastPlayerLane ? { f: Object.values(lean.room.players).map(packFastPlayer) } : {}),
        ...(includePlayerLane ? { p: Object.values(lean.room.players).map(packPlayer) } : {}),
        ...(includeBallLane ? { b: Object.values(lean.room.balls).map(packBall) } : {}),
        ...(includeWorldLane ? { w: world } : {})
    };
}
function inflateCompactSnapshot(snapshot) {
    const players = {};
    const balls = {};
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
function mergeTieredCompactSnapshot(snapshot, previous, localPlayerId) {
    const lanes = laneInfoFromTieredSnapshot(snapshot);
    const previousRoom = previous?.room ?? null;
    const world = snapshot.w ?? (previousRoom ? roomMeta(previousRoom) : null);
    if (!world)
        return null;
    const players = snapshot.p
        ? unpackPlayers(snapshot.p)
        : previousRoom
            ? { ...previousRoom.players }
            : {};
    if (!snapshot.p && !previousRoom)
        return null;
    if (!snapshot.p && snapshot.f && localPlayerId) {
        for (const packedPlayer of snapshot.f) {
            const playerId = packedPlayer[0];
            if (playerId !== localPlayerId)
                continue;
            const base = players[playerId];
            if (base)
                players[playerId] = mergeFastPlayer(base, packedPlayer);
            break;
        }
    }
    const balls = snapshot.b
        ? unpackBalls(snapshot.b)
        : previousRoom
            ? { ...previousRoom.balls }
            : {};
    if (!snapshot.b && !previousRoom)
        return null;
    const room = {
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
function laneInfoFromFullSnapshot(snapshot) {
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
function laneInfoFromTieredSnapshot(snapshot) {
    const hasFastPlayerLane = (snapshot.l & exports.TIERED_SNAPSHOT_LANES.FAST_PLAYERS) !== 0;
    const hasPlayerLane = (snapshot.l & exports.TIERED_SNAPSHOT_LANES.PLAYER) !== 0;
    const hasBallLane = (snapshot.l & exports.TIERED_SNAPSHOT_LANES.BALL) !== 0;
    const hasWorldLane = (snapshot.l & exports.TIERED_SNAPSHOT_LANES.WORLD) !== 0;
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
function packPlayer(player) {
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
        packMovementInternal(player.movementInternal),
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
function packFastPlayer(player) {
    return [
        player.id,
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
        packMovementInternal(player.movementInternal),
        [packHand(player.hands.left), packHand(player.hands.right)],
        [player.dash.charges, player.dash.rechargeTimerSeconds, player.dash.cooldownSeconds],
        player.lives,
        player.combatState,
        player.eliminatedAtMs,
        player.lastPlayerBuffUntilMs,
        b(player.connected),
        player.reconnectDeadlineAtMs,
        player.lastProcessedInputSeq
    ];
}
function unpackPlayer(packed) {
    const movementInternal = packed[16];
    const hands = packed[17];
    const dash = packed[18];
    const matchStats = packed[20];
    return {
        id: packed[0],
        name: '',
        teamId: packed[1],
        spawnSide: packed[2],
        teamSlotIndex: packed[3],
        legalHalf: packed[4],
        movement: {
            position: unpackPos(packed[5]),
            velocity: unpackVel(packed[6]),
            yawRadians: packed[7],
            pitchRadians: packed[8],
            facing: unpackUnit(packed[9]),
            grounded: Boolean(packed[10]),
            crouching: Boolean(packed[11]),
            sliding: Boolean(packed[12]),
            wallRunning: Boolean(packed[13]),
            dashingThisFrame: Boolean(packed[14]),
            speed: packed[15]
        },
        movementInternal: unpackMovementInternal(movementInternal),
        hands: {
            left: unpackHand('left', hands[0]),
            right: unpackHand('right', hands[1])
        },
        dash: {
            charges: dash[0],
            rechargeTimerSeconds: dash[1],
            cooldownSeconds: dash[2]
        },
        score: packed[19],
        matchStats: {
            hits: matchStats[0],
            hitsTaken: matchStats[1],
            catches: matchStats[2],
            parries: matchStats[3],
            saves: matchStats[4]
        },
        lives: packed[21],
        combatState: packed[22],
        eliminatedAtMs: packed[23],
        lastPlayerBuffUntilMs: packed[24],
        connected: Boolean(packed[25]),
        reconnectDeadlineAtMs: packed[26],
        lastProcessedInputSeq: packed[27]
    };
}
function mergeFastPlayer(base, packed) {
    const hands = packed[13];
    const dash = packed[14];
    return {
        ...base,
        movement: {
            position: unpackPos(packed[1]),
            velocity: unpackVel(packed[2]),
            yawRadians: packed[3],
            pitchRadians: packed[4],
            facing: unpackUnit(packed[5]),
            grounded: Boolean(packed[6]),
            crouching: Boolean(packed[7]),
            sliding: Boolean(packed[8]),
            wallRunning: Boolean(packed[9]),
            dashingThisFrame: Boolean(packed[10]),
            speed: packed[11]
        },
        movementInternal: unpackMovementInternal(packed[12]),
        hands: {
            left: unpackHand('left', hands[0]),
            right: unpackHand('right', hands[1])
        },
        dash: {
            charges: dash[0],
            rechargeTimerSeconds: dash[1],
            cooldownSeconds: dash[2]
        },
        lives: packed[15],
        combatState: packed[16],
        eliminatedAtMs: packed[17],
        lastPlayerBuffUntilMs: packed[18],
        connected: Boolean(packed[19]),
        reconnectDeadlineAtMs: packed[20],
        lastProcessedInputSeq: packed[21]
    };
}
function packMovementInternal(movementInternal) {
    return [
        movementInternal.slideTimer,
        movementInternal.slideBufferTimer,
        movementInternal.jumpGraceTimer,
        movementInternal.wallRunTimer,
        movementInternal.wallReattachCooldown,
        movementInternal.dashActiveTimer,
        b(movementInternal.doubleJumpAvailable),
        movementInternal.catchBoostTimer,
        movementInternal.groundHeight,
        movementInternal.lastWallNormalX,
        movementInternal.lastWallNormalZ,
        b(movementInternal.backflipActive),
        movementInternal.backflipTimer,
        movementInternal.backflipCooldown
    ];
}
function unpackMovementInternal(movementInternal) {
    return {
        slideTimer: movementInternal[0],
        slideBufferTimer: movementInternal.length > 13 ? movementInternal[1] : 0,
        jumpGraceTimer: movementInternal[movementInternal.length > 13 ? 2 : 1],
        wallRunTimer: movementInternal[movementInternal.length > 13 ? 3 : 2],
        wallReattachCooldown: movementInternal[movementInternal.length > 13 ? 4 : 3],
        dashActiveTimer: movementInternal[movementInternal.length > 13 ? 5 : 4],
        doubleJumpAvailable: Boolean(movementInternal[movementInternal.length > 13 ? 6 : 5]),
        catchBoostTimer: movementInternal[movementInternal.length > 13 ? 7 : 6],
        groundHeight: movementInternal[movementInternal.length > 13 ? 8 : 7],
        lastWallNormalX: movementInternal[movementInternal.length > 13 ? 9 : 8],
        lastWallNormalZ: movementInternal[movementInternal.length > 13 ? 10 : 9],
        backflipActive: Boolean(movementInternal[movementInternal.length > 13 ? 11 : 10]),
        backflipTimer: movementInternal[movementInternal.length > 13 ? 12 : 11],
        backflipCooldown: movementInternal[movementInternal.length > 13 ? 13 : 12]
    };
}
function packHand(hand) {
    return [
        hand.heldBallId,
        hand.mode,
        hand.chargeSeconds,
        hand.cooldownSeconds,
        hand.lastCatchAttemptId
    ];
}
function unpackHand(side, packed) {
    return {
        side,
        heldBallId: packed[0],
        mode: packed[1],
        chargeSeconds: packed[2],
        cooldownSeconds: packed[3],
        catchTrackingSecondsByBallId: {},
        lastCatchAttemptId: packed[4]
    };
}
function packBall(ball) {
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
function unpackBall(packed) {
    return {
        id: packed[0],
        phase: packed[1],
        position: unpackPos(packed[2]),
        velocity: unpackVel(packed[3]),
        ownerKind: packed[4],
        ownerId: packed[5],
        heldByPlayerId: packed[6],
        heldHand: packed[7],
        bounceCount: packed[8],
        isSuper: Boolean(packed[9]),
        dropScale: packed[10],
        curveAccel: unpackVel(packed[11]),
        // Not wire-synced: each side (server, client prediction) tracks its own curve ramp distance
        // locally from the throw, so a decoded snapshot ball doesn't need this to drive curve replay.
        curveDistance: 0,
        lastTouchedByPlayerId: packed[12],
        throwId: packed[13]
    };
}
function unpackPlayers(packedPlayers) {
    const players = {};
    for (const packedPlayer of packedPlayers) {
        const player = unpackPlayer(packedPlayer);
        players[player.id] = player;
    }
    return players;
}
function unpackBalls(packedBalls) {
    const balls = {};
    for (const packedBall of packedBalls) {
        const ball = unpackBall(packedBall);
        balls[ball.id] = ball;
    }
    return balls;
}
function roomMeta(room) {
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
function quantizeScalar(n, scale) {
    if (!Number.isFinite(n))
        return 0;
    const scaled = Math.round(n * scale);
    return scaled < INT16_MIN ? INT16_MIN : scaled > INT16_MAX ? INT16_MAX : scaled;
}
function dequantizeScalar(n, scale) {
    return typeof n === 'number' && Number.isFinite(n) ? n / scale : 0;
}
function packVecScaled(v, scale) {
    return [quantizeScalar(v.x, scale), quantizeScalar(v.y, scale), quantizeScalar(v.z, scale)];
}
function unpackVecScaled(v, scale) {
    return {
        x: dequantizeScalar(v[0], scale),
        y: dequantizeScalar(v[1], scale),
        z: dequantizeScalar(v[2], scale)
    };
}
function packPos(v) {
    return packVecScaled(v, POSITION_SCALE);
}
function unpackPos(v) {
    return unpackVecScaled(v, POSITION_SCALE);
}
function packVel(v) {
    return packVecScaled(v, VELOCITY_SCALE);
}
function unpackVel(v) {
    return unpackVecScaled(v, VELOCITY_SCALE);
}
function packUnit(v) {
    return packVecScaled(v, UNIT_SCALE);
}
function unpackUnit(v) {
    return unpackVecScaled(v, UNIT_SCALE);
}
function b(value) {
    return value ? 1 : 0;
}
function isCompactSnapshot(snapshot) {
    return snapshot.type === 'snapshot-compact';
}
function isTieredCompactSnapshot(snapshot) {
    return snapshot.type === 'snapshot-tiered-v1';
}
function hydrateSnapshotRoster(snapshot, roster) {
    let changed = false;
    const players = {};
    for (const playerId in snapshot.room.players) {
        const player = snapshot.room.players[playerId];
        const known = roster[playerId]?.name;
        if ((player.name === undefined || player.name === '') && known) {
            players[playerId] = { ...player, name: known };
            changed = true;
        }
        else {
            players[playerId] = player;
            if (player.name)
                roster[playerId] = { name: player.name };
        }
    }
    return changed
        ? { ...snapshot, room: { ...snapshot.room, players } }
        : snapshot;
}
function leanPlayer(player) {
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
    };
}
function leanHands(hands) {
    return {
        left: leanHand(hands.left),
        right: leanHand(hands.right)
    };
}
function leanHand(hand) {
    return {
        ...hand,
        chargeSeconds: q3(hand.chargeSeconds),
        cooldownSeconds: q3(hand.cooldownSeconds)
    };
}
function leanBall(ball) {
    return {
        ...ball,
        position: qVec(ball.position, q3),
        velocity: qVec(ball.velocity, q3),
        curveAccel: qVec(ball.curveAccel, q3),
        dropScale: q3(ball.dropScale)
    };
}
function qVec(v, quantize) {
    return {
        x: quantize(v.x),
        y: quantize(v.y),
        z: quantize(v.z)
    };
}
function q0(n) {
    return Math.round(n);
}
function q3(n) {
    return Math.round(n * 1000) / 1000;
}
function q4(n) {
    return Math.round(n * 10000) / 10000;
}
