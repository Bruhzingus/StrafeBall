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

  it('defaults lobby and battle music to 20 percent and persists clamped values', async () => {
    const storage = createStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage
    });

    const { settings } = await import('../src/game/config/Settings');
    expect(settings.lobbyMusicVolume).toBe(0.2);
    expect(settings.battleMusicVolume).toBe(0.2);

    settings.setLobbyMusicVolume(2);
    settings.setBattleMusicVolume(-1);
    expect(settings.lobbyMusicVolume).toBe(1);
    expect(settings.battleMusicVolume).toBe(0);

    const stored = JSON.parse(storage.getItem('strafeball.settings.v1') ?? '{}') as {
      lobbyMusicVolume?: number;
      battleMusicVolume?: number;
    };
    expect(stored.lobbyMusicVolume).toBe(1);
    expect(stored.battleMusicVolume).toBe(0);
  });

  it('loads persisted split music volumes on boot', async () => {
    const storage = createStorage({
      'strafeball.settings.v1': JSON.stringify({ lobbyMusicVolume: 0.35, battleMusicVolume: 0.5 })
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage
    });

    const { settings } = await import('../src/game/config/Settings');
    expect(settings.lobbyMusicVolume).toBe(0.35);
    expect(settings.battleMusicVolume).toBe(0.5);
  });

  it('migrates the old single musicVolume to both split sliders', async () => {
    const storage = createStorage({
      'strafeball.settings.v1': JSON.stringify({ musicVolume: 0.42 })
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage
    });

    const { settings } = await import('../src/game/config/Settings');
    expect(settings.lobbyMusicVolume).toBe(0.42);
    expect(settings.battleMusicVolume).toBe(0.42);
  });

  it('keeps the sensitivity slider value unchanged while halving gameplay sensitivity', async () => {
    const storage = createStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage
    });

    const { settings, SENSITIVITY_DEFAULT, SENSITIVITY_EFFECTIVE_SCALE } = await import('../src/game/config/Settings');
    expect(settings.mouseSensitivity).toBe(SENSITIVITY_DEFAULT);
    expect(settings.effectiveMouseSensitivity).toBe(SENSITIVITY_DEFAULT * SENSITIVITY_EFFECTIVE_SCALE);

    settings.setMouseSensitivity(0.004);
    expect(settings.mouseSensitivity).toBe(0.004);
    expect(settings.effectiveMouseSensitivity).toBe(0.002);

    const stored = JSON.parse(storage.getItem('strafeball.settings.v1') ?? '{}') as {
      mouseSensitivity?: number;
    };
    expect(stored.mouseSensitivity).toBe(0.004);
  });
});
