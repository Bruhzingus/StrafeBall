import { describe, expect, it } from 'vitest';
import type { ServerSnapshot } from '../shared/protocol';
import { createBallState } from '../shared/simulation/BallSim';
import { vec3 } from '../shared/simulation/CollisionMath';
import { createRoomState } from '../shared/simulation/MatchSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import { hydrateSnapshotRoster, inflateCompactSnapshot, makeCompactSnapshot, rosterFromRoom } from '../shared/snapshotCodec';

describe('snapshot codec', () => {
  it('compact snapshots preserve hand, combat, ack, and ball identity fields', () => {
    const player = createPlayerState('p1', 'blue', 'negativeZ', {
      name: 'Ace',
      combatState: 'eliminated',
      lastProcessedInputSeq: 321
    });
    player.hands = {
      left: {
        ...player.hands.left,
        heldBallId: 'ball_0',
        mode: 'charging',
        chargeSeconds: 0.25,
        cooldownSeconds: 0.125,
        lastCatchAttemptId: 12
      },
      right: {
        ...player.hands.right,
        mode: 'catching',
        chargeSeconds: 0,
        cooldownSeconds: 0.47,
        lastCatchAttemptId: 13
      }
    };

    const ball = createBallState('ball_0', vec3(1, 2, 3), {
      phase: 'held',
      velocity: vec3(4, 5, 6),
      ownerKind: 'player',
      ownerId: 'p1',
      heldByPlayerId: 'p1',
      heldHand: 'left',
      bounceCount: 2,
      isSuper: true,
      dropScale: 0.5,
      curveAccel: vec3(0.1, 0.2, 0.3),
      lastTouchedByPlayerId: 'p1',
      throwId: 77
    });
    const room = createRoomState({ id: 'room', tick: 44, players: [player], balls: [ball] });
    room.resetVote = { ...room.resetVote, resetSerial: 3 };

    const snapshot: ServerSnapshot = {
      type: 'snapshot',
      tick: 44,
      serverTimeMs: 123456.7,
      room
    };
    const roster = rosterFromRoom(room);

    const compact = makeCompactSnapshot(snapshot);
    const inflated = inflateCompactSnapshot(compact);
    const hydrated = hydrateSnapshotRoster(inflated, roster);

    const decodedPlayer = hydrated.room.players.p1;
    expect(decodedPlayer.name).toBe('Ace');
    expect(decodedPlayer.combatState).toBe('eliminated');
    expect(decodedPlayer.lastProcessedInputSeq).toBe(321);
    expect(decodedPlayer.hands.left.heldBallId).toBe('ball_0');
    expect(decodedPlayer.hands.left.mode).toBe('charging');
    expect(decodedPlayer.hands.left.chargeSeconds).toBe(0.25);
    expect(decodedPlayer.hands.left.cooldownSeconds).toBe(0.125);
    expect(decodedPlayer.hands.left.lastCatchAttemptId).toBe(12);
    expect(decodedPlayer.hands.right.mode).toBe('catching');
    expect(decodedPlayer.hands.right.lastCatchAttemptId).toBe(13);

    const decodedBall = hydrated.room.balls.ball_0;
    expect(decodedBall.phase).toBe('held');
    expect(decodedBall.ownerKind).toBe('player');
    expect(decodedBall.ownerId).toBe('p1');
    expect(decodedBall.heldByPlayerId).toBe('p1');
    expect(decodedBall.heldHand).toBe('left');
    expect(decodedBall.throwId).toBe(77);
    expect(decodedBall.lastTouchedByPlayerId).toBe('p1');
    expect(hydrated.room.resetVote.resetSerial).toBe(3);
  });
});
