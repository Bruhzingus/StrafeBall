import { describe, expect, it, vi } from 'vitest';
import { ClientState, getMessageBytes, Protocol } from 'colyseus';
import { WebSocketClient } from '@colyseus/ws-transport';
import type WebSocket from 'ws';
import { PERF_REPORT_INTERVAL_MS, SNAPSHOT_BACKPRESSURE_BYTES } from '../../shared/netConfig';
import { DuelRoom } from '../src/rooms/DuelRoom';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

function setup(count = 4) {
  const room = new DuelRoom();
  const game = new ServerGameLoop('snapshot-test', { mode: count === 4 ? '2v2' : '1v1', playersPerTeam: count / 2 });
  // Exercise the real broadcast path without starting room lifecycle timers or matchmaker hooks.
  const internals = room as unknown as {
    game: ServerGameLoop;
    debug: { PERF_DEBUG: boolean };
    netFlightRecorderEnabled: boolean;
    eventLoopDelay: { reset(): void };
    broadcastSnapshot(dueMs: number, actualMs: number): void;
    recordSimulationTick(durationMs: number, nowMs: number): void;
  };
  internals.game = game;
  internals.debug = { ...internals.debug, PERF_DEBUG: false };
  internals.netFlightRecorderEnabled = true;
  const peers = Array.from({ length: count }, (_, i) => {
    const socket = { bufferedAmount: 0, send: vi.fn(), readyState: 1 };
    const client = new WebSocketClient(`player-${i}`, socket as unknown as WebSocket);
    client.state = ClientState.JOINED;
    room.clients.push(client);
    game.addPlayer(client.sessionId, client.sessionId);
    return { client, socket };
  });
  return { room, game, internals, peers };
}

describe('DuelRoom snapshot delivery', () => {
  it.each([2, 4])('encodes one immutable frame for %i peers, including recorder accounting', (count) => {
    const { internals, peers } = setup(count);
    const encode = vi.spyOn(getMessageBytes, 'raw');
    try {
      internals.broadcastSnapshot(10, 10);
      expect(encode).toHaveBeenCalledTimes(1);
      expect(encode.mock.calls[0][0]).toBe(Protocol.ROOM_DATA);
      expect(encode.mock.calls[0][1]).toBe('snapshot');
      const frame = peers[0].socket.send.mock.calls[0][0] as Buffer;
      const saved = Buffer.from(frame);
      for (const { socket } of peers) expect(socket.send.mock.calls[0][0]).toBe(frame);
      // Later encodes cannot corrupt a frame while a slow socket is still transmitting it.
      getMessageBytes.raw(Protocol.ROOM_DATA, 'pong', { serverTimeMs: 999 });
      expect(frame).toEqual(saved);
    } finally {
      encode.mockRestore();
    }
  });

  it('keeps a congested peer out of the send and preserves the Colyseus joining queue', () => {
    const { internals, peers } = setup();
    peers[0].socket.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
    peers[1].client.state = ClientState.JOINING;
    internals.broadcastSnapshot(10, 10);
    expect(peers[0].socket.send).not.toHaveBeenCalled();
    expect(peers[1].socket.send).not.toHaveBeenCalled();
    expect(peers[1].client._enqueuedMessages).toHaveLength(1);
    expect(peers[1].client._enqueuedMessages[0]).toBe(peers[2].socket.send.mock.calls[0][0]);
    expect(peers[3].socket.send).toHaveBeenCalledTimes(1);
  });

  it('resets the pong diagnostic window even without verbose perf logging', () => {
    const { internals } = setup(2);
    const reset = vi.spyOn(internals.eventLoopDelay, 'reset');
    try {
      internals.recordSimulationTick(0.1, 1);
      internals.recordSimulationTick(0.1, 1 + PERF_REPORT_INTERVAL_MS);
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      reset.mockRestore();
    }
  });
});
