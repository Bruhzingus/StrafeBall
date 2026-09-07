import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { isHostCode, RELAY_CLOSE, RELAY_ERRORS, RELAY_TIMEOUT_MS } from '../../../shared/relayTunnel';
import { bridge, bytes, closeSocket, heartbeat, sendFrame } from './socketUtils';

export interface HostTunnelOptions {
  brokerUrl: string;
  localUrl: string;
  code?: string;
  secret?: string;
  roomId: () => string | null;
  expired?: () => boolean;
  onStatus?: (status: string) => void;
  retryBaseMs?: number;
}

/** One outbound control socket plus one outbound byte tunnel per guest. */
export class HostTunnelClient {
  readonly code: string;
  private readonly secret: string;
  private control: WebSocket | null = null;
  private readonly sockets = new Set<WebSocket>();
  private retry?: NodeJS.Timeout;
  private stopped = false;
  private attempts = 0;
  private registeredAt = 0;
  private readonly broker: string;
  private readonly local: string;
  private readonly requests = new Set<AbortController>();

  constructor(private readonly options: HostTunnelOptions) {
    this.code = options.code?.trim().toUpperCase() ?? `HOST-${randomBytes(8).toString('hex').toUpperCase()}`;
    this.secret = options.secret ?? randomBytes(32).toString('hex');
    if (!isHostCode(this.code) || !/^[a-f0-9]{64}$/.test(this.secret)) throw new Error('Invalid host code or registration secret.');
    const broker = new URL(options.brokerUrl);
    if (!['ws:', 'wss:'].includes(broker.protocol) || broker.username || broker.password || broker.search || broker.hash) {
      throw new Error('RELAY_BROKER_URL must be a ws:// or wss:// server URL without credentials or query parameters.');
    }
    if (broker.protocol !== 'wss:' && !['localhost', '127.0.0.1', '[::1]'].includes(broker.hostname)) {
      throw new Error('Remote relay brokers require wss://.');
    }
    this.broker = broker.toString().replace(/\/$/, '');
    const local = new URL(options.localUrl);
    if (local.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)
      || local.username || local.password || local.pathname !== '/' || local.search || local.hash) {
      throw new Error('Host simulation endpoint must be a loopback ws:// origin.');
    }
    this.local = local.toString().replace(/\/$/, '');
  }

  start(): void {
    if (this.stopped || this.control) return;
    const ws = new WebSocket(`${this.broker}/relay/register`, { handshakeTimeout: RELAY_TIMEOUT_MS, maxPayload: 64 * 1024 });
    this.control = ws;
    heartbeat(ws);
    const registrationTimer = setTimeout(() => ws.terminate(), RELAY_TIMEOUT_MS);
    ws.on('open', () => ws.send(JSON.stringify({ code: this.code, secret: this.secret })));
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(bytes(raw).toString());
        if (message.type === 'registered' && message.code === this.code) {
          clearTimeout(registrationTimer);
          this.registeredAt = Date.now();
          this.options.onStatus?.(`Relay connected. Share code: ${this.code}`);
        } else if (message.type === 'http' && typeof message.id === 'string' && typeof message.body === 'string') {
          void this.reserve(ws, message.id, message.body);
        } else if (message.type === 'open' && typeof message.id === 'string' && typeof message.path === 'string') {
          this.open(ws, message.id, message.path);
        }
      } catch { ws.terminate(); }
    });
    ws.once('close', (code) => {
      clearTimeout(registrationTimer);
      if (this.control !== ws) return;
      this.control = null;
      for (const request of this.requests) request.abort();
      for (const socket of this.sockets) closeSocket(socket, RELAY_CLOSE.disconnected, 'Host disconnected');
      if (this.stopped) return;
      // Reset only after a stable connection; flapping registrations still back off.
      if (this.registeredAt && Date.now() - this.registeredAt > 30_000) this.attempts = 0;
      this.registeredAt = 0;
      const delay = Math.min(30_000, (this.options.retryBaseMs ?? 500) * 2 ** Math.min(this.attempts++, 6));
      this.options.onStatus?.(code === RELAY_CLOSE.conflict
        ? 'Code registration is still occupied. Retrying with the same identity.'
        : 'Relay disconnected. Retrying; guests will need to join again.');
      this.retry = setTimeout(() => this.start(), Math.min(30_000, delay + Math.random() * delay * 0.25));
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.control?.terminate();
    for (const request of this.requests) request.abort();
    for (const socket of this.sockets) socket.terminate();
  }

  private async reserve(control: WebSocket, id: string, body: string): Promise<void> {
    let status = 503;
    let response = JSON.stringify({ code: RELAY_CLOSE.unreachable, error: RELAY_ERRORS.unreachable });
    const roomId = this.options.roomId();
    if (!roomId && this.options.expired?.()) {
      status = 404;
      response = JSON.stringify({ code: RELAY_CLOSE.expired, error: RELAY_ERRORS.expired });
    }
    if (roomId) {
      if (this.requests.size >= 16) {
        sendFrame(control, Buffer.from(JSON.stringify({ type: 'http-result', id, status, body: response })), false);
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS - 1000);
      this.requests.add(controller);
      try {
        const result = await fetch(`${this.local.replace(/^ws/, 'http')}/matchmake/joinById/${encodeURIComponent(roomId)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          signal: controller.signal, redirect: 'error'
        });
        status = result.status;
        response = await result.text();
      } catch { /* return a friendly bounded failure */ }
      finally { clearTimeout(timer); this.requests.delete(controller); }
    }
    sendFrame(control, Buffer.from(JSON.stringify({ type: 'http-result', id, status, body: response })), false);
  }

  private open(control: WebSocket, id: string, path: string): void {
    const roomId = this.options.roomId();
    const parsed = new URL(path, 'http://local');
    const segments = parsed.pathname.split('/');
    if (!roomId || segments.length !== 3 || segments[2] !== roomId || !/^[\w-]+$/.test(segments[1])
      || !/^[\w-]{1,64}$/.test(parsed.searchParams.get('sessionId') ?? '') || this.sockets.size >= 16) {
      sendFrame(control, Buffer.from(JSON.stringify({ type: 'open-failed', id })), false);
      return;
    }
    const tunnel = new WebSocket(`${this.broker}/relay/data?code=${this.code}&id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${this.secret}` }, handshakeTimeout: RELAY_TIMEOUT_MS,
      maxPayload: 1024 * 1024, perMessageDeflate: false
    });
    this.track(tunnel);
    tunnel.once('open', () => {
      if (control !== this.control || control.readyState !== WebSocket.OPEN) { closeSocket(tunnel); return; }
      // Fixed loopback origin + validated room path: a broker cannot turn the agent into an open proxy.
      const local = new WebSocket(`${this.local}${parsed.pathname}${parsed.search}`, {
        handshakeTimeout: RELAY_TIMEOUT_MS, maxPayload: 1024 * 1024, perMessageDeflate: false
      });
      this.track(local);
      bridge(tunnel, local);
    });
  }

  private track(socket: WebSocket): void {
    this.sockets.add(socket);
    heartbeat(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }
}
