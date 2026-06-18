import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { PlayerMovementState, PlayerState, Vec3 } from '../types';

export interface PlayerHitCapsule {
  base: Vec3;
  top: Vec3;
  radius: number;
  height: number;
}

export function playerBodyHeight(
  movement: Pick<PlayerMovementState, 'crouching' | 'sliding'>,
  constants: GameConstants = GAME_CONSTANTS
): number {
  if (movement.sliding) return constants.player.height * constants.slide.heightScale;
  return movement.crouching ? constants.player.height * constants.player.crouchHeightMultiplier : constants.player.height;
}

export function playerAimOriginHeight(
  movement: Pick<PlayerMovementState, 'crouching' | 'sliding'>,
  constants: GameConstants = GAME_CONSTANTS
): number {
  if (movement.sliding) return constants.player.eyeHeight * constants.slide.heightScale;
  return movement.crouching ? constants.player.eyeHeight * constants.player.crouchHeightMultiplier : constants.player.eyeHeight;
}

export function playerHitCapsule(
  player: Pick<PlayerState, 'movement'>,
  constants: GameConstants = GAME_CONSTANTS
): PlayerHitCapsule {
  const base = player.movement.position;
  const height = playerBodyHeight(player.movement, constants);
  return {
    base: { x: base.x, y: base.y, z: base.z },
    top: { x: base.x, y: base.y + height, z: base.z },
    radius: constants.player.radius,
    height
  };
}

export function playerBallHitRadius(constants: GameConstants = GAME_CONSTANTS): number {
  return constants.player.radius + constants.ball.radius;
}
