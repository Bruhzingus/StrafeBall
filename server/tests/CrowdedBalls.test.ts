import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../../shared/constants';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';
import { createBallState } from '../../shared/simulation/BallSim';

const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const floorY = C.ball.radius + 0.05;

function playingLoop() {
  const loop = new ServerGameLoop('crowd');
  loop.addPlayer('a', 'A');
  loop.addPlayer('b', 'B');
  loop.state.match.status = 'playing';
  // Park both players far from the corner and from center so pickup/hit logic never interferes.
  loop.state.players.a.movement.position = v(-10, 0, -15);
  loop.state.players.b.movement.position = v(10, 0, 15);
  return loop;
}

/** Advance `seconds` of simulated time (the loop steps at its fixed tick). */
function advanceSeconds(loop: ServerGameLoop, seconds: number): void {
  const ticks = Math.ceil(seconds * (loop as unknown as { tickRate: number }).tickRate);
  for (let i = 0; i < ticks; i += 1) loop.advance();
}

describe('crowded loose balls respawn at center', () => {
  it('uses the same crowd timer during warmup', () => {
    const loop = playingLoop();
    loop.state.match.status = 'warmup';
    const spawn = { ...loop.state.balls.ball_0.position };
    loop.state.balls.ball_0 = { ...loop.state.balls.ball_0, position: v(12, floorY, 17) };
    loop.state.balls.ball_1 = { ...loop.state.balls.ball_1, position: v(12.8, floorY, 17.4) };

    advanceSeconds(loop, 6.5);
    expect(loop.state.balls.ball_0.position.x).toBeCloseTo(12, 1);
    advanceSeconds(loop, 1);
    expect(loop.state.balls.ball_0.position.x).toBeCloseTo(spawn.x, 5);
    expect(loop.state.balls.ball_0.position.z).toBeCloseTo(spawn.z, 5);
    expect(loop.state.balls.ball_0.crowdedSeconds ?? 0).toBe(0);
  });

  it('sends a pair of balls stashed in a corner back to their spawn slots after 7 seconds', () => {
    const loop = playingLoop();
    const spawn0 = { ...loop.state.balls.ball_0.position };
    const spawn1 = { ...loop.state.balls.ball_1.position };
    loop.state.balls.ball_0 = { ...loop.state.balls.ball_0, position: v(12, floorY, 17) };
    loop.state.balls.ball_1 = { ...loop.state.balls.ball_1, position: v(12.8, floorY, 17.4) };

    advanceSeconds(loop, 6.5);
    expect(loop.state.balls.ball_0.position.x).toBeCloseTo(12, 1);
    expect(loop.state.balls.ball_1.position.x).toBeCloseTo(12.8, 1);

    advanceSeconds(loop, 1);
    expect(loop.state.balls.ball_0.position.x).toBeCloseTo(spawn0.x, 5);
    expect(loop.state.balls.ball_0.position.z).toBeCloseTo(spawn0.z, 5);
    expect(loop.state.balls.ball_1.position.x).toBeCloseTo(spawn1.x, 5);
    expect(loop.state.balls.ball_1.position.z).toBeCloseTo(spawn1.z, 5);
    expect(loop.state.balls.ball_0.phase).toBe('loose');
    expect(loop.state.balls.ball_0.crowdedSeconds ?? 0).toBe(0);
  });

  it('never respawns a lone ball, and the timer resets once the balls separate', () => {
    const loop = playingLoop();
    loop.state.balls.ball_0 = { ...loop.state.balls.ball_0, position: v(12, floorY, 17) };
    loop.state.balls.ball_1 = { ...loop.state.balls.ball_1, position: v(12.8, floorY, 17.4) };
    advanceSeconds(loop, 5);
    expect(loop.state.balls.ball_0.crowdedSeconds ?? 0).toBeGreaterThan(4);
    // Separate them past the crowd radius: the timer must drop to 0 and neither ball moves later.
    loop.state.balls.ball_1 = { ...loop.state.balls.ball_1, position: v(12, floorY, 12) };
    advanceSeconds(loop, 10);
    expect(loop.state.balls.ball_0.crowdedSeconds ?? 0).toBe(0);
    expect(loop.state.balls.ball_0.position.x).toBeCloseTo(12, 1);
    expect(loop.state.balls.ball_1.position.z).toBeCloseTo(12, 1);
  });

  it('the initial center row is not crowded (slots are wider than the crowd radius)', () => {
    const loop = playingLoop();
    const before = Object.values(loop.state.balls).map((ball) => ({ ...ball.position }));
    advanceSeconds(loop, 10);
    Object.values(loop.state.balls).forEach((ball, i) => {
      expect(ball.position.x).toBeCloseTo(before[i].x, 5);
      expect(ball.crowdedSeconds ?? 0).toBe(0);
    });
    expect(C.ball.crowdRadius).toBeLessThan(2);
  });

  it('ignores held balls, live balls, and special power-up balls', () => {
    const loop = playingLoop();
    // A held ball next to a loose one: neither is crowded.
    loop.state.balls.ball_0 = { ...loop.state.balls.ball_0, position: v(12, floorY, 17) };
    loop.state.balls.ball_1 = {
      ...loop.state.balls.ball_1, position: v(12.5, floorY, 17), phase: 'held',
      ownerKind: 'player', ownerId: 'b', heldByPlayerId: 'b', heldHand: 'left'
    };
    loop.state.players.b.hands.left = { ...loop.state.players.b.hands.left, heldBallId: 'ball_1', mode: 'holding' };
    loop.state.players.b.movement.position = v(12.5, 0, 17);
    // A cannonball resting near a loose ball is not a crowd either.
    loop.state.balls.ball_2 = { ...loop.state.balls.ball_2, position: v(-12, floorY, -17) };
    loop.state.balls.powerball_1 = createBallState('powerball_1', v(-12.5, floorY, -17), { kind: 'cannon', phase: 'held', heldByPlayerId: 'a', heldHand: 'left', ownerKind: 'player', ownerId: 'a' });
    loop.state.players.a.hands.left = { ...loop.state.players.a.hands.left, heldBallId: 'powerball_1', mode: 'holding' };
    loop.state.players.a.movement.position = v(-12.5, 0, -17);

    advanceSeconds(loop, 10);
    expect(loop.state.balls.ball_0.position.x).toBeCloseTo(12, 1);
    expect(loop.state.balls.ball_2.position.x).toBeCloseTo(-12, 1);
    expect(loop.state.balls.ball_0.crowdedSeconds ?? 0).toBe(0);
  });
});
