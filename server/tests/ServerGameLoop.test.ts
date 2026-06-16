import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS } from '../../shared/constants';
import { vec3 } from '../../shared/simulation/CollisionMath';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

describe('ServerGameLoop', () => {
  it('assigns two players and rejects a third', () => {
    const loop = new ServerGameLoop('room');

    const p1 = loop.addPlayer('a', 'A');
    const p2 = loop.addPlayer('b', 'B');
    const p3 = loop.addPlayer('c', 'C');

    expect(p1?.spawnSide).toBe('negativeZ');
    expect(p2?.spawnSide).toBe('positiveZ');
    expect(p3).toBeNull();
  });

  it('server decides a contested pickup and does not duplicate the ball', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');

    loop.state.players.a.movement.position = vec3(0, 0, 0);
    loop.state.players.b.movement.position = vec3(0, 0, 0);

    const first = loop.handlePickup('a');
    const second = loop.handlePickup('b');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(loop.state.players.a.hands.left.heldBallId).toBeTruthy();
    expect(loop.state.players.b.hands.left.heldBallId).toBeTruthy();
    expect(loop.state.players.a.hands.left.heldBallId).not.toBe(loop.state.players.b.hands.left.heldBallId);
  });

  it('validates throws from held balls only', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.state.players.a.movement.position = vec3(0, 0, 0);

    expect(loop.handleThrow('a', { hand: 'left', direction: vec3(0, 0, 1), charge01: 0 }).ok).toBe(false);

    expect(loop.handlePickup('a').ok).toBe(true);
    const thrown = loop.handleThrow('a', { hand: 'left', direction: vec3(0, 0, 1), charge01: 0 });

    expect(thrown.ok).toBe(true);
    const ballId = Object.values(loop.state.balls).find((ball) => ball.phase === 'live')?.id;
    expect(ballId).toBeTruthy();
  });

  it('server-side hit validation grants score and dash charge', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');

    loop.state.players.a.dash.charges = GAME_CONSTANTS.dash.maxCharges - 1;
    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      position: { ...loop.state.players.b.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
      velocity: vec3()
    };

    loop.step();

    expect(loop.state.match.scoreByTeamId.blue).toBe(1);
    expect(loop.state.players.a.score).toBe(1);
    expect(loop.state.players.a.dash.charges).toBe(GAME_CONSTANTS.dash.maxCharges);
    expect(loop.state.balls.ball_0.phase).toBe('dead');
  });

  it('blocks mid-match reset but allows a rematch once the match is complete', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    loop.state.match.scoreByTeamId.blue = 3;
    loop.state.players.a.score = 3;

    // Unilateral reset mid-duel is griefing and is rejected (#6).
    expect(loop.handleReset('a').ok).toBe(false);
    expect(loop.state.match.scoreByTeamId.blue).toBe(3);

    // Once the match is complete, either player may start a rematch.
    loop.state.match.status = 'complete';
    const reset = loop.handleReset('a');

    expect(reset.ok).toBe(true);
    expect(Object.keys(loop.state.players)).toEqual(['a', 'b']);
    expect(Object.keys(loop.state.balls)).toHaveLength(GAME_CONSTANTS.map.ballCount);
    expect(loop.state.match.scoreByTeamId.blue).toBe(0);
    expect(loop.state.players.a.score).toBe(0);
  });

  it('forfeits to the remaining player when an opponent abandons mid-match', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');

    loop.abandon('b');

    expect(loop.state.match.status).toBe('complete');
    expect(loop.state.match.winnerTeamId).toBe(loop.state.players.a.teamId);
    expect(Object.keys(loop.state.players)).toEqual(['a']);
  });
});
