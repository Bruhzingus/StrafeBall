import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Room } from '@colyseus/sdk';
import { DirectRoom, WebRTCTransport, joinPrivateHost, negotiateDirect, roomConnectionDiagnostics, roomConnectionPath, type DirectLink } from '../src/game/network/directSession';
import { HostSessionClient } from '../src/game/network/hostSession';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  it('reports the selected network route and ICE RTT independently of the live send queue', async () => {
    vi.useFakeTimers();
    const peer = link();
    const report = new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'active' }],
      ['active', { type: 'candidate-pair', state: 'succeeded', nominated: true,
        currentRoundTripTime: 0.012, localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['other', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.1 }],
      ['local', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }],
      ['remote', { type: 'remote-candidate', candidateType: 'host', address: 'do-not-expose-addresses' }]
    ]);
    peer.peer.getStats = vi.fn().mockResolvedValue(report);
    const room = new DirectRoom('duel', peer);
    room.connect('ws://host/process/room?sessionId=seat');
    await Promise.resolve();
    Object.assign(peer.channel, { bufferedAmount: 240 });
    expect(roomConnectionDiagnostics(room)).toEqual({ networkRttMs: 12, bufferedBytes: 240,
      localCandidateType: 'srflx', remoteCandidateType: 'host', networkProtocol: 'udp' });
    report.delete('transport'); report.delete('active'); report.delete('other');
    await vi.advanceTimersByTimeAsync(1000);
    expect(roomConnectionDiagnostics(room).networkRttMs).toBeNull();
    room.connection.close();
  });
  it('does not overlap slow stats calls or close gameplay when diagnostics fail', async () => {
    vi.useFakeTimers();
    const peer = link();
    let rejectStats!: (error: Error) => void;
    peer.peer.getStats = vi.fn().mockReturnValue(new Promise((_resolve, reject) => { rejectStats = reject; }));
    const transport = new WebRTCTransport(peer, {});
    transport.connect('ws://host/process/room?sessionId=seat');
    await vi.advanceTimersByTimeAsync(3000);
    expect(peer.peer.getStats).toHaveBeenCalledOnce();
    rejectStats(new Error('Statistics unavailable')); await Promise.resolve();
    expect(transport.isOpen).toBe(true);
    transport.close();
    await vi.advanceTimersByTimeAsync(3000);
    expect(peer.peer.getStats).toHaveBeenCalledOnce();
  });
  it('distinguishes requested relay from unsupported WebRTC without reserving extra seats', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    const rooms = [{}, {}] as Room[];
    const join = vi.spyOn(HostSessionClient.prototype, 'joinById').mockResolvedValueOnce(rooms[0]).mockResolvedValueOnce(rooms[1]);
    const signal = new AbortController().signal;
    const requested = await joinPrivateHost('ws://broker', 'HOST-code', 'Guest', signal, { relayOnly: true });
    const unsupported = await joinPrivateHost('ws://broker', 'HOST-code', 'Guest', signal);
    expect(roomConnectionPath(requested)).toBe('relay');
    expect(roomConnectionDiagnostics(requested).relayReason).toBe('requested');
    expect(roomConnectionDiagnostics(unsupported).relayReason).toBe('unsupported');
    expect(join).toHaveBeenCalledTimes(2);
  });
  it('falls back immediately when ICE explicitly fails and preserves why the relay was needed', async () => {
    vi.useFakeTimers();
    let peer: any;
    const closePeer = vi.fn(); const closeSocket = vi.fn();
    vi.stubGlobal('RTCPeerConnection', class {
      iceConnectionState = 'checking';
      constructor() { peer = this; }
      createDataChannel() { return { close: vi.fn() }; }
      close = closePeer;
    });
    vi.stubGlobal('WebSocket', class { close = closeSocket; });
    const room = {} as Room;
    const join = vi.spyOn(HostSessionClient.prototype, 'joinById').mockResolvedValue(room);
    const pending = joinPrivateHost('ws://broker', 'HOST-code', 'Guest', new AbortController().signal);
    peer.iceConnectionState = 'failed'; peer.oniceconnectionstatechange();
    expect(await pending).toBe(room);
    expect(roomConnectionDiagnostics(room).relayReason).toBe('ice');
    expect(join).toHaveBeenCalledOnce();
    expect(closePeer).toHaveBeenCalledOnce(); expect(closeSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(join).toHaveBeenCalledOnce();
  });
  it('records the timeout fallback and releases a peer when signaling cannot be constructed', async () => {
    vi.useFakeTimers();
    const closePeer = vi.fn();
    vi.stubGlobal('RTCPeerConnection', class { createDataChannel() { return { close: vi.fn() }; } close = closePeer; });
    vi.stubGlobal('WebSocket', class { close = vi.fn(); });
    const room = {} as Room;
    vi.spyOn(HostSessionClient.prototype, 'joinById').mockResolvedValue(room);
    const pending = joinPrivateHost('ws://broker', 'HOST-code', 'Guest', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(roomConnectionDiagnostics(await pending).relayReason).toBe('timeout');
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Blocked by browser policy'); } });
    await expect(negotiateDirect('ws://broker', new AbortController().signal)).rejects.toThrow('Direct negotiation unavailable');
    expect(closePeer).toHaveBeenCalledTimes(2);
  });
});
