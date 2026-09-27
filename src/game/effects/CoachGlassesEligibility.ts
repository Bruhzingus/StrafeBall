import { GAME_CONSTANTS } from '../../../shared/constants';
import type { HandSide, PlayerState, RoomState } from '../../../shared/types';

/** The scene calls this only for its own local player and first-person view. */
export function coachGlassesEligible(
  room: RoomState,
  local: PlayerState | null,
  hand: HandSide,
  chargeSeconds: number,
  charging: boolean,
  releasingOrFaking: boolean,
  firstPerson: boolean,
  countdown: boolean
): boolean {
  if (!local || !firstPerson || countdown || !local.connected || local.combatState !== 'alive' || local.lives <= 0 ||
    (room.match.status !== 'playing' && room.match.status !== 'warmup') ||
    room.settings.powerupsEnabled === false || (local.movementInternal.buffs?.coachGlassesSeconds ?? 0) <= 0 ||
    !charging || chargeSeconds < GAME_CONSTANTS.ball.maxChargeSeconds - 0.001 || releasingOrFaking) return false;
  const held = room.balls[local.hands[hand].heldBallId ?? ''];
  return held?.phase === 'held' && held.heldByPlayerId === local.id && (!held.kind || held.kind === 'normal');
}
