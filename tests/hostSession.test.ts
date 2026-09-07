import { describe, expect, it, vi, afterEach } from 'vitest';
import { HostSessionClient } from '../src/game/network/hostSession';
import { isHostCode, RELAY_ERRORS, relayErrorMessage } from '../shared/relayTunnel';

afterEach(() => vi.useRealTimers());
describe('host session join failures', () => {
  it('recognizes only the separate host namespace and preserves friendly errors', () => {
    expect(isHostCode(' host-0123456789abcdef ')).toBe(true);
    expect(isHostCode('ordinaryId')).toBe(false);
    expect(isHostCode('HOST-bad')).toBe(false);
    expect(relayErrorMessage({ code: 4404 })).toBe(RELAY_ERRORS.expired);
    expect(relayErrorMessage({ code: 4410 })).toBe(RELAY_ERRORS.disconnected);
    expect(relayErrorMessage({ message: 'room is full' })).toBe(RELAY_ERRORS.full);
    expect(relayErrorMessage(new Error('raw socket details'))).toBe(RELAY_ERRORS.unreachable);
  });

  it('closes a socket and settles if the host never sends a Colyseus handshake', async () => {
    vi.useFakeTimers();
    const listeners: Record<string, Function> = {};
    const close = vi.fn();
    const signal = (name: string) => ({ once: (fn: Function) => { listeners[name] = fn; } });
    const room = {
      connect: vi.fn(), connection: { close }, reconnection: { enabled: true },
      onError: signal('error'), onLeave: signal('leave'), onJoin: signal('join')
    };
    const client = new HostSessionClient('ws://localhost:2567/relay/HOST-0123456789ABCDEF');
    vi.spyOn(client as any, 'createRoom').mockReturnValue(room);
    const pending = client.consumeSeatReservation({ name: 'duel', roomId: 'local', processId: 'process', sessionId: 'seat' } as any);
    const rejected = expect(pending).rejects.toThrow(RELAY_ERRORS.unreachable);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    listeners.join();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
