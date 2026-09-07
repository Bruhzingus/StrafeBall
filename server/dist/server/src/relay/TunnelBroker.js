"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TunnelBroker = void 0;
const node_crypto_1 = require("node:crypto");
const ws_1 = __importStar(require("ws"));
const relayTunnel_1 = require("../../../shared/relayTunnel");
const socketUtils_1 = require("./socketUtils");
/** No Colyseus imports: matchmaking bodies and gameplay messages are opaque to this service. */
class TunnelBroker {
    timeoutMs;
    graceMs;
    sessions = new Map();
    wss = new ws_1.WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
    sweep;
    closed = false;
    constructor(server, timeoutMs = relayTunnel_1.RELAY_TIMEOUT_MS, graceMs = 120_000) {
        this.timeoutMs = timeoutMs;
        this.graceMs = graceMs;
        (0, socketUtils_1.routeRequests)(server, (url) => url.startsWith('/relay/'), (req, res) => { void this.request(req, res).catch(() => (0, socketUtils_1.json)(res, 400, { code: 4411, error: relayTunnel_1.RELAY_ERRORS.unreachable })); }, (req, socket, head) => this.upgrade(req, socket, head));
        this.sweep = setInterval(() => {
            for (const [code, session] of this.sessions) {
                if (!session.control && Date.now() - session.disconnectedAt > this.graceMs)
                    this.sessions.delete(code);
            }
        }, Math.min(graceMs, 30_000));
        this.sweep.unref();
        server.once('close', () => this.close());
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        clearInterval(this.sweep);
        for (const session of this.sessions.values()) {
            this.disconnect(session);
            session.control?.terminate();
        }
        this.sessions.clear();
        for (const socket of this.wss.clients)
            socket.terminate();
        this.wss.close();
    }
    disconnect(session) {
        session.disconnectedAt = Date.now();
        for (const socket of session.sockets)
            (0, socketUtils_1.closeSocket)(socket, relayTunnel_1.RELAY_CLOSE.disconnected, 'Host disconnected');
        for (const pending of session.pending.values())
            pending.finish(503, JSON.stringify({ code: relayTunnel_1.RELAY_CLOSE.disconnected, error: relayTunnel_1.RELAY_ERRORS.disconnected }));
        for (const join of session.joins.values())
            clearTimeout(join.timer);
        session.joins.clear();
    }
    async request(req, res) {
        if (this.closed) {
            (0, socketUtils_1.json)(res, 503, { code: relayTunnel_1.RELAY_CLOSE.disconnected, error: relayTunnel_1.RELAY_ERRORS.disconnected });
            return;
        }
        // Same-origin production traffic, with CORS parity for development clients.
        // The Colyseus SDK uses credentials: include, which forbids wildcard CORS origins.
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url, 'http://relay');
        const match = /^\/relay\/(HOST-[A-F0-9]{16})\/matchmake\/joinById\/\1$/.exec(url.pathname);
        if (req.method !== 'POST' || !match) {
            (0, socketUtils_1.json)(res, 404, { code: relayTunnel_1.RELAY_CLOSE.expired, error: relayTunnel_1.RELAY_ERRORS.expired });
            return;
        }
        const session = this.sessions.get(match[1]);
        if (!session) {
            (0, socketUtils_1.json)(res, 404, { code: relayTunnel_1.RELAY_CLOSE.expired, error: relayTunnel_1.RELAY_ERRORS.expired });
            return;
        }
        if (!session.control) {
            (0, socketUtils_1.json)(res, 503, { code: relayTunnel_1.RELAY_CLOSE.disconnected, error: relayTunnel_1.RELAY_ERRORS.disconnected });
            return;
        }
        if (session.pending.size >= 16 || session.sockets.size >= 16) {
            (0, socketUtils_1.json)(res, 503, { code: relayTunnel_1.RELAY_CLOSE.unreachable, error: relayTunnel_1.RELAY_ERRORS.unreachable });
            return;
        }
        const control = session.control;
        const id = (0, node_crypto_1.randomBytes)(16).toString('hex');
        let finished = false;
        const timer = setTimeout(() => finish(504, JSON.stringify({ code: relayTunnel_1.RELAY_CLOSE.unreachable, error: relayTunnel_1.RELAY_ERRORS.unreachable })), this.timeoutMs);
        const finish = (status, response) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            session.pending.delete(id);
            if (res.destroyed || res.writableEnded)
                return;
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(response, () => { if (!req.complete)
                req.destroy(); });
        };
        session.pending.set(id, { finish });
        res.once('close', () => { finished = true; clearTimeout(timer); session.pending.delete(id); if (!req.complete)
            req.destroy(); });
        // Count uploads before awaiting their bodies, so concurrent slow writers cannot bypass the limit.
        try {
            const body = await (0, socketUtils_1.readBody)(req, 8192, this.timeoutMs);
            if (finished)
                return;
            if (session.control !== control || control.readyState !== ws_1.default.OPEN) {
                finish(503, JSON.stringify({ code: relayTunnel_1.RELAY_CLOSE.disconnected, error: relayTunnel_1.RELAY_ERRORS.disconnected }));
                return;
            }
            (0, socketUtils_1.sendFrame)(control, Buffer.from(JSON.stringify({ type: 'http', id, body })), false);
        }
        catch {
            finish(400, JSON.stringify({ code: relayTunnel_1.RELAY_CLOSE.unreachable, error: relayTunnel_1.RELAY_ERRORS.unreachable }));
        }
    }
    upgrade(req, socket, head) {
        if (this.closed || this.wss.clients.size >= 4608) {
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            return;
        }
        let url;
        try {
            url = new URL(req.url, 'http://relay');
        }
        catch {
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on('error', () => ws.terminate());
            if (url.pathname === '/relay/register') {
                this.register(ws);
                return;
            }
            if (url.pathname === '/relay/data') {
                this.data(ws, url, req);
                return;
            }
            const match = /^\/relay\/(HOST-[A-F0-9]{16})(\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)$/.exec(url.pathname);
            const session = match && this.sessions.get(match[1]);
            if (!session) {
                (0, socketUtils_1.closeSocket)(ws, relayTunnel_1.RELAY_CLOSE.expired, 'Invalid or expired host code');
                return;
            }
            if (!session.control) {
                (0, socketUtils_1.closeSocket)(ws, relayTunnel_1.RELAY_CLOSE.disconnected, 'Host disconnected');
                return;
            }
            if (session.sockets.size + session.joins.size >= 16) {
                (0, socketUtils_1.closeSocket)(ws);
                return;
            }
            (0, socketUtils_1.heartbeat)(ws);
            const id = (0, node_crypto_1.randomBytes)(24).toString('hex');
            const path = match[2] + url.search;
            session.sockets.add(ws);
            // No gameplay is sent before the local server handshake. Pause incoming frames until paired.
            ws.pause();
            const timer = setTimeout(() => { session.joins.delete(id); (0, socketUtils_1.closeSocket)(ws); }, this.timeoutMs);
            session.joins.set(id, { socket: ws, path, timer });
            ws.once('close', () => { clearTimeout(timer); session.joins.delete(id); session.sockets.delete(ws); });
            (0, socketUtils_1.sendFrame)(session.control, Buffer.from(JSON.stringify({ type: 'open', id, path })), false);
        });
    }
    register(ws) {
        const timer = setTimeout(() => (0, socketUtils_1.closeSocket)(ws), this.timeoutMs);
        ws.once('close', () => clearTimeout(timer));
        ws.once('message', (data) => {
            clearTimeout(timer);
            let message;
            if ((0, socketUtils_1.bytes)(data).length > 4096) {
                (0, socketUtils_1.closeSocket)(ws);
                return;
            }
            try {
                message = JSON.parse((0, socketUtils_1.bytes)(data).toString());
            }
            catch {
                (0, socketUtils_1.closeSocket)(ws);
                return;
            }
            if (!message || typeof message.code !== 'string' || !(0, relayTunnel_1.isHostCode)(message.code)
                || typeof message.secret !== 'string' || !/^[a-f0-9]{64}$/.test(message.secret)) {
                (0, socketUtils_1.closeSocket)(ws);
                return;
            }
            const code = message.code.trim().toUpperCase();
            let session = this.sessions.get(code);
            if (session && (session.control || !(0, node_crypto_1.timingSafeEqual)(Buffer.from(session.secret), Buffer.from(message.secret)))) {
                (0, socketUtils_1.closeSocket)(ws, relayTunnel_1.RELAY_CLOSE.conflict, 'Host code already registered');
                return;
            }
            if (!session) {
                if (this.sessions.size >= 256) {
                    (0, socketUtils_1.closeSocket)(ws);
                    return;
                }
                session = { secret: message.secret, control: null, disconnectedAt: 0, sockets: new Set(), pending: new Map(), joins: new Map() };
                this.sessions.set(code, session);
            }
            const owned = session;
            owned.control = ws;
            (0, socketUtils_1.heartbeat)(ws);
            ws.on('message', (raw) => {
                try {
                    if ((0, socketUtils_1.bytes)(raw).length > 64 * 1024) {
                        (0, socketUtils_1.closeSocket)(ws);
                        return;
                    }
                    const response = JSON.parse((0, socketUtils_1.bytes)(raw).toString());
                    if (response.type === 'http-result' && typeof response.id === 'string' && typeof response.body === 'string'
                        && Number.isInteger(response.status) && response.status >= 200 && response.status <= 599) {
                        owned.pending.get(response.id)?.finish(response.status, response.body);
                    }
                    else if (response.type === 'open-failed' && typeof response.id === 'string') {
                        const join = owned.joins.get(response.id);
                        if (join) {
                            clearTimeout(join.timer);
                            owned.joins.delete(response.id);
                            (0, socketUtils_1.closeSocket)(join.socket);
                        }
                    }
                }
                catch {
                    (0, socketUtils_1.closeSocket)(ws);
                }
            });
            ws.once('close', () => {
                if (owned.control !== ws)
                    return;
                owned.control = null;
                this.disconnect(owned);
            });
            ws.send(JSON.stringify({ type: 'registered', code }));
        });
    }
    data(ws, url, req) {
        const session = this.sessions.get(url.searchParams.get('code') ?? '');
        const id = url.searchParams.get('id') ?? '';
        const join = session?.joins.get(id);
        // Secret is a header, never a URL/query string that proxy access logs might expose.
        const secret = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        if (!session?.control || !join || join.socket.readyState !== ws_1.default.OPEN || !/^[a-f0-9]{64}$/.test(secret)
            || !(0, node_crypto_1.timingSafeEqual)(Buffer.from(secret), Buffer.from(session.secret))) {
            (0, socketUtils_1.closeSocket)(ws);
            return;
        }
        clearTimeout(join.timer);
        session.joins.delete(id); // one use: another data connection cannot steal this player
        session.sockets.add(ws);
        ws.once('close', () => session.sockets.delete(ws));
        (0, socketUtils_1.heartbeat)(ws);
        (0, socketUtils_1.bridge)(join.socket, ws, relayTunnel_1.RELAY_CLOSE.disconnected);
        join.socket.resume();
    }
}
exports.TunnelBroker = TunnelBroker;
