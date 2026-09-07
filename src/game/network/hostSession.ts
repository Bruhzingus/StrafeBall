import { Client, Room } from '@colyseus/sdk';
import { RELAY_ERRORS, RELAY_TIMEOUT_MS, relayErrorMessage } from '../../../shared/relayTunnel';

export function localHostConfig(): { code: string; serverUrl: string; brokerUrl: string } | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { __STRAFEBALL_HOST__?: { code: string; serverUrl: string; brokerUrl: string } }).__STRAFEBALL_HOST__;
}

let setupError = '';
export function hostSetupError(): string { return setupError; }

/** Only an explicit host link contacts loopback; ordinary visitors never get a permission prompt. */
export async function initializeHostSession(): Promise<void> {
  if (localHostConfig() || new URLSearchParams(location.search).get('host') !== '1') return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch('http://127.0.0.1:2567/private-host/config', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Agent unavailable');
    const config = await response.json();
    if (config.serverUrl !== 'ws://127.0.0.1:2567' || typeof config.code !== 'string'
      || !/^HOST-[A-F0-9]{16}$/.test(config.code) || config.brokerUrl !== 'wss://strafeball.xyz/colyseus') throw new Error('Invalid agent');
    Object.assign(window, { __STRAFEBALL_HOST__: config });
  } catch {
    setupError = 'Start the host app and allow local network access, then retry. You can also play from the localhost link.';
  } finally { clearTimeout(timer); }
}

function hostHttpBase(): string { return localHostConfig()?.serverUrl.replace(/^ws/, 'http') ?? ''; }

/** Own the Room before connecting so timeout/close-before-handshake always disposes its socket. */
export class HostSessionClient extends Client {
  constructor(endpoint: string, private readonly signal?: AbortSignal) {
    super(endpoint);
    if (signal) this.http.options.signal = signal;
  }

  override async consumeSeatReservation<T>(response: Parameters<Client['consumeSeatReservation']>[0]): Promise<Room<any, T>> {
    // The host controls this response. Keep room paths and transport on the selected endpoint.
    if (response?.name !== 'duel' || ![response.roomId, response.processId, response.sessionId]
      .every((value) => typeof value === 'string' && /^[\w-]{1,64}$/.test(value))) {
      throw new Error(RELAY_ERRORS.unreachable);
    }
    const room = this.createRoom<T>(response.name);
    room.roomId = response.roomId;
    room.sessionId = response.sessionId;
    // Host-supplied publicAddress must never move a browser off its selected broker origin.
    const reservation = { ...response, publicAddress: undefined, protocol: 'ws' };
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error(RELAY_ERRORS.unreachable)), RELAY_TIMEOUT_MS);
      const aborted = () => fail(new Error(RELAY_ERRORS.unreachable));
      const cleanup = () => {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', aborted);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        room.reconnection.enabled = false;
        try { room.connection?.close(); } catch { /* a transport can fail before opening */ }
        reject(new Error(relayErrorMessage(error)));
      };
      room.onError.once((code, message) => fail({ code, message }));
      room.onLeave.once((code) => fail({ code }));
      room['onJoin'].once(() => {
        if (settled) { room.connection.close(); return; }
        settled = true;
        cleanup();
        // Relay loss is reported immediately; the agent reconnects but old player sockets do not.
        room.reconnection.enabled = false;
        resolve(room);
      });
      this.signal?.addEventListener('abort', aborted, { once: true });
      if (this.signal?.aborted) { aborted(); return; }
      try {
        room.connect(this.buildEndpoint(reservation, { sessionId: room.sessionId }), reservation);
      } catch (error) { fail(error); }
    });
  }
}

export async function publishHostRoom(room: Room, signal: AbortSignal): Promise<void> {
    const response = await fetch(`${hostHttpBase()}/private-host/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: room.roomId, sessionId: room.sessionId }),
      signal
    });
    if (!response.ok) throw new Error(response.status === 409 ? RELAY_ERRORS.active : RELAY_ERRORS.unreachable);
}

export async function localHostRoomId(signal: AbortSignal): Promise<string> {
  const response = await fetch(`${hostHttpBase()}/private-host/session`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 404 ? RELAY_ERRORS.expired : RELAY_ERRORS.unreachable);
  const body = await response.json();
  if (typeof body.roomId !== 'string' || !/^[\w-]{1,64}$/.test(body.roomId)) throw new Error(RELAY_ERRORS.unreachable);
  return body.roomId;
}
