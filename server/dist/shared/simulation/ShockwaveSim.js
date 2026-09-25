"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shockwaveFalloff = shockwaveFalloff;
exports.shockwavePlayerVelocity = shockwavePlayerVelocity;
exports.shockwaveBallVelocity = shockwaveBallVelocity;
const constants_1 = require("../constants");
const EPSILON = 1e-6;
function horizontalDirection(dx, dz, fallback) {
    const distance = Math.hypot(dx, dz);
    if (distance > EPSILON)
        return { x: dx / distance, z: dz / distance };
    const fallbackDistance = Math.hypot(fallback.x, fallback.z);
    if (fallbackDistance > EPSILON)
        return { x: fallback.x / fallbackDistance, z: fallback.z / fallbackDistance };
    return { x: 0, z: 1 };
}
/** Full power at the blast center, falling linearly to zero at its outer radius. */
function shockwaveFalloff(distance, radius) {
    if (!Number.isFinite(distance) || !Number.isFinite(radius) || radius <= 0)
        return 0;
    return Math.max(0, 1 - Math.max(0, distance) / radius);
}
/**
 * Player shockwaves add to existing momentum. In particular, an already-rising jump contributes its
 * vertical speed to the blast, making a well-timed point-blank jump capable of crossing the court.
 * Downward velocity is discarded so a shockwave always launches rather than merely slowing a fall.
 */
function shockwavePlayerVelocity(position, velocity, blastPosition, fallbackDirection, c = constants_1.GAME_CONSTANTS) {
    const dx = position.x - blastPosition.x;
    const dy = position.y + c.player.height / 2 - blastPosition.y;
    const dz = position.z - blastPosition.z;
    const falloff = shockwaveFalloff(Math.hypot(dx, dy, dz), c.powerup.shockRadius);
    if (falloff <= 0)
        return null;
    const direction = horizontalDirection(dx, dz, fallbackDirection);
    return {
        x: velocity.x + direction.x * c.powerup.shockPlayerSpeed * falloff,
        y: Math.max(0, velocity.y) + c.powerup.shockPlayerLift * falloff,
        z: velocity.z + direction.z * c.powerup.shockPlayerSpeed * falloff
    };
}
/** Loose balls are redirected radially rather than preserving their pre-blast path. */
function shockwaveBallVelocity(position, blastPosition, fallbackDirection, c = constants_1.GAME_CONSTANTS) {
    const dx = position.x - blastPosition.x;
    const dy = position.y - blastPosition.y;
    const dz = position.z - blastPosition.z;
    const falloff = shockwaveFalloff(Math.hypot(dx, dy, dz), c.powerup.shockRadius);
    if (falloff <= 0)
        return null;
    const direction = horizontalDirection(dx, dz, fallbackDirection);
    return {
        x: direction.x * c.powerup.shockBallSpeed * falloff,
        y: c.powerup.shockBallLift * falloff,
        z: direction.z * c.powerup.shockBallSpeed * falloff
    };
}
