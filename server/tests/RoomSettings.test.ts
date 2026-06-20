import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS } from '../../shared/constants';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

/** Force the match into live play (skips the pre-round countdown) for lock-during-play assertions. */
function playNow(loop: ServerGameLoop): void {
  loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };
}

describe('ServerGameLoop host + settings authority', () => {
  it('derives 1v1 room setup from the recommended preset', () => {
    const loop = new ServerGameLoop('room');
    const settings = loop.getMatchSettings();
    expect(loop.getSettings().preset).toBe('1v1-recommended');
    expect(settings.teamSize).toBe(1);
    expect(settings.maxPlayers).toBe(2);
    expect(settings.livesPerPlayer).toBe(GAME_CONSTANTS.match.playerLives);
    expect(Object.keys(loop.state.balls)).toHaveLength(GAME_CONSTANTS.map.ballCount);

    const player = loop.addPlayer('a', 'A');
    expect(player?.lives).toBe(GAME_CONSTANTS.match.playerLives);
  });

  it('derives 2v2 room setup (team size, lives, ball count) from settings', () => {
    const loop = new ServerGameLoop('room', { mode: '2v2', playersPerTeam: 2 });
    const settings = loop.getMatchSettings();
    expect(loop.getSettings().preset).toBe('2v2-recommended');
    expect(settings.teamSize).toBe(2);
    expect(settings.maxPlayers).toBe(4);
    expect(Object.keys(loop.state.balls)).toHaveLength(GAME_CONSTANTS.match.twoVTwoBallCount);
  });

  it('makes the room creator the host and exposes it in the snapshot', () => {
    const loop = new ServerGameLoop('room');
    expect(loop.getHostPlayerId()).toBeNull();
    // A single player keeps the room in the lobby (a full 1v1 roster auto-starts the countdown).
    loop.addPlayer('a', 'A');
    expect(loop.getHostPlayerId()).toBe('a');
    const snapshot = loop.snapshot();
    expect(snapshot.room.hostPlayerId).toBe('a');
    expect(snapshot.room.phase).toBe('lobby');
    expect(snapshot.room.settings.format).toBe('1v1');
  });

  it('reassigns the host when the host leaves', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    expect(loop.getHostPlayerId()).toBe('a');
    loop.abandon('a');
    expect(loop.getHostPlayerId()).toBe('b');
    loop.abandon('b');
    expect(loop.getHostPlayerId()).toBeNull();
  });

  it('lets the host change a valid setting and applies it authoritatively', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    const result = loop.handleUpdateRoomSettings('a', { livesPerPlayer: 5, maxLiveBallBounces: 3 });
    expect(result.ok).toBe(true);
    expect(loop.getSettings().livesPerPlayer).toBe(5);
    expect(loop.getMatchSettings().maxLiveBallBounces).toBe(3);
    expect(loop.state.settings.livesPerPlayer).toBe(5);
    // A fighter who joins after the change starts with the new life count.
    const joiner = loop.addPlayer('b', 'B');
    expect(joiner?.lives).toBe(5);
  });

  it('rejects a non-host attempting to change settings', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    const result = loop.handleUpdateRoomSettings('b', { livesPerPlayer: 5 });
    expect(result).toEqual({ ok: false, reason: 'not-host' });
    expect(loop.getSettings().livesPerPlayer).toBe(GAME_CONSTANTS.match.playerLives);
  });

  it('rejects invalid setting values', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    expect(loop.handleUpdateRoomSettings('a', { livesPerPlayer: 99 })).toEqual({ ok: false, reason: 'invalid-field' });
    expect(loop.handleUpdateRoomSettings('a', { matPreset: 3 })).toEqual({ ok: false, reason: 'invalid-field' });
  });

  it('locks settings during live play but allows changes between games', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    playNow(loop);
    expect(loop.handleUpdateRoomSettings('a', { livesPerPlayer: 4 })).toEqual({ ok: false, reason: 'settings-locked' });

    // Back to lobby (warmup) — host may configure again.
    loop.state.match = { ...loop.state.match, status: 'warmup' };
    expect(loop.handleUpdateRoomSettings('a', { livesPerPlayer: 4 }).ok).toBe(true);

    // And at the match summary (complete) — between games.
    loop.state.match = { ...loop.state.match, status: 'complete' };
    expect(loop.handleUpdateRoomSettings('a', { dodgeballCount: 8 }).ok).toBe(true);
  });

  it('rejects in-room format changes (format is fixed at creation in this stage)', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    expect(loop.handleUpdateRoomSettings('a', { format: '2v2' })).toEqual({ ok: false, reason: 'format-locked' });
    // A preset that implies a different format is also rejected.
    expect(loop.handleUpdateRoomSettings('a', { preset: '2v2-recommended' })).toEqual({ ok: false, reason: 'format-locked' });
  });

  it('applies a recommended preset in one update', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    expect(loop.handleUpdateRoomSettings('a', { livesPerPlayer: 6, dodgeballCount: 11 }).ok).toBe(true);
    expect(loop.getSettings().preset).toBe('custom');

    const result = loop.handleUpdateRoomSettings('a', { preset: '1v1-recommended' });
    expect(result.ok).toBe(true);
    expect(loop.getSettings().preset).toBe('1v1-recommended');
    expect(loop.getSettings().livesPerPlayer).toBe(GAME_CONSTANTS.match.playerLives);
    expect(loop.getSettings().dodgeballCount).toBe(GAME_CONSTANTS.map.ballCount);
  });

  it('rebuilds the ball set to the new dodgeball count on the next match start', () => {
    const loop = new ServerGameLoop('room');
    // Single player keeps the room in the lobby so the host can configure it.
    loop.addPlayer('a', 'A');
    expect(loop.handleUpdateRoomSettings('a', { dodgeballCount: 9 }).ok).toBe(true);
    // The next match start rebuilds the world (a 1-player room needs a single reset vote).
    expect(loop.handleReset('a').ok).toBe(true);
    expect(Object.keys(loop.state.balls)).toHaveLength(9);
  });
});
