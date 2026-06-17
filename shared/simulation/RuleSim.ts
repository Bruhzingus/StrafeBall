import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type {
  BallPhase,
  BoundaryEvent,
  HalfCourtViolationState,
  LegalHalf,
  MatchMode,
  MatchState,
  Vec3
} from '../types';
import { distance } from './CollisionMath';

export function createMatchState(
  id = 'match',
  teamIds: string[] = ['player', 'opponent'],
  overrides: Partial<MatchState> = {},
  constants: GameConstants = GAME_CONSTANTS
): MatchState {
  const scoreByTeamId: Record<string, number> = {};
  for (const teamId of teamIds) {
    scoreByTeamId[teamId] = 0;
  }

  const base: MatchState = {
    id,
    mode: '1v1',
    status: 'playing',
    elapsedSeconds: 0,
    scoreLimit: constants.match.scoreLimit,
    teamIds: [...teamIds],
    playersPerTeam: 1,
    maxPlayers: Math.max(2, teamIds.length),
    scoreByTeamId,
    winnerTeamId: null,
    countdownSeconds: 0,
    boundary: {
      elapsedSeconds: 0,
      noBoundaries: false,
      illegalCrossByPlayerId: {},
      lastEvent: { type: 'none' }
    }
  };

  return {
    ...base,
    ...overrides,
    id,
    mode: (overrides.mode ?? base.mode) as MatchMode,
    teamIds: overrides.teamIds ? [...overrides.teamIds] : base.teamIds,
    scoreByTeamId: { ...base.scoreByTeamId, ...overrides.scoreByTeamId },
    boundary: {
      ...base.boundary,
      ...overrides.boundary,
      illegalCrossByPlayerId: {
        ...base.boundary.illegalCrossByPlayerId,
        ...overrides.boundary?.illegalCrossByPlayerId
      },
      lastEvent: overrides.boundary?.lastEvent ?? base.boundary.lastEvent
    }
  };
}

export function applyScore(match: MatchState, teamId: string, value = 1): MatchState {
  if (match.status === 'complete') return match;

  const current = match.scoreByTeamId[teamId] ?? 0;
  const scoreByTeamId = {
    ...match.scoreByTeamId,
    [teamId]: current + value
  };
  const winnerTeamId = scoreByTeamId[teamId] >= match.scoreLimit ? teamId : match.winnerTeamId;

  return {
    ...match,
    scoreByTeamId,
    winnerTeamId,
    status: winnerTeamId ? 'complete' : match.status
  };
}

export function hasReachedScoreLimit(score: number, constants: GameConstants = GAME_CONSTANTS): boolean {
  return score >= constants.match.scoreLimit;
}

export function getOpponentTeamId(match: MatchState, teamId: string): string | null {
  return match.teamIds.find((candidate) => candidate !== teamId) ?? null;
}

export function isLivePlayerOwnedBall(phase: BallPhase | string, ownerKind: string | null): boolean {
  return phase === 'live' && ownerKind === 'player';
}

export function isHitInRange(ballPosition: Vec3, targetPosition: Vec3, constants: GameConstants = GAME_CONSTANTS): boolean {
  return distance(ballPosition, targetPosition) <= constants.ball.hitRadius;
}

export function advanceNoBoundariesTimer(
  match: MatchState,
  dt: number,
  constants: GameConstants = GAME_CONSTANTS
): MatchState {
  if (match.boundary.noBoundaries) {
    return {
      ...match,
      elapsedSeconds: match.elapsedSeconds + dt,
      boundary: {
        ...match.boundary,
        elapsedSeconds: match.boundary.elapsedSeconds + dt,
        lastEvent: { type: 'none' }
      }
    };
  }

  const elapsedSeconds = match.boundary.elapsedSeconds + dt;
  const noBoundaries = elapsedSeconds >= constants.match.noBoundariesSeconds;
  const event: BoundaryEvent = noBoundaries ? { type: 'no-boundaries' } : { type: 'none' };

  return {
    ...match,
    elapsedSeconds: match.elapsedSeconds + dt,
    boundary: {
      ...match.boundary,
      elapsedSeconds,
      noBoundaries,
      lastEvent: event
    }
  };
}

export function isIllegalHalfCourtPosition(
  legalHalf: LegalHalf,
  position: Vec3,
  constants: GameConstants = GAME_CONSTANTS
): boolean {
  if (legalHalf === 'negativeZ') return position.z > constants.match.halfCourtLineZ;
  return position.z < -constants.match.halfCourtLineZ;
}

export function applyHalfCourtRule(
  match: MatchState,
  playerId: string,
  offenderTeamId: string,
  legalHalf: LegalHalf,
  position: Vec3,
  constants: GameConstants = GAME_CONSTANTS
): MatchState {
  const existing = match.boundary.illegalCrossByPlayerId[playerId] ?? createHalfCourtViolationState();

  if (match.boundary.noBoundaries) {
    return setHalfCourtViolation(match, playerId, { ...existing, wasAcross: false }, { type: 'none' });
  }

  const across = isIllegalHalfCourtPosition(legalHalf, position, constants);
  if (!across || existing.wasAcross) {
    return setHalfCourtViolation(match, playerId, { ...existing, wasAcross: across }, { type: 'none' });
  }

  const illegalCrossCount = existing.illegalCrossCount + 1;
  const shouldWarn = illegalCrossCount <= constants.match.illegalCrossWarningsBeforePenalty;

  if (shouldWarn) {
    return setHalfCourtViolation(
      match,
      playerId,
      {
        ...existing,
        illegalCrossCount,
        warningsIssued: existing.warningsIssued + 1,
        wasAcross: true
      },
      { type: 'half-court-warning', playerId, warningsIssued: existing.warningsIssued + 1 }
    );
  }

  const opponentTeamId = getOpponentTeamId(match, offenderTeamId);
  const penalizedMatch = opponentTeamId
    ? applyScore(match, opponentTeamId, constants.match.penaltyHitValue)
    : match;

  return setHalfCourtViolation(
    penalizedMatch,
    playerId,
    {
      ...existing,
      illegalCrossCount,
      penaltiesIssued: existing.penaltiesIssued + 1,
      wasAcross: true
    },
    {
      type: 'half-court-penalty',
      playerId,
      opponentTeamId: opponentTeamId ?? '',
      value: constants.match.penaltyHitValue
    }
  );
}

function createHalfCourtViolationState(): HalfCourtViolationState {
  return {
    illegalCrossCount: 0,
    warningsIssued: 0,
    penaltiesIssued: 0,
    wasAcross: false
  };
}

function setHalfCourtViolation(
  match: MatchState,
  playerId: string,
  violation: HalfCourtViolationState,
  lastEvent: BoundaryEvent
): MatchState {
  return {
    ...match,
    boundary: {
      ...match.boundary,
      illegalCrossByPlayerId: {
        ...match.boundary.illegalCrossByPlayerId,
        [playerId]: violation
      },
      lastEvent
    }
  };
}
