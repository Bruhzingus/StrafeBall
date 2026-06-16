import type { BallState, MatState, PlayerState, ResetVoteState, RoomState } from '../types';
import { grantDashCharge } from './PlayerSim';
import { applyScore, createMatchState } from './RuleSim';
import { MAT_SPECS } from './MapGeometry';

/** Fresh, all-standing mat state keyed by id (the start-of-match / post-reset layout). */
export function createMatStates(): Record<string, MatState> {
  const mats: Record<string, MatState> = {};
  for (const spec of MAT_SPECS) {
    mats[spec.id] = {
      id: spec.id,
      position: { x: spec.x, y: spec.y, z: spec.z },
      yawRadians: spec.yawRadians,
      knockedOver: false,
      knockDirection: { x: 0, y: 0, z: 0 }
    };
  }
  return mats;
}

export function createRoomState(options: {
  id?: string;
  tick?: number;
  players?: PlayerState[];
  balls?: BallState[];
  mats?: Record<string, MatState>;
  resetVote?: ResetVoteState;
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
    balls,
    mats: options.mats ?? createMatStates(),
    resetVote: options.resetVote ?? createResetVoteState()
  };
}

export function createResetVoteState(overrides: Partial<ResetVoteState> = {}): ResetVoteState {
  return {
    votesByPlayerId: {},
    voteCount: 0,
    requiredVotes: 0,
    expiresAtMs: null,
    resetSerial: 0,
    ...overrides
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
