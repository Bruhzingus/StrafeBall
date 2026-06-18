import { Vector3 } from '@babylonjs/core';
import type { MatchState, Vec3 } from '../../../shared/types';
import { advanceNoBoundariesTimer, applyHalfCourtRule, createMatchState } from '../../../shared/simulation/RuleSim';

// Player's legal half is negative Z (they spawn at z=-12; center line is z=0). A small
// grace band past center avoids false positives from brushing the line.
const PLAYER_ID = 'local-player';
const PLAYER_TEAM_ID = 'player';
const OPPONENT_TEAM_ID = 'opponent';

export class BoundaryRules {
  public elapsed = 0;
  public noBoundaries = false;
  public illegalCrossWarnings = 0;
  public opponentPenaltyHits = 0;
  public illegalCountdownActive = false;
  public illegalCountdownSeconds = 0;
  public lastMessage = 'Half-court active.';

  // Edge-trigger guard: a single sustained excursion past the line counts once, not once
  // per frame. Re-crossing after returning legal counts again.
  private match: MatchState = createBoundaryMatch();

  update(dt: number, playerPosition: Vector3): void {
    const hadBoundaries = !this.match.boundary.noBoundaries;
    this.match = advanceNoBoundariesTimer(this.match, dt);

    if (hadBoundaries && this.match.boundary.noBoundaries) {
      this.syncPublicState();
      this.lastMessage = 'BELL! No boundaries. Full court is open.';
      return;
    }

    this.match = applyHalfCourtRule(
      this.match,
      PLAYER_ID,
      PLAYER_TEAM_ID,
      'negativeZ',
      toSharedVec3(playerPosition),
      dt
    );
    this.syncPublicState();

    const event = this.match.boundary.lastEvent;
    if (event.type === 'half-court-warning') {
      this.lastMessage = 'WARNING: stay on your side until half court drops.';
    } else if (event.type === 'half-court-penalty') {
      this.lastMessage = `Half-court penalty: opponent +${event.value}.`;
    } else if (event.type === 'half-court-elimination') {
      this.lastMessage = 'Out! Half-court violation.';
    } else if (this.illegalCountdownActive) {
      this.lastMessage = `Illegal side! Next penalty in ${Math.ceil(this.illegalCountdownSeconds)}s.`;
    }
  }

  reset(): void {
    this.match = createBoundaryMatch();
    this.elapsed = 0;
    this.noBoundaries = false;
    this.illegalCrossWarnings = 0;
    this.opponentPenaltyHits = 0;
    this.illegalCountdownActive = false;
    this.illegalCountdownSeconds = 0;
    this.lastMessage = 'Half-court active.';
  }

  private syncPublicState(): void {
    const violation = this.match.boundary.illegalCrossByPlayerId[PLAYER_ID];
    this.elapsed = this.match.boundary.elapsedSeconds;
    this.noBoundaries = this.match.boundary.noBoundaries;
    this.illegalCrossWarnings = violation?.warningsIssued ?? 0;
    this.illegalCountdownActive = violation?.deathCountdownActive ?? false;
    this.illegalCountdownSeconds = violation?.countdownSeconds ?? 0;
    this.opponentPenaltyHits = this.match.scoreByTeamId[OPPONENT_TEAM_ID] ?? 0;
  }
}

function createBoundaryMatch(): MatchState {
  return createMatchState('local-boundary', [PLAYER_TEAM_ID, OPPONENT_TEAM_ID]);
}

function toSharedVec3(v: Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}
