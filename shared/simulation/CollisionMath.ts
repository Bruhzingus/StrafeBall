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

export function isMovingToward(origin: Vec3, velocity: Vec3, target: Vec3, minDot = 0.35): boolean {
  const toTarget = subtract(target, origin);
  const toTargetLengthSq = lengthSquared(toTarget);
  const velocityLengthSq = lengthSquared(velocity);
  if (toTargetLengthSq <= EPSILON || velocityLengthSq <= EPSILON) return false;
  return dot(toTarget, velocity) / Math.sqrt(toTargetLengthSq * velocityLengthSq) > minDot;
}
