import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { HandSide, PlayerState, Vec3 } from '../types';
import { add, scale, vec3 } from './CollisionMath';
import { lookVectorsFromAngles } from './AimMath';

export interface HandAnchorOptions {
  horizontalOffset?: number;
  forwardOffset?: number;
  verticalOffset?: number;
  originHeight?: number;
}

export interface HandAnchors {
  left: Vec3;
  right: Vec3;
}

const DEFAULT_HAND_ANCHOR: Required<HandAnchorOptions> = {
  horizontalOffset: 0.36,
  forwardOffset: 0.56,
  verticalOffset: -0.36,
  originHeight: GAME_CONSTANTS.player.eyeHeight
};

export function computePlayerHandAnchor(
  player: Pick<PlayerState, 'movement'>,
  hand: HandSide,
  options: HandAnchorOptions = {},
  constants: GameConstants = GAME_CONSTANTS
): Vec3 {
  const config = { ...DEFAULT_HAND_ANCHOR, ...options };
  const movement = player.movement;
  const { forward, right, up } = lookVectorsFromAngles(movement.yawRadians, movement.pitchRadians, constants);
  const sideSign = hand === 'left' ? -1 : 1;
  const origin = add(movement.position, vec3(0, config.originHeight, 0));

  return add(
    add(origin, scale(right, sideSign * config.horizontalOffset)),
    add(scale(forward, config.forwardOffset), scale(up, config.verticalOffset))
  );
}

export function computePlayerHandAnchors(
  player: Pick<PlayerState, 'movement'>,
  options: HandAnchorOptions = {},
  constants: GameConstants = GAME_CONSTANTS
): HandAnchors {
  return {
    left: computePlayerHandAnchor(player, 'left', options, constants),
    right: computePlayerHandAnchor(player, 'right', options, constants)
  };
}
