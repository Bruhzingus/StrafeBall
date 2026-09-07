import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RTCDataChannel, RTCPeerConnection } from 'werift';
import { SpikeRawClient } from './peer';

function signal() {
  let listener: (...args: any[]) => void = () => undefined;
  return { subscribe: (callback: typeof listener) => { listener = callback; }, emit: (...args: any[]) => listener(...args) };
}
function setup() {
  vi.useFakeTimers();
  const channel = { readyState: 'connecting', bufferedAmount: 0, send: vi.fn(),
    onMessage: signal(), stateChange: signal(), error: signal() };
  const peer = { close: vi.fn(async () => undefined) };
  const raw = new SpikeRawClient(channel as unknown as RTCDataChannel, peer as unknown as RTCPeerConnection);
  return { channel, peer, raw };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Phase 0 raw channel adapter', () => {
  it('reports channel state and delivers unchanged binary bytes', () => {
    const { raw, channel } = setup();
    expect(raw.readyState).toBe(0);
    channel.readyState = 'open';
    expect(raw.readyState).toBe(1);
    const listener = vi.fn();
    raw.on('message', listener);
    const frame = Buffer.from([0, 255, 1, 128]);
    channel.onMessage.emit(frame);
    expect(listener).toHaveBeenCalledWith(frame);
    const callback = vi.fn();
    raw.send(frame, {}, callback);
    expect(channel.send).toHaveBeenCalledWith(frame);
    expect(callback).toHaveBeenCalledWith();
    channel.readyState = 'closing';
    expect(raw.readyState).toBe(2);
    channel.readyState = 'closed';
    expect(raw.readyState).toBe(3);
  });

  it('propagates explicit close once and releases the peer', async () => {
    const { raw, channel, peer } = setup();
    channel.readyState = 'open';
    const listener = vi.fn();
    raw.on('close', listener);
    raw.close(4000, 'test leave');
    channel.stateChange.emit('closed');
    raw.close();
    expect(listener).toHaveBeenCalledExactlyOnceWith(4000, Buffer.from('test leave'));
    expect(JSON.parse(channel.send.mock.calls[0][0])).toEqual({ type: 'closed', code: 4000, reason: 'test leave' });
    expect(raw.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('cleans up when even the close notice cannot be sent', () => {
    const { raw, channel } = setup();
    channel.readyState = 'open';
    channel.send.mockImplementation(() => { throw new Error('broken SCTP'); });
    const close = vi.fn();
    const callback = vi.fn();
    raw.on('close', close);
    expect(() => raw.send(Buffer.from([1]), {}, callback)).not.toThrow();
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    expect(close).toHaveBeenCalledOnce();
    expect(raw.readyState).toBe(3);
  });

  it('releases ICE resources after a remote channel close', async () => {
    const { raw, channel, peer } = setup();
    channel.readyState = 'closed';
    const close = vi.fn();
    raw.on('close', close);
    channel.stateChange.emit('closed');
    expect(close).toHaveBeenCalledExactlyOnceWith(1006, Buffer.from('DataChannel closed'));
    await vi.advanceTimersByTimeAsync(100);
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('rejects excess outbound backlog and inbound nonbinary gameplay', () => {
    const { raw, channel } = setup();
    channel.readyState = 'open';
    channel.bufferedAmount = 1024 * 1024;
    const callback = vi.fn();
    raw.send(Buffer.from([1]), {}, callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    expect(raw.readyState).toBe(3);
    const other = setup();
    other.channel.readyState = 'open';
    const message = vi.fn();
    other.raw.on('message', message);
    other.channel.onMessage.emit('unexpected text');
    expect(other.raw.readyState).toBe(3);
    expect(message).not.toHaveBeenCalled();
  });
});
