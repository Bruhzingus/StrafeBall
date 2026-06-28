"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toWireInput = toWireInput;
// The historical comment above talks about dashDirection because that was the first trim. The type
// now also supports previous-input delta packets for the high-frequency input stream.
/** Vectors at or below this length are treated as "no dash direction" — matches the sim's EPS. */
const WIRE_DASH_DIRECTION_EPS = 0.001;
/**
 * Encode a PlayerInput for the wire, omitting `dashDirection` when it is effectively zero. A zero
 * dash direction carries no information: the sim ignores dashDirection on non-dash ticks entirely,
 * and on a dash tick a zero/absent direction makes it fall back to the wish/facing direction — the
 * exact behavior a zero vector already produces. The local prediction copy keeps the full input
 * untouched (only the transmitted object is trimmed), so reconciliation is unaffected.
 */
function toWireInput(input, previous) {
    const { sequence: _sequence, clientTimeMs: _clientTimeMs, dashDirection, ...rest } = input;
    const dx = dashDirection?.x ?? 0;
    const dz = dashDirection?.z ?? 0;
    const hasDashDirection = input.dashPressed && Math.hypot(dx, dz) > WIRE_DASH_DIRECTION_EPS;
    if (!previous) {
        return hasDashDirection ? { ...rest, dashDirection } : rest;
    }
    const wire = {
        lookYawRadians: input.lookYawRadians,
        lookPitchRadians: input.lookPitchRadians
    };
    copyChangedInputField(wire, input, previous, 'moveX');
    copyChangedInputField(wire, input, previous, 'moveZ');
    copyChangedInputField(wire, input, previous, 'jumpHeld');
    copyChangedInputField(wire, input, previous, 'crouchHeld');
    copyChangedInputField(wire, input, previous, 'slideHeld');
    copyChangedInputField(wire, input, previous, 'fakeThrowHeld');
    copyChangedInputField(wire, input, previous, 'leftHandHeld');
    copyChangedInputField(wire, input, previous, 'rightHandHeld');
    copyChangedInputField(wire, input, previous, 'resetSerial');
    copyChangedInputField(wire, input, previous, 'interactHeld');
    copyEdgeInputField(wire, input, previous, 'jumpPressed');
    copyEdgeInputField(wire, input, previous, 'dashPressed');
    copyEdgeInputField(wire, input, previous, 'crouchPressed');
    copyEdgeInputField(wire, input, previous, 'slidePressed');
    copyEdgeInputField(wire, input, previous, 'backflipPressed');
    copyEdgeInputField(wire, input, previous, 'pickupPressed');
    copyEdgeInputField(wire, input, previous, 'dropPressed');
    copyEdgeInputField(wire, input, previous, 'fakeThrowPressed');
    copyEdgeInputField(wire, input, previous, 'leftHandPressed');
    copyEdgeInputField(wire, input, previous, 'rightHandPressed');
    copyEdgeInputField(wire, input, previous, 'leftHandReleased');
    copyEdgeInputField(wire, input, previous, 'rightHandReleased');
    copyLatchedNumberInputField(wire, input, previous, 'leftCatchAttemptId');
    copyLatchedNumberInputField(wire, input, previous, 'rightCatchAttemptId');
    copyLatchedNumberInputField(wire, input, previous, 'backflipThrowTier');
    if (hasDashDirection)
        wire.dashDirection = dashDirection;
    return wire;
}
function copyChangedInputField(wire, input, previous, key) {
    if (input[key] !== previous[key]) {
        wire[key] = input[key];
    }
}
function copyEdgeInputField(wire, input, previous, key) {
    if (input[key] === true || input[key] !== previous[key]) {
        wire[key] = input[key];
    }
}
function copyLatchedNumberInputField(wire, input, previous, key) {
    const value = input[key];
    if (value !== 0 || value !== previous[key]) {
        wire[key] = value;
    }
}
