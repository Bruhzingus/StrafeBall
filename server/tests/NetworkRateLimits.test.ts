import { describe, expect, it } from 'vitest';
import { CLIENT_INPUT_RATE } from '../../shared/netConfig';
import { inflateCompactSnapshot, makeCompactSnapshot } from '../../shared/snapshotCodec';
import { buildInboundRateLimits, computeMaxMessagesPerSecondPerClient, expectedPerClientMessagesPerSecond } from '../src/network/NetworkRateLimits';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

describe('NetworkRateLimits', () => {
  it('keeps the Colyseus per-client cap above normal steady-state traffic', () => {
    const expected = expectedPerClientMessagesPerSecond(CLIENT_INPUT_RATE);
    const limit = computeMaxMessagesPerSecondPerClient(CLIENT_INPUT_RATE);

    expect(limit).toBeGreaterThan(expected);
    expect(limit).toBeGreaterThanOrEqual(300);
  });

  it('sizes the input token bucket above the steady input rate with burst headroom', () => {
    const inputLimit = buildInboundRateLimits(CLIENT_INPUT_RATE).input;

    expect(inputLimit.refillPerSecond).toBeGreaterThan(CLIENT_INPUT_RATE);
    expect(inputLimit.capacity).toBeGreaterThan(CLIENT_INPUT_RATE);
  });
});

describe('compact snapshot round-trip', () => {
  it('preserves the fields needed for movement, hands, combat, ack, balls, and match state', () => {
    const loop = new ServerGameLoop('snapshot-diag', { mode: '2v2', playersPerTeam: 2 });
    for (const playerId of ['a', 'b', 'c', 'd']) {
      expect(loop.addPlayer(playerId, playerId.toUpperCase())).toBeTruthy();
    }

    const a = loop.state.players.a;
    a.movement.position.x = 1.25;
    a.movement.position.z = -3.5;
    a.movement.yawRadians = Math.PI / 3;
    a.movement.pitchRadians = -0.35;
    a.hands.left.mode = 'catching';
    a.hands.left.heldBallId = 'ball-1';
    a.hands.left.lastCatchAttemptId = 42;
    a.hands.right.mode = 'holding';
    a.hands.right.heldBallId = 'ball-2';
    a.lastProcessedInputSeq = 777;
    a.combatState = 'alive';
    a.lives = 2;

    const b = loop.state.players.b;
    b.combatState = 'eliminated';
    b.lives = 0;

    const firstBall = Object.values(loop.state.balls)[0];
    firstBall.phase = 'live';
    firstBall.ownerKind = 'player';
    firstBall.ownerId = 'a';
    firstBall.heldByPlayerId = null;
    firstBall.heldHand = null;
    firstBall.throwId = 19;

    const secondBall = Object.values(loop.state.balls)[1];
    secondBall.phase = 'held';
    secondBall.ownerKind = 'player';
    secondBall.ownerId = 'a';
    secondBall.heldByPlayerId = 'a';
    secondBall.heldHand = 'right';
    secondBall.throwId = 20;

    loop.state.match.status = 'playing';
    loop.state.match.scoreByTeamId[a.teamId] = 3;
    loop.state.match.scoreByTeamId[b.teamId] = 1;

    const inflated = inflateCompactSnapshot(makeCompactSnapshot(loop.snapshot()));
    const inflatedA = inflated.room.players.a;
    const inflatedB = inflated.room.players.b;
    const inflatedFirstBall = inflated.room.balls[firstBall.id];
    const inflatedSecondBall = inflated.room.balls[secondBall.id];

    expect(inflatedA.movement.position.x).toBeCloseTo(a.movement.position.x, 3);
    expect(inflatedA.movement.position.z).toBeCloseTo(a.movement.position.z, 3);
    expect(inflatedA.movement.yawRadians).toBeCloseTo(a.movement.yawRadians, 4);
    expect(inflatedA.movement.pitchRadians).toBeCloseTo(a.movement.pitchRadians, 4);
    expect(inflatedA.hands.left.mode).toBe('catching');
    expect(inflatedA.hands.left.heldBallId).toBe('ball-1');
    expect(inflatedA.hands.left.lastCatchAttemptId).toBe(42);
    expect(inflatedA.hands.right.mode).toBe('holding');
    expect(inflatedA.hands.right.heldBallId).toBe('ball-2');
    expect(inflatedA.lastProcessedInputSeq).toBe(777);
    expect(inflatedA.combatState).toBe('alive');
    expect(inflatedA.lives).toBe(2);
    expect(inflatedB.combatState).toBe('eliminated');
    expect(inflatedB.lives).toBe(0);
    expect(inflatedFirstBall.phase).toBe('live');
    expect(inflatedFirstBall.ownerId).toBe('a');
    expect(inflatedFirstBall.throwId).toBe(19);
    expect(inflatedSecondBall.phase).toBe('held');
    expect(inflatedSecondBall.heldByPlayerId).toBe('a');
    expect(inflatedSecondBall.heldHand).toBe('right');
    expect(inflatedSecondBall.throwId).toBe(20);
    expect(inflated.room.match.status).toBe('playing');
    expect(inflated.room.match.scoreByTeamId[a.teamId]).toBe(3);
    expect(inflated.room.match.scoreByTeamId[b.teamId]).toBe(1);
  });
});
