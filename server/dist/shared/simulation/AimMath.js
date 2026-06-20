"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clampLookPitch = clampLookPitch;
exports.facingFromAngles = facingFromAngles;
exports.backflipPitchOffset = backflipPitchOffset;
exports.lookVectorsFromAngles = lookVectorsFromAngles;
const constants_1 = require("../constants");
const CollisionMath_1 = require("./CollisionMath");
function clampLookPitch(pitchRadians, constants = constants_1.GAME_CONSTANTS) {
    return (0, CollisionMath_1.clamp)(pitchRadians, -constants.player.lookPitchLimitRadians, constants.player.lookPitchLimitRadians);
}
function facingFromAngles(yawRadians, pitchRadians, constants = constants_1.GAME_CONSTANTS) {
    const pitch = clampLookPitch(pitchRadians, constants);
    const pitchCos = Math.cos(pitch);
    const x = Math.sin(yawRadians) * pitchCos;
    const y = -Math.sin(pitch);
    const z = Math.cos(yawRadians) * pitchCos;
    return (0, CollisionMath_1.normalize)({ x, y, z }, (0, CollisionMath_1.vec3)(0, 0, 1));
}
/**
 * Camera pitch offset (radians) for the backflip view tumble. Rotates a full 2π backward over the
 * flip duration with smoothstep easing so the start/end line up with the normal view. Returns 0
 * when not flipping. Lives here (shared) so online (predicted) and offline use identical math and
 * neither the client scene nor the player controller need to import the other.
 */
function backflipPitchOffset(active, timer, constants = constants_1.GAME_CONSTANTS) {
    if (!active)
        return 0;
    const progress = (0, CollisionMath_1.clamp)(timer / constants.backflip.durationSeconds, 0, 1);
    const eased = progress * progress * (3 - 2 * progress);
    // Negative = pitch backward (look up then over). A full revolution returns to the original pitch.
    return -eased * Math.PI * 2;
}
function lookVectorsFromAngles(yawRadians, pitchRadians, constants = constants_1.GAME_CONSTANTS) {
    const forward = facingFromAngles(yawRadians, pitchRadians, constants);
    const yawRight = (0, CollisionMath_1.vec3)(Math.cos(yawRadians), 0, -Math.sin(yawRadians));
    const right = (0, CollisionMath_1.normalize)((0, CollisionMath_1.cross)((0, CollisionMath_1.vec3)(0, 1, 0), forward), yawRight);
    const up = (0, CollisionMath_1.normalize)((0, CollisionMath_1.cross)(forward, right), (0, CollisionMath_1.vec3)(0, 1, 0));
    return { forward, right, up };
}
