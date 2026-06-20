import type { BallState, EndVoteState, IntermissionVoteState, MatState, PlayerState, ResetVoteState, RoomLifecyclePhase, RoomSettings, RoomState, StartVoteState } from '../types';
import { grantDashCharge } from './PlayerSim';
import { applyScore, createMatchState } from './RuleSim';
import { MAT_SPECS, matSpecsForPreset } from './MapGeometry';
import { defaultRoomSettings, resolveMatchSettings, roomPhaseFromMatchStatus } from '../roomSettings';

/**
 * Fresh, all-standing mat state keyed by id (the start-of-match / post-reset layout). `matSpecs`
 * defaults to the full layout; the server passes the active host-preset subset so authoritative mat
 * state contains only the mats that actually exist for that room.
 */
export function createMatStates(matSpecs: readonly typeof MAT_SPECS[number][] = MAT_SPECS): Record<string, MatState> {
  const mats: Record<string, MatState> = {};
  for (const spec of matSpecs) {
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
  startVote?: StartVoteState;
  endVote?: EndVoteState;
  intermissionVote?: IntermissionVoteState;
  /** Authoritative host settings. Defaults to the recommended 1v1 preset. */
  settings?: RoomSettings;
  /** Pre-built match state (server path). When omitted it is derived from `settings`. */
  match?: RoomState['match'];
  hostPlayerId?: string | null;
  phase?: RoomLifecyclePhase;
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
  const settings = options.settings ?? defaultRoomSettings();
  const matchSettings = resolveMatchSettings(settings);
  // Match legacy fields (mode/scoreLimit/playersPerTeam/maxPlayers) are DERIVED from the resolved
  // host settings, so existing consumers that read `match.*` keep working while `settings` is the
  // source of truth. The new per-round knobs (lives/dodgeballs/bounces/etc.) live on `settings`.
  const match = options.match ?? createMatchState('match', teamIds.length > 0 ? teamIds : ['player', 'opponent'], {
    mode: matchSettings.format,
    scoreLimit: matchSettings.scoreLimit,
    playersPerTeam: matchSettings.teamSize,
    maxPlayers: matchSettings.maxPlayers
  });

  return {
    id: options.id ?? 'room',
    tick: options.tick ?? 0,
    hostPlayerId: options.hostPlayerId ?? null,
    phase: options.phase ?? roomPhaseFromMatchStatus(match.status),
    settings,
    match,
    players,
    balls,
    mats: options.mats ?? createMatStates(matSpecsForPreset(settings.matPreset)),
    resetVote: options.resetVote ?? createResetVoteState(),
    startVote: options.startVote ?? createStartVoteState(),
    endVote: options.endVote ?? createEndVoteState(),
    intermissionVote: options.intermissionVote ?? createIntermissionVoteState()
  };
}

export function createEndVoteState(overrides: Partial<EndVoteState> = {}): EndVoteState {
  return {
    active: false,
    initiatedByPlayerId: null,
    votesByPlayerId: {},
    voteCount: 0,
    requiredVotes: 0,
    expiresAtMs: null,
    ...overrides
  };
}

export function createIntermissionVoteState(overrides: Partial<IntermissionVoteState> = {}): IntermissionVoteState {
  return {
    active: false,
    allowsNextRound: false,
    nextRoundByPlayerId: {},
    nextRoundCount: 0,
    toLobbyByPlayerId: {},
    toLobbyCount: 0,
    requiredVotes: 0,
    nextRoundDeadlineAtMs: null,
    ...overrides
  };
}

export function createResetVoteState(overrides: Partial<ResetVoteState> = {}): ResetVoteState {
  return {
    mode: 'same-teams',
    votesByPlayerId: {},
    voteCount: 0,
    requiredVotes: 0,
    expiresAtMs: null,
    resetSerial: 0,
    ...overrides
  };
}

export function createStartVoteState(overrides: Partial<StartVoteState> = {}): StartVoteState {
  return {
    votesByPlayerId: {},
    voteCount: 0,
    requiredVotes: 0,
    expiresAtMs: null,
    teamChoicesByPlayerId: {},
    teamChoiceCount: 0,
    requiredTeamChoices: 0,
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
