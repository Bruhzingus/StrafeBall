"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computePlayerHandAnchor = computePlayerHandAnchor;
exports.computePlayerHandAnchors = computePlayerHandAnchors;
const constants_1 = require("../constants");
const CollisionMath_1 = require("./CollisionMath");
const AimMath_1 = require("./AimMath");
const PlayerHitbox_1 = require("./PlayerHitbox");
const DEFAULT_HAND_ANCHOR = {
    horizontalOffset: 0.36,
    forwardOffset: 0.56,
    verticalOffset: -0.36
};
function computePlayerHandAnchor(player, hand, options = {}, constants = constants_1.GAME_CONSTANTS) {
    const config = { ...DEFAULT_HAND_ANCHOR, ...options };
    const movement = player.movement;
    const { forward, right, up } = (0, AimMath_1.lookVectorsFromAngles)(movement.yawRadians, movement.pitchRadians, constants);
    const sideSign = hand === 'left' ? -1 : 1;
    const originHeight = options.originHeight ?? (0, PlayerHitbox_1.playerAimOriginHeight)(movement, constants);
    const origin = (0, CollisionMath_1.add)(movement.position, (0, CollisionMath_1.vec3)(0, originHeight, 0));
    return (0, CollisionMath_1.add)((0, CollisionMath_1.add)(origin, (0, CollisionMath_1.scale)(right, sideSign * config.horizontalOffset)), (0, CollisionMath_1.add)((0, CollisionMath_1.scale)(forward, config.forwardOffset), (0, CollisionMath_1.scale)(up, config.verticalOffset)));
}
function computePlayerHandAnchors(player, options = {}, constants = constants_1.GAME_CONSTANTS) {
    return {
        left: computePlayerHandAnchor(player, 'left', options, constants),
        right: computePlayerHandAnchor(player, 'right', options, constants)
    };
}
