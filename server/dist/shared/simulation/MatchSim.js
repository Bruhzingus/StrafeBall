"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMatStates = createMatStates;
exports.createRoomState = createRoomState;
exports.createResetVoteState = createResetVoteState;
exports.createStartVoteState = createStartVoteState;
exports.registerPlayerHit = registerPlayerHit;
const PlayerSim_1 = require("./PlayerSim");
const RuleSim_1 = require("./RuleSim");
const MapGeometry_1 = require("./MapGeometry");
/** Fresh, all-standing mat state keyed by id (the start-of-match / post-reset layout). */
function createMatStates() {
    const mats = {};
    for (const spec of MapGeometry_1.MAT_SPECS) {
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
    return {
        id: options.id ?? 'room',
        tick: options.tick ?? 0,
        match: (0, RuleSim_1.createMatchState)('match', teamIds.length > 0 ? teamIds : ['player', 'opponent']),
        players,
        balls,
        mats: options.mats ?? createMatStates(),
        resetVote: options.resetVote ?? createResetVoteState(),
        startVote: options.startVote ?? createStartVoteState()
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
