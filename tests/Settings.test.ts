import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('settings music volume', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to 20 percent and persists clamped values', async () => {
    const storage = createStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage
    });

    const { settings } = await import('../src/game/config/Settings');
    expect(settings.musicVolume).toBe(0.2);

    settings.setMusicVolume(2);
    expect(settings.musicVolume).toBe(1);

    const stored = JSON.parse(storage.getItem('strafeball.settings.v1') ?? '{}') as { musicVolume?: number };
    expect(stored.musicVolume).toBe(1);
  });

  it('loads persisted music volume on boot', async () => {
    const storage = createStorage({
      'strafeball.settings.v1': JSON.stringify({ musicVolume: 0.35 })
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage
    });

    const { settings } = await import('../src/game/config/Settings');
    expect(settings.musicVolume).toBe(0.35);
  });
});
