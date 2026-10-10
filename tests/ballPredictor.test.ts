import { describe, expect, it } from 'vitest';
import { BallPredictor } from '../src/game/network/BallPredictor';
import { createBallState, advanceBall } from '../shared/simulation/BallSim';
import { EXTRAPOLATION_LIMIT_MS } from '../shared/netConfig';
import type { ThrowEvent } from '../shared/protocol';
import type { BallState } from '../shared/types';

const event: ThrowEvent = {
  type: 'throw-event', throwId: 1, ballId: 'ball', ownerId: 'red', hand: 'right',
  serverTick: 128, serverTimeMs: 1000, origin: { x: 0, y: 5, z: 0 },
  velocity: { x: 30, y: 0, z: 0 }, curveAccel: { x: 0, y: 0, z: 4 },
  dropScale: 0.5, isSuper: false, isCurve: true, charge01: 1, resetSerial: 0
};
const dt = 1 / 128 / 2;
function initial(): BallState {
  return createBallState(event.ballId, event.origin, {
    phase: 'live', throwId: event.throwId, ownerId: event.ownerId, ownerKind: 'player',
    velocity: event.velocity, curveAccel: event.curveAccel, dropScale: event.dropScale
  });
}
function advance(ball: BallState, ms: number): BallState {
  while (ms > 0) {
    const step = Math.min(dt, ms / 1000);
    ball = advanceBall(ball, step);
    ms -= step * 1000;
  }
  return ball;
}
function seeded(): BallPredictor {
  const predictor = new BallPredictor({ fixedDt: dt });
  predictor.applyThrowEvent(event);
  return predictor;
}

describe('ball visual prediction', () => {
  it('moves between packets without treating packet age as position error', () => {
    const predictor = seeded();
    const snapshot = advance(initial(), 31.25);
    const a = { ...predictor.predict(snapshot, 1031.25, 1031.25)!.position };
    const b = predictor.predict(snapshot, 1041.25, 1031.25)!;
    expect(b.position.x - a.x).toBeCloseTo(0.3, 6);
    expect(b.errorM).toBe(0);
    expect(predictor.getStats().totalCorrections).toBe(0);
  });

  it('has the same trajectory at 60Hz and 144Hz rendering', () => {
    function renderAt(rate: number) {
      const predictor = seeded();
      const snapshot = initial();
      for (let t = 0; t < 100; t += 1000 / rate) predictor.predict(snapshot, 1000 + t, 1000);
      return { ...predictor.predict(snapshot, 1100, 1000)!.position };
    }
    expect(renderAt(60)).toEqual(renderAt(144));
  });

  it('refreshes velocity and curve progress from new authoritative samples', () => {
    const predictor = seeded();
    predictor.predict(initial(), 1000, 1000);
    const authoritative = advance(initial(), 31.25);
    authoritative.velocity.x = 15;
    authoritative.curveDistance = 10;
    predictor.predict(authoritative, 1031.25, 1031.25);
    const position = predictor.predict(authoritative, 1051.25, 1031.25)!.position;
    expect(position).toEqual(advance(authoritative, 20).position);
  });

  it('counts a correction once per authoritative sample, not once per frame', () => {
    const predictor = seeded();
    predictor.predict(initial(), 1000, 1000);
    const authoritative = advance(initial(), 31.25);
    authoritative.position.x += 0.2;
    predictor.predict(authoritative, 1031.25, 1031.25);
    predictor.predict(authoritative, 1040, 1031.25);
    predictor.predict(authoritative, 1050, 1031.25);
    expect(predictor.getStats().totalCorrections).toBe(1);
    expect(predictor.getStats().softCorrectionCount).toBe(1);
  });

  it('anchors bounce prediction at packet time and advances to render time', () => {
    const predictor = seeded();
    const ball = initial();
    ball.bounceCount = 1;
    ball.velocity.x = -30;
    const result = predictor.predict(ball, 1050, 1030)!;
    expect(result.snapReason).toBe('bounce');
    expect(result.position).toEqual(advance(ball, 20).position);
  });

  it('stops prediction on authoritative catches and changed throw identities', () => {
    const predictor = seeded();
    const caught = { ...initial(), phase: 'held' as const, heldByPlayerId: 'blue' };
    expect(predictor.predict(caught, 1050, 1030)).toBeNull();
    expect(predictor.has('ball')).toBe(false);
    predictor.applyThrowEvent(event);
    expect(predictor.predict({ ...initial(), throwId: 2 }, 1050, 1030)).toBeNull();
    expect(predictor.has('ball')).toBe(false);
  });

  it('ends a delayed held-ball bridge when a newer snapshot reports a catch', () => {
    const predictor = seeded();
    const caught = { ...initial(), phase: 'held' as const, heldByPlayerId: 'blue' };
    expect(predictor.advanceVisualOnly('ball', 1050, caught, 1040)).toBeNull();
    expect(predictor.has('ball')).toBe(false);
  });

  it('allows the throw event to bridge an older held snapshot', () => {
    const predictor = seeded();
    const held = { ...initial(), phase: 'held' as const, heldByPlayerId: 'red', throwId: 0 };
    expect(predictor.advanceVisualOnly('ball', 1010, held, 990)?.x).toBeCloseTo(0.3);
  });

  it.each(['held', 'loose', 'live'] as const)('does not cancel a newer throw from an older %s snapshot', phase => {
    const predictor = seeded();
    const old = { ...initial(), phase, ownerId: 'blue', throwId: 0 };
    expect(predictor.predict(old, 1010, 990)?.position.x).toBeCloseTo(0.3);
    expect(predictor.getStats().totalCorrections).toBe(0);
    expect(predictor.has('ball')).toBe(true);
  });

  it('refreshes a held-pose bridge beyond the extrapolation cap when fresh packets arrive', () => {
    const predictor = seeded();
    let authoritative = initial();
    for (let elapsed = 31.25; elapsed <= 187.5; elapsed += 31.25) {
      authoritative = advance(authoritative, 31.25);
      expect(predictor.advanceVisualOnly('ball', 1000 + elapsed + 10, authoritative, 1000 + elapsed))
        .toEqual(advance(authoritative, 10).position);
    }
    expect(predictor.getStats().totalCorrections).toBe(0);
  });

  it('does not repeat bounce snaps for the same packet', () => {
    const predictor = seeded();
    const bounced = { ...initial(), bounceCount: 1 };
    expect(predictor.predict(bounced, 1030, 1030)?.snapReason).toBe('bounce');
    expect(predictor.predict(bounced, 1040, 1030)?.snapped).toBe(false);
    expect(predictor.getStats().snapCount).toBe(1);
  });

  it('caps extrapolation during an outage and forgets the trajectory on reset', () => {
    const predictor = seeded();
    const position = { ...predictor.predict(initial(), 5000, 1000)!.position };
    expect(position.x).toBeCloseTo(30 * EXTRAPOLATION_LIMIT_MS / 1000);
    expect(predictor.predict(initial(), 10000, 1000)!.position).toEqual(position);
    predictor.clear();
    expect(predictor.predict(initial(), 10010, 1000)).toBeNull();
  });
});
