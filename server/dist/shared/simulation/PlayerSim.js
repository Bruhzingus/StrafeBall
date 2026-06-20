"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDashState = createDashState;
exports.createPlayerState = createPlayerState;
exports.createPlayerMatchStats = createPlayerMatchStats;
exports.createMovementInternalState = createMovementInternalState;
exports.advanceDashState = advanceDashState;
exports.canSpendDashCharge = canSpendDashCharge;
exports.spendDashCharge = spendDashCharge;
exports.grantDashCharge = grantDashCharge;
exports.calculateDashVelocity = calculateDashVelocity;
exports.tryDash = tryDash;
exports.tryUpwardDash = tryUpwardDash;
const constants_1 = require("../constants");
const HandSim_1 = require("./HandSim");
const CollisionMath_1 = require("./CollisionMath");
function createDashState(overrides = {}, constants = constants_1.GAME_CONSTANTS) {
    return {
        charges: constants.dash.maxCharges,
        rechargeTimerSeconds: 0,
        cooldownSeconds: 0,
        ...overrides
    };
}
function createPlayerState(id, teamId, legalHalf = 'negativeZ', overrides = {}) {
    const spawnSide = overrides.spawnSide ?? legalHalf;
    const base = {
        id,
        name: overrides.name ?? id,
        teamId,
        spawnSide,
        teamSlotIndex: overrides.teamSlotIndex ?? 0,
        legalHalf,
        movement: {
            position: (0, CollisionMath_1.vec3)(),
            velocity: (0, CollisionMath_1.vec3)(),
            yawRadians: 0,
            pitchRadians: 0,
            facing: (0, CollisionMath_1.vec3)(0, 0, 1),
            grounded: true,
            crouching: false,
            sliding: false,
            wallRunning: false,
            dashingThisFrame: false,
            speed: 0
        },
        movementInternal: createMovementInternalState(),
        hands: (0, HandSim_1.createHands)(),
        dash: createDashState(),
        score: 0,
        matchStats: createPlayerMatchStats(),
        lives: overrides.lives ?? constants_1.GAME_CONSTANTS.match.playerLives,
        combatState: overrides.combatState ?? 'alive',
        eliminatedAtMs: overrides.eliminatedAtMs ?? null,
        lastPlayerBuffUntilMs: overrides.lastPlayerBuffUntilMs ?? null,
        connected: true,
        reconnectDeadlineAtMs: overrides.reconnectDeadlineAtMs ?? null,
        lastProcessedInputSeq: 0
    };
    return {
        ...base,
        ...overrides,
        id,
        teamId,
        legalHalf,
        movement: {
            ...base.movement,
            ...overrides.movement,
            position: (0, CollisionMath_1.cloneVec3)(overrides.movement?.position ?? base.movement.position),
            velocity: (0, CollisionMath_1.cloneVec3)(overrides.movement?.velocity ?? base.movement.velocity),
            facing: (0, CollisionMath_1.cloneVec3)(overrides.movement?.facing ?? base.movement.facing)
        },
        movementInternal: overrides.movementInternal
            ? { ...base.movementInternal, ...overrides.movementInternal }
            : base.movementInternal,
        hands: overrides.hands ?? base.hands,
        dash: overrides.dash ? { ...base.dash, ...overrides.dash } : base.dash,
        matchStats: overrides.matchStats ? { ...base.matchStats, ...overrides.matchStats } : base.matchStats,
        lastProcessedInputSeq: overrides.lastProcessedInputSeq ?? base.lastProcessedInputSeq
    };
}
function createPlayerMatchStats(overrides = {}) {
    return {
        hits: 0,
        hitsTaken: 0,
        catches: 0,
        parries: 0,
        saves: 0,
        ...overrides
    };
}
function createMovementInternalState(overrides = {}) {
    return {
        slideTimer: 0,
        slideBufferTimer: 0,
        jumpGraceTimer: 0,
        wallRunTimer: 0,
        wallReattachCooldown: 0,
        dashActiveTimer: 0,
        doubleJumpAvailable: true,
        catchBoostTimer: 0,
        groundHeight: 0,
        lastWallNormalX: 0,
        lastWallNormalZ: 0,
        backflipActive: false,
        backflipTimer: 0,
        backflipCooldown: 0,
        ...overrides
    };
}
function advanceDashState(dash, dt, constants = constants_1.GAME_CONSTANTS, cooldownRateScale = 1) {
    const scaledDt = dt * cooldownRateScale;
    const cooldownSeconds = Math.max(0, dash.cooldownSeconds - scaledDt);
    if (dash.charges >= constants.dash.maxCharges) {
        return {
            ...dash,
            charges: constants.dash.maxCharges,
            rechargeTimerSeconds: 0,
            cooldownSeconds
        };
    }
    let charges = dash.charges;
    let rechargeTimerSeconds = dash.rechargeTimerSeconds + scaledDt;
    while (charges < constants.dash.maxCharges && rechargeTimerSeconds >= constants.dash.rechargeSeconds) {
        charges += 1;
        rechargeTimerSeconds -= constants.dash.rechargeSeconds;
    }
    if (charges >= constants.dash.maxCharges)
        rechargeTimerSeconds = 0;
    return {
        charges,
        rechargeTimerSeconds,
        cooldownSeconds
    };
}
function canSpendDashCharge(dash) {
    return dash.charges > 0 && dash.cooldownSeconds <= 0;
}
function spendDashCharge(dash, constants = constants_1.GAME_CONSTANTS) {
    if (!canSpendDashCharge(dash))
        return null;
    return {
        charges: dash.charges - 1,
        rechargeTimerSeconds: dash.rechargeTimerSeconds,
        cooldownSeconds: constants.dash.cooldownBetweenDashes
    };
}
function grantDashCharge(dash, constants = constants_1.GAME_CONSTANTS) {
    return {
        charges: Math.min(constants.dash.maxCharges, dash.charges + 1),
        rechargeTimerSeconds: dash.charges + 1 >= constants.dash.maxCharges ? 0 : dash.rechargeTimerSeconds,
        cooldownSeconds: dash.cooldownSeconds
    };
}
function calculateDashVelocity(currentVelocity, dashDirection, constants = constants_1.GAME_CONSTANTS, movementScale = 1) {
    const direction = (0, CollisionMath_1.normalize)(dashDirection);
    if ((0, CollisionMath_1.lengthSquared)(direction) <= 0)
        return (0, CollisionMath_1.cloneVec3)(currentVelocity);
    const impulseScale = sanitizeMovementScale(movementScale);
    const currentHorizontal = (0, CollisionMath_1.vec3)(currentVelocity.x, 0, currentVelocity.z);
    const currentSpeed = (0, CollisionMath_1.length)(currentHorizontal);
    const normalizedCurrent = currentSpeed > 0.001 ? (0, CollisionMath_1.scale)(currentHorizontal, 1 / currentSpeed) : direction;
    const sameDirection = (0, CollisionMath_1.dot)(normalizedCurrent, direction) >= constants.dash.similarDirectionDot;
    if (sameDirection) {
        return (0, CollisionMath_1.add)(currentVelocity, (0, CollisionMath_1.scale)(direction, constants.dash.impulse * impulseScale));
    }
    // Against momentum: retain more of the opposing velocity AND weaken the dash impulse, so a
    // reverse-dash can't snap you to full speed the other way instantly.
    return (0, CollisionMath_1.add)((0, CollisionMath_1.scale)(currentVelocity, constants.dash.oppositeDirectionMomentumPenalty), (0, CollisionMath_1.scale)(direction, constants.dash.impulse * constants.dash.oppositeDirectionImpulseScale * impulseScale));
}
function tryDash(dash, currentVelocity, dashDirection, constants = constants_1.GAME_CONSTANTS, movementScale = 1) {
    if ((0, CollisionMath_1.lengthSquared)(dashDirection) <= 0.001)
        return { ok: false };
    const nextDash = spendDashCharge(dash, constants);
    if (!nextDash)
        return { ok: false };
    return {
        ok: true,
        dash: nextDash,
        velocity: calculateDashVelocity(currentVelocity, dashDirection, constants, movementScale)
    };
}
function tryUpwardDash(dash, currentVelocity, constants = constants_1.GAME_CONSTANTS, movementScale = 1) {
    const nextDash = spendDashCharge(dash, constants);
    if (!nextDash)
        return { ok: false };
    const impulseScale = sanitizeMovementScale(movementScale);
    return {
        ok: true,
        dash: nextDash,
        velocity: {
            ...currentVelocity,
            y: Math.max(currentVelocity.y, constants.dash.upwardImpulse * impulseScale)
        }
    };
}
function sanitizeMovementScale(scaleValue) {
    return Number.isFinite(scaleValue) ? Math.max(0.05, scaleValue) : 1;
}
