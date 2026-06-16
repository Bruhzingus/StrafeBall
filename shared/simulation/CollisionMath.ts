import type { Vec3 } from '../types';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPSILON = 0.00001;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3, amount: number): Vec3 {
  return { x: v.x * amount, y: v.y * amount, z: v.z * amount };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

export function lengthSquared(v: Vec3): number {
  return dot(v, v);
}

export function length(v: Vec3): number {
  return Math.sqrt(lengthSquared(v));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(subtract(a, b));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function saturate(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function normalize(v: Vec3, fallback: Vec3 = vec3()): Vec3 {
  const len = length(v);
  if (len <= EPSILON) return cloneVec3(fallback);
  return scale(v, 1 / len);
}

export function angleBetweenDegrees(a: Vec3, b: Vec3): number {
  const aLength = length(a);
  const bLength = length(b);
  if (aLength <= EPSILON || bLength <= EPSILON) return 180;
  const cosine = clamp(dot(a, b) / (aLength * bLength), -1, 1);
  return Math.acos(cosine) * RAD2DEG;
}

export function isWithinCone(origin: Vec3, forward: Vec3, target: Vec3, coneDegrees: number, maxRange?: number): boolean {
  const toTarget = subtract(target, origin);
  if (lengthSquared(toTarget) <= EPSILON) return true;
  if (maxRange !== undefined && length(toTarget) > maxRange) return false;
  return angleBetweenDegrees(forward, toTarget) <= coneDegrees;
}

export function distXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function isMovingToward(origin: Vec3, velocity: Vec3, target: Vec3, minDot = 0.35): boolean {
  const toTarget = subtract(target, origin);
  const toTargetLengthSq = lengthSquared(toTarget);
  const velocityLengthSq = lengthSquared(velocity);
  if (toTargetLengthSq <= EPSILON || velocityLengthSq <= EPSILON) return false;
  return dot(toTarget, velocity) / Math.sqrt(toTargetLengthSq * velocityLengthSq) > minDot;
}

/**
 * Closest point on segment [a, b] to point p. Used for swept cone checks: instead of testing
 * only the ball's current position, we find where along the ball's path it was closest to the
 * cone origin, giving correct catch/parry checks even when a fast ball crosses the cone in one
 * tick without landing on a tick boundary inside it.
 */
export function closestPointOnSegment(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const ab = subtract(b, a);
  const abLenSq = dot(ab, ab);
  if (abLenSq <= EPSILON) return cloneVec3(a);
  const t = clamp(dot(subtract(p, a), ab) / abLenSq, 0, 1);
  return add(a, scale(ab, t));
}

/**
 * True if the swept ball path [ballPrev → ballCurr] passes within `coneDegrees` of `forward`
 * as seen from `origin`, AND the closest approach point is within `maxRange`. Uses the closest
 * point on the segment so fast balls that cross the cone in a single tick are still caught.
 */
export function sweptSegmentInCone(
  origin: Vec3,
  forward: Vec3,
  ballPrev: Vec3,
  ballCurr: Vec3,
  coneDegrees: number,
  maxRange: number
): boolean {
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
export function closestDistanceBetweenSegments(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = subtract(q1, p1);
  const d2 = subtract(q2, p2);
  const r = subtract(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);

  let s: number;
  let t: number;

  if (a <= EPSILON && e <= EPSILON) {
    return length(r);
  }
  if (a <= EPSILON) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const cValue = dot(d1, r);
    if (e <= EPSILON) {
      t = 0;
      s = clamp(-cValue / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - cValue * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-cValue / a, 0, 1);
      } else if (t > 1) {
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
export function sweptBallHitsBody(ballPrev: Vec3, ballCurr: Vec3, bodyBase: Vec3, bodyTop: Vec3, radius: number): boolean {
  return closestDistanceBetweenSegments(ballPrev, ballCurr, bodyBase, bodyTop) <= radius;
}
