"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.playerBodyHeight = playerBodyHeight;
exports.playerAimOriginHeight = playerAimOriginHeight;
exports.playerHitCapsule = playerHitCapsule;
exports.playerBallHitRadius = playerBallHitRadius;
const constants_1 = require("../constants");
function playerBodyHeight(movement, constants = constants_1.GAME_CONSTANTS) {
    if (movement.sliding)
        return constants.player.height * constants.slide.heightScale;
    return movement.crouching ? constants.player.height * constants.player.crouchHeightMultiplier : constants.player.height;
}
function playerAimOriginHeight(movement, constants = constants_1.GAME_CONSTANTS) {
    if (movement.sliding)
        return constants.player.eyeHeight * constants.slide.heightScale;
    return movement.crouching ? constants.player.eyeHeight * constants.player.crouchHeightMultiplier : constants.player.eyeHeight;
}
function playerHitCapsule(player, constants = constants_1.GAME_CONSTANTS) {
    const base = player.movement.position;
    const height = playerBodyHeight(player.movement, constants);
    return {
        base: { x: base.x, y: base.y, z: base.z },
        top: { x: base.x, y: base.y + height, z: base.z },
        radius: constants.player.radius,
        height
    };
}
function playerBallHitRadius(constants = constants_1.GAME_CONSTANTS) {
    return constants.player.radius + constants.ball.radius;
}
