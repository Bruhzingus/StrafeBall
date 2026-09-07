import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectRoom, WebRTCTransport, negotiateDirect, type DirectLink } from '../src/game/network/directSession';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function link() {
  const channel = { readyState: 'open', bufferedAmount: 0, send: vi.fn(), close: vi.fn(), onmessage: null as any };
  const close = vi.fn(() => { channel.readyState = 'closed'; });
  return { channel, close, peer: {} } as unknown as DirectLink;
}
describe('browser direct transport', () => {
  it('maps state live, copies SDK frames, and closes once with the server code', () => {
    vi.useFakeTimers();
    const peer = link();
    const closed = vi.fn();
    const transport = new WebRTCTransport(peer, { onclose: closed });
    transport.connect('ws://host/relay/HOST-code/process/room?sessionId=seat');
    expect(JSON.parse((peer.channel.send as any).mock.calls[0][0])).toEqual({ type: 'join', processId: 'process', roomId: 'room', sessionId: 'seat' });
    const input = new Uint8Array([0, 255, 1]);
    transport.send(input); input[0] = 42;
    expect((peer.channel.send as any).mock.calls[1][0][0]).toBe(0);
    expect(transport.isOpen).toBe(true);
    peer.channel.onmessage!({ data: '{"type":"closed","code":4000,"reason":"left"}' } as MessageEvent);
    transport.close();
    expect(closed).toHaveBeenCalledExactlyOnceWith({ code: 4000, reason: 'left' });
    expect(transport.isOpen).toBe(false);
    expect(transport.ws.readyState).toBe(3);
  });
  it('does not interpret text heartbeat as Colyseus and detects a silent dead host', async () => {
    vi.useFakeTimers();
    const peer = link();
    const message = vi.fn(); const close = vi.fn();
    const transport = new WebRTCTransport(peer, { onmessage: message, onclose: close });
    transport.connect('ws://host/process/room?sessionId=seat');
    peer.channel.onmessage!({ data: '{"type":"alive"}' } as MessageEvent);
    expect(message).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 4410 }));
  });
  it('reports close before handshake as a join error and disables SDK reconnection', () => {
    vi.useFakeTimers();
    const peer = link();
    const room = new DirectRoom('duel', peer);
    const error = vi.fn(); room.onError(error);
    room.connect('ws://host/process/room?sessionId=seat');
    room.connection.close(4410, 'gone');
    expect(error).toHaveBeenCalledExactlyOnceWith(4410, 'gone');
    expect(room.reconnection.enabled).toBe(false);
  });
  it('cancels negotiation promptly and disposes both peer and signaling resources', async () => {
    vi.useFakeTimers();
    const channel = { close: vi.fn() };
    const closePeer = vi.fn(); const closeSocket = vi.fn();
    vi.stubGlobal('RTCPeerConnection', class { createDataChannel() { return channel; } close = closePeer; });
    vi.stubGlobal('WebSocket', class { close = closeSocket; });
    const controller = new AbortController();
    const pending = negotiateDirect('ws://localhost/relay/HOST-code', controller.signal);
    const rejected = expect(pending).rejects.toThrow('Direct negotiation unavailable');
    controller.abort(); await rejected;
    expect(closePeer).toHaveBeenCalledOnce(); expect(closeSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(closePeer).toHaveBeenCalledOnce();
  });
});
