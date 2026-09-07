"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RELAY_ERRORS = exports.RELAY_CLOSE = exports.RELAY_TIMEOUT_MS = exports.RELAY_PATH = exports.HOST_CODE_PATTERN = void 0;
exports.isHostCode = isHostCode;
exports.relayErrorMessage = relayErrorMessage;
/** Separate namespace from Colyseus room IDs. Codes are case insensitive. */
exports.HOST_CODE_PATTERN = /^HOST-[A-F0-9]{16}$/;
exports.RELAY_PATH = '/relay';
exports.RELAY_TIMEOUT_MS = 10_000;
exports.RELAY_CLOSE = { expired: 4404, disconnected: 4410, unreachable: 4411, conflict: 4409 };
exports.RELAY_ERRORS = {
    expired: 'Invalid or expired host code. Check the code with your host.',
    disconnected: 'Host disconnected. Ask your host to restart the session, then join again.',
    unreachable: 'Host agent not reachable. Ask your host to keep the agent running and create a match.',
    active: 'A private session is already running. Rejoin its code or close that session before creating another.',
    full: 'This private session is full. Ask your host for an available spot.'
};
function isHostCode(value) {
    return exports.HOST_CODE_PATTERN.test(value.trim().toUpperCase());
}
function relayErrorMessage(error) {
    const code = Number(error?.code);
    if (code === exports.RELAY_CLOSE.expired)
        return exports.RELAY_ERRORS.expired;
    if (code === exports.RELAY_CLOSE.disconnected)
        return exports.RELAY_ERRORS.disconnected;
    const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
    if (Object.values(exports.RELAY_ERRORS).some((value) => value === message))
        return message;
    if (/full|seat|locked/i.test(message))
        return exports.RELAY_ERRORS.full;
    return exports.RELAY_ERRORS.unreachable;
}
