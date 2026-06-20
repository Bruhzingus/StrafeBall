"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMatStates = createMatStates;
exports.createRoomState = createRoomState;
exports.createEndVoteState = createEndVoteState;
exports.createIntermissionVoteState = createIntermissionVoteState;
exports.createResetVoteState = createResetVoteState;
exports.createStartVoteState = createStartVoteState;
exports.registerPlayerHit = registerPlayerHit;
const PlayerSim_1 = require("./PlayerSim");
const RuleSim_1 = require("./RuleSim");
const MapGeometry_1 = require("./MapGeometry");
const roomSettings_1 = require("../roomSettings");
/**
 * Fresh, all-standing mat state keyed by id (the start-of-match / post-reset layout). `matSpecs`
 * defaults to the full layout; the server passes the active host-preset subset so authoritative mat
 * state contains only the mats that actually exist for that room.
 */
function createMatStates(matSpecs = MapGeometry_1.MAT_SPECS) {
    const mats = {};
    for (const spec of matSpecs) {
        mats[spec.id] = {
            id: spec.id,
            position: { x: spec.x, y: spec.y, z: spec.z },
            yawRadians: spec.yawRadians,
            knockedOver: false,
            knockDirection: { x: 0, y: 0, z: 0 }
        };
    }
    return mats;
}
function createRoomState(options = {}) {
    const players = {};
    const balls = {};
    for (const player of options.players ?? []) {
        players[player.id] = player;
    }
    for (const ball of options.balls ?? []) {
        balls[ball.id] = ball;
    }
    const teamIds = Array.from(new Set(Object.values(players).map((player) => player.teamId)));
    const settings = options.settings ?? (0, roomSettings_1.defaultRoomSettings)();
    const matchSettings = (0, roomSettings_1.resolveMatchSettings)(settings);
    // Match legacy fields (mode/scoreLimit/playersPerTeam/maxPlayers) are DERIVED from the resolved
    // host settings, so existing consumers that read `match.*` keep working while `settings` is the
    // source of truth. The new per-round knobs (lives/dodgeballs/bounces/etc.) live on `settings`.
    const match = options.match ?? (0, RuleSim_1.createMatchState)('match', teamIds.length > 0 ? teamIds : ['player', 'opponent'], {
        mode: matchSettings.format,
        scoreLimit: matchSettings.scoreLimit,
        playersPerTeam: matchSettings.teamSize,
        maxPlayers: matchSettings.maxPlayers
    });
    return {
        id: options.id ?? 'room',
        tick: options.tick ?? 0,
        hostPlayerId: options.hostPlayerId ?? null,
        phase: options.phase ?? (0, roomSettings_1.roomPhaseFromMatchStatus)(match.status),
        settings,
        match,
        players,
        balls,
        mats: options.mats ?? createMatStates((0, MapGeometry_1.matSpecsForPreset)(settings.matPreset)),
        resetVote: options.resetVote ?? createResetVoteState(),
        startVote: options.startVote ?? createStartVoteState(),
        endVote: options.endVote ?? createEndVoteState(),
        intermissionVote: options.intermissionVote ?? createIntermissionVoteState()
    };
}
function createEndVoteState(overrides = {}) {
    return {
        active: false,
        initiatedByPlayerId: null,
        votesByPlayerId: {},
        voteCount: 0,
        requiredVotes: 0,
        expiresAtMs: null,
        ...overrides
    };
}
function createIntermissionVoteState(overrides = {}) {
    return {
        active: false,
        allowsNextRound: false,
        nextRoundByPlayerId: {},
        nextRoundCount: 0,
        toLobbyByPlayerId: {},
        toLobbyCount: 0,
        requiredVotes: 0,
        nextRoundDeadlineAtMs: null,
        ...overrides
    };
}
function createResetVoteState(overrides = {}) {
    return {
        mode: 'same-teams',
        votesByPlayerId: {},
        voteCount: 0,
        requiredVotes: 0,
        expiresAtMs: null,
        resetSerial: 0,
        ...overrides
    };
}
function createStartVoteState(overrides = {}) {
    return {
        votesByPlayerId: {},
        voteCount: 0,
        requiredVotes: 0,
        expiresAtMs: null,
        teamChoicesByPlayerId: {},
        teamChoiceCount: 0,
        requiredTeamChoices: 0,
        ...overrides
    };
}
function registerPlayerHit(room, scorerPlayerId, value = 1) {
    const player = room.players[scorerPlayerId];
    if (!player)
        return room;
    return {
        ...room,
        match: (0, RuleSim_1.applyScore)(room.match, player.teamId, value),
        players: {
            ...room.players,
            [scorerPlayerId]: {
                ...player,
                dash: (0, PlayerSim_1.grantDashCharge)(player.dash)
            }
        }
    };
}
