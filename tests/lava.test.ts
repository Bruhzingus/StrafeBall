import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { LavaExposure, lavaMaxHeight, mapEffectForPresentation, mapEffectWarningSeconds } from '../shared/simulation/MapEffectSim';
import type { MapEffectState } from '../shared/types';

describe('lava contact and presentation', () => {
  it('charges continuous contact on the first-hit and repeat cadence', () => {
    const exposure = new LavaExposure();
    expect(exposure.step(true, C.mapEffect.lavaFirstDamageSeconds - 0.01)).toBe(false);
    expect(exposure.step(true, 0.01)).toBe(true);
    expect(exposure.step(true, C.mapEffect.lavaDamageIntervalSeconds - 0.01)).toBe(false);
    expect(exposure.step(true, 0.01)).toBe(true);
    exposure.step(false, 0);
    expect(exposure.step(true, 0.06)).toBe(false);
  });

  it('does not queue catch-up damage after a long frame', () => {
    const exposure = new LavaExposure();
    expect(exposure.step(true, 4)).toBe(true);
    expect(exposure.step(true, 0.01)).toBe(false);
    exposure.reset();
    expect(exposure.step(true, 0.01)).toBe(false);
  });

  it('gives only lava the extra half-second warning', () => {
    expect(mapEffectWarningSeconds('lava')).toBe(3.5);
    expect(mapEffectWarningSeconds('moon')).toBe(3);
    expect(mapEffectWarningSeconds('frenzy')).toBe(3);
  });

  it('renders rising lava at the estimated server time without mutating the snapshot', () => {
    const effect: MapEffectState = { kind: 'lava', phase: 'active', remainingSeconds: 18, lavaLevel: 0, spawnIndex: 0 };
    const view = mapEffectForPresentation(effect, 0.2)!;
    expect(view.lavaLevel).toBeCloseTo(lavaMaxHeight() * 0.2 / C.mapEffect.lavaRiseSeconds);
    expect(effect.remainingSeconds).toBe(18);
    expect(effect.lavaLevel).toBe(0);
    expect(mapEffectForPresentation(effect, 10)?.lavaLevel).toBeCloseTo(lavaMaxHeight() * 0.5 / C.mapEffect.lavaRiseSeconds);
  });

  it('keeps warning harmless and receding lava aligned with its timer', () => {
    const effect: MapEffectState = { kind: 'lava', phase: 'warning', remainingSeconds: 0.1, lavaLevel: 0, spawnIndex: 0 };
    expect(mapEffectForPresentation(effect, 0.3)).toMatchObject({ phase: 'warning', lavaLevel: 0 });
    effect.phase = 'ending';
    effect.remainingSeconds = C.mapEffect.lavaRecedeSeconds;
    expect(mapEffectForPresentation(effect, 0.2)?.lavaLevel).toBeCloseTo(lavaMaxHeight() * 0.9);
    expect(mapEffectForPresentation(null, 1)).toBeNull();
  });
});
