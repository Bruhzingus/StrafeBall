import { clamp } from '../utils/math';

/**
 * User-adjustable settings that persist across reloads (localStorage). Kept tiny and framework-
 * free: UI reads/stores `mouseSensitivity`, gameplay reads `effectiveMouseSensitivity`.
 */
const STORAGE_KEY = 'strafeball.settings.v1';

export const SENSITIVITY_MIN = 0.0006;
export const SENSITIVITY_MAX = 0.006;
export const SENSITIVITY_DEFAULT = 0.0022;
export const SENSITIVITY_EFFECTIVE_SCALE = 0.5;
export const SFX_VOLUME_DEFAULT = 0.8;
export const MUSIC_VOLUME_DEFAULT = 0.2;

class SettingsStore {
  public mouseSensitivity = SENSITIVITY_DEFAULT;
  public sfxVolume = SFX_VOLUME_DEFAULT;
  public lobbyMusicVolume = MUSIC_VOLUME_DEFAULT;
  public battleMusicVolume = MUSIC_VOLUME_DEFAULT;
  public reducedEffects = false;
  /** Show the 3D end-wall scoreboards. Off = hide them (some players find them distracting). */
  public showScoreboard = true;
  /** Planning mode: play a smaller lobby playlist instead of shuffling every lobby track. */
  public loopClaudesPlan = false;
  /** Expose the live polished-renderer tuning panel. Off by default, available in production. */
  public devGraphicsTuning = false;

  constructor() {
    this.load();
  }

  setMouseSensitivity(value: number): void {
    this.mouseSensitivity = clamp(value, SENSITIVITY_MIN, SENSITIVITY_MAX);
    this.save();
  }

  get effectiveMouseSensitivity(): number {
    return this.mouseSensitivity * SENSITIVITY_EFFECTIVE_SCALE;
  }

  setSfxVolume(value: number): void {
    this.sfxVolume = clamp(value, 0, 1);
    this.save();
  }

  setLobbyMusicVolume(value: number): void {
    this.lobbyMusicVolume = clamp(value, 0, 1);
    this.save();
  }

  setBattleMusicVolume(value: number): void {
    this.battleMusicVolume = clamp(value, 0, 1);
    this.save();
  }

  setReducedEffects(value: boolean): void {
    this.reducedEffects = value;
    this.save();
  }

  setShowScoreboard(value: boolean): void {
    this.showScoreboard = value;
    this.save();
  }

  setLoopClaudesPlan(value: boolean): void {
    this.loopClaudesPlan = value;
    this.save();
  }

  setDevGraphicsTuning(value: boolean): void {
    this.devGraphicsTuning = value;
    this.save();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        mouseSensitivity?: unknown;
        sfxVolume?: unknown;
        musicVolume?: unknown;
        lobbyMusicVolume?: unknown;
        battleMusicVolume?: unknown;
        reducedEffects?: unknown;
        showScoreboard?: unknown;
        loopClaudesPlan?: unknown;
        devGraphicsTuning?: unknown;
      };
      if (typeof parsed.mouseSensitivity === 'number' && Number.isFinite(parsed.mouseSensitivity)) {
        this.mouseSensitivity = clamp(parsed.mouseSensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX);
      }
      if (typeof parsed.sfxVolume === 'number' && Number.isFinite(parsed.sfxVolume)) {
        this.sfxVolume = clamp(parsed.sfxVolume, 0, 1);
      }
      // Migrate the old single `musicVolume` (pre-split) to both new sliders as a starting point.
      if (typeof parsed.musicVolume === 'number' && Number.isFinite(parsed.musicVolume)) {
        const migrated = clamp(parsed.musicVolume, 0, 1);
        this.lobbyMusicVolume = migrated;
        this.battleMusicVolume = migrated;
      }
      if (typeof parsed.lobbyMusicVolume === 'number' && Number.isFinite(parsed.lobbyMusicVolume)) {
        this.lobbyMusicVolume = clamp(parsed.lobbyMusicVolume, 0, 1);
      }
      if (typeof parsed.battleMusicVolume === 'number' && Number.isFinite(parsed.battleMusicVolume)) {
        this.battleMusicVolume = clamp(parsed.battleMusicVolume, 0, 1);
      }
      if (typeof parsed.reducedEffects === 'boolean') {
        this.reducedEffects = parsed.reducedEffects;
      }
      if (typeof parsed.showScoreboard === 'boolean') {
        this.showScoreboard = parsed.showScoreboard;
      }
      if (typeof parsed.loopClaudesPlan === 'boolean') {
        this.loopClaudesPlan = parsed.loopClaudesPlan;
      }
      if (typeof parsed.devGraphicsTuning === 'boolean') {
        this.devGraphicsTuning = parsed.devGraphicsTuning;
      }
    } catch {
      // Corrupt/unavailable storage — fall back to defaults silently.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mouseSensitivity: this.mouseSensitivity,
        sfxVolume: this.sfxVolume,
        lobbyMusicVolume: this.lobbyMusicVolume,
        battleMusicVolume: this.battleMusicVolume,
        reducedEffects: this.reducedEffects,
        showScoreboard: this.showScoreboard,
        loopClaudesPlan: this.loopClaudesPlan,
        devGraphicsTuning: this.devGraphicsTuning
      }));
    } catch {
      // Storage may be unavailable (private mode); ignore.
    }
  }
}

export const settings = new SettingsStore();
