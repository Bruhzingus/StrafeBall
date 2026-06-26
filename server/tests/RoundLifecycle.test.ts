import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS } from '../../shared/constants';
import { vec3 } from '../../shared/simulation/CollisionMath';
import { canonicalizeRoomSettings, recommendedRoomSettings } from '../../shared/roomSettings';
import type { RoomSettings } from '../../shared/types';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

function playNow(loop: ServerGameLoop): void {
  loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };
}

function setLiveHitBall(loop: ServerGameLoop, ballId: string, throwerId: string, targetId: string): void {
  const target = loop.state.players[targetId];
  loop.state.balls[ballId] = {
    ...loop.state.balls[ballId],
    phase: 'live',
    ownerKind: 'player',
    ownerId: throwerId,
    heldByPlayerId: null,
    heldHand: null,
    position: { ...target.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
    velocity: vec3(0, 0, 24),
    bounceCount: 0
  };
}

function settings(overrides: Partial<RoomSettings>): RoomSettings {
  return canonicalizeRoomSettings({ ...recommendedRoomSettings(overrides.format ?? '1v1'), ...overrides });
}

/** Drain a (countdown) timer by stepping past it, leaving the match live. */
function stepThroughCountdown(loop: ServerGameLoop): void {
  const steps = Math.ceil(GAME_CONSTANTS.match.countdownSeconds * loop.tickRate) + 2;
  for (let i = 0; i < steps && loop.state.match.status === 'countdown'; i += 1) loop.step();
}

describe('Stage 3 — unified round lifecycle', () => {
  it('1v1 is lives-based: eliminating the opponent ends the single-round match', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    const aTeam = loop.state.players.a.teamId;
    loop.state.players.b.lives = 1;
    setLiveHitBall(loop, 'ball_0', 'a', 'b');
    loop.step();

    expect(loop.state.players.b.combatState).toBe('eliminated');
    expect(loop.state.match.status).toBe('complete');
    expect(loop.state.match.winnerTeamId).toBe(aTeam);
    expect(loop.state.match.roundsWonByTeamId[aTeam]).toBe(1);
    expect(loop.state.phase).toBe('match-end');
  });

  it('progresses through multiple rounds before a best-of-3 match completes', () => {
    const loop = new ServerGameLoop('room', { settings: settings({ format: '1v1', roundCount: 3 }) });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    const aTeam = loop.state.players.a.teamId;
    expect(loop.state.match.roundCount).toBe(3);

    // Round 1 → a wins: opponent eliminated, but the MATCH continues (best of 3) → intermission.
    playNow(loop);
    loop.state.players.b.lives = 1;
    setLiveHitBall(loop, 'ball_0', 'a', 'b');
    loop.step();
    expect(loop.state.match.status).toBe('intermission');
    expect(loop.state.phase).toBe('round-end');
    expect(loop.state.match.roundsWonByTeamId[aTeam]).toBe(1);
    expect(loop.state.match.winnerTeamId).toBeNull();
    expect(loop.state.intermissionVote.active).toBe(true);
    expect(loop.state.intermissionVote.requiredVotes).toBe(2); // 70% of 2 players

    // Both players vote for the next round → inter-round countdown begins.
    expect(loop.handleIntermissionVote('a', 'next-round').ok).toBe(true);
    expect(loop.state.intermissionVote.nextRoundCount).toBe(1);
    expect(loop.state.match.status).toBe('intermission'); // not enough yet
    expect(loop.handleIntermissionVote('b', 'next-round').ok).toBe(true);
    expect(loop.state.match.status).toBe('countdown');
    expect(loop.state.match.currentRound).toBe(2);

    // The inter-round countdown rebuilds the world: b is alive again with full lives.
    stepThroughCountdown(loop);
    expect(loop.state.match.status).toBe('playing');
    expect(loop.state.players.b.combatState).toBe('alive');
    expect(loop.state.players.b.lives).toBe(GAME_CONSTANTS.match.playerLives);

    // Round 2 → a wins again: clinches the best-of-3 (2 rounds) → match complete.
    loop.state.players.b.lives = 1;
    setLiveHitBall(loop, 'ball_0', 'a', 'b');
    loop.step();
    expect(loop.state.match.roundsWonByTeamId[aTeam]).toBe(2);
    expect(loop.state.match.status).toBe('complete');
    expect(loop.state.match.winnerTeamId).toBe(aTeam);
  });

  it('shows the report card between rounds and a to-lobby vote returns to the pregame lobby', () => {
    const loop = new ServerGameLoop('room', { settings: settings({ format: '1v1', roundCount: 3 }) });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    loop.state.players.b.lives = 1;
    setLiveHitBall(loop, 'ball_0', 'a', 'b');
    loop.step();
    expect(loop.state.match.status).toBe('intermission');
    expect(loop.state.intermissionVote.allowsNextRound).toBe(true);

    // Both vote to return to the lobby → warmup pregame lobby (membership preserved).
    expect(loop.handleIntermissionVote('a', 'to-lobby').ok).toBe(true);
    expect(loop.state.intermissionVote.toLobbyCount).toBe(1);
    expect(loop.handleIntermissionVote('b', 'to-lobby').ok).toBe(true);
    expect(loop.state.match.status).toBe('warmup');
    expect(loop.state.phase).toBe('lobby');
    expect(loop.state.intermissionVote.active).toBe(false);
    expect(Object.keys(loop.state.players)).toEqual(['a', 'b']);
  });

  it('requires a 70% supermajority to pass an intermission vote (3-of-4 in 2v2)', () => {
    const loop = new ServerGameLoop('room', { settings: settings({ format: '2v2', roundCount: 3 }) });
    for (const id of ['a', 'b', 'c', 'd']) loop.addPlayer(id, id.toUpperCase());
    playNow(loop);
    const aTeam = loop.state.players.a.teamId;
    // Eliminate the opposing pair to end round 1.
    const losers = Object.values(loop.state.players).filter((p) => p.teamId !== aTeam).map((p) => p.id);
    const winners = Object.values(loop.state.players).filter((p) => p.teamId === aTeam).map((p) => p.id);
    loop.state.players[losers[0]].lives = 1;
    loop.state.players[losers[1]].lives = 1;
    setLiveHitBall(loop, 'ball_0', winners[0], losers[0]);
    loop.step();
    setLiveHitBall(loop, 'ball_1', winners[1] ?? winners[0], losers[1]);
    loop.step();
    expect(loop.state.match.status).toBe('intermission');
    expect(loop.state.intermissionVote.requiredVotes).toBe(3); // ceil(0.7 * 4)

    // Two of four is not enough.
    loop.handleIntermissionVote('a', 'next-round');
    loop.handleIntermissionVote('b', 'next-round');
    expect(loop.state.match.status).toBe('intermission');
    // The third vote passes it.
    loop.handleIntermissionVote('c', 'next-round');
    expect(loop.state.match.status).toBe('countdown');
  });

  it('auto-advances to the next round if the intermission times out', () => {
    let nowMs = 0;
    const loop = new ServerGameLoop('room', { settings: settings({ format: '1v1', roundCount: 3 }), now: () => nowMs });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);
    loop.state.players.b.lives = 1;
    setLiveHitBall(loop, 'ball_0', 'a', 'b');
    loop.step();
    expect(loop.state.match.status).toBe('intermission');

    nowMs += 31_000; // past the 30s intermission timeout
    loop.step();
    expect(loop.state.match.status).toBe('countdown');
    expect(loop.state.match.currentRound).toBe(2);
  });

  it('drops half-court restrictions once the configured half timer elapses', () => {
    const loop = new ServerGameLoop('room', { settings: settings({ format: '1v1', halfCourtTimerSeconds: 0 }) });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);
    expect(loop.state.match.boundary.noBoundaries).toBe(false);
    loop.step();
    expect(loop.state.match.boundary.noBoundaries).toBe(true);
  });

  it('does NOT drop restrictions before the configured half timer', () => {
    const loop = new ServerGameLoop('room', { settings: settings({ format: '1v1', halfCourtTimerSeconds: 300 }) });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);
    for (let i = 0; i < 20; i += 1) loop.step();
    expect(loop.state.match.boundary.noBoundaries).toBe(false);
  });
});

describe('Stage 3 — settings-driven mat presets', () => {
  it('spawns the authoritative mat set for each preset', () => {
    const six = new ServerGameLoop('room', { settings: settings({ format: '1v1', matPreset: 6 }) });
    expect(Object.keys(six.state.mats)).toHaveLength(6);

    const four = new ServerGameLoop('room', { settings: settings({ format: '1v1', matPreset: 4 }) });
    expect(Object.keys(four.state.mats)).toHaveLength(4);

    const two = new ServerGameLoop('room', { settings: settings({ format: '1v1', matPreset: 2 }) });
    expect(Object.keys(two.state.mats)).toHaveLength(2);

    const none = new ServerGameLoop('room', { settings: settings({ format: '1v1', matPreset: 0 }) });
    expect(Object.keys(none.state.mats)).toHaveLength(0);
  });

  it('rebuilds the mat set when the host changes the preset in the lobby', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A'); // single player keeps the lobby open
    expect(Object.keys(loop.state.mats)).toHaveLength(4);
    expect(loop.handleUpdateRoomSettings('a', { matPreset: 6 }).ok).toBe(true);
    expect(Object.keys(loop.state.mats)).toHaveLength(6);
    expect(loop.handleUpdateRoomSettings('a', { matPreset: 2 }).ok).toBe(true);
    expect(Object.keys(loop.state.mats)).toHaveLength(2);
    expect(loop.handleUpdateRoomSettings('a', { matPreset: 0 }).ok).toBe(true);
    expect(Object.keys(loop.state.mats)).toHaveLength(0);
  });
});

describe('Stage 3 — live-ball bounce cap from settings', () => {
  it('kills a live ball after the configured number of bounces', () => {
    const loop = new ServerGameLoop('room', { settings: settings({ format: '1v1', maxLiveBallBounces: 0, matPreset: 0 }) });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);
    expect(loop.getMatchSettings().maxLiveBallBounces).toBe(0);

    // A live ball driven into the floor must die immediately (0 bounces survived).
    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      heldByPlayerId: null,
      heldHand: null,
      position: vec3(8, GAME_CONSTANTS.ball.radius + 0.02, 8),
      velocity: vec3(0, -20, 0),
      bounceCount: 0
    };
    for (let i = 0; i < 6; i += 1) loop.step();
    expect(loop.state.balls.ball_0.phase).toBe('dead');
  });

  it('always kills a live ball on the floor even when the bounce cap is higher', () => {
    const loop = new ServerGameLoop('room', { settings: settings({ format: '1v1', maxLiveBallBounces: 3, matPreset: 0 }) });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      heldByPlayerId: null,
      heldHand: null,
      position: vec3(0, GAME_CONSTANTS.ball.radius + 0.02, 0),
      velocity: vec3(0, -20, 0),
      bounceCount: 0
    };

    for (let i = 0; i < 6; i += 1) loop.step();
    expect(loop.state.balls.ball_0.phase).toBe('dead');
    expect(loop.state.balls.ball_0.bounceCount).toBe(1);
  });

  it('applies the configured bounce cap to wall and ceiling rebounds', () => {
    const loop = new ServerGameLoop('room', { settings: settings({ format: '1v1', maxLiveBallBounces: 3, matPreset: 0 }) });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      heldByPlayerId: null,
      heldHand: null,
      position: vec3(0, GAME_CONSTANTS.map.wallHeight - GAME_CONSTANTS.ball.radius - 0.01, 0),
      velocity: vec3(0, 24, 0),
      bounceCount: 0
    };

    for (let i = 0; i < 8 && loop.state.balls.ball_0.bounceCount < 1; i += 1) loop.step();
    expect(loop.state.balls.ball_0.phase).toBe('live');
    expect(loop.state.balls.ball_0.bounceCount).toBe(1);
  });
});

describe('Stage 4 — early-end vote + host start', () => {
  it('host opens the vote, reaches the 70% threshold, then the room returns to the lobby', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A'); // a is host
    loop.addPlayer('b', 'B');
    playNow(loop);
    expect(loop.getHostPlayerId()).toBe('a');

    // Host opens it (counts as their yes); 1 of 2 — not enough yet.
    expect(loop.handleEndVote('a').ok).toBe(true);
    expect(loop.state.endVote.active).toBe(true);
    expect(loop.state.endVote.initiatedByPlayerId).toBe('a');
    expect(loop.state.endVote.voteCount).toBe(1);
    expect(loop.state.endVote.requiredVotes).toBe(2);
    expect(loop.state.match.status).toBe('playing');

    // The guest agrees → threshold reached → return to lobby (no auto-start), votes cleared.
    expect(loop.handleEndVote('b').ok).toBe(true);
    expect(loop.state.match.status).toBe('warmup');
    expect(loop.state.phase).toBe('lobby');
    expect(loop.state.endVote.active).toBe(false);
  });

  it('rejects a non-host opening the vote and a vote while not live', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');

    // Not live (warmup/countdown handled as not-live for opening — warmup here).
    loop.state.match = { ...loop.state.match, status: 'warmup' };
    expect(loop.handleEndVote('a')).toEqual({ ok: false, reason: 'not-live' });

    playNow(loop);
    expect(loop.handleEndVote('b')).toEqual({ ok: false, reason: 'not-host' });
  });

  it('lets the host start a configured match from the lobby (and rejects a guest)', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    // End the live game → lobby.
    loop.handleEndVote('a');
    loop.handleEndVote('b');
    expect(loop.state.match.status).toBe('warmup');

    expect(loop.handleStartMatch('b')).toEqual({ ok: false, reason: 'not-host' });
    expect(loop.handleStartMatch('a').ok).toBe(true);
    expect(loop.state.match.status).toBe('countdown');
  });

  it('a full 1v1 lobby waits in warmup and starts only once both players vote', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');

    // Filling the lobby must NOT silently start the match.
    expect(loop.state.match.status).toBe('warmup');

    expect(loop.handleStartVote('a').ok).toBe(true);
    expect(loop.state.startVote.voteCount).toBe(1);
    expect(loop.state.startVote.requiredVotes).toBe(2);
    expect(loop.state.match.status).toBe('warmup');

    expect(loop.handleStartVote('b').ok).toBe(true);
    expect(loop.state.match.status).toBe('countdown');
  });
});
