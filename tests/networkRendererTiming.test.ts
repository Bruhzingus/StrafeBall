import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine, Scene } from '@babylonjs/core';
import { NetworkRenderer } from '../src/game/network/NetworkRenderer';
import { createRoomState } from '../shared/simulation/MatchSim';
import { laneInfoFromFullSnapshot } from '../shared/snapshotCodec';
import type { CatchEvent, ServerSnapshot, ThrowEvent } from '../shared/protocol';
import type { BallPredictor } from '../src/game/network/BallPredictor';
import { createBallState } from '../shared/simulation/BallSim';

afterEach(() => vi.restoreAllMocks());
function snapshot(tick: number, serverTimeMs: number, resetSerial = 0): ServerSnapshot {
  const room = createRoomState({ players: [] });
  room.balls = {};
  room.resetVote.resetSerial = resetSerial;
  return { type: 'snapshot', tick, serverTimeMs, room };
}
function renderer(): NetworkRenderer {
  // These tests exercise buffering and clocking with no visual entities, so no GPU scene is used.
  return new NetworkRenderer(null as unknown as Scene);
}
type Internals = {
  advanceRenderClock(dt: number): number;
  samplePlayerSnapshot(timeMs: number): unknown;
  sampleBallSnapshot(timeMs: number): unknown;
  playerSnapshotBuffer: { tick: number; receivedAtMs: number }[];
  ballSnapshotBuffer: { tick: number; receivedAtMs: number }[];
  metricIntervalMaxMs: number;
  metricUnderruns: number;
  frameUnderrun: boolean;
  ballPredictor: BallPredictor;
};
function internals(value: NetworkRenderer): Internals { return value as unknown as Internals; }
function throwEvent(serverTimeMs: number, resetSerial = 0): ThrowEvent {
  return {
    type: 'throw-event', throwId: 1, ballId: 'ball', ownerId: 'red', hand: 'right',
    serverTick: 128, serverTimeMs, origin: { x: 0, y: 5, z: 0 },
    velocity: { x: 30, y: 0, z: 0 }, curveAccel: { x: 0, y: 0, z: 0 },
    dropScale: 0.5, isSuper: false, isCurve: false, charge01: 1, resetSerial
  };
}
function catchEvent(serverTimeMs: number): CatchEvent {
  return {
    type: 'catch-event', ballId: 'ball', catcherId: 'red', hand: 'right', absorbedSpeed: 0,
    incomingVelocity: { x: 0, y: 0, z: 0 }, serverTick: 128, serverTimeMs, reclaim: false
  };
}

describe('network renderer delivery timing', () => {
  it('preserves all between-frame snapshots and measures actual arrival gaps', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const view = renderer();
    for (let i = 0; i < 3; i++) view.ingestSnapshot(snapshot(i, 1000 + i * 10), undefined, 20 + i * 10);
    // Rendering the same newest packet must not retimestamp it or insert it twice.
    view.update(snapshot(2, 1020), 'local', 1 / 60);
    const state = internals(view);
    expect(state.playerSnapshotBuffer.map(s => s.tick)).toEqual([0, 1, 2]);
    expect(state.playerSnapshotBuffer.map(s => s.receivedAtMs)).toEqual([20, 30, 40]);
    expect(state.metricIntervalMaxMs).toBe(10);
    expect(view.getDebugStats().latestSnapshotAgeMs).toBe(60);
  });

  it('preserves a ball lane followed by a player-only packet within one frame', () => {
    const view = renderer();
    const full = snapshot(1, 1000);
    view.ingestSnapshot(full, undefined, 20);
    const fast = snapshot(2, 1010);
    view.ingestSnapshot(fast, { ...laneInfoFromFullSnapshot(fast), ballLane: false }, 30);
    expect(internals(view).playerSnapshotBuffer.map(s => s.tick)).toEqual([1, 2]);
    expect(internals(view).ballSnapshotBuffer.map(s => s.tick)).toEqual([1]);
  });

  it('advances evenly between packets at both 60Hz and 144Hz', () => {
    function run(rate: number): number {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const view = renderer();
      const state = internals(view);
      view.ingestSnapshot(snapshot(0, 10000), undefined, 0);
      const start = state.advanceRenderClock(0);
      let nextArrival = 10;
      for (let frame = 1; frame <= rate; frame++) {
        now = frame * 1000 / rate;
        while (nextArrival <= now) {
          view.ingestSnapshot(snapshot(nextArrival, 10000 + nextArrival), undefined, nextArrival);
          nextArrival += 10;
        }
        expect(state.advanceRenderClock(1 / rate)).toBeCloseTo(start + now, 5);
      }
      return state.advanceRenderClock(0) - start;
    }
    expect(run(60)).toBeCloseTo(1000, 5);
    expect(run(144)).toBeCloseTo(1000, 5);
  });

  it('does not count sampling exactly at the newest snapshot as an underrun', () => {
    const view = renderer();
    view.ingestSnapshot(snapshot(0, 1000), undefined, 20);
    view.ingestSnapshot(snapshot(1, 1010), undefined, 30);
    const state = internals(view);
    state.samplePlayerSnapshot(1010);
    state.sampleBallSnapshot(1010);
    expect(state.frameUnderrun).toBe(false);
  });

  it('counts a frame once when both lanes underrun', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const view = renderer();
    view.ingestSnapshot(snapshot(0, 1000), undefined, 0);
    view.ingestSnapshot(snapshot(1, 1010), undefined, 10);
    view.update(snapshot(1, 1010), 'local', 1 / 60);
    expect(internals(view).metricUnderruns).toBe(1);
  });

  it('preserves a later rethrow when older catches and parries are drained in the same frame', () => {
    const view = renderer();
    view.applyThrowEvents([throwEvent(1050)]);
    view.applyCatchEvents([catchEvent(1000)]);
    view.applyParryEvents([{ type: 'parry-event', ballId: 'ball', deflectorId: 'blue', serverTick: 128, serverTimeMs: 1020 }]);
    expect(internals(view).ballPredictor.has('ball')).toBe(true);
    view.applyCatchEvents([catchEvent(1060)]);
    expect(internals(view).ballPredictor.has('ball')).toBe(false);
  });

  it('keeps a fresh throw after reset ingestion and ignores throw events from the previous round', () => {
    const view = renderer();
    view.ingestSnapshot(snapshot(0, 1000), undefined, 0);
    view.applyThrowEvents([throwEvent(1000)]);
    view.ingestSnapshot(snapshot(1, 1010, 1), undefined, 10);
    expect(internals(view).ballPredictor.has('ball')).toBe(false);
    view.applyThrowEvents([throwEvent(1010)]);
    expect(internals(view).ballPredictor.has('ball')).toBe(false);
    view.applyThrowEvents([throwEvent(1010, 1)]);
    view.update(snapshot(1, 1010, 1), 'local', 1 / 60);
    expect(internals(view).ballPredictor.has('ball')).toBe(true);
  });

  it.each(['held', 'loose'] as const)('renders a fresh throw even while interpolation still shows %s', phase => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const view = new NetworkRenderer(scene);
    try {
      const old = snapshot(0, 1000);
      old.room.balls.ball = createBallState('ball', { x: 0, y: 5, z: 0 }, {
        phase, heldByPlayerId: phase === 'held' ? 'red' : null,
        heldHand: phase === 'held' ? 'right' : null
      });
      view.ingestSnapshot(old, undefined, now);
      now = 20;
      const fresh = snapshot(1, 1020);
      fresh.room.balls.ball = createBallState('ball', { x: 0.3, y: 5, z: 0 }, {
        phase: 'live', throwId: 1, ownerId: 'red', ownerKind: 'player',
        velocity: { x: 30, y: 0, z: 0 }, dropScale: 0.5
      });
      view.ingestSnapshot(fresh, undefined, now);
      view.applyThrowEvents([throwEvent(1010)]);
      view.update(fresh, 'local', 1 / 60);
      expect(scene.getMeshByName('networkBall_ball')?.position.x).toBeCloseTo(0.3);
      now += 10;
      view.update(fresh, 'local', 0.01);
      expect(scene.getMeshByName('networkBall_ball')?.position.x).toBeCloseTo(0.6);
    } finally {
      view.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it('clears the old interpolation timeline and gap history on round reset', () => {
    const view = renderer();
    view.ingestSnapshot(snapshot(10, 1000), undefined, 20);
    view.ingestSnapshot(snapshot(11, 1010), undefined, 30);
    view.ingestSnapshot(snapshot(12, 1020, 1), undefined, 5000);
    expect(internals(view).playerSnapshotBuffer.map(s => s.tick)).toEqual([12]);
    expect(internals(view).ballSnapshotBuffer.map(s => s.tick)).toEqual([12]);
    expect(internals(view).metricIntervalMaxMs).toBe(10);
  });
});
