"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expectedPerClientMessagesPerSecond = expectedPerClientMessagesPerSecond;
exports.computeMaxMessagesPerSecondPerClient = computeMaxMessagesPerSecondPerClient;
exports.buildInboundRateLimits = buildInboundRateLimits;
const netConfig_1 = require("../../../shared/netConfig");
const INPUT_BURST_MULTIPLIER = 2;
const INPUT_REFILL_MULTIPLIER = 1.25;
const INPUT_HEADROOM_PER_SECOND = 32;
const PER_CLIENT_OVERHEAD_PER_SECOND = 30;
const MAX_MESSAGES_BURST_MULTIPLIER = 2.5;
const MIN_MAX_MESSAGES_PER_SECOND = 300;
function expectedPerClientMessagesPerSecond(clientInputRate = netConfig_1.CLIENT_INPUT_RATE) {
    return clientInputRate + PER_CLIENT_OVERHEAD_PER_SECOND;
}
function computeMaxMessagesPerSecondPerClient(clientInputRate = netConfig_1.CLIENT_INPUT_RATE) {
    return Math.max(MIN_MAX_MESSAGES_PER_SECOND, Math.ceil(expectedPerClientMessagesPerSecond(clientInputRate) * MAX_MESSAGES_BURST_MULTIPLIER));
}
function buildInboundRateLimits(clientInputRate = netConfig_1.CLIENT_INPUT_RATE) {
    const inputCapacity = Math.max(Math.ceil(clientInputRate * INPUT_BURST_MULTIPLIER), Math.ceil(clientInputRate + INPUT_HEADROOM_PER_SECOND));
    const inputRefillPerSecond = Math.max(Math.ceil(clientInputRate * INPUT_REFILL_MULTIPLIER), Math.ceil(clientInputRate + INPUT_HEADROOM_PER_SECOND));
    const resetLike = { capacity: 2, refillPerSecond: 0.5 };
    return {
        input: { capacity: inputCapacity, refillPerSecond: inputRefillPerSecond },
        throw: { capacity: 8, refillPerSecond: 8 },
        pickup: { capacity: 8, refillPerSecond: 8 },
        'catch-parry': { capacity: 10, refillPerSecond: 10 },
        drop: { capacity: 8, refillPerSecond: 8 },
        reset: resetLike,
        'start-vote': resetLike,
        'switch-team': resetLike,
        ping: { capacity: 4, refillPerSecond: 2 }
    };
}
