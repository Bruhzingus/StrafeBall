"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.catchRecoilForVelocity = catchRecoilForVelocity;
const constants_1 = require("../constants");
/**
 * Cosmetic catch knockback shared by first-person and remote rendering. Ordinary quick throws are
 * intentionally below the cutoff; only a genuinely hard incoming ball produces recoil.
 */
function catchRecoilForVelocity(incomingVelocity, constants = constants_1.GAME_CONSTANTS) {
    const horizontalSpeed = Math.hypot(incomingVelocity.x, incomingVelocity.z);
    if (horizontalSpeed <= 0.001)
        return null;
    const speed = Math.hypot(incomingVelocity.x, incomingVelocity.y, incomingVelocity.z);
    const recoil = constants.catch;
    if (speed < recoil.momentumRecoilMinSpeed)
        return null;
    const range = Math.max(0.001, recoil.momentumRecoilMaxSpeed - recoil.momentumRecoilMinSpeed);
    const strength = Math.max(0, Math.min(1, (speed - recoil.momentumRecoilMinSpeed) / range));
    const distance = recoil.momentumRecoilMinDistance +
        (recoil.momentumRecoilMaxDistance - recoil.momentumRecoilMinDistance) * strength;
    return {
        directionX: incomingVelocity.x / horizontalSpeed,
        directionZ: incomingVelocity.z / horizontalSpeed,
        distance,
        strength
    };
}
