"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBallState = createBallState;
exports.isBallPickupStateEligible = isBallPickupStateEligible;
exports.isBallCatchableInFlight = isBallCatchableInFlight;
exports.isBallPickupEligible = isBallPickupEligible;
exports.holdBall = holdBall;
exports.markBallDead = markBallDead;
exports.dropHeldBall = dropHeldBall;
exports.validateThrowBall = validateThrowBall;
exports.throwHeldBall = throwHeldBall;
exports.catchBall = catchBall;
exports.deflectBall = deflectBall;
exports.applyBallBounce = applyBallBounce;
exports.applyMatBounce = applyMatBounce;
exports.settleBallIfSlow = settleBallIfSlow;
exports.curveRampFactor = curveRampFactor;
exports.advanceBall = advanceBall;
const constants_1 = require("../constants");
const CollisionMath_1 = require("./CollisionMath");
function createBallState(id, position = (0, CollisionMath_1.vec3)(), overrides = {}) {
    const base = {
        id,
        phase: 'loose',
        position: (0, CollisionMath_1.cloneVec3)(position),
        velocity: (0, CollisionMath_1.vec3)(),
        ownerKind: null,
        ownerId: null,
        heldByPlayerId: null,
        heldHand: null,
        bounceCount: 0,
        isSuper: false,
        dropScale: 1,
        curveAccel: (0, CollisionMath_1.vec3)(),
        curveDistance: 0,
        lastTouchedByPlayerId: null,
        throwId: 0
    };
    return {
        ...base,
        ...overrides,
        id,
        position: (0, CollisionMath_1.cloneVec3)(overrides.position ?? position),
        velocity: (0, CollisionMath_1.cloneVec3)(overrides.velocity ?? base.velocity),
        curveAccel: (0, CollisionMath_1.cloneVec3)(overrides.curveAccel ?? base.curveAccel)
    };
}
function isBallPickupStateEligible(ball, constants = constants_1.GAME_CONSTANTS) {
    if (ball.phase === 'held')
        return false;
    if (ball.phase === 'loose' || ball.phase === 'dead')
        return true;
    return (0, CollisionMath_1.length)(ball.velocity) <= constants.ball.slowPickupSpeed;
}
/**
 * Whether a ball is in a CATCHABLE in-flight state. A 'live' or 'deflected' ball is always catchable.
 * A ball that has bounced (off floor/back-wall/bleachers) is marked 'dead' — it can no longer score
 * a hit — but while it is still moving fast enough to be airborne/playable, it stays catchable no
 * matter how many times it has bounced. This does NOT affect scoring: a dead ball never scores
 * regardless (see canScorePlayerHit).
 */
function isBallCatchableInFlight(ball, constants = constants_1.GAME_CONSTANTS) {
    if (ball.phase === 'live' || ball.phase === 'deflected')
        return true;
    if (ball.phase !== 'dead')
        return false;
    return ((0, CollisionMath_1.length)(ball.velocity) >= constants.catch.bouncedCatchMinSpeed);
}
function isBallPickupEligible(ball, playerPosition, constants = constants_1.GAME_CONSTANTS) {
    if (!isBallPickupStateEligible(ball, constants))
        return false;
    // Use XZ + vertical separately: a ball at the player's feet on the floor should be
    // reachable even if the 3D distance is inflated by height difference, and a ball at
    // the same XZ but far above should not be reachable via floor pickup.
    if ((0, CollisionMath_1.distXZ)(ball.position, playerPosition) > constants.ball.pickupRadius)
        return false;
    if (Math.abs(ball.position.y - playerPosition.y) > constants.ball.pickupVerticalTolerance)
        return false;
    return true;
}
function holdBall(ball, playerId, hand) {
    return {
        ...ball,
        phase: 'held',
        velocity: (0, CollisionMath_1.vec3)(),
        ownerKind: 'player',
        ownerId: playerId,
        heldByPlayerId: playerId,
        heldHand: hand,
        bounceCount: 0,
        isSuper: false,
        dropScale: 1,
        curveAccel: (0, CollisionMath_1.vec3)(),
        curveDistance: 0,
        lastTouchedByPlayerId: playerId
    };
}
function markBallDead(ball, velocity = ball.velocity) {
    return {
        ...ball,
        phase: 'dead',
        velocity: (0, CollisionMath_1.cloneVec3)(velocity),
        ownerKind: null,
        ownerId: null,
        heldByPlayerId: null,
        heldHand: null,
        isSuper: false
    };
}
function dropHeldBall(ball, position, velocity = (0, CollisionMath_1.vec3)(0, -1.4, 0)) {
    return {
        ...markBallDead(ball, velocity),
        position: (0, CollisionMath_1.cloneVec3)(position),
        bounceCount: 1
    };
}
function validateThrowBall(ball, playerId, hand) {
    if (ball.phase !== 'held')
        return { ok: false, reason: 'ball-not-held' };
    if (ball.heldByPlayerId !== playerId)
        return { ok: false, reason: 'wrong-player' };
    if (ball.heldHand !== hand)
        return { ok: false, reason: 'wrong-hand' };
    return { ok: true };
}
function throwHeldBall(ball, request) {
    const validation = validateThrowBall(ball, request.playerId, request.hand);
    if (!validation.ok)
        return validation;
    return {
        ok: true,
        ball: {
            ...ball,
            phase: 'live',
            position: (0, CollisionMath_1.cloneVec3)(request.origin),
            velocity: (0, CollisionMath_1.cloneVec3)(request.velocity),
            ownerKind: request.ownerKind ?? 'player',
            ownerId: request.playerId,
            heldByPlayerId: null,
            heldHand: null,
            bounceCount: 0,
            isSuper: request.isSuper ?? false,
            dropScale: request.dropScale ?? 1,
            curveAccel: (0, CollisionMath_1.cloneVec3)(request.curveAccel ?? (0, CollisionMath_1.vec3)()),
            curveDistance: 0,
            lastTouchedByPlayerId: request.playerId,
            throwId: request.throwId ?? ball.throwId
        }
    };
}
function catchBall(ball, playerId, hand) {
    return holdBall(ball, playerId, hand);
}
function deflectBall(ball, defenderPlayerId, forward, constants = constants_1.GAME_CONSTANTS, throwId) {
    const incomingSpeed = (0, CollisionMath_1.length)(ball.velocity);
    const deflectForward = (0, CollisionMath_1.normalize)(forward, (0, CollisionMath_1.vec3)(0, 0, 1));
    const deflectedVelocity = (0, CollisionMath_1.add)((0, CollisionMath_1.scale)(deflectForward, incomingSpeed * constants.parry.deflectSpeedMultiplier), (0, CollisionMath_1.vec3)(0, constants.parry.deflectUpVelocity, 0));
    return {
        ...ball,
        phase: 'deflected',
        velocity: deflectedVelocity,
        ownerKind: 'player',
        ownerId: defenderPlayerId,
        heldByPlayerId: null,
        heldHand: null,
        bounceCount: 0,
        isSuper: false,
        curveAccel: (0, CollisionMath_1.vec3)(),
        curveDistance: 0,
        lastTouchedByPlayerId: defenderPlayerId,
        // A deflect is a new live identity — bump throwId so the client snaps its prediction.
        throwId: throwId ?? ball.throwId
    };
}
function applyBallBounce(ball, bounceRule, constants = constants_1.GAME_CONSTANTS) {
    if (ball.phase !== 'live' && ball.phase !== 'deflected') {
        return { ...ball, bounceCount: ball.bounceCount + 1 };
    }
    const bounceCount = ball.bounceCount + 1;
    const deadAfterBounces = ball.phase === 'deflected'
        ? bounceRule?.deflectedDeadAfterBounces ?? constants.ball.deflectedDeadAfterBounces
        : bounceRule?.deadAfterBounces ?? constants.ball.deadAfterBounces;
    if (bounceCount >= deadAfterBounces) {
        return {
            ...markBallDead(ball),
            bounceCount
        };
    }
    return {
        ...ball,
        bounceCount
    };
}
/**
 * Bounce off a mat (standing cover OR a knocked-over mat lying flat). A mat reflects the ball but
 * NEVER kills it: a live ball stays live (a deflected ball stays deflected), so it can still score
 * and be caught. A mat is the ONLY surface that keeps a ball alive after a floor-level bounce —
 * every other surface (floor, back walls, bleachers) still kills via applyBallBounce. bounceCount is
 * incremented so the throw's first-flight curve/drop ends and impact effects fire, but the phase is
 * intentionally left untouched.
 */
function applyMatBounce(ball) {
    return { ...ball, bounceCount: ball.bounceCount + 1 };
}
function settleBallIfSlow(ball, constants = constants_1.GAME_CONSTANTS) {
    if (ball.phase !== 'dead' || (0, CollisionMath_1.length)(ball.velocity) >= constants.ball.settleSpeed)
        return ball;
    return {
        ...ball,
        phase: 'loose',
        velocity: (0, CollisionMath_1.vec3)(),
        ownerKind: null,
        ownerId: null,
        heldByPlayerId: null,
        heldHand: null,
        isSuper: false
    };
}
/**
 * Smooth 0→1 ramp for the crouch curve: flat zero until `curveStartDistance` meters into the
 * flight, then a smoothstep rise to full strength over the next `curveRampDistance` meters. Short
 * ramp distance = a sharp snap into the curve; longer = a gentler build-up.
 */
function curveRampFactor(distanceTraveled, constants) {
    const { curveStartDistance, curveRampDistance } = constants.ball;
    const t = Math.max(0, Math.min(1, (distanceTraveled - curveStartDistance) / curveRampDistance));
    return t * t * (3 - 2 * t);
}
function advanceBall(ball, dt, constants = constants_1.GAME_CONSTANTS) {
    if (ball.phase !== 'live' && ball.phase !== 'dead' && ball.phase !== 'loose' && ball.phase !== 'deflected')
        return ball;
    const firstLiveFlight = ball.phase === 'live' && ball.bounceCount === 0;
    const gravityScale = firstLiveFlight ? ball.dropScale : 1;
    const velocityWithGravity = (0, CollisionMath_1.add)(ball.velocity, (0, CollisionMath_1.vec3)(0, -constants.ball.gravity * gravityScale * dt, 0));
    const rampFactor = firstLiveFlight ? curveRampFactor(ball.curveDistance, constants) : 0;
    let velocity = firstLiveFlight
        ? (0, CollisionMath_1.add)(velocityWithGravity, (0, CollisionMath_1.scale)(ball.curveAccel, rampFactor * dt))
        : velocityWithGravity;
    // Apply floor friction to dead/loose balls resting on or near the ground so they don't
    // slide forever. Only damp the XZ plane when the ball is on the floor (y ≈ radius).
    if ((ball.phase === 'dead' || ball.phase === 'loose') && ball.position.y <= constants.ball.radius + 0.05) {
        const friction = constants.ball.looseFriction;
        const frictionFactor = Math.max(0, 1 - friction * dt);
        velocity = (0, CollisionMath_1.vec3)(velocity.x * frictionFactor, velocity.y, velocity.z * frictionFactor);
    }
    return {
        ...ball,
        velocity,
        position: (0, CollisionMath_1.add)(ball.position, (0, CollisionMath_1.scale)(velocity, dt)),
        curveDistance: firstLiveFlight ? ball.curveDistance + (0, CollisionMath_1.length)((0, CollisionMath_1.scale)(velocity, dt)) : ball.curveDistance
    };
}
