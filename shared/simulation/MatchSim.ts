import type { BallState, PlayerState, RoomState } from '../types';
import { grantDashCharge } from './PlayerSim';
import { applyScore, createMatchState } from './RuleSim';

export function createRoomState(options: {
  id?: string;
  tick?: number;
  players?: PlayerState[];
  balls?: BallState[];
} = {}): RoomState {
  const players: Record<string, PlayerState> = {};
  const balls: Record<string, BallState> = {};

  for (const player of options.players ?? []) {
    players[player.id] = player;
  }

  for (const ball of options.balls ?? []) {
    balls[ball.id] = ball;
  }

  const teamIds = Array.from(new Set(Object.values(players).map((player) => player.teamId)));

  return {
    id: options.id ?? 'room',
    tick: options.tick ?? 0,
    match: createMatchState('match', teamIds.length > 0 ? teamIds : ['player', 'opponent']),
    players,
    balls
  };
}

export function registerPlayerHit(room: RoomState, scorerPlayerId: string, value = 1): RoomState {
  const player = room.players[scorerPlayerId];
  if (!player) return room;

  return {
    ...room,
    match: applyScore(room.match, player.teamId, value),
    players: {
      ...room.players,
      [scorerPlayerId]: {
        ...player,
        dash: grantDashCharge(player.dash)
      }
    }
  };
}
