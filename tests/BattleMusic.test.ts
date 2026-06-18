import { describe, expect, it } from 'vitest';
import {
  createBattleMusicSessionSeed,
  formatBattleMusicTimestamp,
  parseBattleMusicFilename,
  resolveBattleMusicTimeline,
  shuffleBattleMusicCycle
} from '../shared/music/BattleMusic';

describe('battle music utilities', () => {
  it('parses strict artist-title filenames', () => {
    expect(parseBattleMusicFilename('Elektronomia - Sky High.mp3')).toEqual({
      artist: 'Elektronomia',
      title: 'Sky High'
    });
    expect(parseBattleMusicFilename('psychronic-clockwork-ascension-425665.mp3')).toBeNull();
  });

  it('shuffles every track exactly once per cycle', () => {
    const order = shuffleBattleMusicCycle(9, 12345, 0);
    expect(order).toHaveLength(9);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('changes shuffle order between cycles while staying deterministic', () => {
    const cycle0 = shuffleBattleMusicCycle(4, 9001, 0);
    const cycle1 = shuffleBattleMusicCycle(4, 9001, 1);
    expect(cycle0).not.toEqual(cycle1);
    expect(shuffleBattleMusicCycle(4, 9001, 1)).toEqual(cycle1);
  });

  it('resolves the expected track and offset across playlist loops', () => {
    const tracks = [
      { durationSeconds: 10 },
      { durationSeconds: 20 },
      { durationSeconds: 30 }
    ];
    const seed = createBattleMusicSessionSeed(7, 1000);
    const cycle0 = shuffleBattleMusicCycle(tracks.length, seed, 0);
    const cycle1 = shuffleBattleMusicCycle(tracks.length, seed, 1);

    const first = resolveBattleMusicTimeline(tracks, seed, 5);
    expect(first?.trackIndex).toBe(cycle0[0]);
    expect(first?.trackElapsedSeconds).toBe(5);

    const secondTrackStart = tracks[cycle0[0]].durationSeconds + 2;
    const second = resolveBattleMusicTimeline(tracks, seed, secondTrackStart);
    expect(second?.trackIndex).toBe(cycle0[1]);
    expect(second?.trackElapsedSeconds).toBe(2);

    const nextCycle = resolveBattleMusicTimeline(tracks, seed, 60 + 4);
    expect(nextCycle?.cycleIndex).toBe(1);
    expect(nextCycle?.trackIndex).toBe(cycle1[0]);
    expect(nextCycle?.trackElapsedSeconds).toBe(4);
  });

  it('formats timestamps as m:ss', () => {
    expect(formatBattleMusicTimestamp(0)).toBe('0:00');
    expect(formatBattleMusicTimestamp(74.8)).toBe('1:14');
  });
});
