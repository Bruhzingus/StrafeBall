import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiplayerClient } from '../src/game/network/MultiplayerClient';
import { createRoomState } from '../shared/simulation/MatchSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import { makeTieredCompactSnapshot } from '../shared/snapshotCodec';

afterEach(() => vi.restoreAllMocks());

function connectedClient() {
  let wallMs = 100_000;
  let monotonicMs = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => wallMs);
  vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
  const client = new MultiplayerClient('ws://test');
  const handlers = new Map<string, (message: any) => void>();
  const room = {
    onMessage: (name: string, handler: (message: any) => void) => handlers.set(name, handler),
    onError: () => {}, onLeave: () => {},
    reconnection: { enabled: false }, leave: async () => {}
  };
  const internal = client as unknown as { room: typeof room; bindRoom: (value: typeof room) => void };
  internal.room = room;
  internal.bindRoom(room);
  client.localPlayerId = 'me';
  const state = createRoomState({ players: [createPlayerState('me', 'blue')] });
  return {
    client,
    emit: (name: string, message: unknown) => handlers.get(name)!(message),
    reset: (serial: number) => { state.resetVote.resetSerial = serial; },
    advance: (ms: number) => { wallMs += ms; monotonicMs += ms; },
    jumpWall: (ms: number) => { wallMs += ms; },
    pong: (rttMs: number, serverTimeMs = 2000) => handlers.get('pong')!({ clientTimeMs: wallMs - rttMs, serverTimeMs }),
    snapshot: (tick: number, serverTimeMs: number, world = true) => handlers.get('snapshot')!(
      makeTieredCompactSnapshot({ type: 'snapshot', tick, serverTimeMs, room: state }, {
        includePlayerLane: world, includeBallLane: world, includeWorldLane: world
      })
    )
  };
}

describe('multiplayer clock and receive pipeline', () => {
  it('keeps clock sync and lag compensation steady through an isolated ping spike', () => {
    const test = connectedClient();
    test.pong(20);
    test.advance(1000);
    test.pong(3020, 3000);
    expect(test.client.pingMs).toBe(3020);
    expect(test.client.rttEstimateMs).toBe(20);
    test.snapshot(1, 3010);
    expect(test.client.estimateServerTimeMs()).toBe(3020);
  });

  it('expires old low RTT samples after a sustained route change, including zero-ms loopback', () => {
    const test = connectedClient();
    test.pong(0);
    test.advance(1000);
    test.pong(100);
    expect(test.client.rttEstimateMs).toBe(0);
    test.advance(9001);
    test.pong(100);
    expect(test.client.rttEstimateMs).toBe(100);
  });

  it('advances server time with a monotonic clock across local wall-clock adjustments', () => {
    const test = connectedClient();
    test.snapshot(1, 2000);
    test.advance(25);
    test.jumpWall(60_000);
    expect(test.client.estimateServerTimeMs()).toBe(2025);
    test.jumpWall(-120_000);
    test.advance(25);
    expect(test.client.estimateServerTimeMs()).toBe(2050);
  });

  it('retains intermediate world/ball lanes and actual arrival times between display frames', () => {
    const test = connectedClient();
    test.snapshot(1, 2000);
    test.advance(8);
    test.snapshot(2, 2008, false);
    test.advance(8);
    test.snapshot(3, 2016);
    const received = test.client.drainReceivedSnapshots();
    expect(received.map((sample) => sample.snapshot.tick)).toEqual([1, 2, 3]);
    expect(received.map((sample) => sample.receivedAtMs)).toEqual([100, 108, 116]);
    expect(received.map((sample) => sample.lanes.ballLane)).toEqual([true, false, true]);
    expect(test.client.drainReceivedSnapshots()).toEqual([]);
    test.snapshot(2, 2008);
    expect(test.client.drainReceivedSnapshots()).toEqual([]);
  });

  it('bounds a paused renderer queue and clears timing across rooms', () => {
    const test = connectedClient();
    for (let tick = 1; tick <= 200; tick += 1) test.snapshot(tick, 2000 + tick * 8);
    const received = test.client.drainReceivedSnapshots();
    expect(received).toHaveLength(128);
    expect(received[127].snapshot.tick).toBe(200);
    test.snapshot(201, 3608);
    test.pong(20);
    test.client.leave();
    expect(test.client.drainReceivedSnapshots()).toEqual([]);
    expect(test.client.estimateServerTimeMs()).toBeNull();
    expect(test.client.rttEstimateMs).toBeNull();
    expect(test.client.getConnectionDebug().socketBufferedAmount).toBe(0);
  });

  it('does not replay old combat or old snapshots after a reset within one display frame', () => {
    const test = connectedClient();
    test.snapshot(1, 2000);
    test.emit('throw-event', { resetSerial: 0, serverTick: 2 });
    test.emit('catch-event', { serverTick: 2 });
    test.emit('throw-event', { resetSerial: 1, serverTick: 3 });
    test.emit('parry-event', { serverTick: 3 });
    test.reset(1);
    test.snapshot(3, 2020);
    test.emit('throw-event', { resetSerial: 0, serverTick: 2 });
    test.emit('catch-event', { serverTick: 2 });
    expect(test.client.drainReceivedSnapshots().map(sample => sample.snapshot.tick)).toEqual([3]);
    expect(test.client.drainThrowEvents()).toEqual([{ resetSerial: 1, serverTick: 3 }]);
    expect(test.client.drainCatchEvents()).toEqual([]);
    expect(test.client.drainParryEvents()).toEqual([{ serverTick: 3 }]);
  });
});
