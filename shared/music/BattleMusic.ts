export interface BattleMusicTrack {
  id: string;
  artist: string;
  title: string;
  filename: string;
  src: string;
  durationSeconds: number;
}

export interface BattleMusicSyncState {
  active: boolean;
  sessionId: number;
  shuffleSeed: number;
  playlistStartedAtServerTimeMs: number;
}

export interface BattleMusicTimeline {
  cycleIndex: number;
  cycleElapsedSeconds: number;
  cycleDurationSeconds: number;
  order: number[];
  orderIndex: number;
  trackIndex: number;
  trackElapsedSeconds: number;
  trackDurationSeconds: number;
}

const FILENAME_SUFFIX = '.mp3';
const FILENAME_SEPARATOR = ' - ';
const UINT32_MAX = 0x100000000;

export function createInactiveBattleMusicSyncState(): BattleMusicSyncState {
  return {
    active: false,
    sessionId: 0,
    shuffleSeed: 0,
    playlistStartedAtServerTimeMs: 0
  };
}

export function parseBattleMusicFilename(filename: string): { artist: string; title: string } | null {
  if (!filename.toLowerCase().endsWith(FILENAME_SUFFIX)) return null;
  const stem = filename.slice(0, -FILENAME_SUFFIX.length);
  const separatorIndex = stem.indexOf(FILENAME_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex >= stem.length - FILENAME_SEPARATOR.length) return null;

  const artist = stem.slice(0, separatorIndex).trim();
  const title = stem.slice(separatorIndex + FILENAME_SEPARATOR.length).trim();
  if (!artist || !title) return null;
  return { artist, title };
}

export function shuffleBattleMusicCycle(trackCount: number, shuffleSeed: number, cycleIndex: number): number[] {
  if (!Number.isFinite(trackCount) || trackCount <= 0) return [];
  const order = Array.from({ length: Math.trunc(trackCount) }, (_, index) => index);
  const rng = mulberry32(mixSeed(shuffleSeed, cycleIndex));
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const next = order[i];
    order[i] = order[j];
    order[j] = next;
  }
  return order;
}

export function resolveBattleMusicTimeline(
  tracks: readonly Pick<BattleMusicTrack, 'durationSeconds'>[],
  shuffleSeed: number,
  elapsedSeconds: number
): BattleMusicTimeline | null {
  if (tracks.length === 0 || !Number.isFinite(elapsedSeconds)) return null;
  const durations = tracks.map((track) => track.durationSeconds).filter((duration) => Number.isFinite(duration) && duration > 0);
  if (durations.length !== tracks.length) return null;

  const cycleDurationSeconds = durations.reduce((sum, duration) => sum + duration, 0);
  if (!Number.isFinite(cycleDurationSeconds) || cycleDurationSeconds <= 0) return null;

  const clampedElapsedSeconds = Math.max(0, elapsedSeconds);
  const cycleIndex = Math.floor(clampedElapsedSeconds / cycleDurationSeconds);
  const cycleElapsedSeconds = clampedElapsedSeconds % cycleDurationSeconds;
  const order = shuffleBattleMusicCycle(tracks.length, shuffleSeed, cycleIndex);

  let remaining = cycleElapsedSeconds;
  for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
    const trackIndex = order[orderIndex];
    const trackDurationSeconds = tracks[trackIndex].durationSeconds;
    if (remaining < trackDurationSeconds || orderIndex === order.length - 1) {
      return {
        cycleIndex,
        cycleElapsedSeconds,
        cycleDurationSeconds,
        order,
        orderIndex,
        trackIndex,
        trackElapsedSeconds: Math.min(trackDurationSeconds, remaining),
        trackDurationSeconds
      };
    }
    remaining -= trackDurationSeconds;
  }

  return null;
}

export function formatBattleMusicTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function createBattleMusicSessionSeed(sessionId: number, serverTimeMs: number): number {
  const a = Math.trunc(sessionId) >>> 0;
  const b = Math.trunc(serverTimeMs) >>> 0;
  return mixSeed(a ^ 0x9e3779b9, b);
}

function mixSeed(a: number, b: number): number {
  let value = (a ^ Math.imul(b ^ 0x85ebca6b, 0xc2b2ae35)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_MAX;
  };
}
