import { Matrix, Vector3, Camera } from '@babylonjs/core';
import { safeNormalize } from './math';

export function yawForward(yawRadians: number): Vector3 {
  return new Vector3(Math.sin(yawRadians), 0, Math.cos(yawRadians));
}

export function yawRight(yawRadians: number): Vector3 {
  return new Vector3(Math.cos(yawRadians), 0, -Math.sin(yawRadians));
}

export function cameraForward(camera: Camera): Vector3 {
  return camera.getForwardRay(1).direction.normalizeToNew();
}

export function movementWishDirection(yawRadians: number, x: number, z: number): Vector3 {
  const forward = yawForward(yawRadians);
  const right = yawRight(yawRadians);
  return safeNormalize(forward.scale(z).add(right.scale(x)));
}

export function airStrafeWishDirection(yawRadians: number, x: number): Vector3 {
  if (Math.abs(x) <= 0.001) return Vector3.Zero();
  return yawRight(yawRadians).scale(x > 0 ? 1 : -1);
}
