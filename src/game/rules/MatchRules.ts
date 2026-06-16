import { BoundaryRules } from './BoundaryRules';
import { ScoringSystem } from './ScoringSystem';

export class MatchRules {
  public readonly scoring = new ScoringSystem();
  public readonly boundary = new BoundaryRules();

  reset(): void {
    this.scoring.reset();
    this.boundary.reset();
  }
}
