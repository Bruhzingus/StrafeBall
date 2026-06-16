import { Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';

// Player's legal half is negative Z (they spawn at z=-12; center line is z=0). A small
// grace band past center avoids false positives from brushing the line.
const HALF_COURT_LINE_Z = 0.25;

export class BoundaryRules {
  public elapsed = 0;
  public noBoundaries = false;
  public illegalCrossWarnings = 0;
  public opponentPenaltyHits = 0;
  public lastMessage = 'Half-court active.';

  // Edge-trigger guard: a single sustained excursion past the line counts once, not once
  // per frame. Re-crossing after returning legal counts again.
  private wasAcross = false;

  update(dt: number, playerPosition: Vector3): void {
    this.elapsed += dt;
    if (!this.noBoundaries && this.elapsed >= TUNING.match.noBoundariesSeconds) {
      this.noBoundaries = true;
      this.lastMessage = 'BELL! No boundaries. Full court is open.';
    }

    if (this.noBoundaries) {
      this.wasAcross = false;
      return;
    }

    const across = playerPosition.z > HALF_COURT_LINE_Z;
    if (across && !this.wasAcross) {
      // New illegal crossing: first one warns, subsequent ones penalize the offender.
      this.illegalCrossWarnings += 1;
      if (this.illegalCrossWarnings <= TUNING.match.illegalCrossWarningsBeforePenalty) {
        this.lastMessage = 'Warning: crossed half-court. Get back!';
      } else {
        this.opponentPenaltyHits += TUNING.match.penaltyHitValue;
        this.lastMessage = `Penalty! Opponent awarded a hit (total ${this.opponentPenaltyHits}).`;
      }
    }
    this.wasAcross = across;
  }

  reset(): void {
    this.elapsed = 0;
    this.noBoundaries = false;
    this.illegalCrossWarnings = 0;
    this.opponentPenaltyHits = 0;
    this.lastMessage = 'Half-court active.';
    this.wasAcross = false;
  }
}
