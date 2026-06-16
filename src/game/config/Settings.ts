import { clamp } from '../utils/math';

/**
 * User-adjustable settings that persist across reloads (localStorage). Kept tiny and framework-
 * free: gameplay code reads `settings.mouseSensitivity` directly, UI calls `setMouseSensitivity`.
 */
const STORAGE_KEY = 'strafeball.settings.v1';

export const SENSITIVITY_MIN = 0.0006;
export const SENSITIVITY_MAX = 0.006;
export const SENSITIVITY_DEFAULT = 0.0022;

class SettingsStore {
  public mouseSensitivity = SENSITIVITY_DEFAULT;

  constructor() {
    this.load();
  }

  setMouseSensitivity(value: number): void {
    this.mouseSensitivity = clamp(value, SENSITIVITY_MIN, SENSITIVITY_MAX);
    this.save();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { mouseSensitivity?: unknown };
      if (typeof parsed.mouseSensitivity === 'number' && Number.isFinite(parsed.mouseSensitivity)) {
        this.mouseSensitivity = clamp(parsed.mouseSensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX);
      }
    } catch {
      // Corrupt/unavailable storage — fall back to defaults silently.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mouseSensitivity: this.mouseSensitivity }));
    } catch {
      // Storage may be unavailable (private mode); ignore.
    }
  }
}

export const settings = new SettingsStore();
