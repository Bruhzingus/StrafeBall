import { settings } from '../config/Settings';
import {
  BATTLE_MUSIC_TRACKS
} from '../../../shared/music/generatedBattleMusicManifest';
import {
  LOBBY_MUSIC_TRACKS
} from '../../../shared/music/generatedLobbyMusicManifest';
import {
  formatBattleMusicTimestamp,
  resolveBattleMusicTimeline,
  type BattleMusicSyncState,
  type BattleMusicTimeline,
  type BattleMusicTrack
} from '../../../shared/music/BattleMusic';

// "Claude Planning mode" (settings toggle) loops this single lobby track instead of shuffling.
const CLAUDES_PLAN_TRACK_ID = 'jeff-guo-claude-s-plan';

const FADE_IN_SECONDS = 0.6;
const FADE_OUT_SECONDS = 0.35;
const RESYNC_INTERVAL_SECONDS = 0.75;
const IGNORE_DRIFT_SECONDS = 0.12;
const SOFT_CORRECT_DRIFT_SECONDS = 0.5;
const SEEK_DRIFT_SECONDS = 0.9;
const LOBBY_MUSIC_OUTPUT_SCALE = 0.06;
// Battle music sits at 30% of the lobby scale, boosted a further 86% so battles read louder.
const BATTLE_MUSIC_OUTPUT_SCALE = LOBBY_MUSIC_OUTPUT_SCALE * 0.3 * 1.86;

type MusicSource = 'none' | 'battle' | 'lobby';

type PitchPreservingAudioElement = HTMLAudioElement & {
  mozPreservesPitch?: boolean;
  preservesPitch: boolean;
  webkitPreservesPitch?: boolean;
};

export interface MusicHudState {
  artist: string;
  title: string;
  currentLabel: string;
  durationLabel: string;
}

export class MusicManager {
  private readonly audio: PitchPreservingAudioElement = new Audio();
  private readonly lobbyShuffleSeed = randomUint32();
  private readonly lobbyStartOffsetSeconds = randomLobbyStartOffsetSeconds();
  private battleSyncState: BattleMusicSyncState | null = null;
  private lobbyMusicActive = false;
  private lobbyMusicStartedAtMs = 0;
  private activeTrackIndex = -1;
  private loadedTrackIndex = -1;
  private loadedSource: MusicSource = 'none';
  private fadeLevel = 0;
  private fadeTarget = 0;
  private pauseWhenSilent = false;
  private autoplayBlocked = false;
  private syncTimer = 0;
  private needsImmediateResync = false;
  private windowFocused = typeof document !== 'undefined' ? document.hasFocus() : true;

  constructor(private readonly estimateServerTimeMs: () => number | null) {
    this.audio.preload = 'auto';
    this.audio.loop = false;
    this.audio.addEventListener('ended', this.onTrackEnded);
    this.audio.addEventListener('loadedmetadata', this.onLoadedMetadata);
    this.audio.addEventListener('canplay', this.onCanPlay);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('focus', this.onWindowFocus);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('pointerdown', this.onUserGesture, { passive: true });
    window.addEventListener('keydown', this.onUserGesture);
    this.enablePitchPreservation();
    this.applyOutputVolume();
  }

  dispose(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio.removeEventListener('ended', this.onTrackEnded);
    this.audio.removeEventListener('loadedmetadata', this.onLoadedMetadata);
    this.audio.removeEventListener('canplay', this.onCanPlay);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('focus', this.onWindowFocus);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('pointerdown', this.onUserGesture);
    window.removeEventListener('keydown', this.onUserGesture);
  }

  setBattleSyncState(syncState: BattleMusicSyncState | null): void {
    if (sameSyncState(this.battleSyncState, syncState)) return;
    const previousSessionId = this.battleSyncState?.sessionId ?? -1;
    const previousActive = this.battleSyncState?.active ?? false;
    this.battleSyncState = syncState;
    this.needsImmediateResync = true;

    if (!syncState?.active) {
      if (!this.lobbyMusicActive) this.beginFadeOut();
      return;
    }

    if (syncState.sessionId !== previousSessionId || !previousActive) {
      this.activeTrackIndex = -1;
      this.loadedTrackIndex = -1;
    }
  }

  setLobbyMusicActive(active: boolean): void {
    if (this.lobbyMusicActive === active) return;
    this.lobbyMusicActive = active;
    this.needsImmediateResync = true;

    if (active) {
      this.lobbyMusicStartedAtMs = performance.now();
      this.activeTrackIndex = -1;
      this.loadedTrackIndex = -1;
      this.loadedSource = 'none';
      return;
    }

    if (!(this.battleSyncState?.active)) this.beginFadeOut();
  }

  update(dt: number): void {
    this.syncTimer += dt;
    this.applyOutputVolume();

    if (!this.shouldDisplayMusic()) {
      this.beginFadeOut();
      this.updateFade(dt);
      return;
    }

    if (!this.shouldAudiblyPlay()) {
      this.beginFadeOut();
      this.updateFade(dt);
      return;
    }

    if (this.needsImmediateResync || this.syncTimer >= RESYNC_INTERVAL_SECONDS) {
      this.syncTimer = 0;
      this.needsImmediateResync = false;
      this.resyncPlayback();
    }

    this.updateFade(dt);
  }

  getHudState(): MusicHudState | null {
    const context = this.expectedPlayback();
    if (!context) return null;
    const track = context.tracks[context.timeline.trackIndex];
    return {
      artist: track.artist,
      title: track.title,
      currentLabel: formatBattleMusicTimestamp(context.timeline.trackElapsedSeconds),
      durationLabel: formatBattleMusicTimestamp(context.timeline.trackDurationSeconds)
    };
  }

  private expectedPlayback() {
    if (this.battleSyncState?.active && BATTLE_MUSIC_TRACKS.length > 0) {
      const serverNowMs = this.estimateServerTimeMs();
      if (serverNowMs !== null) {
        const timeline = resolveBattleMusicTimeline(
          BATTLE_MUSIC_TRACKS,
          this.battleSyncState.shuffleSeed,
          Math.max(0, (serverNowMs - this.battleSyncState.playlistStartedAtServerTimeMs) / 1000)
        );
        if (timeline) {
          return { source: 'battle' as const, tracks: BATTLE_MUSIC_TRACKS, timeline };
        }
      }
    }

    if (this.lobbyMusicActive && LOBBY_MUSIC_TRACKS.length > 0) {
      const lobbyElapsedSeconds =
        this.lobbyStartOffsetSeconds + Math.max(0, (performance.now() - this.lobbyMusicStartedAtMs) / 1000);
      // "Claude Planning mode": loop just "Claude's Plan"; otherwise shuffle the lobby playlist. The
      // single-track loop reuses the normal track-boundary machinery (ended → resync → seek to 0), so
      // it loops exactly like any lobby track transition.
      const timeline = settings.loopClaudesPlan
        ? singleTrackLoopTimeline(LOBBY_MUSIC_TRACKS, claudesPlanTrackIndex(), lobbyElapsedSeconds)
        : resolveBattleMusicTimeline(LOBBY_MUSIC_TRACKS, this.lobbyShuffleSeed, lobbyElapsedSeconds);
      if (timeline) {
        return { source: 'lobby' as const, tracks: LOBBY_MUSIC_TRACKS, timeline };
      }
    }

    return null;
  }

  private shouldDisplayMusic(): boolean {
    return this.expectedPlayback() !== null;
  }

  private shouldAudiblyPlay(): boolean {
    return this.shouldDisplayMusic() && document.visibilityState === 'visible' && this.windowFocused;
  }

  private resyncPlayback(): void {
    const context = this.expectedPlayback();
    if (!context) {
      this.beginFadeOut();
      return;
    }

    if (context.source !== this.loadedSource || context.timeline.trackIndex !== this.loadedTrackIndex) {
      this.loadTrack(context.source, context.tracks[context.timeline.trackIndex], context.timeline.trackIndex);
      return;
    }

    if (this.audio.readyState < HTMLMediaElement.HAVE_METADATA) return;

    const expected = clampAudioTime(context.timeline.trackElapsedSeconds, context.timeline.trackDurationSeconds);
    const drift = this.audio.currentTime - expected;
    if (Math.abs(drift) >= SEEK_DRIFT_SECONDS) {
      this.audio.currentTime = expected;
      this.fadeLevel = Math.min(this.fadeLevel, 0.2);
      this.beginFadeIn();
    } else if (Math.abs(drift) >= SOFT_CORRECT_DRIFT_SECONDS) {
      this.audio.currentTime = expected;
    } else if (Math.abs(drift) > IGNORE_DRIFT_SECONDS) {
      this.audio.playbackRate = clamp(1 - drift * 0.08, 0.97, 1.03);
    } else {
      this.audio.playbackRate = 1;
    }

    if (this.audio.paused) this.tryPlay();
    else this.beginFadeIn();
  }

  private loadTrack(source: MusicSource, track: { src: string } | undefined, trackIndex: number): void {
    if (!track || source === 'none') return;
    this.loadedSource = source;
    this.loadedTrackIndex = trackIndex;
    this.activeTrackIndex = trackIndex;
    this.audio.pause();
    this.audio.playbackRate = 1;
    this.audio.src = track.src;
    this.audio.load();
  }

  private tryPlay(): void {
    const playPromise = this.audio.play();
    if (!playPromise || typeof playPromise.then !== 'function') {
      this.beginFadeIn();
      return;
    }

    playPromise
      .then(() => {
        this.autoplayBlocked = false;
        this.beginFadeIn();
      })
      .catch(() => {
        this.autoplayBlocked = true;
        this.beginFadeOut();
      });
  }

  private beginFadeIn(): void {
    this.pauseWhenSilent = false;
    this.fadeTarget = 1;
  }

  private beginFadeOut(): void {
    this.fadeTarget = 0;
    this.pauseWhenSilent = true;
    this.audio.playbackRate = 1;
  }

  private updateFade(dt: number): void {
    const duration = this.fadeTarget > this.fadeLevel ? FADE_IN_SECONDS : FADE_OUT_SECONDS;
    const next = moveToward(this.fadeLevel, this.fadeTarget, dt / Math.max(0.001, duration));
    if (next !== this.fadeLevel) {
      this.fadeLevel = next;
      this.applyOutputVolume();
    }

    if (this.fadeLevel <= 0.001 && this.fadeTarget === 0 && this.pauseWhenSilent && !this.audio.paused) {
      this.audio.pause();
    }
  }

  // Per-source user volume (battle vs lobby) × the fixed engineering scale for that source.
  private userVolumeForActiveSource(): number {
    const source = this.expectedPlayback()?.source ?? this.loadedSource;
    if (source === 'battle') return clamp(settings.battleMusicVolume, 0, 1) * BATTLE_MUSIC_OUTPUT_SCALE;
    return clamp(settings.lobbyMusicVolume, 0, 1) * LOBBY_MUSIC_OUTPUT_SCALE;
  }

  private applyOutputVolume(): void {
    this.audio.volume = this.fadeLevel * this.userVolumeForActiveSource();
  }

  private enablePitchPreservation(): void {
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
  }

  private onLoadedMetadata = (): void => {
    const context = this.expectedPlayback();
    if (!context || context.source !== this.loadedSource || context.timeline.trackIndex !== this.loadedTrackIndex) return;
    this.audio.currentTime = clampAudioTime(context.timeline.trackElapsedSeconds, context.timeline.trackDurationSeconds);
  };

  private onCanPlay = (): void => {
    if (!this.shouldAudiblyPlay()) return;
    this.tryPlay();
  };

  private onTrackEnded = (): void => {
    this.needsImmediateResync = true;
  };

  private onVisibilityChange = (): void => {
    this.needsImmediateResync = true;
    if (!this.shouldAudiblyPlay()) this.beginFadeOut();
  };

  private onWindowFocus = (): void => {
    this.windowFocused = true;
    this.needsImmediateResync = true;
  };

  private onWindowBlur = (): void => {
    this.windowFocused = false;
    this.beginFadeOut();
  };

  private onUserGesture = (): void => {
    if (!this.autoplayBlocked || !this.shouldAudiblyPlay()) return;
    this.needsImmediateResync = true;
    this.resyncPlayback();
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function moveToward(current: number, target: number, delta: number): number {
  if (current === target) return current;
  if (target > current) return Math.min(target, current + delta);
  return Math.max(target, current - delta);
}

function clampAudioTime(currentTime: number, durationSeconds: number): number {
  return clamp(currentTime, 0, Math.max(0, durationSeconds - 0.01));
}

function sameSyncState(a: BattleMusicSyncState | null, b: BattleMusicSyncState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.active === b.active &&
    a.sessionId === b.sessionId &&
    a.shuffleSeed === b.shuffleSeed &&
    a.playlistStartedAtServerTimeMs === b.playlistStartedAtServerTimeMs
  );
}

function claudesPlanTrackIndex(): number {
  return LOBBY_MUSIC_TRACKS.findIndex((track) => track.id === CLAUDES_PLAN_TRACK_ID);
}

/**
 * A timeline that plays a single track on repeat: `trackIndex` fixed, position = elapsed mod its
 * duration. Returns null if the track is missing/zero-length so the caller falls back to the shuffle.
 */
function singleTrackLoopTimeline(
  tracks: readonly BattleMusicTrack[],
  trackIndex: number,
  elapsedSeconds: number
): BattleMusicTimeline | null {
  const track = trackIndex >= 0 ? tracks[trackIndex] : undefined;
  if (!track || !Number.isFinite(track.durationSeconds) || track.durationSeconds <= 0) return null;
  const duration = track.durationSeconds;
  const clamped = Math.max(0, elapsedSeconds);
  const trackElapsedSeconds = clamped % duration;
  return {
    cycleIndex: Math.floor(clamped / duration),
    cycleElapsedSeconds: trackElapsedSeconds,
    cycleDurationSeconds: duration,
    order: [trackIndex],
    orderIndex: 0,
    trackIndex,
    trackElapsedSeconds,
    trackDurationSeconds: duration
  };
}

function randomUint32(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

function randomLobbyStartOffsetSeconds(): number {
  if (LOBBY_MUSIC_TRACKS.length === 0) return 0;
  const totalDurationSeconds = LOBBY_MUSIC_TRACKS.reduce((sum, track) => sum + track.durationSeconds, 0);
  if (!Number.isFinite(totalDurationSeconds) || totalDurationSeconds <= 0) return 0;
  return (Math.random() * totalDurationSeconds) % totalDurationSeconds;
}
