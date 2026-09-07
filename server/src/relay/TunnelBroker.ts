import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { isHostCode, RELAY_CLOSE, RELAY_ERRORS, RELAY_TIMEOUT_MS } from '../../../shared/relayTunnel';
import { bridge, bytes, closeSocket, heartbeat, json, readBody, routeRequests, sendFrame } from './socketUtils';

interface Session {
  secret: string;
  control: WebSocket | null;
  disconnectedAt: number;
  sockets: Set<WebSocket>;
  pending: Map<string, { finish: (status: number, body: string) => void }>;
  joins: Map<string, { socket: WebSocket; path: string; timer: NodeJS.Timeout }>;
}

/** No Colyseus imports: matchmaking bodies and gameplay messages are opaque to this service. */
export class TunnelBroker {
  private readonly sessions = new Map<string, Session>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  private readonly sweep: NodeJS.Timeout;
  private closed = false;

  constructor(server: Server, private readonly timeoutMs = RELAY_TIMEOUT_MS, private readonly graceMs = 120_000) {
    routeRequests(server, (url) => url.startsWith('/relay/'),
      (req, res) => { void this.request(req, res).catch(() => json(res, 400, { code: 4411, error: RELAY_ERRORS.unreachable })); },
      (req, socket, head) => this.upgrade(req, socket, head));
    this.sweep = setInterval(() => {
      for (const [code, session] of this.sessions) {
        if (!session.control && Date.now() - session.disconnectedAt > this.graceMs) this.sessions.delete(code);
      }
    }, Math.min(graceMs, 30_000));
    this.sweep.unref();
    server.once('close', () => this.close());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweep);
    for (const session of this.sessions.values()) {
      this.disconnect(session);
      session.control?.terminate();
    }
    this.sessions.clear();
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close();
  }

  private disconnect(session: Session): void {
    session.disconnectedAt = Date.now();
    for (const socket of session.sockets) closeSocket(socket, RELAY_CLOSE.disconnected, 'Host disconnected');
    for (const pending of session.pending.values()) pending.finish(503, JSON.stringify({ code: RELAY_CLOSE.disconnected, error: RELAY_ERRORS.disconnected }));
    for (const join of session.joins.values()) clearTimeout(join.timer);
    session.joins.clear();
  }

  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed) { json(res, 503, { code: RELAY_CLOSE.disconnected, error: RELAY_ERRORS.disconnected }); return; }
    // Same-origin production traffic, with CORS parity for development clients.
    // The Colyseus SDK uses credentials: include, which forbids wildcard CORS origins.
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url!, 'http://relay');
    const match = /^\/relay\/(HOST-[A-F0-9]{16})\/matchmake\/joinById\/\1$/.exec(url.pathname);
    if (req.method !== 'POST' || !match) { json(res, 404, { code: RELAY_CLOSE.expired, error: RELAY_ERRORS.expired }); return; }
    const session = this.sessions.get(match[1]);
    if (!session) { json(res, 404, { code: RELAY_CLOSE.expired, error: RELAY_ERRORS.expired }); return; }
    if (!session.control) { json(res, 503, { code: RELAY_CLOSE.disconnected, error: RELAY_ERRORS.disconnected }); return; }
    if (session.pending.size >= 16 || session.sockets.size >= 16) {
      json(res, 503, { code: RELAY_CLOSE.unreachable, error: RELAY_ERRORS.unreachable }); return;
    }
    const control = session.control;
    const id = randomBytes(16).toString('hex');
    let finished = false;
    const timer = setTimeout(() => finish(504, JSON.stringify({ code: RELAY_CLOSE.unreachable, error: RELAY_ERRORS.unreachable })), this.timeoutMs);
    const finish = (status: number, response: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      session.pending.delete(id);
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(response, () => { if (!req.complete) req.destroy(); });
    };
    session.pending.set(id, { finish });
    res.once('close', () => { finished = true; clearTimeout(timer); session.pending.delete(id); if (!req.complete) req.destroy(); });
    // Count uploads before awaiting their bodies, so concurrent slow writers cannot bypass the limit.
    try {
      const body = await readBody(req, 8192, this.timeoutMs);
      if (finished) return;
      if (session.control !== control || control.readyState !== WebSocket.OPEN) {
        finish(503, JSON.stringify({ code: RELAY_CLOSE.disconnected, error: RELAY_ERRORS.disconnected })); return;
      }
      sendFrame(control, Buffer.from(JSON.stringify({ type: 'http', id, body })), false);
    } catch {
      finish(400, JSON.stringify({ code: RELAY_CLOSE.unreachable, error: RELAY_ERRORS.unreachable }));
    }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closed || this.wss.clients.size >= 4608) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    let url: URL;
    try { url = new URL(req.url!, 'http://relay'); } catch { socket.destroy(); return; }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate());
      if (url.pathname === '/relay/register') { this.register(ws); return; }
      if (url.pathname === '/relay/data') { this.data(ws, url, req); return; }
      const match = /^\/relay\/(HOST-[A-F0-9]{16})(\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)$/.exec(url.pathname);
      const session = match && this.sessions.get(match[1]);
      if (!session) { closeSocket(ws, RELAY_CLOSE.expired, 'Invalid or expired host code'); return; }
      if (!session.control) { closeSocket(ws, RELAY_CLOSE.disconnected, 'Host disconnected'); return; }
      if (session.sockets.size + session.joins.size >= 16) { closeSocket(ws); return; }
      heartbeat(ws);
      const id = randomBytes(24).toString('hex');
      const path = match![2] + url.search;
      session.sockets.add(ws);
      // No gameplay is sent before the local server handshake. Pause incoming frames until paired.
      ws.pause();
      const timer = setTimeout(() => { session.joins.delete(id); closeSocket(ws); }, this.timeoutMs);
      session.joins.set(id, { socket: ws, path, timer });
      ws.once('close', () => { clearTimeout(timer); session.joins.delete(id); session.sockets.delete(ws); });
      sendFrame(session.control, Buffer.from(JSON.stringify({ type: 'open', id, path })), false);
    });
  }

  private register(ws: WebSocket): void {
    const timer = setTimeout(() => closeSocket(ws), this.timeoutMs);
    ws.once('close', () => clearTimeout(timer));
    ws.once('message', (data) => {
      clearTimeout(timer);
      let message: { code: string; secret: string };
      if (bytes(data).length > 4096) { closeSocket(ws); return; }
      try { message = JSON.parse(bytes(data).toString()); } catch { closeSocket(ws); return; }
      if (!message || typeof message.code !== 'string' || !isHostCode(message.code)
        || typeof message.secret !== 'string' || !/^[a-f0-9]{64}$/.test(message.secret)) {
        closeSocket(ws); return;
      }
      const code = message.code.trim().toUpperCase();
      let session = this.sessions.get(code);
      if (session && (session.control || !timingSafeEqual(Buffer.from(session.secret), Buffer.from(message.secret)))) {
        closeSocket(ws, RELAY_CLOSE.conflict, 'Host code already registered'); return;
      }
      if (!session) {
        if (this.sessions.size >= 256) { closeSocket(ws); return; }
        session = { secret: message.secret, control: null, disconnectedAt: 0, sockets: new Set(), pending: new Map(), joins: new Map() };
        this.sessions.set(code, session);
      }
      const owned = session;
      owned.control = ws;
      heartbeat(ws);
      ws.on('message', (raw) => {
        try {
          if (bytes(raw).length > 64 * 1024) { closeSocket(ws); return; }
          const response = JSON.parse(bytes(raw).toString());
          if (response.type === 'http-result' && typeof response.id === 'string' && typeof response.body === 'string'
            && Number.isInteger(response.status) && response.status >= 200 && response.status <= 599) {
            owned.pending.get(response.id)?.finish(response.status, response.body);
          } else if (response.type === 'open-failed' && typeof response.id === 'string') {
            const join = owned.joins.get(response.id);
            if (join) { clearTimeout(join.timer); owned.joins.delete(response.id); closeSocket(join.socket); }
          }
        } catch { closeSocket(ws); }
      });
      ws.once('close', () => {
        if (owned.control !== ws) return;
        owned.control = null;
        this.disconnect(owned);
      });
      ws.send(JSON.stringify({ type: 'registered', code }));
    });
  }

  private data(ws: WebSocket, url: URL, req: IncomingMessage): void {
    const session = this.sessions.get(url.searchParams.get('code') ?? '');
    const id = url.searchParams.get('id') ?? '';
    const join = session?.joins.get(id);
    // Secret is a header, never a URL/query string that proxy access logs might expose.
    const secret = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!session?.control || !join || join.socket.readyState !== WebSocket.OPEN || !/^[a-f0-9]{64}$/.test(secret)
      || !timingSafeEqual(Buffer.from(secret), Buffer.from(session.secret))) { closeSocket(ws); return; }
    clearTimeout(join.timer);
    session.joins.delete(id); // one use: another data connection cannot steal this player
    session.sockets.add(ws);
    ws.once('close', () => session.sockets.delete(ws));
    heartbeat(ws);
    bridge(join.socket, ws, RELAY_CLOSE.disconnected);
    join.socket.resume();
  }
}
