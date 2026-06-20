"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toWireInput = toWireInput;
/** Vectors at or below this length are treated as "no dash direction" — matches the sim's EPS. */
const WIRE_DASH_DIRECTION_EPS = 0.001;
/**
 * Encode a PlayerInput for the wire, omitting `dashDirection` when it is effectively zero. A zero
 * dash direction carries no information: the sim ignores dashDirection on non-dash ticks entirely,
 * and on a dash tick a zero/absent direction makes it fall back to the wish/facing direction — the
 * exact behavior a zero vector already produces. The local prediction copy keeps the full input
 * untouched (only the transmitted object is trimmed), so reconciliation is unaffected.
 */
function toWireInput(input) {
    const { dashDirection, ...rest } = input;
    const dx = dashDirection?.x ?? 0;
    const dz = dashDirection?.z ?? 0;
    if (Math.hypot(dx, dz) <= WIRE_DASH_DIRECTION_EPS)
        return rest;
    return { ...rest, dashDirection };
}
