import { Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { BoundaryRules } from '../src/game/rules/BoundaryRules';

describe('BoundaryRules practice lobby', () => {
  it('detects crossing for education without warnings, countdowns, or penalty score', () => {
    const rules = new BoundaryRules();
    const across = new Vector3(0, 0, 8);

    expect(rules.updatePractice(1 / 60, across)).toBe(true);
    for (let i = 0; i < 180; i += 1) rules.updatePractice(1 / 60, across);

    expect(rules.illegalCrossWarnings).toBe(0);
    expect(rules.illegalCountdownActive).toBe(false);
    expect(rules.opponentPenaltyHits).toBe(0);
  });

  it('edge-triggers the teaching signal while allowing free movement', () => {
    const rules = new BoundaryRules();
    const legal = new Vector3(0, 0, -8);
    const across = new Vector3(0, 0, 8);

    expect(rules.updatePractice(1 / 60, across)).toBe(true);
    expect(rules.updatePractice(1 / 60, across)).toBe(false);
    expect(rules.updatePractice(1 / 60, legal)).toBe(false);
    expect(rules.updatePractice(1 / 60, across)).toBe(true);
  });
});
