import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('server battle music sync', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts on playing and stops when the match completes', async () => {
    let nowMs = 1_000;
    const { ServerGameLoop } = await import('../src/simulation/ServerGameLoop');
    const loop = new ServerGameLoop('music-room', { now: () => nowMs, battleMusicTrackCount: 2 });
    loop.addPlayer('p1', 'One');
    loop.addPlayer('p2', 'Two');

    loop.state.match = {
      ...loop.state.match,
      status: 'countdown',
      countdownSeconds: 0.001
    };

    nowMs = 2_000;
    loop.advance();
    const playingMusic = loop.getBattleMusicSyncState();
    expect(playingMusic.active).toBe(true);
    expect(playingMusic.sessionId).toBe(1);
    expect(playingMusic.playlistStartedAtServerTimeMs).toBe(2_000);
    expect(loop.drainBattleMusicSyncDirty()).toEqual(playingMusic);

    nowMs = 2_500;
    loop.setConnected('p2', false, nowMs + 1_000);
    const stoppedMusic = loop.getBattleMusicSyncState();
    expect(stoppedMusic.active).toBe(false);
    expect(stoppedMusic.sessionId).toBe(1);
  });

  it('starts a fresh session after a reset and replay', async () => {
    let nowMs = 10_000;
    const { ServerGameLoop } = await import('../src/simulation/ServerGameLoop');
    const loop = new ServerGameLoop('music-room', { now: () => nowMs, battleMusicTrackCount: 1 });
    loop.addPlayer('p1', 'One');
    loop.addPlayer('p2', 'Two');

    loop.state.match = {
      ...loop.state.match,
      status: 'countdown',
      countdownSeconds: 0.001
    };
    nowMs = 11_000;
    loop.advance();
    expect(loop.getBattleMusicSyncState().sessionId).toBe(1);

    loop.handleReset('p1');
    loop.handleReset('p2');
    expect(loop.getBattleMusicSyncState().active).toBe(false);

    loop.state.match = {
      ...loop.state.match,
      status: 'countdown',
      countdownSeconds: 0.001
    };
    nowMs = 12_000;
    loop.advance();
    const nextSession = loop.getBattleMusicSyncState();
    expect(nextSession.active).toBe(true);
    expect(nextSession.sessionId).toBe(2);
    expect(nextSession.playlistStartedAtServerTimeMs).toBe(12_000);
  });
});
