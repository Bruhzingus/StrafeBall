import { afterEach, expect, it, vi } from 'vitest';
import type { RTCDataChannel } from 'werift';
import { DataChannelClient } from '../src/relay/DataChannelClient';
function event() {
  let receive: (...args: any[]) => void = () => undefined;
  return { subscribe: (fn: typeof receive) => { receive = fn; }, emit: (...args: any[]) => receive(...args) };
}
function setup() {
  vi.useFakeTimers();
  const channel = { readyState: 'open', bufferedAmount: 0, send: vi.fn(), onMessage: event(), stateChange: event(), error: event() };
  const release = vi.fn();
  return { channel, release, raw: new DataChannelClient(channel as unknown as RTCDataChannel, release) };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it('delivers unchanged bytes, maps readyState, and preserves one close code', async () => {
  const { channel, raw, release } = setup();
  const receive = vi.fn(); const close = vi.fn(); raw.on('message', receive); raw.on('close', close);
  const frame = Buffer.from([0, 255, 128]); channel.onMessage.emit(frame);
  expect(receive).toHaveBeenCalledWith(frame);
  channel.readyState = 'connecting'; expect(raw.readyState).toBe(0);
  channel.readyState = 'closing'; expect(raw.readyState).toBe(2);
  channel.readyState = 'open'; expect(raw.readyState).toBe(1);
  raw.close(4000, 'leave'); channel.stateChange.emit('closed');
  expect(raw.readyState).toBe(3);
  expect(close).toHaveBeenCalledExactlyOnceWith(4000, Buffer.from('leave'));
  await vi.advanceTimersByTimeAsync(100); expect(release).toHaveBeenCalledOnce();
});
it('bounds outbound memory and releases a broken channel even if its close notice throws', () => {
  const { channel, raw } = setup();
  channel.bufferedAmount = 1024 * 1024;
  channel.send.mockImplementation(() => { throw new Error('gone'); });
  const callback = vi.fn(); const close = vi.fn(); raw.on('close', close);
  expect(() => raw.send(Buffer.from([1]), {}, callback)).not.toThrow();
  expect(callback).toHaveBeenCalledWith(expect.any(Error)); expect(close).toHaveBeenCalledOnce();
});
it('drops oversized inbound frames and detects peers that stop responding', async () => {
  const first = setup(); const receive = vi.fn(); first.raw.on('message', receive);
  first.channel.onMessage.emit(Buffer.alloc(1024 * 1024 + 1));
  expect(receive).not.toHaveBeenCalled(); expect(first.raw.readyState).toBe(3);
  const second = setup();
  await vi.advanceTimersByTimeAsync(12_100);
  expect(second.raw.readyState).toBe(3); expect(second.release).toHaveBeenCalledOnce();
});
