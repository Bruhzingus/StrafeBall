import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Graphics preset migration matrix (plan: dreamy-chasing-quokka, Phase 0) + the tuning-overlay merge.
 * graphicsConfig reads `window.localStorage` (browser-only), so tests install a window stub.
 */

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    }
  };
}

function installWindowStorage(initial: Record<string, string> = {}) {
  const storage = createStorage(initial);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage }
  });
  return storage;
}

describe('graphics mode resolution + migration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to polished with no stored key', async () => {
    installWindowStorage();
    const { resolveGraphicsMode, getGraphicsQuality } = await import('../src/game/config/graphicsConfig');
    expect(resolveGraphicsMode()).toBe('polished');
    expect(getGraphicsQuality()).toBe('polished');
  });

  it('keeps valid new-scheme values as-is', async () => {
    for (const mode of ['polished', 'performance', 'neutral']) {
      vi.resetModules();
      installWindowStorage({ 'strafeball.graphics.mode': mode });
      const { resolveGraphicsMode } = await import('../src/game/config/graphicsConfig');
      expect(resolveGraphicsMode()).toBe(mode);
    }
  });

  it("migrates legacy 'showcase' to polished and deletes the tier key (write-back once)", async () => {
    const storage = installWindowStorage({
      'strafeball.graphics.mode': 'showcase',
      'strafeball.graphics.tier': 'ultra'
    });
    const { resolveGraphicsMode } = await import('../src/game/config/graphicsConfig');
    expect(resolveGraphicsMode()).toBe('polished');
    expect(storage.getItem('strafeball.graphics.mode')).toBe('polished');
    expect(storage.getItem('strafeball.graphics.tier')).toBeNull();
  });

  it("migrates legacy 'competitive' to performance (the user chose the old baseline — keep their look)", async () => {
    const storage = installWindowStorage({ 'strafeball.graphics.mode': 'competitive' });
    const { resolveGraphicsMode } = await import('../src/game/config/graphicsConfig');
    expect(resolveGraphicsMode()).toBe('performance');
    expect(storage.getItem('strafeball.graphics.mode')).toBe('performance');
  });

  it('falls back to the compiled default on garbage values without writing back', async () => {
    const storage = installWindowStorage({ 'strafeball.graphics.mode': 'ultra-mega' });
    const { resolveGraphicsMode } = await import('../src/game/config/graphicsConfig');
    expect(resolveGraphicsMode()).toBe('polished');
    // Garbage is left in place (harmless) — only known legacy values are migrated.
    expect(storage.getItem('strafeball.graphics.mode')).toBe('ultra-mega');
  });

  it('persistGraphicsPreset writes the mode and clears the legacy tier key', async () => {
    const storage = installWindowStorage({ 'strafeball.graphics.tier': 'high' });
    const { persistGraphicsPreset, getGraphicsPreset } = await import('../src/game/config/graphicsConfig');
    persistGraphicsPreset('performance');
    expect(storage.getItem('strafeball.graphics.mode')).toBe('performance');
    expect(storage.getItem('strafeball.graphics.tier')).toBeNull();
    expect(getGraphicsPreset()).toBe('performance');
  });

  it('hides the Neutral preset from the settings list unless the graphics debug flag is set', async () => {
    installWindowStorage();
    const { getGraphicsPresets } = await import('../src/game/config/graphicsConfig');
    expect(getGraphicsPresets().map((p) => p.value)).toEqual(['polished', 'performance']);

    vi.resetModules();
    installWindowStorage({ 'strafeball.debug.graphics': '1' });
    const { getGraphicsPresets: withDebug } = await import('../src/game/config/graphicsConfig');
    expect(withDebug().map((p) => p.value)).toEqual(['polished', 'performance', 'neutral']);
  });
});

describe('polished config tuning overlay', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns the compiled config when no overrides are stored', async () => {
    installWindowStorage();
    const { resolvePolishedConfig } = await import('../src/game/config/graphicsTuning');
    const { POLISHED_CONFIG } = await import('../src/game/config/graphicsConfig');
    expect(resolvePolishedConfig()).toEqual(POLISHED_CONFIG);
  });

  it('deep-merges stored overrides and replaces tuples whole', async () => {
    installWindowStorage({
      'strafeball.graphics.tuning.v1': JSON.stringify({
        imageProcessing: { exposure: 1.3 },
        lights: { hemi: { intensity: 0.6, diffuse: [0.9, 0.9, 0.9] } }
      })
    });
    const { resolvePolishedConfig } = await import('../src/game/config/graphicsTuning');
    const { POLISHED_CONFIG } = await import('../src/game/config/graphicsConfig');
    const cfg = resolvePolishedConfig();
    expect(cfg.imageProcessing.exposure).toBe(1.3);
    // Untouched siblings/subtrees survive — compare against the SHIPPED values, never literals
    // (the shipped numbers change during look calibration; this test is about merge shape).
    expect(cfg.imageProcessing.contrast).toBe(POLISHED_CONFIG.imageProcessing.contrast);
    expect(cfg.lights.hemi.intensity).toBe(0.6);
    expect(cfg.lights.hemi.diffuse).toEqual([0.9, 0.9, 0.9]); // tuple replaced whole
    expect(cfg.lights.key.intensity).toBe(POLISHED_CONFIG.lights.key.intensity);
  });

  it('ignores unknown/stale override keys and type mismatches', async () => {
    installWindowStorage({
      'strafeball.graphics.tuning.v1': JSON.stringify({
        notARealSystem: { foo: 1 },
        shadows: { darkness: 'oops', mapSize: 4096 }
      })
    });
    const { resolvePolishedConfig } = await import('../src/game/config/graphicsTuning');
    const { POLISHED_CONFIG } = await import('../src/game/config/graphicsConfig');
    const cfg = resolvePolishedConfig();
    expect(cfg.shadows.darkness).toBe(POLISHED_CONFIG.shadows.darkness); // type mismatch kept the base value
    expect(cfg.shadows.mapSize).toBe(4096); // valid override applied
    expect((cfg as unknown as Record<string, unknown>).notARealSystem).toBeUndefined();
  });

  it('never mutates the shipped POLISHED_CONFIG object', async () => {
    installWindowStorage({
      'strafeball.graphics.tuning.v1': JSON.stringify({ shadows: { darkness: 0.5 } })
    });
    const { resolvePolishedConfig } = await import('../src/game/config/graphicsTuning');
    const { POLISHED_CONFIG } = await import('../src/game/config/graphicsConfig');
    const shippedDarkness = POLISHED_CONFIG.shadows.darkness;
    const shippedHemi = POLISHED_CONFIG.lights.hemi.intensity;
    const cfg = resolvePolishedConfig();
    expect(cfg.shadows.darkness).toBe(0.5);
    expect(POLISHED_CONFIG.shadows.darkness).toBe(shippedDarkness);
    cfg.lights.hemi.intensity = 99; // caller mutating its copy…
    expect(POLISHED_CONFIG.lights.hemi.intensity).toBe(shippedHemi); // …can't touch the shipped block
  });
});
