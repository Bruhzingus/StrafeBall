import { describe, expect, it } from 'vitest';
import { createMatchState, isHalfCourtOpen } from '../shared/simulation/RuleSim';
import type { MapEffectState } from '../shared/types';

describe('lava escape routes', () => {
  it.each(['warning', 'active', 'ending'] as const)('opens both halves during lava %s without permanently dropping the boundary', phase => {
    const match = createMatchState();
    const effect: MapEffectState = { kind: 'lava', phase, remainingSeconds: 1, spawnIndex: 0, lavaLevel: 1 };
    expect(isHalfCourtOpen(match, effect)).toBe(true);
    expect(match.boundary.noBoundaries).toBe(false);
    expect(isHalfCourtOpen(match, null)).toBe(false);
  });

  it('keeps the ordinary boundary policy for other effects and after the permanent timer ends', () => {
    const match = createMatchState();
    const effect: MapEffectState = { kind: 'moon', phase: 'active', remainingSeconds: 1, spawnIndex: 0, lavaLevel: 0 };
    expect(isHalfCourtOpen(match, effect)).toBe(false);
    effect.kind = 'frenzy';
    expect(isHalfCourtOpen(match, effect)).toBe(false);
    match.boundary.noBoundaries = true;
    expect(isHalfCourtOpen(match, null)).toBe(true);
  });
});
