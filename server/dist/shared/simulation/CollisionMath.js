"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EPSILON = exports.RAD2DEG = exports.DEG2RAD = void 0;
exports.vec3 = vec3;
exports.cloneVec3 = cloneVec3;
exports.add = add;
exports.subtract = subtract;
exports.scale = scale;
exports.dot = dot;
exports.cross = cross;
exports.lengthSquared = lengthSquared;
exports.length = length;
exports.distance = distance;
exports.clamp = clamp;
exports.saturate = saturate;
exports.lerp = lerp;
exports.normalize = normalize;
exports.angleBetweenDegrees = angleBetweenDegrees;
exports.isWithinCone = isWithinCone;
exports.distXZ = distXZ;
exports.isMovingToward = isMovingToward;
exports.closestPointOnSegment = closestPointOnSegment;
exports.sweptSegmentInCone = sweptSegmentInCone;
exports.closestDistanceBetweenSegments = closestDistanceBetweenSegments;
exports.sweptBallHitsBody = sweptBallHitsBody;
exports.DEG2RAD = Math.PI / 180;
exports.RAD2DEG = 180 / Math.PI;
exports.EPSILON = 0.00001;
function vec3(x = 0, y = 0, z = 0) {
    return { x, y, z };
}
function cloneVec3(v) {
    return { x: v.x, y: v.y, z: v.z };
}
function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function subtract(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(v, amount) {
    return { x: v.x * amount, y: v.y * amount, z: v.z * amount };
}
function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x
    };
}
function lengthSquared(v) {
    return dot(v, v);
}
function length(v) {
    return Math.sqrt(lengthSquared(v));
}
function distance(a, b) {
    return length(subtract(a, b));
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function saturate(value) {
    return clamp(value, 0, 1);
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
function normalize(v, fallback = vec3()) {
    const len = length(v);
    if (len <= exports.EPSILON)
        return cloneVec3(fallback);
    return scale(v, 1 / len);
}
function angleBetweenDegrees(a, b) {
    const aLength = length(a);
    const bLength = length(b);
    if (aLength <= exports.EPSILON || bLength <= exports.EPSILON)
        return 180;
    const cosine = clamp(dot(a, b) / (aLength * bLength), -1, 1);
    return Math.acos(cosine) * exports.RAD2DEG;
}
function isWithinCone(origin, forward, target, coneDegrees, maxRange) {
    const toTarget = subtract(target, origin);
    if (lengthSquared(toTarget) <= exports.EPSILON)
        return true;
    if (maxRange !== undefined && length(toTarget) > maxRange)
        return false;
    return angleBetweenDegrees(forward, toTarget) <= coneDegrees;
}
function distXZ(a, b) {
    const dx = a.x - b.x, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}
function isMovingToward(origin, velocity, target, minDot = 0.35) {
    const toTarget = subtract(target, origin);
    const toTargetLengthSq = lengthSquared(toTarget);
    const velocityLengthSq = lengthSquared(velocity);
    if (toTargetLengthSq <= exports.EPSILON || velocityLengthSq <= exports.EPSILON)
        return false;
    return dot(toTarget, velocity) / Math.sqrt(toTargetLengthSq * velocityLengthSq) > minDot;
}
/**
 * Closest point on segment [a, b] to point p. Used for swept cone checks: instead of testing
 * only the ball's current position, we find where along the ball's path it was closest to the
 * cone origin, giving correct catch/parry checks even when a fast ball crosses the cone in one
 * tick without landing on a tick boundary inside it.
 */
function closestPointOnSegment(a, b, p) {
    const ab = subtract(b, a);
    const abLenSq = dot(ab, ab);
    if (abLenSq <= exports.EPSILON)
        return cloneVec3(a);
    const t = clamp(dot(subtract(p, a), ab) / abLenSq, 0, 1);
    return add(a, scale(ab, t));
}
/**
 * True if the swept ball path [ballPrev → ballCurr] passes within `coneDegrees` of `forward`
 * as seen from `origin`, AND the closest approach point is within `maxRange`. Uses the closest
 * point on the segment so fast balls that cross the cone in a single tick are still caught.
 */
function sweptSegmentInCone(origin, forward, ballPrev, ballCurr, coneDegrees, maxRange) {
    const closest = closestPointOnSegment(ballPrev, ballCurr, origin);
    return isWithinCone(origin, forward, closest, coneDegrees, maxRange);
}
/**
 * Shortest distance between two line segments [p1,q1] and [p2,q2] (Ericson, Real-Time Collision
 * Detection). Used for swept hit detection: one segment is the ball's path this tick, the other
 * is the target's vertical body axis. This is what makes both headshots register (the body axis
 * spans feet→head, not a single mid-height point) AND stops fast balls tunnelling between ticks
 * (we test the whole swept path, not just the end position).
 */
function closestDistanceBetweenSegments(p1, q1, p2, q2) {
    const d1 = subtract(q1, p1);
    const d2 = subtract(q2, p2);
    const r = subtract(p1, p2);
    const a = dot(d1, d1);
    const e = dot(d2, d2);
    const f = dot(d2, r);
    let s;
    let t;
    if (a <= exports.EPSILON && e <= exports.EPSILON) {
        return length(r);
    }
    if (a <= exports.EPSILON) {
        s = 0;
        t = clamp(f / e, 0, 1);
    }
    else {
        const cValue = dot(d1, r);
        if (e <= exports.EPSILON) {
            t = 0;
            s = clamp(-cValue / a, 0, 1);
        }
        else {
            const b = dot(d1, d2);
            const denom = a * e - b * b;
            s = denom !== 0 ? clamp((b * f - cValue * e) / denom, 0, 1) : 0;
            t = (b * s + f) / e;
            if (t < 0) {
                t = 0;
                s = clamp(-cValue / a, 0, 1);
            }
            else if (t > 1) {
                t = 1;
                s = clamp((b - cValue) / a, 0, 1);
            }
        }
    }
    const c1 = add(p1, scale(d1, s));
    const c2 = add(p2, scale(d2, t));
    return distance(c1, c2);
}
/**
 * True if a ball travelling from `ballPrev` to `ballCurr` this tick comes within `radius` of an
 * upright body capsule whose axis runs from `bodyBase` (feet) to `bodyTop` (head). `radius`
 * should be the combined ball + body radius.
 */
function sweptBallHitsBody(ballPrev, ballCurr, bodyBase, bodyTop, radius) {
    return closestDistanceBetweenSegments(ballPrev, ballCurr, bodyBase, bodyTop) <= radius;
}
