import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiplayerClient } from '../src/game/network/MultiplayerClient';
import { createRoomState } from '../shared/simulation/MatchSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import { lavaMaxHeight } from '../shared/simulation/MapEffectSim';
import { makeTieredCompactSnapshot } from '../shared/snapshotCodec';
import type { SnapshotPayload } from '../shared/protocol';

afterEach(() => vi.restoreAllMocks());

describe('online lava clock', () => {
  it('keeps the world timer age across fast packets, then reanchors on a world packet', () => {
    let now = 100000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const client = new MultiplayerClient('ws://test');
    const handlers = new Map<string, (message: SnapshotPayload) => void>();
    const fakeRoom = {
      onMessage: (name: string, handler: (message: SnapshotPayload) => void) => handlers.set(name, handler),
      onError: () => {}, onLeave: () => {}
    };
    const internal = client as unknown as { room: typeof fakeRoom; bindRoom: (room: typeof fakeRoom) => void };
    internal.room = fakeRoom;
    internal.bindRoom(fakeRoom);
    client.localPlayerId = 'me';
    const room = createRoomState({ players: [createPlayerState('me', 'blue')] });
    room.match.status = 'playing';
    room.mapEffect = { kind: 'lava', phase: 'active', remainingSeconds: 18, spawnIndex: 0, lavaLevel: 0 };
    const send = (tick: number, serverTimeMs: number, world: boolean) => {
      handlers.get('snapshot')!(makeTieredCompactSnapshot({ type: 'snapshot', tick, serverTimeMs, room }, {
        includePlayerLane: world, includeBallLane: world, includeWorldLane: world
      }));
    };
    send(1, 2000, true);
    expect(client.latestSnapshot?.room.mapEffect).toBeDefined();
    now += 50;
    send(2, 2050, false);
    now += 10;
    expect(client.latestSnapshot?.room.mapEffect?.lavaLevel).toBe(0);
    expect(client.presentedMapEffect?.lavaLevel).toBeCloseTo(lavaMaxHeight() * 0.06 / 4);

    now += 40;
    room.mapEffect.remainingSeconds = 17.9;
    send(3, 2100, true);
    expect(client.presentedMapEffect?.lavaLevel).toBeCloseTo(lavaMaxHeight() * 0.1 / 4);
    room.match.status = 'countdown';
    send(4, 2150, true);
    now += 100;
    expect(client.presentedMapEffect?.remainingSeconds).toBe(17.9);
  });
});
