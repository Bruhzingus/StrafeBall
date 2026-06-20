"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHandState = createHandState;
exports.createHands = createHands;
exports.heldBallCount = heldBallCount;
exports.getFirstOpenHand = getFirstOpenHand;
exports.validatePickup = validatePickup;
exports.tryPickupBall = tryPickupBall;
exports.beginCharge = beginCharge;
exports.cancelCharge = cancelCharge;
exports.tickHands = tickHands;
exports.validateThrowFromHand = validateThrowFromHand;
exports.throwBallFromHand = throwBallFromHand;
exports.dropBallFromHand = dropBallFromHand;
exports.isInCatchCone = isInCatchCone;
exports.catchBallInHand = catchBallInHand;
exports.isInParryCone = isInParryCone;
exports.autoParryBall = autoParryBall;
exports.sweptCatchFailReason = sweptCatchFailReason;
exports.sweptParryFailReason = sweptParryFailReason;
exports.aimForwardFromYaw = aimForwardFromYaw;
const constants_1 = require("../constants");
const BallSim_1 = require("./BallSim");
const CollisionMath_1 = require("./CollisionMath");
function createHandState(side, overrides = {}) {
    return {
        side,
        heldBallId: null,
        mode: 'empty',
        chargeSeconds: 0,
        cooldownSeconds: 0,
        catchTrackingSecondsByBallId: {},
        lastCatchAttemptId: 0,
        ...overrides
    };
}
function createHands(overrides = {}) {
    return {
        left: overrides.left ?? createHandState('left'),
        right: overrides.right ?? createHandState('right')
    };
}
function heldBallCount(hands) {
    return (hands.left.heldBallId ? 1 : 0) + (hands.right.heldBallId ? 1 : 0);
}
function getFirstOpenHand(hands) {
    if (!hands.left.heldBallId)
        return 'left';
    if (!hands.right.heldBallId)
        return 'right';
    return null;
}
function validatePickup(player, hands, ball, constants = constants_1.GAME_CONSTANTS) {
    if (heldBallCount(hands) >= constants.ball.maxHeldBalls)
        return { ok: false, reason: 'hands-full' };
    if (!(0, BallSim_1.isBallPickupEligible)(ball, player.movement.position, constants))
        return { ok: false, reason: 'ball-not-pickup-eligible' };
    return { ok: true };
}
function tryPickupBall(player, hands, ball, constants = constants_1.GAME_CONSTANTS) {
    const validation = validatePickup(player, hands, ball, constants);
    if (!validation.ok)
        return validation;
    const side = getFirstOpenHand(hands);
    if (!side)
        return { ok: false, reason: 'hands-full' };
    return {
        ok: true,
        hand: side,
        hands: setHandHolding(hands, side, ball.id),
        ball: (0, BallSim_1.holdBall)(ball, player.id, side)
    };
}
function beginCharge(hands, side) {
    const hand = hands[side];
    if (!hand.heldBallId)
        return hands;
    return replaceHand(hands, side, { ...hand, mode: 'charging', chargeSeconds: 0 });
}
function cancelCharge(hands, side) {
    const hand = hands[side];
    if (!hand.heldBallId)
        return hands;
    return replaceHand(hands, side, { ...hand, mode: 'holding', chargeSeconds: 0 });
}
function tickHands(hands, dt, constants = constants_1.GAME_CONSTANTS) {
    return {
        left: tickHand(hands.left, dt, constants),
        right: tickHand(hands.right, dt, constants)
    };
}
function validateThrowFromHand(player, hands, side, ball) {
    const hand = hands[side];
    if (!hand.heldBallId)
        return { ok: false, reason: 'empty-hand' };
    if (hand.heldBallId !== ball.id)
        return { ok: false, reason: 'hand-ball-mismatch' };
    const validation = (0, BallSim_1.throwHeldBall)(ball, {
        playerId: player.id,
        hand: side,
        origin: ball.position,
        velocity: ball.velocity
    });
    if (!validation.ok)
        return validation;
    return { ok: true };
}
function throwBallFromHand(player, hands, side, ball, request) {
    const hand = hands[side];
    if (!hand.heldBallId)
        return { ok: false, reason: 'empty-hand' };
    if (hand.heldBallId !== ball.id)
        return { ok: false, reason: 'hand-ball-mismatch' };
    const thrown = (0, BallSim_1.throwHeldBall)(ball, {
        ...request,
        playerId: player.id,
        hand: side
    });
    if (!thrown.ok)
        return thrown;
    return {
        ok: true,
        hands: clearHand(hands, side),
        ball: thrown.ball
    };
}
function dropBallFromHand(hands, side, ball, position, velocity = (0, CollisionMath_1.vec3)(0, -1.4, 0)) {
    const hand = hands[side];
    if (!hand.heldBallId)
        return { ok: false, reason: 'empty-hand' };
    if (hand.heldBallId !== ball.id)
        return { ok: false, reason: 'hand-ball-mismatch' };
    return {
        ok: true,
        hands: clearHand(hands, side),
        ball: (0, BallSim_1.dropHeldBall)(ball, position, velocity)
    };
}
function isInCatchCone(playerPosition, aimForward, ball, constants = constants_1.GAME_CONSTANTS) {
    return (0, CollisionMath_1.isWithinCone)(playerPosition, aimForward, ball.position, constants.catch.coneDegrees, constants.catch.rangeMeters);
}
function catchBallInHand(player, hands, side, ball, aimForward, 
// Cone origin — pass the eye position so a chest-height ball aimed at horizontally is in-cone
// (defaults to the feet position for backward compatibility).
origin = player.movement.position, constants = constants_1.GAME_CONSTANTS) {
    const hand = hands[side];
    if (hand.heldBallId)
        return { ok: false, reason: 'hand-full' };
    if (hand.cooldownSeconds > 0)
        return { ok: false, reason: 'catch-cooldown' };
    if (!(0, BallSim_1.isBallCatchableInFlight)(ball, constants))
        return { ok: false, reason: 'not-live' };
    if (ball.ownerId !== null && ball.ownerId === player.id && ball.bounceCount <= 0)
        return { ok: false, reason: 'not-live' };
    if (!isInCatchCone(origin, aimForward, ball, constants))
        return { ok: false, reason: 'outside-catch-cone' };
    return {
        ok: true,
        hands: replaceHand(hands, side, {
            ...hand,
            heldBallId: ball.id,
            mode: 'holding',
            chargeSeconds: 0,
            cooldownSeconds: constants.catch.cooldownSeconds
        }),
        ball: (0, BallSim_1.catchBall)(ball, player.id, side)
    };
}
function isInParryCone(playerPosition, aimForward, ball, constants = constants_1.GAME_CONSTANTS) {
    const coneDegrees = ball.isSuper ? constants.catch.superParryConeDegrees : constants.parry.coneDegrees;
    return (0, CollisionMath_1.isWithinCone)(playerPosition, aimForward, ball.position, coneDegrees, constants.parry.rangeMeters);
}
function autoParryBall(player, hands, ball, aimForward, parryCooldownSeconds, origin = player.movement.position, constants = constants_1.GAME_CONSTANTS) {
    if (heldBallCount(hands) < constants.ball.maxHeldBalls)
        return { ok: false, reason: 'hands-not-full' };
    if (parryCooldownSeconds > 0)
        return { ok: false, reason: 'parry-cooldown' };
    if (ball.phase !== 'live')
        return { ok: false, reason: 'not-live' };
    if (!isInParryCone(origin, aimForward, ball, constants))
        return { ok: false, reason: 'outside-parry-cone' };
    return {
        ok: true,
        ball: (0, BallSim_1.deflectBall)(ball, player.id, (0, CollisionMath_1.normalize)(aimForward, (0, CollisionMath_1.vec3)(0, 0, 1)), constants),
        parryCooldownSeconds: constants.parry.cooldownSeconds
    };
}
function sweptCatchFailReason(request, constants = constants_1.GAME_CONSTANTS) {
    if (request.timing) {
        if (request.timing.nowMs < request.timing.openedAtMs + request.timing.startupMs)
            return 'too-early';
        if (request.timing.nowMs > request.timing.activeUntilMs)
            return 'too-late';
    }
    if (!request.handEmpty)
        return 'no-empty-hand';
    if ((request.handCooldownSeconds ?? 0) > 0)
        return 'catch-cooldown';
    if (request.dashing)
        return 'dashing';
    if (!(0, BallSim_1.isBallCatchableInFlight)(request.ball, constants))
        return 'ball-not-live';
    if (request.ball.ownerId !== null && request.ball.ownerId === request.defenderPlayerId && request.ball.bounceCount <= 0)
        return 'owner-invalid';
    const closest = (0, CollisionMath_1.closestPointOnSegment)(request.segmentStart, request.segmentEnd, request.origin);
    if ((0, CollisionMath_1.distance)(request.origin, closest) > constants.catch.rangeMeters)
        return 'out-of-range';
    if (!(0, CollisionMath_1.sweptSegmentInCone)(request.origin, request.forward, request.segmentStart, request.segmentEnd, constants.catch.coneDegrees, constants.catch.rangeMeters)) {
        return 'angle-too-wide';
    }
    return null;
}
function sweptParryFailReason(request, constants = constants_1.GAME_CONSTANTS) {
    if (request.heldBallCount < constants.ball.maxHeldBalls)
        return 'no-two-balls';
    if (request.parryCooldownSeconds > 0)
        return 'parry-cooldown';
    if (request.ball.phase !== 'live')
        return 'ball-not-live';
    if (request.ball.ownerId !== null && request.ball.ownerId === request.defenderPlayerId)
        return 'owner-invalid';
    const coneDegrees = request.ball.isSuper ? constants.catch.superParryConeDegrees : constants.parry.coneDegrees;
    const closest = (0, CollisionMath_1.closestPointOnSegment)(request.segmentStart, request.segmentEnd, request.origin);
    if ((0, CollisionMath_1.distance)(request.origin, closest) > constants.parry.rangeMeters)
        return 'out-of-range';
    if (!(0, CollisionMath_1.sweptSegmentInCone)(request.origin, request.forward, request.segmentStart, request.segmentEnd, coneDegrees, constants.parry.rangeMeters)) {
        return 'angle-too-wide';
    }
    return null;
}
function tickHand(hand, dt, constants) {
    return {
        ...hand,
        cooldownSeconds: Math.max(0, hand.cooldownSeconds - dt),
        chargeSeconds: hand.mode === 'charging'
            ? Math.min(constants.ball.maxChargeSeconds, hand.chargeSeconds + dt)
            : hand.chargeSeconds
    };
}
function setHandHolding(hands, side, ballId) {
    return replaceHand(hands, side, {
        ...hands[side],
        heldBallId: ballId,
        mode: 'holding',
        chargeSeconds: 0,
        cooldownSeconds: 0,
        catchTrackingSecondsByBallId: {}
    });
}
function clearHand(hands, side) {
    return replaceHand(hands, side, {
        ...hands[side],
        heldBallId: null,
        mode: 'empty',
        chargeSeconds: 0,
        catchTrackingSecondsByBallId: {}
    });
}
function replaceHand(hands, side, hand) {
    const cleanHand = {
        ...hand,
        side,
        catchTrackingSecondsByBallId: { ...hand.catchTrackingSecondsByBallId }
    };
    return {
        left: side === 'left' ? cleanHand : cloneHand(hands.left),
        right: side === 'right' ? cleanHand : cloneHand(hands.right)
    };
}
function cloneHand(hand) {
    return {
        ...hand,
        catchTrackingSecondsByBallId: { ...hand.catchTrackingSecondsByBallId }
    };
}
function aimForwardFromYaw(yawRadians) {
    return (0, CollisionMath_1.cloneVec3)({ x: Math.sin(yawRadians), y: 0, z: Math.cos(yawRadians) });
}
