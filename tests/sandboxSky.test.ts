import { describe, expect, it } from 'vitest';
import {
  competitiveSandboxSkyStyle,
  sandboxSkyStyle
} from '../src/game/practice/SandboxAtmosphere';

describe('Creator course sky presets', () => {
  it('provides visibly distinct but bounded authored looks', () => {
    const looks = ['clear', 'sunset', 'overcast', 'night'] as const;
    const horizons = looks.map((preset) => sandboxSkyStyle(preset).horizon.join(','));
    expect(new Set(horizons).size).toBe(looks.length);
    for (const preset of looks) {
      const style = sandboxSkyStyle(preset);
      expect(style.fogEnd).toBeGreaterThan(style.fogStart);
      expect(style.sunIntensity).toBeGreaterThan(0);
    }
  });

  it('preserves the legacy Competitive clear sky and fog distances', () => {
    const clear = competitiveSandboxSkyStyle('clear');
    expect(clear.horizon).toEqual([0.52, 0.63, 0.79]);
    expect(clear.fogStart).toBe(240);
    expect(clear.fogEnd).toBe(700);
  });
});
