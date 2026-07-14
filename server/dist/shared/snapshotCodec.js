"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIERED_SNAPSHOT_LANES = void 0;
exports.rosterFromRoom = rosterFromRoom;
exports.makeCompactSnapshot = makeCompactSnapshot;
exports.makeTieredCompactSnapshot = makeTieredCompactSnapshot;
exports.inflateCompactSnapshot = inflateCompactSnapshot;
exports.mergeTieredCompactSnapshot = mergeTieredCompactSnapshot;
exports.laneInfoFromFullSnapshot = laneInfoFromFullSnapshot;
exports.laneInfoFromTieredSnapshot = laneInfoFromTieredSnapshot;
exports.isCompactSnapshot = isCompactSnapshot;
exports.isTieredCompactSnapshot = isTieredCompactSnapshot;
exports.hydrateSnapshotRoster = hydrateSnapshotRoster;
const AimMath_1 = require("./simulation/AimMath");
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
/**
 * Room metadata (everything but players/balls) with the few per-tick float fields quantized.
 * Player/ball quantization happens INSIDE the pack helpers now (they emit scaled integers), so the
 * packed paths no longer deep-clone every player and ball per snapshot just to round their floats —
 * that lean pre-pass was a meaningful per-broadcast allocation cost at 96Hz on a starved host.
 */
function leanWorld(room) {
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
function makeCompactSnapshot(snapshot) {
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
function makeTieredCompactSnapshot(snapshot, options) {
    const includePlayerLane = options.includePlayerLane;
    const includeFastPlayerLane = options.includeFastPlayerLane ?? !includePlayerLane;
    const includeBallLane = options.includeBallLane ?? true;
    const includeWorldLane = options.includeWorldLane;
    const lanes = (includeFastPlayerLane ? exports.TIERED_SNAPSHOT_LANES.FAST_PLAYERS : 0) |
        (includePlayerLane ? exports.TIERED_SNAPSHOT_LANES.PLAYER : 0) |
        (includeBallLane ? exports.TIERED_SNAPSHOT_LANES.BALL : 0) |
        (includeWorldLane ? exports.TIERED_SNAPSHOT_LANES.WORLD : 0);
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
    if (!snapshot.p && snapshot.f) {
        // Merge EVERY fast row that has a base (local for reconciliation, remotes for interpolation) —
        // the rows are on the wire regardless, and merging remotes doubles their effective pose rate
        // (96Hz instead of the 48Hz player lane). A row without a base (player joined since our last
        // full lane) is skipped; the next player lane (≤2 snapshots away) introduces them whole.
        for (const packedPlayer of snapshot.f) {
            const playerId = packedPlayer[0];
            if (!playerId)
                continue;
            const base = players[playerId];
            if (base)
                players[playerId] = mergeFastPlayer(base, packedPlayer);
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
function packFastPlayer(player) {
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
            yawRadians: uq4(packed[7]),
            pitchRadians: uq4(packed[8]),
            // The facing slot is a placeholder 0 on the wire; facing is a pure function of yaw/pitch
            // (MovementSim recomputes it every tick the same way), so it is derived here instead of sent.
            facing: (0, AimMath_1.facingFromAngles)(uq4(packed[7]), uq4(packed[8])),
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
            charges: dash[0],
            rechargeTimerSeconds: uq3(dash[1]),
            cooldownSeconds: uq3(dash[2])
        },
        score: packed[19],
        matchStats: {
            hits: matchStats[0],
            hitsTaken: matchStats[1],
            catches: matchStats[2],
            parries: matchStats[3],
            saves: matchStats[4],
            // Report-card breakdown stats (appended later): tolerate short arrays from an older server.
            throws: matchStats[5] ?? 0,
            directHits: matchStats[6] ?? 0,
            bounceHits: matchStats[7] ?? 0,
            curveHits: matchStats[8] ?? 0,
            backflipHits: matchStats[9] ?? 0
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
            yawRadians: uq4(packed[3]),
            pitchRadians: uq4(packed[4]),
            // Facing slot is a placeholder 0 on the wire — derived from yaw/pitch (see unpackPlayer).
            facing: (0, AimMath_1.facingFromAngles)(uq4(packed[3]), uq4(packed[4])),
            grounded: Boolean(packed[6]),
            crouching: Boolean(packed[7]),
            sliding: Boolean(packed[8]),
            wallRunning: Boolean(packed[9]),
            dashingThisFrame: Boolean(packed[10]),
            speed: uq3(packed[11])
        },
        movementInternal: unpackMovementInternal(packed[12]),
        hands: {
            left: unpackHand('left', hands[0]),
            right: unpackHand('right', hands[1])
        },
        dash: {
            charges: dash[0],
            rechargeTimerSeconds: uq3(dash[1]),
            cooldownSeconds: uq3(dash[2])
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
function unpackMovementInternal(movementInternal) {
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
function packHand(hand) {
    return [
        hand.heldBallId,
        hand.mode,
        pq3(hand.chargeSeconds),
        pq3(hand.cooldownSeconds),
        hand.lastCatchAttemptId
    ];
}
function unpackHand(side, packed) {
    return {
        side,
        heldBallId: packed[0],
        mode: packed[1],
        chargeSeconds: uq3(packed[2]),
        cooldownSeconds: uq3(packed[3]),
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
        pq3(ball.dropScale),
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
        dropScale: uq3(packed[10]),
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
/**
 * Scaled-INTEGER quantizers for the scalar floats in the hot player/ball lanes. Colyseus encodes
 * room messages with msgpack, where any non-integer number costs 9 bytes (float64) but small
 * integers cost 1–3. ×1000 (pq3) / ×10000 (pq4) match the q3/q4 rounding makeLeanSnapshot has
 * always applied, so the DECODED values are identical to before — only the wire bytes shrink.
 * (Math.round(n·s)/s and Math.round(n·s) then /s are the same double.)
 */
function pq3(n) {
    return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}
function uq3(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n / 1000 : 0;
}
function pq4(n) {
    return Number.isFinite(n) ? Math.round(n * 10000) : 0;
}
function uq4(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n / 10000 : 0;
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
function q0(n) {
    return Math.round(n);
}
function q3(n) {
    return Math.round(n * 1000) / 1000;
}
