"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServerGameLoop = void 0;
const constants_1 = require("../../../shared/constants");
const node_perf_hooks_1 = require("node:perf_hooks");
const netConfig_1 = require("../../../shared/netConfig");
const DefenseHistory_1 = require("./DefenseHistory");
const BallSim_1 = require("../../../shared/simulation/BallSim");
const CollisionMath_1 = require("../../../shared/simulation/CollisionMath");
const HandSim_1 = require("../../../shared/simulation/HandSim");
const MatchSim_1 = require("../../../shared/simulation/MatchSim");
const PlayerSim_1 = require("../../../shared/simulation/PlayerSim");
const RuleSim_1 = require("../../../shared/simulation/RuleSim");
const MapGeometry_1 = require("../../../shared/simulation/MapGeometry");
const MovementSim_1 = require("../../../shared/simulation/MovementSim");
const AimMath_1 = require("../../../shared/simulation/AimMath");
const HandAnchors_1 = require("../../../shared/simulation/HandAnchors");
const ThrowMath_1 = require("../../../shared/simulation/ThrowMath");
const PlayerHitbox_1 = require("../../../shared/simulation/PlayerHitbox");
const generatedBattleMusicManifest_1 = require("../../../shared/music/generatedBattleMusicManifest");
const BattleMusic_1 = require("../../../shared/music/BattleMusic");
const EMPTY_THROW_EVENTS = [];
const EMPTY_COMBAT_EVENTS = [];
const SPAWN_BASE_BY_SIDE = {
    negativeZ: { position: (0, CollisionMath_1.vec3)(0, 0, -12), yawRadians: 0 },
    positiveZ: { position: (0, CollisionMath_1.vec3)(0, 0, 12), yawRadians: Math.PI }
};
// Max inputs buffered per player before we drop the oldest. Driven by netConfig so the buffer
// scales with the active tick rate (~1 s of headroom) instead of a hardcoded 30Hz assumption.
const MAX_INPUT_QUEUE = netConfig_1.SERVER_INPUT_QUEUE_LIMIT;
// If no fresh input arrives for this long, the player's input is treated as neutral (so a
// backgrounded/frozen tab doesn't keep walking or charging on the last-held input).
const STALE_INPUT_MS = 1000;
// Default dashDirection for an input whose dashDirection was trimmed from the wire (zero vector).
// MUST be zero, not the previous input, so the sim derives the dash dir from the wish/facing — see
// normalizeInput. Frozen so it can't be mutated by a downstream consumer.
const ZERO_DASH_DIRECTION = Object.freeze((0, CollisionMath_1.vec3)());
const START_VOTE_TTL_MS = constants_1.GAME_CONSTANTS.match.startVoteSeconds * 1000;
const RESET_VOTE_TTL_MS = constants_1.GAME_CONSTANTS.match.resetVoteSeconds * 1000;
const LAST_PLAYER_BUFF_MS = constants_1.GAME_CONSTANTS.match.lastPlayerBuffSeconds * 1000;
class ServerGameLoop {
    tickRate;
    state;
    roomId;
    tickSeconds;
    logger;
    debug;
    matchMode;
    teamIds;
    playersPerTeam;
    maxPlayers;
    teamsRequiredToPlay;
    battleMusicTrackCount;
    playerSlots;
    /** Injectable wall-clock (ms). Defaults to Date.now; overridden by a virtual clock in tests. */
    now;
    // Players AND balls collide with bleachers + STANDING mats; both sets are rebuilt whenever a mat
    // is knocked over so a downed mat becomes walkable AND lets balls pass over it.
    playerCollisionBoxes = (0, MapGeometry_1.createPlayerCollisionBoxes)();
    ballCollisionBoxes = (0, MapGeometry_1.createBallCollisionBoxes)();
    playerCollisionScratch = [];
    ballCollisionScratch = [];
    knockedOverMatIds = new Set();
    // Hold-E mat restore: per-player progress (seconds) toward standing the nearest knocked-over mat
    // back up. Resets when E is released or the player moves out of reach.
    matRestoreHoldByPlayerId = new Map();
    // Brief per-mat grace after a reset so the restoring player can step clear before contact
    // knock-over is allowed again.
    matPostResetKnockImmunityById = new Map();
    static MAT_RESTORE_HOLD_SECONDS = constants_1.GAME_CONSTANTS.mat.restoreHoldSeconds;
    static MAT_RESTORE_REACH = constants_1.GAME_CONSTANTS.mat.restoreReach;
    static MAT_POST_RESET_KNOCK_IMMUNITY_SECONDS = constants_1.GAME_CONSTANTS.mat.postResetKnockImmunitySeconds;
    inputQueueByPlayerId = new Map();
    lastInputByPlayerId = new Map();
    previousInputByPlayerId = new Map();
    lastInputAtByPlayerId = new Map();
    lastProcessedInputAtByPlayerId = new Map();
    lastEnqueuedSeqByPlayerId = new Map();
    inputRttMsByPlayerId = new Map();
    parryCooldownByPlayerId = new Map();
    lastInputDebugAtByPlayerId = new Map();
    playerNetWindowStatsByPlayerId = new Map();
    teamChoicesByPlayerId = new Set();
    startVotesByPlayerId = new Map();
    resetVotesByPlayerId = new Map();
    // Anti "2-ball technique": tracks each player's most recent throw so a second throw landing
    // within `doubleThrowWindowSeconds` of the first gets BOTH balls slowed (see handleThrow).
    lastThrowByPlayerId = new Map();
    resetSerial = 0;
    // Cheap combat counters for the throttled server [perf] report (verify the lag-comp catch fix in
    // production). Plain integers, no allocations; drained + reset each report window by the room.
    combatMetrics = {
        catchAttemptsOpened: 0, // distinct catch clicks accepted
        catches: 0, // catches that landed (present-time OR lag-comp reclaim)
        reclaimCatches: 0, // of those, ones the lag-comp reclaim pass claimed (high-ping saves)
        parries: 0,
        hits: 0,
        hitReverts: 0 // hits undone because a lag-comp catch superseded them
    };
    // Windowed input-drain counters for the throttled [perf] line. These make packet bunching visible
    // without per-tick logging: healthy steady-state is max/avg near 1, backlog drain shows >1.
    inputDrainMetrics = {
        samples: 0,
        inputsDrainedTotal: 0,
        maxInputsDrainedThisTick: 0,
        maxInputQueueBeforeDrain: 0
    };
    // --- Server-authoritative combat (catch attempts + lag-compensated defense) ---
    // Per-player defensive-state history (eye/aim/hands/dashing per tick), rewound to the click
    // moment when validating a catch/parry so a high-ping defender is judged fairly. Capped by age.
    defenseHistoryByPlayerId = new Map();
    // Per-ball position history, used to reconstruct the ball's swept segment around a rewound click.
    ballHistoryById = new Map();
    // Open catch windows per player+hand. A click opens one; it evaluates during its active span,
    // then blocks re-attempts until its cooldown elapses. Keyed `${playerId}:${hand}`.
    catchAttemptByKey = new Map();
    // Highest catch-attempt id consumed per player+hand (dedupe latched re-sends). Keyed as above.
    lastCatchAttemptIdByKey = new Map();
    // De-spam catch trace evaluation lines: one line per player/hand/attempt/ball/reason.
    catchTraceEvalSeen = new Set();
    // Hits applied in the last ~catchHitGraceMs, keyed by ballId. A lag-compensated catch from the
    // hit defender can revert the score if their well-timed catch arrived after the server scored.
    recentHitByBallId = new Map();
    // Monotonic throw identity — assigned to each new live throw/deflect (see BallState.throwId).
    throwCounter = 0;
    // Throw events accepted this step, drained by the room and broadcast before the next snapshot.
    pendingThrowEvents = [];
    // Immediate combat events (catch/parry/hit/revert) queued each step, broadcast before snapshot.
    pendingCombatEvents = [];
    // Wall-clock time of the current step, captured once at the top of step() for history timestamps.
    stepNowMs = 0;
    lastSnapshotBuildMs = 0;
    battleMusicSyncState = (0, BattleMusic_1.createInactiveBattleMusicSyncState)();
    battleMusicSyncDirty = false;
    nextBattleMusicSessionId = 0;
    constructor(roomId, options = {}) {
        this.roomId = roomId;
        this.tickRate = options.tickRate ?? netConfig_1.SERVER_TICK_RATE;
        this.tickSeconds = 1 / this.tickRate;
        this.logger = options.logger ?? (() => undefined);
        this.now = options.now ?? Date.now;
        this.teamIds = options.teamIds?.length ? [...options.teamIds] : [...constants_1.GAME_CONSTANTS.match.teamIds];
        this.playersPerTeam = Math.max(1, Math.trunc(options.playersPerTeam ?? 1));
        this.maxPlayers = this.teamIds.length * this.playersPerTeam;
        this.teamsRequiredToPlay = Math.min(2, this.teamIds.length);
        this.battleMusicTrackCount = Math.max(0, Math.trunc(options.battleMusicTrackCount ?? generatedBattleMusicManifest_1.BATTLE_MUSIC_TRACKS.length));
        this.matchMode = options.mode ?? (this.playersPerTeam >= 2 ? '2v2' : '1v1');
        this.playerSlots = buildPlayerSlots(this.teamIds, this.playersPerTeam);
        // All flags default OFF. The legacy `debugInput` boolean maps to NET_DEBUG for compat; an
        // explicit `debug.NET_DEBUG` (if provided) wins over it.
        this.debug = {
            ...netConfig_1.DEBUG_DEFAULTS,
            NET_DEBUG: options.debug?.NET_DEBUG ?? options.debugInput ?? netConfig_1.DEBUG_DEFAULTS.NET_DEBUG,
            PERF_DEBUG: options.debug?.PERF_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.PERF_DEBUG,
            SOAK_DEBUG: options.debug?.SOAK_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.SOAK_DEBUG,
            BALL_DEBUG: options.debug?.BALL_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.BALL_DEBUG,
            PICKUP_DEBUG: options.debug?.PICKUP_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.PICKUP_DEBUG,
            THROW_DEBUG: options.debug?.THROW_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.THROW_DEBUG,
            COLLISION_DEBUG: options.debug?.COLLISION_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.COLLISION_DEBUG,
            CATCH_DEBUG: options.debug?.CATCH_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.CATCH_DEBUG,
            CATCH_TRACE_DEBUG: options.debug?.CATCH_TRACE_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.CATCH_TRACE_DEBUG,
            PARRY_DEBUG: options.debug?.PARRY_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.PARRY_DEBUG,
            BALL_PREDICT_DEBUG: options.debug?.BALL_PREDICT_DEBUG ?? netConfig_1.DEBUG_DEFAULTS.BALL_PREDICT_DEBUG
        };
        this.state = this.createFreshRoomState();
    }
    addPlayer(playerId, rawName) {
        if (this.playerCount() >= this.maxPlayers)
            return null;
        if (this.state.players[playerId])
            return this.state.players[playerId];
        const slot = this.nextPlayerSlot();
        if (!slot)
            return null;
        const name = sanitizeName(rawName, this.playerCount() + 1);
        // Mid-match late join: a player who joins (fresh sessionId) while a match is already in
        // countdown/playing must NOT enter as a full-lives fighter — otherwise someone can leave after
        // being eliminated and rejoin to "respawn" with a full life count. They join as a spectator
        // (eliminated, 0 lives); the next room reset rebuilds every roster member with full lives, so
        // they fight normally in the following match. (A genuine drop+reconnect keeps its state via the
        // framework's reconnection window and never reaches addPlayer.)
        const matchInProgress = this.state.match.status === 'countdown' || this.state.match.status === 'playing';
        const player = (0, PlayerSim_1.createPlayerState)(playerId, slot.teamId, slot.spawnSide, {
            name,
            spawnSide: slot.spawnSide,
            teamSlotIndex: slot.teamSlotIndex,
            movement: this.spawnMovement(slot),
            ...(matchInProgress
                ? { lives: 0, combatState: 'eliminated', eliminatedAtMs: this.now() }
                : {})
        });
        this.state.players[playerId] = player;
        this.seedInputTracking(playerId, slot.yawRadians);
        this.syncPlayerScores();
        this.reconcilePregameState('join');
        return player;
    }
    removePlayer(playerId) {
        const player = this.state.players[playerId];
        if (!player)
            return;
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
        this.reconcilePregameState('remove');
    }
    /** Mark a player connected/disconnected (drives match pause + the connected flag). */
    setConnected(playerId, connected, reconnectDeadlineAtMs = null) {
        const player = this.state.players[playerId];
        if (!player)
            return;
        if (!connected)
            this.dropAllHeldBalls(player);
        player.connected = connected;
        player.reconnectDeadlineAtMs = connected ? null : reconnectDeadlineAtMs;
        if (connected)
            this.lastInputAtByPlayerId.set(playerId, this.now());
        this.reconcilePregameState(connected ? 'reconnect' : 'disconnect');
    }
    /**
     * Handle a player abandoning (a non-consented leave that didn't reconnect in time). If that leaves
     * only one connected team in an active match, the remaining team wins by forfeit.
     */
    abandon(playerId) {
        const player = this.state.players[playerId];
        if (!player)
            return;
        this.removePlayer(playerId);
        this.resolveForfeitIfNeeded('abandon');
    }
    dispose() {
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
    }
    /** Enqueue a client input. `seq` lets the client reconcile; out-of-order/dupes are ignored. */
    handleInput(playerId, rawInput = {}, seq = 0, rttMs) {
        const player = this.state.players[playerId];
        if (!player)
            return false;
        // Reject inputs from BEFORE the latest room reset. After a reset the client restarts its input
        // sequence at 0, but pre-reset packets (high seq) may still be in flight; if accepted, they bump
        // lastEnqueuedSeq back to a stale-high value and every fresh post-reset input is then dropped as
        // a "duplicate" — freezing the player at spawn. A MISSING resetSerial (undefined) means a legacy
        // client that predates the field and is allowed through; a present value (including 0, the
        // pre-first-reset baseline) is gated strictly against the current timeline.
        if (rawInput.resetSerial !== undefined) {
            const inputResetSerial = Math.max(0, Math.trunc(Number(rawInput.resetSerial) || 0));
            if (inputResetSerial < this.resetSerial) {
                if ((rawInput.leftCatchAttemptId ?? 0) > 0 || (rawInput.rightCatchAttemptId ?? 0) > 0) {
                    this.catchTrace(`input-received player=${playerId} seq=${seq} resetSerial=${inputResetSerial}/${this.resetSerial}` +
                        ` left=${rawInput.leftCatchAttemptId ?? 0} right=${rawInput.rightCatchAttemptId ?? 0} result=drop reason=stale-reset`);
                }
                return true; // stale timeline → drop
            }
        }
        const lastSeq = this.lastEnqueuedSeqByPlayerId.get(playerId) ?? 0;
        const sequence = Number.isFinite(seq) ? seq : 0;
        if (sequence > 0 && sequence <= lastSeq) {
            if ((rawInput.leftCatchAttemptId ?? 0) > 0 || (rawInput.rightCatchAttemptId ?? 0) > 0) {
                this.catchTrace(`input-received player=${playerId} seq=${sequence} lastSeq=${lastSeq}` +
                    ` left=${rawInput.leftCatchAttemptId ?? 0} right=${rawInput.rightCatchAttemptId ?? 0} result=drop reason=stale-seq`);
            }
            return true; // stale/duplicate
        }
        if (sequence > 0)
            this.lastEnqueuedSeqByPlayerId.set(playerId, sequence);
        this.updateInputRttEstimate(playerId, rttMs);
        const fallback = this.lastInputByPlayerId.get(playerId);
        const input = normalizeInput({ ...rawInput, sequence }, fallback);
        if (input.leftCatchAttemptId > 0 || input.rightCatchAttemptId > 0) {
            this.catchTrace(`input-received player=${playerId} seq=${sequence || lastSeq} resetSerial=${input.resetSerial}` +
                ` left=${input.leftCatchAttemptId} right=${input.rightCatchAttemptId}` +
                ` clientTimeMs=${Math.round(input.clientTimeMs)} queueBefore=${this.inputQueueByPlayerId.get(playerId)?.length ?? 0}`);
        }
        this.lastInputByPlayerId.set(playerId, input);
        this.lastInputAtByPlayerId.set(playerId, this.now());
        const queue = this.inputQueueByPlayerId.get(playerId) ?? [];
        queue.push({ seq: sequence || lastSeq, input });
        while (queue.length > MAX_INPUT_QUEUE)
            queue.shift();
        this.inputQueueByPlayerId.set(playerId, queue);
        return true;
    }
    updateInputRttEstimate(playerId, rttMs) {
        if (typeof rttMs !== 'number' || !Number.isFinite(rttMs))
            return;
        const clamped = (0, CollisionMath_1.clamp)(rttMs, 0, constants_1.GAME_CONSTANTS.combat.catchMaxRttMs);
        const previous = this.inputRttMsByPlayerId.get(playerId);
        this.inputRttMsByPlayerId.set(playerId, previous === undefined ? clamped : previous * 0.85 + clamped * 0.15);
    }
    catchRewindMsForPlayer(playerId) {
        const rttMs = this.inputRttMsByPlayerId.get(playerId) ?? constants_1.GAME_CONSTANTS.combat.catchDefaultRttMs;
        const raw = constants_1.GAME_CONSTANTS.combat.catchRewindMs + (rttMs - constants_1.GAME_CONSTANTS.combat.catchDefaultRttMs);
        return (0, CollisionMath_1.clamp)(raw, constants_1.GAME_CONSTANTS.combat.defenseInputGraceMs, constants_1.GAME_CONSTANTS.combat.defenseMaxRewindMs);
    }
    catchTrace(message) {
        if (!this.debug.CATCH_TRACE_DEBUG && !this.debug.CATCH_DEBUG)
            return;
        this.logger(`[catch/trace] ${message}`);
    }
    handlePickup(playerId) {
        const player = this.state.players[playerId];
        if (!player)
            return { ok: false, reason: 'unknown-player' };
        if (!this.isPlayerAlive(player))
            return { ok: false, reason: 'eliminated' };
        const pp = player.movement.position;
        const allBalls = Object.values(this.state.balls);
        const candidates = allBalls
            .map((ball) => ({ ball, distance: (0, CollisionMath_1.distance)(ball.position, pp) }))
            .sort((a, b) => a.distance - b.distance);
        if (this.debug.PICKUP_DEBUG) {
            this.logger(`pickup attempt player=${playerId} pos=(${pp.x.toFixed(2)},${pp.y.toFixed(2)},${pp.z.toFixed(2)}) balls=${allBalls.length}`);
            for (const { ball, distance: dist } of candidates.slice(0, 4)) {
                this.logger(`  ball=${ball.id} phase=${ball.phase} owner=${ball.ownerId ?? 'none'}` +
                    ` pos=(${ball.position.x.toFixed(2)},${ball.position.y.toFixed(2)},${ball.position.z.toFixed(2)})` +
                    ` dist=${dist.toFixed(2)} pickupRadius=${constants_1.GAME_CONSTANTS.ball.pickupRadius}`);
            }
        }
        for (const { ball } of candidates) {
            const result = (0, HandSim_1.tryPickupBall)(player, player.hands, ball);
            if (!result.ok)
                continue;
            this.state.players[playerId] = { ...player, hands: result.hands };
            this.state.balls[ball.id] = result.ball;
            return { ok: true, log: `pickup accepted player=${playerId} ball=${ball.id} hand=${result.hand}` };
        }
        return { ok: false, reason: (0, HandSim_1.heldBallCount)(player.hands) >= constants_1.GAME_CONSTANTS.ball.maxHeldBalls ? 'hands-full' : 'no-pickup-candidate' };
    }
    handleDrop(playerId, requestedHand) {
        const player = this.state.players[playerId];
        if (!player)
            return { ok: false, reason: 'unknown-player' };
        if (!this.isPlayerAlive(player))
            return { ok: false, reason: 'eliminated' };
        const hand = requestedHand ?? preferredDropHand(player);
        if (!hand)
            return { ok: false, reason: 'empty-hands' };
        const ballId = player.hands[hand].heldBallId;
        if (!ballId)
            return { ok: false, reason: 'empty-hand' };
        const ball = this.state.balls[ballId];
        if (!ball)
            return { ok: false, reason: 'missing-ball' };
        const result = (0, HandSim_1.dropBallFromHand)(player.hands, hand, ball, heldBallPosition(player, hand), dropReleaseVelocity(player.movement.velocity));
        if (!result.ok)
            return result;
        this.state.players[playerId] = { ...player, hands: result.hands };
        this.state.balls[ball.id] = result.ball;
        return { ok: true };
    }
    handleThrow(playerId, request) {
        const player = this.state.players[playerId];
        if (!player)
            return { ok: false, reason: 'unknown-player' };
        if (!this.isPlayerAlive(player))
            return { ok: false, reason: 'eliminated' };
        if (!request.hand)
            return { ok: false, reason: 'missing-hand' };
        const ballId = player.hands[request.hand].heldBallId;
        if (!ballId)
            return { ok: false, reason: 'empty-hand' };
        const ball = this.state.balls[ballId];
        if (!ball)
            return { ok: false, reason: 'missing-ball' };
        // Charge is taken from the SERVER-tracked hand state, never trusted from the client (#7).
        const handState = player.hands[request.hand];
        const charge01 = handState.mode === 'charging'
            ? (0, CollisionMath_1.clamp)(handState.chargeSeconds / constants_1.GAME_CONSTANTS.ball.maxChargeSeconds, 0, 1)
            : 0;
        // Direction is the SERVER's known facing (derived from validated look angles), so a client
        // can't throw anywhere but where it is actually aiming (#7 — anti-aimbot).
        const forward = (0, CollisionMath_1.normalize)(player.movement.facing, (0, MovementSim_1.facingFromAngles)(player.movement.yawRadians, player.movement.pitchRadians));
        // Backflip landing throw: the client reports the QTE success tier (1..5). The server only honors
        // it when the throw genuinely follows a backflip — the player must be grounded AND have flipped
        // recently (cooldown still high). This bounds abuse: a client can't claim a backflip throw it
        // didn't earn. A valid tier sets the speed (tier 1 = quick, top tier = fastest) and marks super.
        // The QTE is landing-only, so a wall-running player can never be mid-QTE here.
        const backflipTier = (0, CollisionMath_1.clamp)(Math.trunc(request.backflipTier ?? 0), 0, constants_1.GAME_CONSTANTS.backflip.qte.tierCount);
        const backflipRecent = player.movementInternal.backflipCooldown >
            constants_1.GAME_CONSTANTS.backflip.cooldownSeconds - (constants_1.GAME_CONSTANTS.backflip.durationSeconds + constants_1.GAME_CONSTANTS.backflip.qte.durationSeconds + 0.3);
        const isBackflipThrow = backflipTier >= 1 && player.movement.grounded && backflipRecent;
        const origin = (0, CollisionMath_1.add)((0, HandAnchors_1.computePlayerHandAnchor)(player, request.hand), (0, CollisionMath_1.scale)(forward, 0.16));
        // Anti "2-ball technique": a second throw landing within doubleThrowWindowSeconds of this
        // player's previous throw slows BOTH balls down, instead of only the new client-side throw.
        const now = this.now();
        const priorThrow = this.lastThrowByPlayerId.get(playerId);
        const isDoubleThrow = !!priorThrow && (now - priorThrow.atMs) <= constants_1.GAME_CONSTANTS.ball.doubleThrowWindowSeconds * 1000;
        if (isDoubleThrow && priorThrow) {
            const priorBall = this.state.balls[priorThrow.ballId];
            if (priorBall && priorBall.phase === 'live' && priorBall.ownerId === playerId) {
                this.state.balls[priorBall.id] = {
                    ...priorBall,
                    velocity: (0, CollisionMath_1.scale)(priorBall.velocity, constants_1.GAME_CONSTANTS.ball.doubleThrowSpeedPenalty)
                };
            }
        }
        // Deterministic crouch-curve (Phase 6): curves perpendicular to AIM (not world axes), opposite
        // the throwing hand. Server-computed so the client can replay the exact same curve for prediction.
        const throwCalc = (0, ThrowMath_1.calculateThrow)({
            hand: request.hand,
            forward,
            playerVelocity: player.movement.velocity,
            charge01,
            crouching: player.movement.crouching || player.movement.sliding,
            backflipTier: isBackflipThrow ? backflipTier : 0
        });
        const { velocity: rawVelocity, curveAccel, dropScale, isSuper } = throwCalc;
        const velocity = isDoubleThrow ? (0, CollisionMath_1.scale)(rawVelocity, constants_1.GAME_CONSTANTS.ball.doubleThrowSpeedPenalty) : rawVelocity;
        // Fresh throw identity — assigned here so it lands on the live ball AND the throw event together.
        this.throwCounter += 1;
        const throwId = this.throwCounter;
        const result = (0, HandSim_1.throwBallFromHand)(player, player.hands, request.hand, ball, {
            origin,
            velocity,
            isSuper,
            dropScale,
            curveAccel,
            throwId
        });
        if (!result.ok)
            return result;
        this.lastThrowByPlayerId.set(playerId, { atMs: now, ballId: ball.id });
        const dash = isBackflipThrow && backflipTier === constants_1.GAME_CONSTANTS.backflip.qte.tierCount
            ? (0, PlayerSim_1.grantDashCharge)(player.dash)
            : player.dash;
        this.state.players[playerId] = { ...player, hands: result.hands, dash };
        this.state.balls[ball.id] = result.ball;
        // Attach backflip tier to the ball state for defensive logic
        this.state.balls[ball.id].backflipTier = isBackflipThrow ? backflipTier : 0;
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
            origin: (0, CollisionMath_1.cloneVec3)(origin),
            velocity: (0, CollisionMath_1.cloneVec3)(velocity),
            curveAccel: (0, CollisionMath_1.cloneVec3)(curveAccel),
            dropScale,
            isSuper,
            isCurve: (0, ThrowMath_1.isCurveThrow)(curveAccel),
            charge01,
            resetSerial: this.resetSerial
        });
        if (this.debug.THROW_DEBUG) {
            this.logger(`throw accepted player=${playerId} ball=${ball.id} hand=${request.hand} throwId=${throwId}` +
                ` charge=${charge01.toFixed(2)} crouchCurve=${Number(player.movement.crouching || player.movement.sliding)} super=${Number(isSuper)}` +
                ` yaw=${player.movement.yawRadians.toFixed(3)} pitch=${player.movement.pitchRadians.toFixed(3)}` +
                ` origin=(${origin.x.toFixed(2)},${origin.y.toFixed(2)},${origin.z.toFixed(2)})` +
                ` vel=(${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)})` +
                ` curve=(${curveAccel.x.toFixed(2)},${curveAccel.y.toFixed(2)},${curveAccel.z.toFixed(2)})`);
        }
        return { ok: true, log: `throw accepted player=${playerId} ball=${ball.id} hand=${request.hand} charge=${charge01.toFixed(2)}${isSuper ? ' SUPER' : ''}` };
    }
    /**
     * Legacy discrete catch/parry request. Catch is now driven by the input-stream attempt model
     * (ingestCatchAttempts) and parry is automatic (tryAutoParry), both resolved server-side in the
     * live-ball tick. A client click also opens an attempt locally, so this message is a harmless
     * no-op kept only so older clients don't get a hard rejection. Returns ok without doing anything.
     */
    handleCatchParry(_playerId) {
        return { ok: true };
    }
    handleReset(playerId, mode = 'same-teams') {
        if (!this.state.players[playerId])
            return { ok: false, reason: 'unknown-player' };
        if (mode === 'reset-teams' && this.matchMode !== '2v2')
            return { ok: false, reason: 'unsupported-mode' };
        this.pruneResetVotes(this.now());
        if (this.state.resetVote.mode !== mode && this.resetVotesByPlayerId.size > 0) {
            this.resetVotesByPlayerId.clear();
        }
        this.resetVotesByPlayerId.set(playerId, this.now() + RESET_VOTE_TTL_MS);
        this.syncResetVoteState(mode);
        const vote = this.state.resetVote;
        if (this.debug.NET_DEBUG)
            this.logger(`reset vote player=${playerId} mode=${mode} votes=${vote.voteCount}/${vote.requiredVotes}`);
        if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes) {
            this.performRoomReset(playerId, mode);
            return { ok: true, log: `room reset approved player=${playerId} mode=${mode}` };
        }
        return { ok: true, log: `reset vote pending player=${playerId} mode=${mode} votes=${vote.voteCount}/${vote.requiredVotes}` };
    }
    handleStartVote(playerId) {
        const player = this.state.players[playerId];
        if (!player)
            return { ok: false, reason: 'unknown-player' };
        if (this.matchMode !== '2v2')
            return { ok: false, reason: 'unsupported-mode' };
        if (this.state.match.status !== 'warmup')
            return { ok: false, reason: 'match-already-started' };
        if (!this.allConnectedPlayersChoseTeams())
            return { ok: false, reason: 'teams-not-chosen' };
        if (!this.canVoteStart())
            return { ok: false, reason: 'start-not-available' };
        this.pruneStartVotes(this.now());
        this.startVotesByPlayerId.set(playerId, this.now() + START_VOTE_TTL_MS);
        this.syncStartVoteState();
        const vote = this.state.startVote;
        if (this.debug.NET_DEBUG)
            this.logger(`start vote player=${playerId} votes=${vote.voteCount}/${vote.requiredVotes}`);
        if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes) {
            this.beginPregameCountdown('vote');
            return { ok: true, log: `start vote approved player=${playerId}` };
        }
        return { ok: true, log: `start vote pending player=${playerId} votes=${vote.voteCount}/${vote.requiredVotes}` };
    }
    handleTeamSwitch(playerId, targetTeamId, requestedSlotIndex) {
        const player = this.state.players[playerId];
        if (!player)
            return { ok: false, reason: 'unknown-player' };
        if (this.matchMode !== '2v2')
            return { ok: false, reason: 'unsupported-mode' };
        if (this.state.match.status !== 'warmup')
            return { ok: false, reason: 'teams-locked' };
        if (!this.teamIds.includes(targetTeamId))
            return { ok: false, reason: 'invalid-team' };
        const currentSlot = this.slotForPlayer(player);
        if (currentSlot.teamId === targetTeamId &&
            (requestedSlotIndex === undefined || requestedSlotIndex === currentSlot.teamSlotIndex)) {
            const wasChosen = this.teamChoicesByPlayerId.has(player.id);
            this.teamChoicesByPlayerId.add(player.id);
            if (wasChosen) {
                this.syncStartVoteState();
            }
            else {
                this.clearVotesForPregameChange();
            }
            return { ok: true, log: `team confirmed player=${playerId} team=${currentSlot.teamId} slot=${currentSlot.teamSlotIndex + 1}` };
        }
        const slot = this.resolveRequestedSlot(targetTeamId, requestedSlotIndex);
        if (!slot)
            return { ok: false, reason: 'invalid-slot' };
        const occupant = Object.values(this.state.players).find((candidate) => candidate.id !== playerId &&
            candidate.teamId === slot.teamId &&
            candidate.teamSlotIndex === slot.teamSlotIndex);
        const sourceSlot = currentSlot;
        if (occupant) {
            this.dropAllHeldBalls(occupant);
            occupant.teamId = sourceSlot.teamId;
            occupant.spawnSide = sourceSlot.spawnSide;
            occupant.legalHalf = sourceSlot.spawnSide;
            occupant.teamSlotIndex = sourceSlot.teamSlotIndex;
            occupant.movement = this.spawnMovement(sourceSlot);
            occupant.movementInternal = (0, PlayerSim_1.createMovementInternalState)();
            occupant.hands = (0, HandSim_1.createHands)();
            occupant.dash = (0, PlayerSim_1.createDashState)();
            occupant.lastPlayerBuffUntilMs = null;
            this.seedInputTracking(occupant.id, sourceSlot.yawRadians);
        }
        this.dropAllHeldBalls(player);
        player.teamId = slot.teamId;
        player.spawnSide = slot.spawnSide;
        player.legalHalf = slot.spawnSide;
        player.teamSlotIndex = slot.teamSlotIndex;
        player.movement = this.spawnMovement(slot);
        player.movementInternal = (0, PlayerSim_1.createMovementInternalState)();
        player.hands = (0, HandSim_1.createHands)();
        player.dash = (0, PlayerSim_1.createDashState)();
        player.lastPlayerBuffUntilMs = null;
        this.seedInputTracking(player.id, slot.yawRadians);
        this.teamChoicesByPlayerId.add(player.id);
        if (occupant)
            this.teamChoicesByPlayerId.add(occupant.id);
        this.clearVotesForPregameChange();
        this.syncPlayerScores();
        return { ok: true, log: `team switch player=${playerId} team=${slot.teamId} slot=${slot.teamSlotIndex + 1}` };
    }
    step() {
        this.advance();
        return this.snapshot();
    }
    advance() {
        const fixedDt = this.tickSeconds;
        const previousMatchStatus = this.state.match.status;
        this.state.tick += 1;
        // One wall-clock read per step, reused for all history timestamps + attempt windows so every
        // sample/attempt in this tick shares a consistent "now".
        this.stepNowMs = this.now();
        this.pruneExpiredReconnects(this.stepNowMs);
        this.pruneStartVotes(this.stepNowMs);
        this.pruneResetVotes(this.stepNowMs);
        this.tickMatPostResetKnockImmunity(fixedDt);
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
            this.updateMatRestoreForPlayer(player, command.input, fixedDt);
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
        this.syncBattleMusicForMatchTransition(previousMatchStatus, this.stepNowMs);
    }
    /** Tick the pre-round countdown timer; flip to 'playing' once it reaches 0. */
    advanceCountdown(dt) {
        if (this.state.match.status !== 'countdown')
            return;
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
    updatePlayerLookOnly(player, input, seq) {
        const spawn = this.slotForPlayer(player);
        player.movement = {
            ...player.movement,
            position: { ...spawn.position },
            velocity: (0, CollisionMath_1.vec3)(),
            yawRadians: input.lookYawRadians,
            pitchRadians: input.lookPitchRadians,
            facing: (0, MovementSim_1.facingFromAngles)(input.lookYawRadians, input.lookPitchRadians),
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
    updateEliminatedPlayer(player, input, seq) {
        player.movement = {
            ...player.movement,
            velocity: (0, CollisionMath_1.vec3)(),
            yawRadians: input.lookYawRadians,
            pitchRadians: input.lookPitchRadians,
            facing: (0, MovementSim_1.facingFromAngles)(input.lookYawRadians, input.lookPitchRadians),
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
    drainCombatMetrics() {
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
    drainThrowEvents() {
        if (this.pendingThrowEvents.length === 0)
            return EMPTY_THROW_EVENTS;
        const events = this.pendingThrowEvents;
        this.pendingThrowEvents = [];
        return events;
    }
    /** Drain immediate combat events accepted since the last drain (room broadcasts them). */
    drainCombatEvents() {
        if (this.pendingCombatEvents.length === 0)
            return EMPTY_COMBAT_EVENTS;
        const events = this.pendingCombatEvents;
        this.pendingCombatEvents = [];
        return events;
    }
    getBattleMusicSyncState() {
        return this.battleMusicSyncState;
    }
    drainBattleMusicSyncDirty() {
        if (!this.battleMusicSyncDirty)
            return null;
        this.battleMusicSyncDirty = false;
        return this.battleMusicSyncState;
    }
    getLastSnapshotBuildMs() {
        return this.lastSnapshotBuildMs;
    }
    historyMaxSamples() {
        return Math.max(16, Math.ceil(this.tickRate * ((constants_1.GAME_CONSTANTS.combat.defenseHistoryMs / 1000) + 0.25)));
    }
    getDebugBufferStats() {
        let inputQueues = 0;
        let maxInputQueue = 0;
        for (const queue of this.inputQueueByPlayerId.values()) {
            inputQueues += queue.length;
            if (queue.length > maxInputQueue)
                maxInputQueue = queue.length;
        }
        let defenseHistoryEntries = 0;
        let maxDefenseHistoryEntries = 0;
        for (const ring of this.defenseHistoryByPlayerId.values()) {
            defenseHistoryEntries += ring.size;
            if (ring.size > maxDefenseHistoryEntries)
                maxDefenseHistoryEntries = ring.size;
        }
        let ballHistoryEntries = 0;
        let maxBallHistoryEntries = 0;
        for (const ring of this.ballHistoryById.values()) {
            ballHistoryEntries += ring.size;
            if (ring.size > maxBallHistoryEntries)
                maxBallHistoryEntries = ring.size;
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
    drainPlayerNetworkStats(nowMs = this.now()) {
        const players = Object.values(this.state.players);
        const stats = players.map((player) => {
            const window = this.playerNetWindowStatsByPlayerId.get(player.id);
            const queueDepthCurrent = this.inputQueueByPlayerId.get(player.id)?.length ?? 0;
            const lastInputAt = this.lastInputAtByPlayerId.get(player.id) ?? nowMs;
            const lastProcessedAt = this.lastProcessedInputAtByPlayerId.get(player.id);
            return {
                playerId: player.id,
                lastProcessedInputSeq: player.lastProcessedInputSeq,
                lastEnqueuedInputSeq: this.lastEnqueuedSeqByPlayerId.get(player.id) ?? 0,
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
            };
        });
        this.playerNetWindowStatsByPlayerId.clear();
        return stats;
    }
    snapshot() {
        const startedAt = node_perf_hooks_1.performance.now();
        // No deep clone (#17): Colyseus serializes the message when broadcasting, so each client
        // already gets its own copy over the wire — cloning here just burned GC every tick.
        const snapshot = {
            type: 'snapshot',
            tick: this.state.tick,
            serverTimeMs: this.now(),
            room: this.state
        };
        this.lastSnapshotBuildMs = node_perf_hooks_1.performance.now() - startedAt;
        return snapshot;
    }
    playerNetWindowStats(playerId) {
        let stats = this.playerNetWindowStatsByPlayerId.get(playerId);
        if (!stats) {
            stats = {
                inputQueueDepthTotal: 0,
                inputQueueDepthSamples: 0,
                inputQueueDepthMax: 0,
                inputsDrainedTotal: 0,
                inputsDrainedSamples: 0,
                inputsDrainedMax: 0
            };
            this.playerNetWindowStatsByPlayerId.set(playerId, stats);
        }
        return stats;
    }
    recordProcessedInputSeq(player, seq) {
        if (seq !== player.lastProcessedInputSeq)
            this.lastProcessedInputAtByPlayerId.set(player.id, this.stepNowMs || this.now());
        player.lastProcessedInputSeq = seq;
    }
    updatePlayer(player, dt, input, seq) {
        const prevInput = this.previousInputByPlayerId.get(player.id) ?? defaultInput(player.movement.yawRadians);
        const catchStanceActive = computeCatchStance(player.hands, input);
        const preVelocity = player.movement.velocity;
        const preGrounded = player.movement.grounded;
        const result = (0, MovementSim_1.stepMovement)(player.movement, player.movementInternal, player.dash, input, prevInput, dt, this.collisionBoxesForPlayer(player.id), catchStanceActive, constants_1.GAME_CONSTANTS, this.playerMovementScale(player), this.playerCooldownRateScale(player));
        player.movement = result.movement;
        player.movementInternal = result.internal;
        player.dash = result.dash;
        player.hands = updateHandCharging(player.hands, input, prevInput);
        player.hands = (0, HandSim_1.tickHands)(player.hands, dt);
        this.recordProcessedInputSeq(player, seq);
        // Open any fresh catch attempts carried by this input (latched ids; dedup by last-processed).
        this.ingestCatchAttempts(player, input);
        if (input.dropPressed) {
            const result = this.handleDrop(player.id);
            if (!result.ok && this.debug.NET_DEBUG)
                this.logger(`drop rejected player=${player.id} reason=${result.reason}`);
        }
        if (input.pickupPressed) {
            const result = this.handlePickup(player.id);
            if (this.debug.PICKUP_DEBUG) {
                if (!result.ok) {
                    this.logger(`pickup rejected player=${player.id} reason=${result.reason}`);
                }
                else if (result.log) {
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
    handleInputThrows(playerId, input) {
        if (input.fakeThrowPressed || input.fakeThrowHeld)
            return;
        const tier = input.backflipThrowTier;
        if (input.leftHandReleased)
            this.handleInputThrow(playerId, 'left', tier);
        if (input.rightHandReleased)
            this.handleInputThrow(playerId, 'right', tier);
    }
    handleInputThrow(playerId, hand, backflipTier = 0) {
        const player = this.state.players[playerId];
        // A normal throw requires a charging hand. A backflip QTE throw is released by the landing event
        // (not a charge), so it fires from a holding hand too — handleThrow re-validates the backflip.
        if (!player)
            return;
        const mode = player.hands[hand].mode;
        if (mode !== 'charging' && !(backflipTier >= 1 && mode === 'holding'))
            return;
        const result = this.handleThrow(playerId, { hand, backflipTier });
        if (!result.ok && this.debug.THROW_DEBUG) {
            this.logger(`throw rejected player=${playerId} hand=${hand} reason=${result.reason}`);
        }
    }
    logInputDebug(playerId, input, preVelocity, preGrounded, postMovement) {
        if (!this.debug.NET_DEBUG)
            return;
        const now = this.now();
        const previous = this.lastInputDebugAtByPlayerId.get(playerId) ?? 0;
        // Always log when an edge-triggered action fires so they are never hidden by throttle.
        const hasEdge = input.jumpPressed || input.dashPressed || input.slidePressed ||
            input.backflipPressed || input.pickupPressed || input.dropPressed;
        if (!hasEdge && now - previous < 500)
            return;
        this.lastInputDebugAtByPlayerId.set(playerId, now);
        const pv = preVelocity;
        const mv = postMovement.velocity;
        this.logger(`input player=${playerId} seq=${input.sequence}` +
            ` move=(${input.moveX.toFixed(2)},${input.moveZ.toFixed(2)})` +
            ` jump=${Number(input.jumpPressed)}/${Number(input.jumpHeld)}` +
            ` dash=${Number(input.dashPressed)} slide=${Number(input.slidePressed)}` +
            ` crouch=${Number(input.crouchHeld)} backflip=${Number(input.backflipPressed)}` +
            ` pickup=${Number(input.pickupPressed)} drop=${Number(input.dropPressed)}` +
            ` yaw=${input.lookYawRadians.toFixed(2)} pitch=${input.lookPitchRadians.toFixed(2)}` +
            ` storedYaw=${postMovement.yawRadians.toFixed(2)} storedPitch=${postMovement.pitchRadians.toFixed(2)}` +
            ` facing=(${postMovement.facing.x.toFixed(2)},${postMovement.facing.y.toFixed(2)},${postMovement.facing.z.toFixed(2)})`);
        this.logger(`veloc player=${playerId}` +
            ` pre=(${pv.x.toFixed(2)},${pv.y.toFixed(2)},${pv.z.toFixed(2)}) grounded=${preGrounded}` +
            ` post=(${mv.x.toFixed(2)},${mv.y.toFixed(2)},${mv.z.toFixed(2)}) grounded=${postMovement.grounded}` +
            ` sliding=${postMovement.sliding} speed=${postMovement.speed.toFixed(2)}`);
    }
    /**
     * Advance balls and resolve live-ball combat with the correct interaction order (Phase 8/9):
     *   1. preserve previous position  2. move ball  3. build swept segment
     *   4. auto-parry  5. catch  6. hit  7. world collision/bounce/settle.
     * Parry/catch/hit each consume the ball — once one fires, later checks skip it that tick, so a
     * valid defense can never be bypassed by hit detection running first.
     */
    updateBalls(dt, combatActive) {
        const subDt = dt / netConfig_1.LIVE_BALL_COMBAT_SUBSTEPS;
        for (const ballId in this.state.balls) {
            const ball = this.state.balls[ballId];
            if (ball.phase === 'held' && ball.heldByPlayerId && ball.heldHand) {
                const owner = this.state.players[ball.heldByPlayerId];
                this.state.balls[ball.id] = owner
                    ? { ...ball, position: heldBallPosition(owner, ball.heldHand), velocity: (0, CollisionMath_1.vec3)() }
                    : (0, BallSim_1.markBallDead)(ball);
                continue;
            }
            if (ball.phase === 'loose')
                continue;
            // Run LIVE_BALL_COMBAT_SUBSTEPS sub-steps per tick. Each sub-step advances the ball by
            // subDt, then runs the full parry→catch→hit pipeline against that sub-tick swept segment.
            // At 128Hz × 2 substeps = 256Hz effective live-ball combat checks — fast balls that would
            // tunnel through catch/hit range between two 128Hz ticks are still caught/registered.
            let current = ball;
            let combatDone = false;
            for (let sub = 0; sub < netConfig_1.LIVE_BALL_COMBAT_SUBSTEPS && !combatDone; sub++) {
                const prevPos = (0, CollisionMath_1.cloneVec3)(current.position);
                const advanced = (0, BallSim_1.advanceBall)(current, subDt);
                let resolved = advanced;
                if (combatActive && (0, BallSim_1.isBallCatchableInFlight)(resolved)) {
                    const segPrev = prevPos;
                    const segCurr = resolved.position;
                    const parried = this.tryAutoParry(resolved, segPrev, segCurr, subDt, this.stepNowMs);
                    if (parried) {
                        resolved = parried;
                        // Deflected ball stays in flight — continue remaining substeps.
                    }
                    else {
                        const caught = this.tryCatchAttempts(resolved, segPrev, segCurr, subDt, this.stepNowMs);
                        if (caught) {
                            resolved = caught;
                            combatDone = true;
                        }
                        else {
                            const friendlyDeflect = this.tryFriendlyDeflect(resolved, segPrev, segCurr);
                            if (friendlyDeflect) {
                                resolved = friendlyDeflect;
                            }
                            const hit = this.tryHit(resolved, segPrev, segCurr);
                            if (hit) {
                                resolved = hit;
                                combatDone = true;
                            }
                        }
                    }
                }
                // World collision per substep so fast balls bounce correctly at sub-tick positions.
                const bounded = resolveBallBounds(resolved);
                const collided = resolveBallStaticBoxes(bounded, this.ballCollisionBoxesWithEliminatedCover(), this.debug.COLLISION_DEBUG ? this.logger : undefined);
                current = (0, BallSim_1.settleBallIfSlow)(collided);
                if (!combatDone &&
                    (current.phase === 'loose' || (current.phase === 'dead' && !(0, BallSim_1.isBallCatchableInFlight)(current)))) {
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
    tryHit(ball, segPrev, segCurr) {
        if (!canScorePlayerHit(ball))
            return null;
        const ownerId = ball.ownerId;
        if (!ownerId)
            return null;
        const scorer = this.state.players[ownerId];
        if (!scorer)
            return null;
        const radius = (0, PlayerHitbox_1.playerBallHitRadius)();
        const radiusSq = radius * radius;
        for (const targetId in this.state.players) {
            const target = this.state.players[targetId];
            if (targetId === ownerId)
                continue;
            if (!this.isPlayerActiveFighter(target))
                continue;
            if (!this.isOpponent(scorer, target))
                continue;
            if (horizontalDistanceSqToSegment(target.movement.position, segPrev, segCurr) > radiusSq)
                continue;
            const hitbox = (0, PlayerHitbox_1.playerHitCapsule)(target);
            if (!(0, CollisionMath_1.sweptBallHitsBody)(segPrev, segCurr, hitbox.base, hitbox.top, radius))
                continue;
            const backflipTier = Math.max(0, Math.trunc(ball.backflipTier ?? 0));
            const breaksParryGuard = backflipTier >= 3 && (0, HandSim_1.heldBallCount)(target.hands) >= constants_1.GAME_CONSTANTS.ball.maxHeldBalls;
            if (breaksParryGuard) {
                this.scatterHeldBalls(target);
                // Nice/Great (tiers 3/4) only shatter the defender's two-ball guard. Only a Perfect (tier 5)
                // is allowed to continue through the guard and register the player hit as well.
                if (backflipTier < constants_1.GAME_CONSTANTS.backflip.qte.tierCount) {
                    return (0, BallSim_1.markBallDead)(ball);
                }
            }
            const previousScore = scorer ? this.state.match.scoreByTeamId[scorer.teamId] ?? 0 : 0;
            const previousWinner = this.state.match.winnerTeamId;
            // Capture the thrower's pre-hit dash so a lag-comp catch that supersedes this hit can restore
            // it (registerPlayerHit grants the scorer a dash charge).
            const throwerDashBefore = scorer ? { ...scorer.dash } : null;
            const dead = (0, BallSim_1.markBallDead)(ball);
            const recentHit = scorer && throwerDashBefore
                ? this.applyPlayerHit(ownerId, target, throwerDashBefore)
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
                if (nextScore !== previousScore)
                    this.logger(`score changed team=${scorer?.teamId ?? 'unknown'} score=${nextScore}`);
                if (!previousWinner && this.state.match.winnerTeamId)
                    this.logger(`match ended winner=${this.state.match.winnerTeamId}`);
            }
            return dead;
        }
        return null;
    }
    tryFriendlyDeflect(ball, segPrev, segCurr) {
        if (ball.phase !== 'live' || ball.ownerKind !== 'player' || !ball.ownerId)
            return null;
        const owner = this.state.players[ball.ownerId];
        if (!owner)
            return null;
        const radius = (0, PlayerHitbox_1.playerBallHitRadius)();
        const radiusSq = radius * radius;
        for (const targetId in this.state.players) {
            const target = this.state.players[targetId];
            if (target.id === owner.id)
                continue;
            if (!this.isPlayerActiveFighter(target))
                continue;
            if (!this.isSameTeam(owner, target))
                continue;
            if (horizontalDistanceSqToSegment(target.movement.position, segPrev, segCurr) > radiusSq)
                continue;
            const hitbox = (0, PlayerHitbox_1.playerHitCapsule)(target);
            if (!(0, CollisionMath_1.sweptBallHitsBody)(segPrev, segCurr, hitbox.base, hitbox.top, radius))
                continue;
            const away = (0, CollisionMath_1.normalize)((0, CollisionMath_1.vec3)(segCurr.x - target.movement.position.x, 0.15, segCurr.z - target.movement.position.z), (0, CollisionMath_1.normalize)((0, CollisionMath_1.scale)(ball.velocity, -1), target.movement.facing));
            this.throwCounter += 1;
            const deflected = (0, BallSim_1.deflectBall)(ball, target.id, away, constants_1.GAME_CONSTANTS, this.throwCounter);
            this.state.balls[ball.id] = deflected;
            if (this.debug.NET_DEBUG)
                this.logger(`friendly deflect player=${target.id} ball=${ball.id} owner=${owner.id}`);
            return deflected;
        }
        return null;
    }
    applyPlayerHit(throwerId, target, throwerDashBefore) {
        const scorer = this.state.players[throwerId];
        if (!scorer)
            return null;
        if (this.state.match.mode !== '2v2') {
            this.state = (0, MatchSim_1.registerPlayerHit)(this.state, throwerId);
            this.adjustPlayerMatchStat(throwerId, 'hits', 1);
            this.adjustPlayerMatchStat(target.id, 'hitsTaken', 1);
            return {
                kind: 'score',
                throwerTeamId: scorer.teamId,
                value: 1,
                throwerDashBefore
            };
        }
        const targetLive = this.state.players[target.id];
        if (!targetLive || !this.isPlayerAlive(targetLive))
            return null;
        const defenderLivesBefore = targetLive.lives;
        const defenderCombatStateBefore = targetLive.combatState;
        const defenderEliminatedAtMsBefore = targetLive.eliminatedAtMs;
        const matchStatusBefore = this.state.match.status;
        const winnerTeamIdBefore = this.state.match.winnerTeamId;
        this.state.players[throwerId] = { ...scorer, dash: (0, PlayerSim_1.grantDashCharge)(scorer.dash) };
        this.adjustPlayerMatchStat(throwerId, 'hits', 1);
        this.adjustPlayerMatchStat(target.id, 'hitsTaken', 1);
        targetLive.lives = Math.max(0, targetLive.lives - 1);
        if (targetLive.lives <= 0)
            this.eliminatePlayer(targetLive.id);
        this.refreshLastPlayerBuffs(this.stepNowMs);
        this.checkEliminationVictory();
        return {
            kind: 'life',
            throwerTeamId: scorer.teamId,
            value: 1,
            defenderLivesBefore,
            defenderCombatStateBefore,
            defenderEliminatedAtMsBefore,
            matchStatusBefore,
            winnerTeamIdBefore,
            throwerDashBefore
        };
    }
    eliminatePlayer(playerId) {
        const player = this.state.players[playerId];
        if (!player || player.combatState === 'eliminated')
            return;
        this.dropAllHeldBalls(player);
        player.lives = 0;
        player.combatState = 'eliminated';
        player.eliminatedAtMs = this.stepNowMs;
        player.lastPlayerBuffUntilMs = null;
        player.movement = {
            ...player.movement,
            velocity: (0, CollisionMath_1.vec3)(),
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
    checkEliminationVictory() {
        if (this.state.match.status === 'complete')
            return;
        for (const teamId of this.state.match.teamIds) {
            const teamPlayers = Object.values(this.state.players).filter((player) => player.teamId === teamId);
            if (!this.teamHasNoActiveFighter(teamPlayers))
                continue;
            const winnerTeamId = this.state.match.teamIds.find((candidate) => candidate !== teamId) ?? null;
            if (!winnerTeamId)
                return;
            this.state.match = {
                ...this.state.match,
                status: 'complete',
                winnerTeamId,
                countdownSeconds: 0
            };
            this.refreshLastPlayerBuffs(this.stepNowMs);
            if (this.debug.NET_DEBUG)
                this.logger(`elimination win team=${winnerTeamId}`);
            return;
        }
    }
    refreshLastPlayerBuffs(nowMs) {
        if (this.state.match.mode !== '2v2') {
            for (const player of Object.values(this.state.players))
                player.lastPlayerBuffUntilMs = null;
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
                }
                else {
                    player.lastPlayerBuffUntilMs = null;
                }
            }
        }
    }
    hasRecentHitAgainst(playerId) {
        for (const hit of this.recentHitByBallId.values()) {
            if (hit.defenderId === playerId)
                return true;
        }
        return false;
    }
    isSameTeam(a, b) {
        return a.teamId === b.teamId;
    }
    isOpponent(a, b) {
        return a.teamId !== b.teamId;
    }
    canBallDamagePlayer(ball, target) {
        if (!canScorePlayerHit(ball))
            return false;
        if (!this.isPlayerActiveFighter(target))
            return false;
        if (!ball.ownerId || target.id === ball.ownerId)
            return false;
        const owner = this.state.players[ball.ownerId];
        if (!owner)
            return false;
        return this.isOpponent(owner, target);
    }
    canPlayerCatchBall(player, ball) {
        if (!this.isPlayerActiveFighter(player))
            return false;
        if (!(0, BallSim_1.isBallCatchableInFlight)(ball))
            return false;
        if (ball.ownerId !== null && ball.ownerId === player.id && ball.bounceCount <= 0)
            return false;
        return true;
    }
    canPlayerParryBall(player, ball) {
        if (!this.isPlayerActiveFighter(player))
            return false;
        if (ball.phase !== 'live' || ball.ownerKind !== 'player' || !ball.ownerId)
            return false;
        return ball.ownerId !== player.id;
    }
    isPlayerAlive(player) {
        return player.combatState !== 'eliminated' && player.lives > 0;
    }
    isPlayerActiveFighter(player) {
        return player.connected !== false && this.isPlayerAlive(player);
    }
    playerMovementScale(player) {
        if (this.state.match.mode === '2v2' &&
            this.isPlayerAlive(player) &&
            (player.lastPlayerBuffUntilMs ?? 0) > this.stepNowMs) {
            return constants_1.GAME_CONSTANTS.match.lastPlayerBuffMultiplier;
        }
        return 1;
    }
    playerCooldownRateScale(player) {
        if (this.state.match.mode === '2v2' &&
            this.isPlayerAlive(player) &&
            (player.lastPlayerBuffUntilMs ?? 0) > this.stepNowMs) {
            return constants_1.GAME_CONSTANTS.match.lastPlayerBuffCooldownRateMultiplier;
        }
        return 1;
    }
    collisionBoxesForPlayer(playerId) {
        this.playerCollisionScratch.length = 0;
        for (const box of this.playerCollisionBoxes)
            this.playerCollisionScratch.push(box);
        this.pushEliminatedCoverBoxes(this.playerCollisionScratch, playerId);
        return this.playerCollisionScratch;
    }
    ballCollisionBoxesWithEliminatedCover() {
        if (!this.hasEliminatedPlayers())
            return this.ballCollisionBoxes;
        this.ballCollisionScratch.length = 0;
        for (const box of this.ballCollisionBoxes)
            this.ballCollisionScratch.push(box);
        this.pushEliminatedCoverBoxes(this.ballCollisionScratch);
        return this.ballCollisionScratch;
    }
    pushEliminatedCoverBoxes(target, exceptPlayerId) {
        for (const player of Object.values(this.state.players)) {
            if (player.id === exceptPlayerId)
                continue;
            if (player.connected === false)
                continue;
            if (player.combatState !== 'eliminated')
                continue;
            const pos = player.movement.position;
            const radius = constants_1.GAME_CONSTANTS.player.radius * 0.95;
            const height = constants_1.GAME_CONSTANTS.player.height * constants_1.GAME_CONSTANTS.player.crouchHeightMultiplier;
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
    hasEliminatedPlayers() {
        for (const player of Object.values(this.state.players)) {
            if (player.connected === false)
                continue;
            if (player.combatState === 'eliminated')
                return true;
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
    knockOverMatsForPlayer(player, preVelocity) {
        // Only an actively-walking player knocks a mat over (not someone resting against it). Use the
        // pre-resolution velocity since the collision solver zeros the into-mat component.
        const horizSpeedSq = preVelocity.x * preVelocity.x + preVelocity.z * preVelocity.z;
        if (horizSpeedSq <= 0.04)
            return; // ~0.2 m/s threshold
        const r = constants_1.GAME_CONSTANTS.player.radius;
        const reach = r + 0.18; // body radius + a small contact margin past the wall push-out line
        const reachSq = reach * reach;
        const pos = player.movement.position;
        let knockedAny = false;
        for (const spec of MapGeometry_1.MAT_SPECS) {
            if (this.knockedOverMatIds.has(spec.id))
                continue;
            if ((this.matPostResetKnockImmunityById.get(spec.id) ?? 0) > 0)
                continue;
            const box = (0, MapGeometry_1.matCollisionBox)(spec);
            // Vertical band: the player's body must overlap the mat height (feet below top, head above base).
            if (pos.y > box.maxY || pos.y + constants_1.GAME_CONSTANTS.player.height < box.minY)
                continue;
            // Closest point on the mat footprint to the player; contact if within radius + margin.
            const dx = pos.x - (0, CollisionMath_1.clamp)(pos.x, box.minX, box.maxX);
            const dz = pos.z - (0, CollisionMath_1.clamp)(pos.z, box.minZ, box.maxZ);
            if (dx * dx + dz * dz > reachSq)
                continue;
            // knockDirection = the player's horizontal heading (normalized); fall back to mat→player so it
            // always tips away from the player. No impulse is applied anywhere — the mat simply falls.
            const dir = (0, CollisionMath_1.normalize)((0, CollisionMath_1.vec3)(preVelocity.x, 0, preVelocity.z), (0, CollisionMath_1.normalize)((0, CollisionMath_1.vec3)(pos.x - spec.x, 0, pos.z - spec.z), (0, CollisionMath_1.vec3)(0, 0, 1)));
            this.state.mats[spec.id] = { ...this.state.mats[spec.id], knockedOver: true, knockDirection: dir };
            this.knockedOverMatIds.add(spec.id);
            knockedAny = true;
            if (this.debug.COLLISION_DEBUG)
                this.logger(`mat knocked over id=${spec.id} by player=${player.id}`);
        }
        // Rebuild both collision sets once if anything changed, so a downed mat becomes walkable AND
        // stops blocking balls.
        if (knockedAny) {
            this.playerCollisionBoxes = (0, MapGeometry_1.createPlayerCollisionBoxes)(this.knockedOverMatIds);
            this.ballCollisionBoxes = (0, MapGeometry_1.createBallCollisionBoxes)(this.knockedOverMatIds);
        }
    }
    /**
     * Hold E next to a knocked-over mat to stand it back up online. Mirrors the offline client's
     * restore behavior so the mechanic actually works in multiplayer (the server is authoritative for
     * mat state, so the client-only restore never reached other players). Picks the nearest downed mat
     * within reach; releasing E or stepping out of reach resets the hold timer.
     */
    updateMatRestoreForPlayer(player, input, dt) {
        if (!input.interactHeld || this.knockedOverMatIds.size === 0) {
            this.matRestoreHoldByPlayerId.delete(player.id);
            return;
        }
        const pos = player.movement.position;
        const reachSq = ServerGameLoop.MAT_RESTORE_REACH * ServerGameLoop.MAT_RESTORE_REACH;
        let nearestId = null;
        let nearestDistSq = Infinity;
        for (const spec of MapGeometry_1.MAT_SPECS) {
            if (!this.knockedOverMatIds.has(spec.id))
                continue;
            const dx = pos.x - spec.x;
            const dz = pos.z - spec.z;
            const distSq = dx * dx + dz * dz;
            if (distSq <= reachSq && distSq < nearestDistSq) {
                nearestDistSq = distSq;
                nearestId = spec.id;
            }
        }
        if (!nearestId) {
            this.matRestoreHoldByPlayerId.delete(player.id);
            return;
        }
        const hold = (this.matRestoreHoldByPlayerId.get(player.id) ?? 0) + dt;
        if (hold < ServerGameLoop.MAT_RESTORE_HOLD_SECONDS) {
            this.matRestoreHoldByPlayerId.set(player.id, hold);
            return;
        }
        this.matRestoreHoldByPlayerId.delete(player.id);
        this.state.mats[nearestId] = { ...this.state.mats[nearestId], knockedOver: false, knockDirection: (0, CollisionMath_1.vec3)() };
        this.knockedOverMatIds.delete(nearestId);
        this.matPostResetKnockImmunityById.set(nearestId, ServerGameLoop.MAT_POST_RESET_KNOCK_IMMUNITY_SECONDS);
        this.playerCollisionBoxes = (0, MapGeometry_1.createPlayerCollisionBoxes)(this.knockedOverMatIds);
        this.ballCollisionBoxes = (0, MapGeometry_1.createBallCollisionBoxes)(this.knockedOverMatIds);
        if (this.debug.COLLISION_DEBUG)
            this.logger(`mat restored id=${nearestId} by player=${player.id}`);
    }
    tickMatPostResetKnockImmunity(dt) {
        for (const [matId, remaining] of this.matPostResetKnockImmunityById) {
            const next = remaining - dt;
            if (next > 0)
                this.matPostResetKnockImmunityById.set(matId, next);
            else
                this.matPostResetKnockImmunityById.delete(matId);
        }
    }
    updateRules(dt) {
        this.state.match = (0, RuleSim_1.advanceNoBoundariesTimer)(this.state.match, dt);
        for (const playerId in this.state.players) {
            const player = this.state.players[playerId];
            if (!this.isPlayerAlive(player))
                continue;
            this.state.match = (0, RuleSim_1.applyHalfCourtRule)(this.state.match, player.id, player.teamId, player.legalHalf, player.movement.position, dt);
            if (this.state.match.boundary.lastEvent.type === 'half-court-elimination') {
                this.eliminatePlayer(player.id);
                this.refreshLastPlayerBuffs(this.stepNowMs);
                this.checkEliminationVictory();
            }
            else if (this.state.match.boundary.lastEvent.type === 'half-court-penalty') {
                this.applyHalfCourtPenalty(player.id, this.state.match.boundary.lastEvent.value);
            }
        }
    }
    applyHalfCourtPenalty(playerId, value) {
        if (this.state.match.mode !== '2v2')
            return;
        const player = this.state.players[playerId];
        if (!player || !this.isPlayerAlive(player))
            return;
        player.lives = Math.max(0, player.lives - value);
        this.adjustPlayerMatchStat(player.id, 'hitsTaken', value);
        if (player.lives <= 0)
            this.eliminatePlayer(player.id);
        this.refreshLastPlayerBuffs(this.stepNowMs);
        this.checkEliminationVictory();
    }
    // ===========================================================================================
    //  Server-authoritative combat: defensive history, catch attempts, auto-parry, swept resolution
    // ===========================================================================================
    /** Record this player's post-update defensive state into their history ring (lag-comp source). */
    recordDefenseSample(player) {
        let ring = this.defenseHistoryByPlayerId.get(player.id);
        if (!ring) {
            ring = new DefenseHistory_1.TimeRing(constants_1.GAME_CONSTANTS.combat.defenseHistoryMs, this.historyMaxSamples());
            this.defenseHistoryByPlayerId.set(player.id, ring);
        }
        const m = player.movement;
        const forward = (0, CollisionMath_1.normalize)(m.facing, (0, MovementSim_1.facingFromAngles)(m.yawRadians, m.pitchRadians));
        const active = this.isPlayerAlive(player);
        ring.push({
            serverTimeMs: this.stepNowMs,
            tick: this.state.tick,
            eye: (0, CollisionMath_1.vec3)(m.position.x, m.position.y + constants_1.GAME_CONSTANTS.player.eyeHeight, m.position.z),
            forward,
            yaw: m.yawRadians,
            pitch: m.pitchRadians,
            leftHandEmpty: active && !player.hands.left.heldBallId,
            rightHandEmpty: active && !player.hands.right.heldBallId,
            leftHeldBallId: player.hands.left.heldBallId,
            rightHeldBallId: player.hands.right.heldBallId,
            heldBallCount: active ? (0, HandSim_1.heldBallCount)(player.hands) : 0,
            dashing: m.dashingThisFrame
        });
    }
    /** Record an interaction-relevant ball's position so a rewound click can reconstruct its swept
     * path. Covers live/deflected balls and moving bounced balls that remain catchable. */
    recordBallSample(ball) {
        // Keep history while the ball is catchable in flight OR a hit on it is still inside the catch-undo
        // grace — a lag-comp catch reclaim needs the ball's PRE-hit (live) samples even after the present
        // ball has died/bounced past the defender. Once neither holds, drop the ring (bounded memory).
        if (!(0, BallSim_1.isBallCatchableInFlight)(ball) && !this.recentHitByBallId.has(ball.id)) {
            this.ballHistoryById.delete(ball.id);
            return;
        }
        let ring = this.ballHistoryById.get(ball.id);
        if (!ring) {
            ring = new DefenseHistory_1.TimeRing(constants_1.GAME_CONSTANTS.combat.defenseHistoryMs, this.historyMaxSamples());
            this.ballHistoryById.set(ball.id, ring);
        }
        ring.push({
            serverTimeMs: this.stepNowMs,
            tick: this.state.tick,
            position: (0, CollisionMath_1.cloneVec3)(ball.position),
            velocity: (0, CollisionMath_1.cloneVec3)(ball.velocity),
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
    ingestCatchAttempts(player, input) {
        this.ingestCatchAttemptForHand(player, input, 'left', input.leftCatchAttemptId);
        this.ingestCatchAttemptForHand(player, input, 'right', input.rightCatchAttemptId);
    }
    ingestCatchAttemptForHand(player, input, hand, attemptId) {
        if (attemptId <= 0)
            return;
        const key = `${player.id}:${hand}`;
        const lastId = this.lastCatchAttemptIdByKey.get(key) ?? 0;
        const handEmptyAtIngest = !player.hands[hand].heldBallId;
        const handCooldownSeconds = player.hands[hand].cooldownSeconds;
        if (attemptId <= lastId) {
            this.catchTrace(`attempt-ingest player=${player.id} hand=${hand} id=${attemptId} result=deduped` +
                ` last=${lastId} handEmpty=${Number(handEmptyAtIngest)} cooldown=${handCooldownSeconds.toFixed(3)}`);
            return; // stale/duplicate latched re-send — already consumed.
        }
        this.lastCatchAttemptIdByKey.set(key, attemptId);
        // Acknowledge on the hand state so the client knows the attempt was received (whether or not it
        // ultimately catches — the catch resolves over the active window below).
        player.hands = setHandLastCatchAttemptId(player.hands, hand, attemptId);
        if (!this.isPlayerAlive(player)) {
            this.catchTrace(`attempt-ingest player=${player.id} hand=${hand} id=${attemptId} result=rejected reason=not-alive` +
                ` last=${lastId} handEmpty=${Number(handEmptyAtIngest)} cooldown=${handCooldownSeconds.toFixed(3)}`);
            return;
        }
        const now = this.stepNowMs;
        const existing = this.catchAttemptByKey.get(key);
        if (existing && now < existing.cooldownUntilMs) {
            this.catchTrace(`attempt-ingest player=${player.id} hand=${hand} id=${attemptId} result=rejected reason=cooldown` +
                ` last=${lastId} handEmpty=${Number(handEmptyAtIngest)} cooldownRemainingMs=${Math.round(existing.cooldownUntilMs - now)}` +
                ` openedAtMs=${Math.round(existing.openedAtMs)} activeUntilMs=${Math.round(existing.activeUntilMs)}`);
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
        const subTickOffset = clientClickMs > 0 ? (0, CollisionMath_1.clamp)(now - clientClickMs, 0, netConfig_1.SERVER_STEP_MS) : 0;
        const openedAtMs = now - subTickOffset;
        this.catchAttemptByKey.set(key, {
            hand,
            attemptId,
            openedAtMs,
            activeUntilMs: openedAtMs + constants_1.GAME_CONSTANTS.combat.catchStartupMs + constants_1.GAME_CONSTANTS.combat.catchActiveMs,
            cooldownUntilMs: openedAtMs + constants_1.GAME_CONSTANTS.combat.catchCooldownMs,
            clickTimeMs: openedAtMs - rewindMs,
            rewindMs,
            clientClickMs,
            resolved: false
        });
        this.combatMetrics.catchAttemptsOpened += 1;
        this.catchTrace(`attempt-ingest player=${player.id} hand=${hand} id=${attemptId} result=accepted` +
            ` last=${lastId} handEmpty=${Number(handEmptyAtIngest)} cooldown=${handCooldownSeconds.toFixed(3)}` +
            ` openedAtMs=${Math.round(openedAtMs)} activeUntilMs=${Math.round(openedAtMs + constants_1.GAME_CONSTANTS.combat.catchStartupMs + constants_1.GAME_CONSTANTS.combat.catchActiveMs)}` +
            ` clickTimeMs=${Math.round(openedAtMs - rewindMs)} rewindMs=${Math.round(rewindMs)} clientClickMs=${Math.round(clientClickMs)}`);
    }
    /**
     * Auto-parry (Phase 11): a defender holding two balls and aiming within the parry cone of a live
     * incoming ball deflects it automatically. Evaluated against the swept segment + the defender's
     * rewound aim. Returns the deflected ball on success, else null (and logs the reason under PARRY_DEBUG).
     */
    tryAutoParry(ball, segPrev, segCurr, _dt, tickStartMs) {
        const ownerId = ball.ownerId;
        if (ball.phase !== 'live' || ball.ownerKind !== 'player' || !ownerId)
            return null;
        for (const defenderId in this.state.players) {
            if (defenderId === ownerId)
                continue;
            const defender = this.state.players[defenderId];
            if (!this.canPlayerParryBall(defender, ball))
                continue;
            const sample = this.sampleDefenseAt(defenderId, tickStartMs);
            const fail = this.parryFailReason(defender, sample, ball, segPrev, segCurr);
            if (fail) {
                if (this.debug.PARRY_DEBUG)
                    this.logParry(defenderId, ball, sample, segPrev, segCurr, fail);
                continue;
            }
            // Success. Deflect using the defender's rewound aim; new throw identity so clients snap.
            const aim = sample ? sample.forward : defender.movement.facing;
            this.throwCounter += 1;
            this.state.balls[ball.id] = (0, BallSim_1.deflectBall)(ball, defenderId, aim, constants_1.GAME_CONSTANTS, this.throwCounter);
            this.parryCooldownByPlayerId.set(defenderId, constants_1.GAME_CONSTANTS.parry.cooldownSeconds);
            this.combatMetrics.parries += 1;
            this.adjustPlayerMatchStat(defenderId, 'parries', 1);
            if (ball.isSuper)
                this.dropOneHeldBall(defender); // super-parry drops a defender ball
            this.pendingCombatEvents.push({ type: 'parry-event', ballId: ball.id, deflectorId: defenderId, serverTick: this.state.tick, serverTimeMs: this.stepNowMs });
            if (this.debug.PARRY_DEBUG || this.debug.NET_DEBUG) {
                this.logger(`parry SUCCESS defender=${defenderId} ball=${ball.id} super=${ball.isSuper} throwId=${this.throwCounter}`);
            }
            return this.state.balls[ball.id];
        }
        return null;
    }
    /** Returns a fail reason, or null if this defender would parry the ball this tick. */
    parryFailReason(defender, sample, ball, segPrev, segCurr) {
        return (0, HandSim_1.sweptParryFailReason)({
            heldBallCount: sample ? sample.heldBallCount : (0, HandSim_1.heldBallCount)(defender.hands),
            parryCooldownSeconds: this.parryCooldownByPlayerId.get(defender.id) ?? 0,
            defenderPlayerId: defender.id,
            ball,
            origin: sample ? sample.eye : (0, CollisionMath_1.add)(defender.movement.position, (0, CollisionMath_1.vec3)(0, constants_1.GAME_CONSTANTS.player.eyeHeight, 0)),
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
    tryCatchAttempts(ball, segPrev, segCurr, _dt, tickStartMs) {
        // A live/deflected ball OR a bounced dead ball that's still fast can be caught.
        // (A bounced ball has its owner cleared, so it's catchable by either player.)
        if (!(0, BallSim_1.isBallCatchableInFlight)(ball))
            return null;
        const now = this.stepNowMs;
        for (const defenderId in this.state.players) {
            // Can't catch your own direct throw before it touches anything. Once it bounces, rebounds are playable.
            if (ball.ownerId !== null && defenderId === ball.ownerId && ball.bounceCount <= 0)
                continue;
            const defender = this.state.players[defenderId];
            if (!this.canPlayerCatchBall(defender, ball))
                continue;
            for (const hand of ['left', 'right']) {
                const key = `${defenderId}:${hand}`;
                const attempt = this.catchAttemptByKey.get(key);
                if (!attempt || attempt.resolved)
                    continue;
                // Expire windows that have fully elapsed.
                if (now > attempt.activeUntilMs)
                    continue;
                // Defender's OWN state (aim/eye/dash/hand) is authoritative at the CLICK frame (client-
                // predicted, not delayed) — sample at openedAtMs, not the rewound ball time. Only the BALL is
                // rewound (present segment here; lag-comp history in resolveCatchReclaim).
                const sample = this.sampleDefenseAt(defenderId, attempt.openedAtMs);
                const fail = this.catchFailReason(defender, hand, sample, ball, segPrev, segCurr, attempt, now);
                if (fail) {
                    this.logCatchTraceEval(defenderId, hand, ball, sample, segPrev, segCurr, attempt, fail);
                    if (this.debug.CATCH_DEBUG)
                        this.logCatch(defenderId, hand, ball, sample, segPrev, segCurr, attempt, fail);
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
    resolveCatchReclaim(nowMs) {
        const minTime = nowMs - constants_1.GAME_CONSTANTS.combat.defenseMaxRewindMs - constants_1.GAME_CONSTANTS.combat.defenseInputGraceMs;
        for (const defenderId in this.state.players) {
            const defender = this.state.players[defenderId];
            if (defender.connected === false)
                continue;
            const recentHitForDefender = this.hasRecentHitAgainst(defenderId);
            if (!this.isPlayerAlive(defender) && !recentHitForDefender)
                continue;
            for (const hand of ['left', 'right']) {
                const attempt = this.catchAttemptByKey.get(`${defenderId}:${hand}`);
                if (!attempt || attempt.resolved)
                    continue;
                if (nowMs < attempt.openedAtMs + constants_1.GAME_CONSTANTS.combat.catchStartupMs)
                    continue; // startup
                if (nowMs > attempt.activeUntilMs)
                    continue; // expired
                // Ball is rewound to what the defender SAW (now − rewind, scanning forward as the window
                // stays open). The defender's OWN state is sampled at the click frame (openedAtMs), since
                // they see themselves in real time — only the world (ball) is delayed.
                const evalTime = (0, CollisionMath_1.clamp)(nowMs - attempt.rewindMs, minTime, nowMs);
                const sample = this.sampleDefenseAt(defenderId, attempt.openedAtMs);
                // The hand must be empty at the click moment to even consider a reclaim (skip the scan if not).
                const handEmpty = sample ? (hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty) : !defender.hands[hand].heldBallId;
                if (!handEmpty)
                    continue;
                for (const ballId in this.state.balls) {
                    // A ball already in someone's hand can't be reclaimed.
                    if (this.state.balls[ballId].phase === 'held')
                        continue;
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
                    const fail = (0, HandSim_1.sweptCatchFailReason)({
                        handEmpty: true,
                        dashing: sample ? sample.dashing : defender.movement.dashingThisFrame,
                        defenderPlayerId: defenderId,
                        ball: { phase: at.phase, velocity: at.velocity, bounceCount: at.bounceCount, ownerId: at.ownerId },
                        origin: sample ? sample.eye : (0, CollisionMath_1.add)(defender.movement.position, (0, CollisionMath_1.vec3)(0, constants_1.GAME_CONSTANTS.player.eyeHeight, 0)),
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
    applyCatch(defenderId, hand, ballId, facing, attempt, nowMs, reclaim = false) {
        attempt.resolved = true;
        this.catchAttemptByKey.set(`${defenderId}:${hand}`, attempt);
        const defender = this.state.players[defenderId];
        const present = this.state.balls[ballId];
        const absorbedSpeed = (0, CollisionMath_1.length)(present.velocity);
        const incomingVelocity = (0, CollisionMath_1.cloneVec3)(present.velocity);
        const caught = (0, BallSim_1.catchBall)(present, defenderId, hand);
        this.state.balls[ballId] = caught;
        const boostDir = (0, CollisionMath_1.normalize)((0, CollisionMath_1.vec3)(facing.x, 0, facing.z), (0, CollisionMath_1.vec3)(0, 0, 1));
        this.state.players[defenderId] = {
            ...defender,
            dash: (0, PlayerSim_1.grantDashCharge)(defender.dash),
            hands: assignCaughtHand(defender.hands, hand, ballId),
            movement: { ...defender.movement, velocity: (0, CollisionMath_1.add)(defender.movement.velocity, (0, CollisionMath_1.scale)(boostDir, constants_1.GAME_CONSTANTS.catch.catchBoostSpeed)) },
            movementInternal: { ...defender.movementInternal, catchBoostTimer: constants_1.GAME_CONSTANTS.catch.catchBoostDuration }
        };
        this.adjustPlayerMatchStat(defenderId, 'catches', 1);
        if (reclaim)
            this.adjustPlayerMatchStat(defenderId, 'saves', 1);
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
        this.catchTrace(`catch-apply player=${defenderId} hand=${hand} id=${attempt.attemptId}` +
            ` ball=${ballId} result=held heldBy=${caught.heldByPlayerId ?? 'none'} heldHand=${caught.heldHand ?? 'none'}` +
            ` event=catch-event snapshotHandBall=${this.state.players[defenderId]?.hands[hand].heldBallId ?? 'none'} reclaim=${Number(reclaim)}`);
        return caught;
    }
    /**
     * If a hit was applied on `defenderId` for `ballId` within the grace window, revert it — a
     * lag-compensated catch from that defender legitimately claimed the ball that scored on them.
     */
    undoRecentHitIfClaimed(ballId, defenderId, nowMs) {
        const hit = this.recentHitByBallId.get(ballId);
        if (!hit)
            return;
        if (hit.defenderId !== defenderId)
            return; // a catch only cancels a hit that landed on this defender
        if (nowMs - hit.atMs > constants_1.GAME_CONSTANTS.combat.catchHitGraceMs)
            return;
        this.revertHit(hit);
        this.recentHitByBallId.delete(ballId);
    }
    /** Revert a scored hit: decrement the thrower team's score, restore their dash, recompute outcome. */
    revertHit(hit) {
        this.adjustPlayerMatchStat(hit.throwerId, 'hits', -hit.value);
        this.adjustPlayerMatchStat(hit.defenderId, 'hitsTaken', -hit.value);
        if (hit.kind === 'score') {
            const current = this.state.match.scoreByTeamId[hit.throwerTeamId] ?? 0;
            const scoreByTeamId = { ...this.state.match.scoreByTeamId, [hit.throwerTeamId]: Math.max(0, current - hit.value) };
            this.state.match = recomputeMatchOutcome({ ...this.state.match, scoreByTeamId });
        }
        else {
            const defender = this.state.players[hit.defenderId];
            if (defender) {
                defender.lives = Math.max(1, hit.defenderLivesBefore ?? defender.lives);
                defender.combatState = hit.defenderCombatStateBefore ?? 'alive';
                defender.eliminatedAtMs = hit.defenderEliminatedAtMsBefore ?? null;
            }
            this.state.match = {
                ...this.state.match,
                status: hit.matchStatusBefore ?? this.state.match.status,
                winnerTeamId: hit.winnerTeamIdBefore ?? null
            };
            this.refreshLastPlayerBuffs(this.stepNowMs);
        }
        const thrower = this.state.players[hit.throwerId];
        if (thrower)
            this.state.players[hit.throwerId] = { ...thrower, dash: hit.throwerDashBefore };
        this.combatMetrics.hitReverts += 1;
        this.pendingCombatEvents.push({ type: 'hit-revert-event', ballId: hit.ballId, throwerId: hit.throwerId, targetId: hit.defenderId, serverTick: this.state.tick, serverTimeMs: this.stepNowMs });
        this.syncPlayerScores();
        if (this.debug.CATCH_DEBUG || this.debug.NET_DEBUG) {
            this.logger(`hit reverted (lag-comp catch) thrower=${hit.throwerId} defender=${hit.defenderId} ball=${hit.ballId}`);
        }
    }
    /** Drop recorded hits older than the catch-undo grace so the map stays bounded. */
    pruneRecentHits(nowMs) {
        for (const [ballId, hit] of this.recentHitByBallId) {
            if (nowMs - hit.atMs > constants_1.GAME_CONSTANTS.combat.catchHitGraceMs)
                this.recentHitByBallId.delete(ballId);
        }
    }
    /** Returns a catch fail reason, or null if this defender+hand would catch the ball this tick. */
    catchFailReason(defender, hand, sample, ball, segPrev, segCurr, attempt, now) {
        {
            const handEmpty = sample
                ? (hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty)
                : !defender.hands[hand].heldBallId;
            return (0, HandSim_1.sweptCatchFailReason)({
                handEmpty,
                dashing: sample ? sample.dashing : defender.movement.dashingThisFrame,
                defenderPlayerId: defender.id,
                ball,
                origin: sample ? sample.eye : (0, CollisionMath_1.add)(defender.movement.position, (0, CollisionMath_1.vec3)(0, constants_1.GAME_CONSTANTS.player.eyeHeight, 0)),
                forward: sample ? sample.forward : defender.movement.facing,
                segmentStart: segPrev,
                segmentEnd: segCurr,
                timing: {
                    nowMs: now,
                    openedAtMs: attempt.openedAtMs,
                    startupMs: constants_1.GAME_CONSTANTS.combat.catchStartupMs,
                    activeUntilMs: attempt.activeUntilMs
                }
            });
        }
        /*
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
    sampleDefenseAt(playerId, atServerTimeMs) {
        const ring = this.defenseHistoryByPlayerId.get(playerId);
        if (!ring)
            return null;
        const minTime = this.stepNowMs - constants_1.GAME_CONSTANTS.combat.defenseMaxRewindMs - constants_1.GAME_CONSTANTS.combat.defenseInputGraceMs;
        const target = Math.max(minTime, atServerTimeMs);
        return ring.nearest(target);
    }
    logCatchTraceEval(defenderId, hand, ball, sample, segPrev, segCurr, attempt, reason) {
        if (!this.debug.CATCH_TRACE_DEBUG && !this.debug.CATCH_DEBUG)
            return;
        const result = reason ? 'fail' : 'success';
        const key = `${defenderId}:${hand}:${attempt.attemptId}:${ball.id}:${result}:${reason ?? 'ok'}`;
        if (reason && this.catchTraceEvalSeen.has(key))
            return;
        this.catchTraceEvalSeen.add(key);
        const origin = sample ? sample.eye : (0, CollisionMath_1.add)(this.state.players[defenderId]?.movement.position ?? (0, CollisionMath_1.vec3)(), (0, CollisionMath_1.vec3)(0, constants_1.GAME_CONSTANTS.player.eyeHeight, 0));
        const closest = (0, CollisionMath_1.closestPointOnSegment)(segPrev, segCurr, origin);
        const range = (0, CollisionMath_1.distance)(origin, closest);
        const handEmpty = sample ? (hand === 'left' ? sample.leftHandEmpty : sample.rightHandEmpty) : !this.state.players[defenderId]?.hands[hand].heldBallId;
        const dashing = sample ? sample.dashing : Boolean(this.state.players[defenderId]?.movement.dashingThisFrame);
        const sampleAgeMs = sample ? Math.round(Math.abs(sample.serverTimeMs - attempt.openedAtMs)) : 'missing';
        this.catchTrace(`catch-eval result=${result}${reason ? ` reason=${reason}` : ''}` +
            ` player=${defenderId} hand=${hand} id=${attempt.attemptId}` +
            ` ball=${ball.id} phase=${ball.phase} speed=${(0, CollisionMath_1.length)(ball.velocity).toFixed(2)}` +
            ` bounce=${ball.bounceCount} owner=${ball.ownerId ?? 'none'}` +
            ` heldBy=${ball.heldByPlayerId ?? 'none'} heldHand=${ball.heldHand ?? 'none'} throwId=${ball.throwId}` +
            ` catchable=${Number((0, BallSim_1.isBallCatchableInFlight)(ball))}` +
            ` range=${range.toFixed(2)}/${constants_1.GAME_CONSTANTS.catch.rangeMeters}` +
            ` handEmpty=${Number(handEmpty)} dashing=${Number(dashing)} sampleAgeMs=${sampleAgeMs}` +
            ` nowMs=${Math.round(this.stepNowMs)} openedAtMs=${Math.round(attempt.openedAtMs)}` +
            ` activeUntilMs=${Math.round(attempt.activeUntilMs)}` +
            ` segStart=(${segPrev.x.toFixed(2)},${segPrev.y.toFixed(2)},${segPrev.z.toFixed(2)})` +
            ` segEnd=(${segCurr.x.toFixed(2)},${segCurr.y.toFixed(2)},${segCurr.z.toFixed(2)})`);
    }
    logCatchTraceReclaimSkip(defenderId, hand, attempt, ballId, reason, evalTime, sample, bracket) {
        if (!this.debug.CATCH_TRACE_DEBUG && !this.debug.CATCH_DEBUG)
            return;
        const key = `${defenderId}:${hand}:${attempt.attemptId}:${ballId}:reclaim:${reason}`;
        if (this.catchTraceEvalSeen.has(key))
            return;
        this.catchTraceEvalSeen.add(key);
        this.catchTrace(`catch-reclaim result=fail reason=${reason}` +
            ` player=${defenderId} hand=${hand} id=${attempt.attemptId} ball=${ballId}` +
            ` evalTimeMs=${Math.round(evalTime)} clickTimeMs=${Math.round(attempt.clickTimeMs)}` +
            ` rewindMs=${Math.round(attempt.rewindMs)}` +
            ` historySample=${sample ? `${sample.phase}/speed=${(0, CollisionMath_1.length)(sample.velocity).toFixed(2)}/bounce=${sample.bounceCount}` : 'missing'}` +
            ` bracket=${bracket ? `${bracket[0].tick}->${bracket[1].tick}` : 'missing'}`);
    }
    logCatch(defenderId, hand, ball, sample, segPrev, segCurr, attempt, reason) {
        const origin = sample ? sample.eye : (0, CollisionMath_1.vec3)();
        const closest = (0, CollisionMath_1.closestPointOnSegment)(segPrev, segCurr, origin);
        const range = sample ? (0, CollisionMath_1.distance)(origin, closest) : -1;
        this.logger(`catch FAIL defender=${defenderId} hand=${hand} ball=${ball.id} phase=${ball.phase}` +
            ` owner=${ball.ownerId ?? 'none'} id=${attempt.attemptId}` +
            ` range=${range.toFixed(2)}/${constants_1.GAME_CONSTANTS.catch.rangeMeters}` +
            ` historyAgeMs=${sample ? Math.round(Math.abs(sample.serverTimeMs - attempt.clickTimeMs)) : 'n/a'}` +
            ` reason=${reason}`);
    }
    logParry(defenderId, ball, sample, segPrev, segCurr, reason) {
        const origin = sample ? sample.eye : (0, CollisionMath_1.vec3)();
        const closest = (0, CollisionMath_1.closestPointOnSegment)(segPrev, segCurr, origin);
        const range = sample ? (0, CollisionMath_1.distance)(origin, closest) : -1;
        this.logger(`parry FAIL defender=${defenderId} ball=${ball.id} isSuper=${ball.isSuper}` +
            ` range=${range.toFixed(2)}/${constants_1.GAME_CONSTANTS.parry.rangeMeters} reason=${reason}`);
    }
    syncPlayerScores() {
        for (const playerId in this.state.players) {
            const player = this.state.players[playerId];
            player.score = this.state.match.scoreByTeamId[player.teamId] ?? 0;
        }
    }
    adjustPlayerMatchStat(playerId, key, delta) {
        if (delta === 0)
            return;
        const player = this.state.players[playerId];
        if (!player)
            return;
        const current = player.matchStats[key] ?? 0;
        player.matchStats = {
            ...player.matchStats,
            [key]: Math.max(0, current + delta)
        };
    }
    syncBattleMusicForMatchTransition(previousStatus, nowMs) {
        const nextStatus = this.state.match.status;
        if (previousStatus !== 'playing' && nextStatus === 'playing') {
            this.startBattleMusicSession(nowMs);
            return;
        }
        if (previousStatus === 'playing' && nextStatus !== 'playing') {
            this.stopBattleMusic();
        }
    }
    startBattleMusicSession(nowMs) {
        if (this.battleMusicTrackCount === 0) {
            this.stopBattleMusic();
            return;
        }
        this.nextBattleMusicSessionId += 1;
        this.setBattleMusicSyncState({
            active: true,
            sessionId: this.nextBattleMusicSessionId,
            shuffleSeed: (0, BattleMusic_1.createBattleMusicSessionSeed)(this.nextBattleMusicSessionId, nowMs),
            playlistStartedAtServerTimeMs: nowMs
        });
    }
    stopBattleMusic() {
        if (!this.battleMusicSyncState.active)
            return;
        this.setBattleMusicSyncState({
            ...this.battleMusicSyncState,
            active: false
        });
    }
    setBattleMusicSyncState(nextState) {
        if (this.battleMusicSyncState.active === nextState.active &&
            this.battleMusicSyncState.sessionId === nextState.sessionId &&
            this.battleMusicSyncState.shuffleSeed === nextState.shuffleSeed &&
            this.battleMusicSyncState.playlistStartedAtServerTimeMs === nextState.playlistStartedAtServerTimeMs) {
            return;
        }
        this.battleMusicSyncState = nextState;
        this.battleMusicSyncDirty = true;
    }
    performRoomReset(triggerPlayerId, mode = 'same-teams') {
        const previousMatchStatus = this.state.match.status;
        const players = Object.values(this.state.players)
            .filter((player) => player.connected !== false)
            .map((player) => (0, PlayerSim_1.createPlayerState)(player.id, player.teamId, player.legalHalf, {
            name: player.name,
            spawnSide: player.spawnSide,
            teamSlotIndex: player.teamSlotIndex,
            score: 0,
            connected: true,
            reconnectDeadlineAtMs: null,
            movement: this.spawnMovement(this.slotForPlayer(player))
        }));
        this.resetSerial += 1;
        this.startVotesByPlayerId.clear();
        this.resetVotesByPlayerId.clear();
        // Preserve the running tick so it stays monotonic across the reset (see createFreshRoomState).
        this.state = this.createFreshRoomState(players, this.state.tick);
        this.teamChoicesByPlayerId.clear();
        for (const player of players) {
            this.seedInputTracking(player.id, this.slotForPlayer(player).yawRadians);
        }
        if (mode === 'same-teams' && this.matchMode === '2v2') {
            for (const player of players)
                this.teamChoicesByPlayerId.add(player.id);
            if (this.canVoteStart(players))
                this.beginPregameCountdown('reset');
        }
        else if (this.matchMode === '1v1' && this.shouldAutoStart(players)) {
            this.beginPregameCountdown('auto');
        }
        this.syncStartVoteState();
        this.syncResetVoteState();
        this.syncBattleMusicForMatchTransition(previousMatchStatus, this.now());
        if (this.debug.NET_DEBUG)
            this.logger(`room reset by player=${triggerPlayerId} mode=${mode} players=${players.length} serial=${this.resetSerial}`);
    }
    pruneResetVotes(now) {
        let changed = false;
        for (const [playerId, expiresAtMs] of this.resetVotesByPlayerId) {
            const player = this.state.players[playerId];
            if (!player || player.connected === false || expiresAtMs <= now) {
                this.resetVotesByPlayerId.delete(playerId);
                changed = true;
            }
        }
        if (changed)
            this.syncResetVoteState();
    }
    syncResetVoteState(mode = this.state.resetVote.mode) {
        const votesByPlayerId = {};
        let expiresAtMs = null;
        for (const [playerId, expiry] of this.resetVotesByPlayerId) {
            if (!this.state.players[playerId] || this.state.players[playerId].connected === false)
                continue;
            votesByPlayerId[playerId] = true;
            expiresAtMs = expiresAtMs === null ? expiry : Math.min(expiresAtMs, expiry);
        }
        this.state.resetVote = (0, MatchSim_1.createResetVoteState)({
            mode,
            votesByPlayerId,
            voteCount: Object.keys(votesByPlayerId).length,
            requiredVotes: this.connectedCount(),
            expiresAtMs,
            resetSerial: this.resetSerial
        });
    }
    pruneStartVotes(now) {
        let changed = false;
        for (const [playerId, expiresAtMs] of this.startVotesByPlayerId) {
            const player = this.state.players[playerId];
            if (!player || player.connected === false || expiresAtMs <= now || this.state.match.status !== 'warmup') {
                this.startVotesByPlayerId.delete(playerId);
                changed = true;
            }
        }
        if (changed)
            this.syncStartVoteState();
    }
    syncStartVoteState() {
        const votesByPlayerId = {};
        let expiresAtMs = null;
        for (const [playerId, expiry] of this.startVotesByPlayerId) {
            if (!this.state.players[playerId] || this.state.players[playerId].connected === false)
                continue;
            votesByPlayerId[playerId] = true;
            expiresAtMs = expiresAtMs === null ? expiry : Math.min(expiresAtMs, expiry);
        }
        this.state.startVote = (0, MatchSim_1.createStartVoteState)({
            votesByPlayerId,
            voteCount: Object.keys(votesByPlayerId).length,
            requiredVotes: this.canVoteStart() ? this.connectedCount() : 0,
            expiresAtMs,
            teamChoicesByPlayerId: this.teamChoicesSnapshot(),
            teamChoiceCount: this.teamChoiceCount(),
            requiredTeamChoices: this.matchMode === '2v2' ? this.connectedCount() : 0
        });
    }
    reconcilePregameState(reason) {
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
        }
        else if (this.matchMode === '1v1' && this.shouldAutoStart()) {
            this.beginPregameCountdown('auto');
        }
        else {
            this.state.match = { ...this.state.match, status: 'warmup', countdownSeconds: 0, winnerTeamId: null };
            this.syncStartVoteState();
            this.syncResetVoteState();
        }
        this.syncBattleMusicForMatchTransition(previousMatchStatus, this.now());
    }
    clearVotesForPregameChange() {
        this.startVotesByPlayerId.clear();
        this.resetVotesByPlayerId.clear();
        this.syncStartVoteState();
        this.syncResetVoteState();
    }
    resolveResetVotesAfterRosterChange() {
        this.syncResetVoteState();
        const vote = this.state.resetVote;
        if (vote.requiredVotes > 0 && vote.voteCount >= vote.requiredVotes && vote.voteCount > 0) {
            const triggerPlayerId = Object.keys(vote.votesByPlayerId)[0] ?? 'roster-change';
            this.performRoomReset(triggerPlayerId, vote.mode);
        }
    }
    pruneExpiredReconnects(nowMs) {
        const expired = [];
        for (const player of Object.values(this.state.players)) {
            if (player.connected !== false)
                continue;
            if ((player.reconnectDeadlineAtMs ?? 0) > nowMs)
                continue;
            expired.push(player.id);
        }
        for (const playerId of expired)
            this.abandon(playerId);
    }
    canVoteStart(players = Object.values(this.state.players)) {
        if (this.matchMode !== '2v2')
            return false;
        const connectedPlayers = players.filter((player) => player.connected !== false);
        if (connectedPlayers.length < 2)
            return false;
        if (!this.allConnectedPlayersChoseTeams(connectedPlayers))
            return false;
        return this.connectedTeamCount(connectedPlayers) >= this.teamsRequiredToPlay;
    }
    allConnectedPlayersChoseTeams(players = Object.values(this.state.players)) {
        const connectedPlayers = players.filter((player) => player.connected !== false);
        return connectedPlayers.length > 0 && connectedPlayers.every((player) => this.teamChoicesByPlayerId.has(player.id));
    }
    teamChoiceCount() {
        let count = 0;
        for (const playerId of this.teamChoicesByPlayerId) {
            const player = this.state.players[playerId];
            if (player && player.connected !== false)
                count += 1;
        }
        return count;
    }
    teamChoicesSnapshot() {
        const choices = {};
        for (const playerId of this.teamChoicesByPlayerId) {
            const player = this.state.players[playerId];
            if (player && player.connected !== false)
                choices[playerId] = true;
        }
        return choices;
    }
    shouldAutoStart(players = Object.values(this.state.players)) {
        if (this.matchMode === '2v2')
            return false;
        if (!this.hasFullRoster(players))
            return false;
        return this.teamIds.every((teamId) => players.filter((player) => player.connected !== false && player.teamId === teamId).length >= this.playersPerTeam);
    }
    beginPregameCountdown(kind) {
        this.startVotesByPlayerId.clear();
        this.syncStartVoteState();
        this.state.match = {
            ...this.state.match,
            status: 'countdown',
            countdownSeconds: constants_1.GAME_CONSTANTS.match.countdownSeconds,
            elapsedSeconds: 0,
            winnerTeamId: null,
            boundary: { ...this.state.match.boundary, elapsedSeconds: 0, noBoundaries: false, lastEvent: { type: 'none' } }
        };
        if (this.debug.NET_DEBUG)
            this.logger(`match start ${kind} players=${this.connectedCount()}/${this.maxPlayers}`);
    }
    resolveForfeitIfNeeded(reason) {
        if (this.state.match.status !== 'countdown' && this.state.match.status !== 'playing')
            return;
        const activeTeams = this.state.match.teamIds.filter((teamId) => Object.values(this.state.players).some((player) => player.teamId === teamId && this.isPlayerActiveFighter(player)));
        if (activeTeams.length === 1) {
            this.forfeitTo(activeTeams[0]);
            if (this.debug.NET_DEBUG)
                this.logger(`forfeit win team=${activeTeams[0]} reason=${reason}`);
            return;
        }
        if (activeTeams.length === 0) {
            this.state.match = { ...this.state.match, status: 'warmup', countdownSeconds: 0, winnerTeamId: null };
            this.syncStartVoteState();
        }
    }
    resolveRequestedSlot(teamId, requestedSlotIndex) {
        if (requestedSlotIndex !== undefined) {
            return this.playerSlots.find((slot) => slot.teamId === teamId && slot.teamSlotIndex === requestedSlotIndex) ?? null;
        }
        return this.playerSlots.find((slot) => slot.teamId === teamId &&
            !Object.values(this.state.players).some((player) => player.teamId === slot.teamId && player.teamSlotIndex === slot.teamSlotIndex)) ?? this.playerSlots.find((slot) => slot.teamId === teamId) ?? null;
    }
    teamHasNoActiveFighter(players) {
        const activeCount = players.filter((player) => this.isPlayerActiveFighter(player)).length;
        return activeCount === 0 && players.length > 0;
    }
    dropOneHeldBall(player) {
        const hand = player.hands.right.heldBallId ? 'right' : player.hands.left.heldBallId ? 'left' : null;
        if (!hand)
            return;
        const ballId = player.hands[hand].heldBallId;
        if (!ballId)
            return;
        const ball = this.state.balls[ballId];
        if (!ball)
            return;
        const result = (0, HandSim_1.dropBallFromHand)(player.hands, hand, ball, heldBallPosition(player, hand), dropReleaseVelocity(player.movement.velocity));
        if (!result.ok)
            return;
        this.state.players[player.id] = { ...player, hands: result.hands };
        this.state.balls[ballId] = result.ball;
    }
    dropAllHeldBalls(player) {
        for (const hand of ['left', 'right']) {
            const ballId = player.hands[hand].heldBallId;
            if (!ballId)
                continue;
            const ball = this.state.balls[ballId];
            if (!ball)
                continue;
            const result = (0, HandSim_1.dropBallFromHand)(player.hands, hand, ball, heldBallPosition(player, hand), dropReleaseVelocity(player.movement.velocity));
            if (!result.ok)
                continue;
            player.hands = result.hands;
            this.state.balls[ballId] = result.ball;
        }
    }
    /** Force drops all held balls with a scattering impulse. */
    scatterHeldBalls(player) {
        for (const hand of ['left', 'right']) {
            const ballId = player.hands[hand].heldBallId;
            if (!ballId)
                continue;
            const ball = this.state.balls[ballId];
            if (!ball)
                continue;
            const res = (0, HandSim_1.dropBallFromHand)(player.hands, hand, ball, heldBallPosition(player, hand));
            if (!res.ok)
                continue;
            player.hands = res.hands;
            const angle = Math.random() * Math.PI * 2;
            const speed = 6 + Math.random() * 4;
            res.ball.velocity = (0, CollisionMath_1.vec3)(Math.cos(angle) * speed, 5, Math.sin(angle) * speed);
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
    repairBallHandConsistency() {
        const claims = new Map();
        const duplicateClaims = new Set();
        for (const playerId in this.state.players) {
            const player = this.state.players[playerId];
            for (const hand of ['left', 'right']) {
                const ballId = player.hands[hand].heldBallId;
                if (!ballId)
                    continue;
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
            for (const hand of ['left', 'right']) {
                const ballId = hands[hand].heldBallId;
                if (!ballId)
                    continue;
                const ball = this.state.balls[ballId];
                const duplicated = duplicateClaims.has(ballId);
                const valid = !duplicated &&
                    !!ball &&
                    ball.phase === 'held' &&
                    ball.heldByPlayerId === playerId &&
                    ball.heldHand === hand;
                if (valid)
                    continue;
                hands = clearHeldHand(hands, hand);
                changed = true;
                if (this.debug.NET_DEBUG) {
                    this.logger(`repair cleared hand player=${playerId} hand=${hand} ball=${ballId}` +
                        ` duplicated=${Number(duplicated)} phase=${ball?.phase ?? 'missing'}`);
                }
            }
            if (changed)
                this.state.players[playerId] = { ...player, hands };
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
                this.state.balls[ballId] = (0, BallSim_1.markBallDead)(ball);
                if (this.debug.NET_DEBUG) {
                    this.logger(`repair dropped orphan held-ball ball=${ballId} owner=${ball.heldByPlayerId ?? '-'} hand=${ball.heldHand ?? '-'} duplicated=${Number(duplicateClaims.has(ballId))}`);
                }
                continue;
            }
            if (ball.heldByPlayerId === claim.playerId && ball.heldHand === claim.hand)
                continue;
            this.state.balls[ballId] = (0, BallSim_1.catchBall)(ball, claim.playerId, claim.hand);
            if (this.debug.NET_DEBUG) {
                this.logger(`repair realigned held-ball ball=${ballId} owner=${claim.playerId} hand=${claim.hand}`);
            }
        }
    }
    connectedCount() {
        let count = 0;
        for (const playerId in this.state.players) {
            if (this.state.players[playerId].connected !== false)
                count += 1;
        }
        return count;
    }
    playerCount(players = Object.values(this.state.players)) {
        return players.length;
    }
    connectedTeamIds(exceptPlayerId, players = Object.values(this.state.players)) {
        const teams = new Set();
        for (const player of players) {
            if (player.id === exceptPlayerId || player.connected === false)
                continue;
            teams.add(player.teamId);
        }
        return [...teams];
    }
    connectedTeamCount(players) {
        return this.connectedTeamIds(undefined, players).length;
    }
    hasEnoughConnectedTeamsToPlay(players) {
        return this.connectedTeamCount(players) >= this.teamsRequiredToPlay;
    }
    hasFullRoster(players = Object.values(this.state.players)) {
        return players.length >= this.maxPlayers;
    }
    startMatch() {
        // Begin with a pre-round COUNTDOWN rather than jumping straight to 'playing'. During it the
        // server pins players to spawn (see pinPlayersToSpawn / step) so the round starts cleanly and
        // identically every time — this is also the deterministic post-reset state that fixes the old
        // "everyone stuck after a 1v1 reset" freeze.
        this.state.match = {
            ...this.state.match,
            status: 'countdown',
            countdownSeconds: constants_1.GAME_CONSTANTS.match.countdownSeconds,
            elapsedSeconds: 0,
            winnerTeamId: null,
            boundary: { ...this.state.match.boundary, elapsedSeconds: 0, noBoundaries: false, lastEvent: { type: 'none' } }
        };
    }
    forfeitTo(winnerTeamId) {
        const scoreByTeamId = {
            ...this.state.match.scoreByTeamId,
            [winnerTeamId]: Math.max(this.state.match.scoreByTeamId[winnerTeamId] ?? 0, this.state.match.scoreLimit)
        };
        this.state.match = { ...this.state.match, status: 'complete', winnerTeamId, scoreByTeamId };
    }
    /** Pull the next input to simulate: drained queued batch, else neutral (if stale), else last-held. */
    nextInputCommand(player) {
        const queue = this.inputQueueByPlayerId.get(player.id);
        const queuedCount = queue?.length ?? 0;
        const playerWindow = this.playerNetWindowStats(player.id);
        this.inputDrainMetrics.samples += 1;
        if (queuedCount > this.inputDrainMetrics.maxInputQueueBeforeDrain) {
            this.inputDrainMetrics.maxInputQueueBeforeDrain = queuedCount;
        }
        playerWindow.inputQueueDepthTotal += queuedCount;
        playerWindow.inputQueueDepthSamples += 1;
        if (queuedCount > playerWindow.inputQueueDepthMax)
            playerWindow.inputQueueDepthMax = queuedCount;
        if (queue && queuedCount > 0) {
            const drained = queue.splice(0, queuedCount);
            const command = coalesceQueuedInputs(drained);
            if (command.input.leftCatchAttemptId > 0 ||
                command.input.rightCatchAttemptId > 0 ||
                drained.some((entry) => entry.input.leftCatchAttemptId > 0 || entry.input.rightCatchAttemptId > 0)) {
                const newest = drained[drained.length - 1]?.input;
                this.catchTrace(`input-coalesce player=${player.id} drained=${queuedCount} seq=${command.seq}` +
                    ` resultLeft=${command.input.leftCatchAttemptId} resultRight=${command.input.rightCatchAttemptId}` +
                    ` newestLeft=${newest?.leftCatchAttemptId ?? 0} newestRight=${newest?.rightCatchAttemptId ?? 0}` +
                    ` resultClientTimeMs=${Math.round(command.input.clientTimeMs)}`);
            }
            this.inputDrainMetrics.inputsDrainedTotal += queuedCount;
            if (queuedCount > this.inputDrainMetrics.maxInputsDrainedThisTick) {
                this.inputDrainMetrics.maxInputsDrainedThisTick = queuedCount;
            }
            playerWindow.inputsDrainedTotal += queuedCount;
            playerWindow.inputsDrainedSamples += 1;
            if (queuedCount > playerWindow.inputsDrainedMax)
                playerWindow.inputsDrainedMax = queuedCount;
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
    slotForPlayer(player) {
        const slot = this.playerSlots.find((candidate) => candidate.teamId === player.teamId && candidate.teamSlotIndex === player.teamSlotIndex);
        if (slot)
            return slot;
        const fallback = SPAWN_BASE_BY_SIDE[player.spawnSide];
        return {
            teamId: player.teamId,
            spawnSide: player.spawnSide,
            teamSlotIndex: player.teamSlotIndex,
            position: { ...fallback.position },
            yawRadians: fallback.yawRadians
        };
    }
    nextPlayerSlot() {
        const usedSlots = new Set(Object.values(this.state.players).map((player) => `${player.teamId}:${player.teamSlotIndex}`));
        for (const slot of this.playerSlots) {
            if (!usedSlots.has(`${slot.teamId}:${slot.teamSlotIndex}`))
                return slot;
        }
        return null;
    }
    spawnMovement(slot) {
        return {
            position: { ...slot.position },
            velocity: (0, CollisionMath_1.vec3)(),
            yawRadians: slot.yawRadians,
            pitchRadians: 0,
            facing: (0, MovementSim_1.facingFromAngles)(slot.yawRadians, 0),
            grounded: true,
            crouching: false,
            sliding: false,
            wallRunning: false,
            dashingThisFrame: false,
            speed: 0
        };
    }
    seedInputTracking(playerId, yawRadians) {
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
        if (player)
            player.lastProcessedInputSeq = 0;
        // Fresh defense history + cleared catch-attempt state (reset/respawn/rejoin must not reuse old
        // history across a discontinuity — that would lag-comp against pre-reset positions).
        this.defenseHistoryByPlayerId.set(playerId, new DefenseHistory_1.TimeRing(constants_1.GAME_CONSTANTS.combat.defenseHistoryMs, this.historyMaxSamples()));
        this.catchAttemptByKey.delete(`${playerId}:left`);
        this.catchAttemptByKey.delete(`${playerId}:right`);
        this.lastCatchAttemptIdByKey.set(`${playerId}:left`, 0);
        this.lastCatchAttemptIdByKey.set(`${playerId}:right`, 0);
    }
    createFreshRoomState(players = [], startTick = 0) {
        // All mats stand again on a fresh state / reset; rebuild both collision sets to include them.
        this.knockedOverMatIds.clear();
        this.matRestoreHoldByPlayerId.clear();
        this.matPostResetKnockImmunityById.clear();
        this.playerCollisionBoxes = (0, MapGeometry_1.createPlayerCollisionBoxes)();
        this.ballCollisionBoxes = (0, MapGeometry_1.createBallCollisionBoxes)();
        // Combat history is timeline-specific: a reset is a discontinuity, so drop ball history, any
        // open catch attempts, and undelivered throw events so lag-comp never rewinds across the reset.
        this.ballHistoryById.clear();
        this.catchAttemptByKey.clear();
        this.catchTraceEvalSeen.clear();
        this.recentHitByBallId.clear();
        this.pendingThrowEvents = [];
        const room = (0, MatchSim_1.createRoomState)({
            id: this.roomId,
            // The snapshot tick MUST stay monotonic across a room reset. The client gates reconciliation
            // on `snapshot.tick > lastReconciledTick`; if the tick fell back to 0 here, every post-reset
            // snapshot would fail that guard and the local player would freeze (never re-adopting server
            // state). Carry the running tick forward; resetSerial is what signals a reset to the client.
            tick: startTick,
            players,
            balls: createInitialBalls(this.initialBallCount()),
            startVote: (0, MatchSim_1.createStartVoteState)(),
            resetVote: (0, MatchSim_1.createResetVoteState)({
                requiredVotes: players.filter((player) => player.connected !== false).length,
                resetSerial: this.resetSerial
            })
        });
        const match = (0, RuleSim_1.createMatchState)(this.roomId, [...this.teamIds], {
            mode: this.matchMode,
            playersPerTeam: this.playersPerTeam,
            maxPlayers: this.maxPlayers
        });
        // Fresh room state always returns to warmup. Joins / explicit start votes / auto-start checks
        // drive the next countdown transition so resets and post-game roster changes land in a clean
        // pre-game waiting state instead of silently re-entering the round.
        return {
            ...room,
            match: {
                ...match,
                status: 'warmup',
                countdownSeconds: 0
            }
        };
    }
    initialBallCount() {
        return this.matchMode === '2v2'
            ? constants_1.GAME_CONSTANTS.match.twoVTwoBallCount
            : constants_1.GAME_CONSTANTS.map.ballCount;
    }
}
exports.ServerGameLoop = ServerGameLoop;
function createInitialBalls(ballCount = constants_1.GAME_CONSTANTS.map.ballCount) {
    const spacing = 2;
    const start = -((ballCount - 1) * spacing) / 2;
    const balls = [];
    for (let i = 0; i < ballCount; i += 1) {
        balls.push((0, BallSim_1.createBallState)(`ball_${i}`, (0, CollisionMath_1.vec3)(start + i * spacing, constants_1.GAME_CONSTANTS.ball.radius + 0.05, 0)));
    }
    return balls;
}
function horizontalDistanceSqToSegment(point, a, b) {
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
function buildPlayerSlots(teamIds, playersPerTeam) {
    const slots = [];
    const clampedPerTeam = Math.max(1, playersPerTeam);
    const laneOffsets = clampedPerTeam <= 1
        ? [0]
        : [-1.9, 1.9];
    for (let teamSlotIndex = 0; teamSlotIndex < clampedPerTeam; teamSlotIndex += 1) {
        for (let teamIndex = 0; teamIndex < teamIds.length; teamIndex += 1) {
            const spawnSide = teamIndex % 2 === 0 ? 'negativeZ' : 'positiveZ';
            const base = SPAWN_BASE_BY_SIDE[spawnSide];
            const x = laneOffsets[Math.min(teamSlotIndex, laneOffsets.length - 1)] ?? 0;
            slots.push({
                teamId: teamIds[teamIndex],
                spawnSide,
                teamSlotIndex,
                position: (0, CollisionMath_1.vec3)(x, base.position.y, base.position.z),
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
function resolveBallBounds(ball) {
    const r = constants_1.GAME_CONSTANTS.ball.radius;
    const e = constants_1.GAME_CONSTANTS.ball.bounceRestitution;
    const minX = -constants_1.GAME_CONSTANTS.map.halfWidth + r;
    const maxX = constants_1.GAME_CONSTANTS.map.halfWidth - r;
    const minZ = -constants_1.GAME_CONSTANTS.map.halfLength + r;
    const maxZ = constants_1.GAME_CONSTANTS.map.halfLength - r;
    const maxY = constants_1.GAME_CONSTANTS.map.wallHeight - r;
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
    }
    else if (position.x > maxX) {
        position.x = maxX;
        velocity.x = -Math.abs(velocity.x) * e;
        hitWallOrCeiling = true;
    }
    if (position.z < minZ) {
        position.z = minZ;
        velocity.z = Math.abs(velocity.z) * e;
        hitWallOrCeiling = true;
    }
    else if (position.z > maxZ) {
        position.z = maxZ;
        velocity.z = -Math.abs(velocity.z) * e;
        hitWallOrCeiling = true;
    }
    if (!hitWallOrCeiling && !hitKillNow)
        return ball;
    const resolved = { ...ball, position, velocity };
    // A floor / back-wall contact always wins (kills now). Otherwise it was a side-wall/ceiling-only
    // contact: let the ball survive its first such bounce, die on the second.
    if (hitKillNow)
        return (0, BallSim_1.applyBallBounce)(resolved);
    return applyWallCeilingBounce(resolved);
}
/**
 * Side-wall / ceiling bounce: a live/deflected ball survives its FIRST such bounce and dies on the
 * SECOND. Implemented by counting wall/ceiling bounces in bounceCount and only killing once the
 * count exceeds 1. Non-live phases just advance the count (mirrors applyBallBounce's tail).
 */
function applyWallCeilingBounce(ball) {
    if (ball.phase !== 'live' && ball.phase !== 'deflected') {
        return { ...ball, bounceCount: ball.bounceCount + 1 };
    }
    const bounceCount = ball.bounceCount + 1;
    // Allow exactly one wall/ceiling bounce; the second one kills.
    if (bounceCount > 1) {
        return { ...(0, BallSim_1.markBallDead)(ball), bounceCount };
    }
    return { ...ball, bounceCount };
}
function resolveBallStaticBoxes(ball, boxes, logger) {
    const r = constants_1.GAME_CONSTANTS.ball.radius;
    const e = constants_1.GAME_CONSTANTS.ball.bounceRestitution;
    const position = { ...ball.position };
    const velocity = { ...ball.velocity };
    let bounced = false;
    let hitBox = null;
    let hitAxis = null;
    for (const box of boxes) {
        if (position.x < box.minX - r || position.x > box.maxX + r)
            continue;
        if (position.y < box.minY - r || position.y > box.maxY + r)
            continue;
        if (position.z < box.minZ - r || position.z > box.maxZ + r)
            continue;
        const penX = Math.min(position.x - (box.minX - r), (box.maxX + r) - position.x);
        const penY = Math.min(position.y - (box.minY - r), (box.maxY + r) - position.y);
        const penZ = Math.min(position.z - (box.minZ - r), (box.maxZ + r) - position.z);
        if (penX <= penY && penX <= penZ) {
            position.x = position.x < (box.minX + box.maxX) * 0.5 ? box.minX - r : box.maxX + r;
            velocity.x = (position.x < (box.minX + box.maxX) * 0.5 ? -1 : 1) * Math.abs(velocity.x) * e;
            hitAxis = 'x';
        }
        else if (penY <= penZ) {
            position.y = position.y < (box.minY + box.maxY) * 0.5 ? box.minY - r : box.maxY + r;
            velocity.y = (position.y < (box.minY + box.maxY) * 0.5 ? -1 : 1) * Math.abs(velocity.y) * e;
            hitAxis = 'y';
        }
        else {
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
    if (!bounced)
        return ball;
    const resolvedBall = { ...ball, position, velocity };
    const resolved = isSideWallLikeStaticBounce(hitBox, hitAxis)
        ? applyWallCeilingBounce(resolvedBall)
        : (0, BallSim_1.applyBallBounce)(resolvedBall);
    if (hitBox?.kind === 'bleacher') {
        logger?.(`bleacher collision ball=${ball.id} box=${hitBox.id ?? 'unknown'}` +
            ` axis=${hitAxis ?? 'unknown'}` +
            ` pos=(${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})` +
            ` vel=(${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)})`);
    }
    return resolved;
}
function isSideWallLikeStaticBounce(box, axis) {
    // In the actual gym, the side bleachers occupy the low side-wall lane. A low bank shot hits
    // those X faces before it can reach the arena bounds, so classify that impact like a side wall.
    return axis === 'x' && box?.kind === 'bleacher';
}
const SIDE_BLEACHER_COURT_FACE_X = constants_1.GAME_CONSTANTS.map.halfWidth -
    MapGeometry_1.BLEACHER_LAYOUT.wallInset -
    MapGeometry_1.BLEACHER_LAYOUT.tierCount * MapGeometry_1.BLEACHER_LAYOUT.tierRun -
    constants_1.GAME_CONSTANTS.ball.radius;
function sideBleacherCourtFaceX(box) {
    const centerX = (box.minX + box.maxX) * 0.5;
    return centerX >= 0 ? SIDE_BLEACHER_COURT_FACE_X : -SIDE_BLEACHER_COURT_FACE_X;
}
/**
 * Recompute winner/status from the current scores (used after a lag-comp catch reverts a hit). A
 * team at/over the score limit wins → 'complete'; if a revert dropped the leader back below the
 * limit, an already-'complete' match returns to 'playing'. Other statuses are untouched.
 */
function recomputeMatchOutcome(match) {
    if (match.mode === '2v2')
        return match;
    let winnerTeamId = null;
    for (const teamId of match.teamIds) {
        if ((match.scoreByTeamId[teamId] ?? 0) >= match.scoreLimit) {
            winnerTeamId = teamId;
            break;
        }
    }
    let status = match.status;
    if (winnerTeamId)
        status = 'complete';
    else if (match.status === 'complete')
        status = 'playing';
    return { ...match, winnerTeamId, status };
}
function canScorePlayerHit(ball) {
    if (ball.phase !== 'live')
        return false;
    if (ball.ownerKind !== 'player' || !ball.ownerId)
        return false;
    if (ball.heldByPlayerId || ball.heldHand)
        return false;
    if ((0, CollisionMath_1.length)(ball.velocity) < constants_1.GAME_CONSTANTS.ball.liveHitMinSpeed)
        return false;
    return true;
}
function coalesceQueuedInputs(commands) {
    const newest = commands[commands.length - 1];
    const input = {
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
    let leftCatchClientTimeMs = null;
    let rightCatchClientTimeMs = null;
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
        }
        else if (next.leftCatchAttemptId === input.leftCatchAttemptId &&
            next.leftCatchAttemptId > 0 &&
            leftCatchClientTimeMs === 0 &&
            next.clientTimeMs > 0) {
            leftCatchClientTimeMs = next.clientTimeMs;
        }
        if (next.rightCatchAttemptId > input.rightCatchAttemptId) {
            input.rightCatchAttemptId = next.rightCatchAttemptId;
            rightCatchClientTimeMs = next.clientTimeMs;
        }
        else if (next.rightCatchAttemptId === input.rightCatchAttemptId &&
            next.rightCatchAttemptId > 0 &&
            rightCatchClientTimeMs === 0 &&
            next.clientTimeMs > 0) {
            rightCatchClientTimeMs = next.clientTimeMs;
        }
        if (next.backflipThrowTier > 0)
            input.backflipThrowTier = next.backflipThrowTier;
    }
    // `clientTimeMs` is only used server-side to sub-tick anchor catch attempts. If a catch id came
    // from an earlier packet in the drained batch, keep that earlier click timing rather than the
    // newest movement packet's timestamp.
    const catchTimes = [leftCatchClientTimeMs, rightCatchClientTimeMs].filter((time) => time !== null);
    if (catchTimes.length > 0)
        input.clientTimeMs = Math.min(...catchTimes);
    return { seq: newest.seq, input };
}
function defaultInput(yawRadians = 0) {
    return {
        sequence: 0,
        clientTimeMs: 0,
        moveX: 0,
        moveZ: 0,
        dashDirection: (0, CollisionMath_1.vec3)(),
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
function neutralInput(source) {
    return { ...defaultInput(source.lookYawRadians), lookPitchRadians: source.lookPitchRadians };
}
function normalizeInput(input, fallback = defaultInput()) {
    const legacy = input;
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
        lookPitchRadians: (0, AimMath_1.clampLookPitch)(finiteNumber(input.lookPitchRadians, fallback.lookPitchRadians)),
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
        backflipThrowTier: (0, CollisionMath_1.clamp)(Math.trunc(finiteNumber(input.backflipThrowTier, 0)), 0, constants_1.GAME_CONSTANTS.backflip.qte.tierCount),
        resetSerial: Math.max(0, Math.trunc(finiteNumber(input.resetSerial, fallback.resetSerial))),
        interactHeld: Boolean(input.interactHeld) || legacyPressed(legacy.interact, false)
    };
}
function computeCatchStance(hands, input) {
    return (!hands.left.heldBallId && input.leftHandHeld) || (!hands.right.heldBallId && input.rightHandHeld);
}
function updateHandCharging(hands, input, previousInput) {
    let next = hands;
    next = updateHandCharge(next, 'left', input.leftHandPressed || (input.leftHandHeld && !previousInput.leftHandHeld), input.fakeThrowPressed || input.fakeThrowHeld);
    next = updateHandCharge(next, 'right', input.rightHandPressed || (input.rightHandHeld && !previousInput.rightHandHeld), input.fakeThrowPressed || input.fakeThrowHeld);
    return next;
}
function updateHandCharge(hands, side, pressed, fakeThrow) {
    const hand = hands[side];
    if (!hand.heldBallId)
        return hands;
    if (fakeThrow)
        return (0, HandSim_1.cancelCharge)(hands, side);
    if (pressed)
        return (0, HandSim_1.beginCharge)(hands, side);
    return hands;
}
function heldBallPosition(player, hand) {
    return (0, HandAnchors_1.computePlayerHandAnchor)(player, hand);
}
function dropReleaseVelocity(velocity) {
    return {
        x: velocity.x,
        y: Math.min(velocity.y, 0) - 1.4,
        z: velocity.z
    };
}
/** Return hands with the given hand's lastCatchAttemptId bumped (ack of a received attempt). */
function setHandLastCatchAttemptId(hands, hand, attemptId) {
    return {
        ...hands,
        [hand]: { ...hands[hand], lastCatchAttemptId: attemptId }
    };
}
/** Assign a caught ball to a hand (holding, charge cleared, catch cooldown applied). */
function assignCaughtHand(hands, hand, ballId) {
    return {
        ...hands,
        [hand]: {
            ...hands[hand],
            heldBallId: ballId,
            mode: 'holding',
            chargeSeconds: 0,
            cooldownSeconds: constants_1.GAME_CONSTANTS.catch.cooldownSeconds
        }
    };
}
function clearHeldHand(hands, hand) {
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
function preferredDropHand(player) {
    if (player.hands.right.heldBallId)
        return 'right';
    if (player.hands.left.heldBallId)
        return 'left';
    return null;
}
function finiteNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function clampNumber(value, min, max, fallback) {
    return (0, CollisionMath_1.clamp)(finiteNumber(value, fallback), min, max);
}
function boolOr(primary, legacy, fallback) {
    if (typeof primary === 'boolean')
        return primary;
    if (typeof legacy === 'boolean')
        return legacy;
    return fallback;
}
function legacyPressed(legacyHeld, previousHeld) {
    return typeof legacyHeld === 'boolean' ? legacyHeld && !previousHeld : false;
}
function sanitizeVec3(value, fallback) {
    if (!value)
        return { ...fallback };
    return {
        x: finiteNumber(value.x, fallback.x),
        y: finiteNumber(value.y, fallback.y),
        z: finiteNumber(value.z, fallback.z)
    };
}
/** Clear one-shot edge fields from a held input so fallback ticks don't re-fire them. */
function clearEdges(input) {
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
function sanitizeName(rawName, playerNumber) {
    const trimmed = rawName?.trim();
    if (!trimmed)
        return `Player ${playerNumber}`;
    return trimmed.slice(0, 24);
}
