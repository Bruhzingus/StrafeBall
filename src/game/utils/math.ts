import { Vector3 } from '@babylonjs/core';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function saturate(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function approach(current: number, target: number, amount: number): number {
  if (current < target) return Math.min(current + amount, target);
  if (current > target) return Math.max(current - amount, target);
  return target;
}

export function angleBetweenDegrees(a: Vector3, b: Vector3): number {
  const an = a.normalizeToNew();
  const bn = b.normalizeToNew();
  const dot = clamp(Vector3.Dot(an, bn), -1, 1);
  return Math.acos(dot) * RAD2DEG;
}

export function horizontal(v: Vector3): Vector3 {
  return new Vector3(v.x, 0, v.z);
}

export function safeNormalize(v: Vector3, fallback = Vector3.Zero()): Vector3 {
  const len = v.length();
  if (len <= 0.00001) return fallback.clone();
  return v.scale(1 / len);
}

export function projectOnPlane(v: Vector3, normal: Vector3): Vector3 {
  return v.subtract(normal.scale(Vector3.Dot(v, normal)));
}
