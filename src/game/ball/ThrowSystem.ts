import { Vector3 } from '@babylonjs/core';
import { HandSide } from './BallState';
import { calculateThrow } from '../../../shared/simulation/ThrowMath';

export interface ThrowRequest {
  hand: HandSide;
  cameraForward: Vector3;
  playerVelocity: Vector3;
  charge01: number;
  isCrouching: boolean;
  isSliding: boolean;
  isWallRunning: boolean;
  isDashing: boolean;
  backflipTier: number;
  fastDoubleThrowPenalty: boolean;
}

export interface ThrowResult {
  velocity: Vector3;
  isSuper: boolean;
  dropScale: number;
  curveAccel: Vector3;
}

export class ThrowSystem {
  calculateThrow(request: ThrowRequest): ThrowResult {
    const result = calculateThrow({
      hand: request.hand,
      forward: toSharedVec3(request.cameraForward),
      playerVelocity: toSharedVec3(request.playerVelocity),
      charge01: request.charge01,
      crouching: request.isCrouching || request.isSliding,
      backflipTier: request.backflipTier,
      fastDoubleThrowPenalty: request.fastDoubleThrowPenalty
    });

    return {
      velocity: toBabylonVector(result.velocity),
      isSuper: result.isSuper,
      dropScale: result.dropScale,
      curveAccel: toBabylonVector(result.curveAccel)
    };
  }
}

function toSharedVec3(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

function toBabylonVector(v: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}
