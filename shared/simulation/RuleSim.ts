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
  const roundsWonByTeamId: Record<string, number> = {};
  for (const teamId of teamIds) {
    scoreByTeamId[teamId] = 0;
    roundsWonByTeamId[teamId] = 0;
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
    roundCount: 1,
    currentRound: 1,
    roundsWonByTeamId,
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
    roundsWonByTeamId: { ...base.roundsWonByTeamId, ...overrides.roundsWonByTeamId },
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
  const winnerTeamId = match.mode === '2v2'
    ? match.winnerTeamId
    : scoreByTeamId[teamId] >= match.scoreLimit ? teamId : match.winnerTeamId;

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

/**
 * Rounds a team must win to clinch a best-of-`roundCount` series (majority). For roundCount=1 this is
 * 1 (single round decides the match); for 3 it is 2; etc. Used by the unified round lifecycle to end
 * the match as soon as a team is mathematically guaranteed the series.
 */
export function roundsNeededToWin(roundCount: number): number {
  return Math.floor(Math.max(1, Math.trunc(roundCount)) / 2) + 1;
}

/**
 * Resolve the overall match winner after a round was awarded, or null if the series continues. The
 * match ends when a team clinches the majority (roundsNeededToWin) OR all rounds have been played; on
 * an all-rounds tie the team with more round wins takes it (callers pass odd round counts to avoid
 * ties — see ROOM_SETTINGS_LIMITS). Pure so it is unit-testable without a running room.
 */
export function matchWinnerFromRounds(match: Pick<MatchState, 'teamIds' | 'roundCount' | 'roundsWonByTeamId'>): string | null {
  const need = roundsNeededToWin(match.roundCount);
  let leader: string | null = null;
  let leaderWins = -1;
  let totalPlayed = 0;
  for (const teamId of match.teamIds) {
    const wins = match.roundsWonByTeamId[teamId] ?? 0;
    totalPlayed += wins;
    if (wins >= need) return teamId; // clinched the series
    if (wins > leaderWins) {
      leaderWins = wins;
      leader = teamId;
    }
  }
  return totalPlayed >= match.roundCount ? leader : null;
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
  /**
   * Seconds until half-court restrictions drop. Sourced from the host setting `halfCourtTimerSeconds`
   * so boundary timing is settings-driven; when omitted, falls back to the constant (offline/legacy).
   */
  halfCourtTimerSecondsOverride?: number,
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

  const dropSeconds = typeof halfCourtTimerSecondsOverride === 'number' && Number.isFinite(halfCourtTimerSecondsOverride)
    ? halfCourtTimerSecondsOverride
    : constants.match.noBoundariesSeconds;
  const elapsedSeconds = match.boundary.elapsedSeconds + dt;
  const noBoundaries = elapsedSeconds >= dropSeconds;
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
  dt = 0,
  constants: GameConstants = GAME_CONSTANTS,
  /**
   * Whether a boundary penalty also awards score to the opponent. Legacy (offline / shared tests)
   * keep the score behavior; the unified server lifecycle passes `false` because boundary penalties
   * now cost the OFFENDER lives instead (applyHalfCourtPenalty), and score never decides victory.
   * The 'half-court-penalty' event still fires either way so the server can apply the life loss.
   */
  scorePenalties = true
): MatchState {
  const existing = match.boundary.illegalCrossByPlayerId[playerId] ?? createHalfCourtViolationState(constants);

  if (match.boundary.noBoundaries) {
    return setHalfCourtViolation(
      match,
      playerId,
      {
        ...existing,
        wasAcross: false,
        deathCountdownActive: false,
        penaltyTickSeconds: constants.match.illegalCrossPenaltyIntervalSeconds,
        countdownSeconds: constants.match.illegalCrossPenaltyIntervalSeconds
      },
      { type: 'none' }
    );
  }

  const across = isIllegalHalfCourtPosition(legalHalf, position, constants);
  if (!across) {
    return setHalfCourtViolation(
      match,
      playerId,
      {
        ...existing,
        wasAcross: false,
        deathCountdownActive: false,
        penaltyTickSeconds: constants.match.illegalCrossPenaltyIntervalSeconds,
        countdownSeconds: constants.match.illegalCrossPenaltyIntervalSeconds
      },
      { type: 'none' }
    );
  }

  if (existing.eliminationIssued) {
    return setHalfCourtViolation(match, playerId, { ...existing, wasAcross: true }, { type: 'none' });
  }

  const illegalCrossCount = existing.wasAcross ? existing.illegalCrossCount : existing.illegalCrossCount + 1;
  const shouldWarn =
    !existing.wasAcross &&
    existing.warningsIssued < constants.match.illegalCrossWarningsBeforePenalty;
  const warningsIssued = shouldWarn ? existing.warningsIssued + 1 : existing.warningsIssued;
  const penaltyIntervalSeconds = Math.max(0.001, constants.match.illegalCrossPenaltyIntervalSeconds);
  // The player is across (checked above) and has spent their warning, so the penalty must tick. The
  // old `(deathCountdownActive || !wasAcross)` guard meant a player who crossed, got warned, and then
  // STAYED across never started taking damage — the countdown only began on the tick right after a
  // re-cross (when !wasAcross was briefly true). That's the "won't tick unless you cross back" bug.
  const penaltyActive = !shouldWarn;
  const startingCountdown = existing.deathCountdownActive ? existing.countdownSeconds : penaltyIntervalSeconds;
  const countdownSeconds = !penaltyActive
    ? penaltyIntervalSeconds
    : Math.max(0, startingCountdown - Math.max(0, dt));
  const overduePenaltySeconds = penaltyActive ? Math.max(0, Math.max(0, dt) - startingCountdown) : 0;
  const penaltiesDue = penaltyActive && countdownSeconds <= 0
    ? 1 + Math.floor(overduePenaltySeconds / penaltyIntervalSeconds)
    : 0;
  const nextCountdownSeconds = penaltiesDue > 0
    ? penaltyIntervalSeconds - (overduePenaltySeconds % penaltyIntervalSeconds)
    : countdownSeconds;
  const nextViolation: HalfCourtViolationState = {
    ...existing,
    illegalCrossCount,
    warningsIssued,
    penaltiesIssued: existing.penaltiesIssued + penaltiesDue,
    penaltyTickSeconds: nextCountdownSeconds,
    wasAcross: true,
    deathCountdownActive: penaltyActive,
    countdownSeconds: nextCountdownSeconds
  };

  if (shouldWarn) {
    return setHalfCourtViolation(
      match,
      playerId,
      nextViolation,
      { type: 'half-court-warning', playerId, warningsIssued }
    );
  }

  if (penaltiesDue > 0) {
    const opponentTeamId = getOpponentTeamId(match, offenderTeamId);
    const value = penaltiesDue * constants.match.penaltyHitValue;
    const scoredMatch = opponentTeamId && scorePenalties && match.mode !== '2v2' ? applyScore(match, opponentTeamId, value) : match;
    return setHalfCourtViolation(
      scoredMatch,
      playerId,
      nextViolation,
      opponentTeamId
        ? { type: 'half-court-penalty', playerId, opponentTeamId, value }
        : { type: 'none' }
    );
  }

  return setHalfCourtViolation(match, playerId, nextViolation, { type: 'none' });
}

function createHalfCourtViolationState(constants: GameConstants = GAME_CONSTANTS): HalfCourtViolationState {
  return {
    illegalCrossCount: 0,
    warningsIssued: 0,
    penaltiesIssued: 0,
    penaltyTickSeconds: constants.match.illegalCrossPenaltyIntervalSeconds,
    wasAcross: false,
    deathCountdownActive: false,
    countdownSeconds: constants.match.illegalCrossPenaltyIntervalSeconds,
    eliminationIssued: false
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
