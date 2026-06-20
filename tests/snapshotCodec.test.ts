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
    room.hostPlayerId = 'p1';
    room.phase = 'live';
    room.settings = { ...room.settings, livesPerPlayer: 5, dodgeballCount: 9, matPreset: 2 };

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

    // Host / lifecycle / settings ride the room spread untouched through the compact codec.
    expect(hydrated.room.hostPlayerId).toBe('p1');
    expect(hydrated.room.phase).toBe('live');
    expect(hydrated.room.settings.livesPerPlayer).toBe(5);
    expect(hydrated.room.settings.dodgeballCount).toBe(9);
    expect(hydrated.room.settings.matPreset).toBe(2);
  });

  it('int16-quantizes positions/velocities within sub-centimeter precision', () => {
    // Realistic in-arena values with messy decimals. Round-trip error must stay far below the
    // interpolation snap threshold (5 m) and reconcile threshold (0.5 m); we assert ~3mm position
    // and ~1cm/s velocity, which is invisible after interpolation.
    const player = createPlayerState('p1', 'blue', 'negativeZ');
    player.movement.position = vec3(12.3456, 7.891, -17.654);
    player.movement.velocity = vec3(-8.337, 0.42, 23.918);
    player.movement.facing = vec3(0.6018, 0, 0.7986);

    const ball = createBallState('b1', vec3(-12.999, 8.4, 17.001), {
      phase: 'live',
      velocity: vec3(40.5, -12.25, -33.75),
      curveAccel: vec3(13.5, 0, -13.5)
    });

    const room = createRoomState({ id: 'room', tick: 5, players: [player], balls: [ball] });
    const snapshot: ServerSnapshot = { type: 'snapshot', tick: 5, serverTimeMs: 1000, room };
    const decoded = inflateCompactSnapshot(makeCompactSnapshot(snapshot));

    const dp = decoded.room.players.p1;
    expect(dp.movement.position.x).toBeCloseTo(12.3456, 2);
    expect(dp.movement.position.y).toBeCloseTo(7.891, 2);
    expect(dp.movement.position.z).toBeCloseTo(-17.654, 2);
    expect(dp.movement.velocity.x).toBeCloseTo(-8.337, 1);
    expect(dp.movement.velocity.z).toBeCloseTo(23.918, 1);
    expect(dp.movement.facing.x).toBeCloseTo(0.6018, 3);
    expect(dp.movement.facing.z).toBeCloseTo(0.7986, 3);

    const db = decoded.room.balls.b1;
    expect(db.position.x).toBeCloseTo(-12.999, 2);
    expect(db.position.z).toBeCloseTo(17.001, 2);
    expect(db.velocity.x).toBeCloseTo(40.5, 1);
    expect(db.velocity.z).toBeCloseTo(-33.75, 1);
    expect(db.curveAccel.x).toBeCloseTo(13.5, 1);

    // Worst-case position error stays well under the reconcile snap threshold.
    const errX = Math.abs(dp.movement.position.x - 12.3456);
    expect(errX).toBeLessThan(0.01);
  });

  it('clamps an out-of-range position instead of overflowing to garbage', () => {
    // A glitch/teleport could put a value beyond the quantization range. It must clamp to the range
    // edge (a harmless far-away visual for a server-authoritative remote entity), never wrap to a
    // wildly wrong coordinate. ±64 m is the position range; 5000 m clamps to ~+64 m, not negative.
    const ball = createBallState('b1', vec3(5000, 0, -5000), { phase: 'live', velocity: vec3(0, 0, 0) });
    const room = createRoomState({ id: 'room', tick: 1, players: [], balls: [ball] });
    const snapshot: ServerSnapshot = { type: 'snapshot', tick: 1, serverTimeMs: 0, room };
    const decoded = inflateCompactSnapshot(makeCompactSnapshot(snapshot));

    const db = decoded.room.balls.b1;
    expect(db.position.x).toBeGreaterThan(60);
    expect(db.position.x).toBeLessThanOrEqual(64);
    expect(db.position.z).toBeLessThan(-60);
    expect(db.position.z).toBeGreaterThanOrEqual(-64);
    expect(Number.isFinite(db.position.x)).toBe(true);
  });

  it('round-trips a non-finite coordinate to 0 (never NaN on the wire)', () => {
    const player = createPlayerState('p1', 'blue', 'negativeZ');
    player.movement.position = vec3(Number.NaN, Infinity, 3);
    const room = createRoomState({ id: 'room', tick: 1, players: [player], balls: [] });
    const snapshot: ServerSnapshot = { type: 'snapshot', tick: 1, serverTimeMs: 0, room };
    const decoded = inflateCompactSnapshot(makeCompactSnapshot(snapshot));
    const dp = decoded.room.players.p1;
    expect(dp.movement.position.x).toBe(0);
    expect(Number.isFinite(dp.movement.position.y)).toBe(true);
    expect(dp.movement.position.z).toBeCloseTo(3, 2);
  });
});
