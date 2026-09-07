"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostTunnelClient = void 0;
const node_crypto_1 = require("node:crypto");
const ws_1 = __importDefault(require("ws"));
const relayTunnel_1 = require("../../../shared/relayTunnel");
const socketUtils_1 = require("./socketUtils");
/** One outbound control socket plus one outbound byte tunnel per guest. */
class HostTunnelClient {
    options;
    code;
    secret;
    control = null;
    sockets = new Set();
    retry;
    stopped = false;
    attempts = 0;
    registeredAt = 0;
    broker;
    local;
    requests = new Set();
    signals = new Set();
    constructor(options) {
        this.options = options;
        this.code = options.code?.trim().toUpperCase() ?? `HOST-${(0, node_crypto_1.randomBytes)(8).toString('hex').toUpperCase()}`;
        this.secret = options.secret ?? (0, node_crypto_1.randomBytes)(32).toString('hex');
        if (!(0, relayTunnel_1.isHostCode)(this.code) || !/^[a-f0-9]{64}$/.test(this.secret))
            throw new Error('Invalid host code or registration secret.');
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
    start() {
        if (this.stopped || this.control)
            return;
        // 16KiB opaque strings can expand sixfold when escaped inside the routing envelope.
        const ws = new ws_1.default(`${this.broker}/relay/register`, { handshakeTimeout: relayTunnel_1.RELAY_TIMEOUT_MS, maxPayload: 128 * 1024 });
        this.control = ws;
        (0, socketUtils_1.heartbeat)(ws);
        const registrationTimer = setTimeout(() => ws.terminate(), relayTunnel_1.RELAY_TIMEOUT_MS);
        ws.on('open', () => ws.send(JSON.stringify({ code: this.code, secret: this.secret })));
        ws.on('message', (raw) => {
            try {
                const message = JSON.parse((0, socketUtils_1.bytes)(raw).toString());
                if (message.type === 'registered' && message.code === this.code) {
                    clearTimeout(registrationTimer);
                    this.registeredAt = Date.now();
                    this.options.onStatus?.('Relay connected. Create a match to get a share code.');
                }
                else if (message.type === 'http' && typeof message.id === 'string' && typeof message.body === 'string') {
                    void this.reserve(ws, message.id, message.body);
                }
                else if (message.type === 'open' && typeof message.id === 'string' && typeof message.path === 'string') {
                    this.open(ws, message.id, message.path);
                }
                else if (message.type === 'signal-open' && typeof message.id === 'string') {
                    if (this.signals.size >= 16) {
                        this.closeSignal(message.id);
                        return;
                    }
                    this.signals.add(message.id);
                    this.options.onSignalOpen?.(message.id);
                }
                else if (message.type === 'signal' && typeof message.id === 'string' && typeof message.data === 'string') {
                    if (this.signals.has(message.id))
                        this.options.onSignal?.(message.id, message.data);
                }
                else if (message.type === 'signal-close' && typeof message.id === 'string') {
                    if (this.signals.delete(message.id))
                        this.options.onSignalClose?.(message.id);
                }
            }
            catch {
                ws.terminate();
            }
        });
        ws.once('close', (code) => {
            clearTimeout(registrationTimer);
            if (this.control !== ws)
                return;
            this.control = null;
            // Losing the control socket loses every signaling channel riding on it.
            for (const id of [...this.signals])
                this.options.onSignalClose?.(id);
            this.signals.clear();
            for (const request of this.requests)
                request.abort();
            for (const socket of this.sockets)
                (0, socketUtils_1.closeSocket)(socket, relayTunnel_1.RELAY_CLOSE.disconnected, 'Host disconnected');
            if (this.stopped)
                return;
            // Reset only after a stable connection; flapping registrations still back off.
            if (this.registeredAt && Date.now() - this.registeredAt > 30_000)
                this.attempts = 0;
            this.registeredAt = 0;
            const delay = Math.min(30_000, (this.options.retryBaseMs ?? 500) * 2 ** Math.min(this.attempts++, 6));
            this.options.onStatus?.(code === relayTunnel_1.RELAY_CLOSE.conflict
                ? 'Code registration is still occupied. Retrying with the same identity.'
                : 'Relay disconnected. Retrying; guests will need to join again.');
            this.retry = setTimeout(() => this.start(), Math.min(30_000, delay + Math.random() * delay * 0.25));
        });
    }
    stop() {
        this.stopped = true;
        this.options.onStop?.();
        for (const id of [...this.signals])
            this.options.onSignalClose?.(id);
        this.signals.clear();
        clearTimeout(this.retry);
        this.control?.terminate();
        for (const request of this.requests)
            request.abort();
        for (const socket of this.sockets)
            socket.terminate();
    }
    /** Send one opaque payload to a guest. False if that channel is gone or the payload is oversized. */
    sendSignal(id, data) {
        const control = this.control;
        if (!control || control.readyState !== ws_1.default.OPEN || !this.signals.has(id)
            || Buffer.byteLength(data) > relayTunnel_1.SIGNAL_MAX_BYTES)
            return false;
        (0, socketUtils_1.sendFrame)(control, Buffer.from(JSON.stringify({ type: 'signal', id, data })), false);
        return true;
    }
    /** Retract a guest's signaling channel (negotiation finished, failed, or was rejected). */
    closeSignal(id) {
        this.signals.delete(id);
        const control = this.control;
        if (control?.readyState === ws_1.default.OPEN) {
            (0, socketUtils_1.sendFrame)(control, Buffer.from(JSON.stringify({ type: 'signal-close', id })), false);
        }
    }
    async reserve(control, id, body) {
        let status = 503;
        let response = JSON.stringify({ code: relayTunnel_1.RELAY_CLOSE.unreachable, error: relayTunnel_1.RELAY_ERRORS.unreachable });
        const roomId = this.options.roomId();
        if (!roomId && this.options.expired?.()) {
            status = 404;
            response = JSON.stringify({ code: relayTunnel_1.RELAY_CLOSE.expired, error: relayTunnel_1.RELAY_ERRORS.expired });
        }
        if (roomId) {
            if (this.requests.size >= 16) {
                (0, socketUtils_1.sendFrame)(control, Buffer.from(JSON.stringify({ type: 'http-result', id, status, body: response })), false);
                return;
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), relayTunnel_1.RELAY_TIMEOUT_MS - 1000);
            this.requests.add(controller);
            try {
                const result = await fetch(`${this.local.replace(/^ws/, 'http')}/matchmake/joinById/${encodeURIComponent(roomId)}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
                    signal: controller.signal, redirect: 'error'
                });
                status = result.status;
                response = await result.text();
            }
            catch { /* return a friendly bounded failure */ }
            finally {
                clearTimeout(timer);
                this.requests.delete(controller);
            }
        }
        (0, socketUtils_1.sendFrame)(control, Buffer.from(JSON.stringify({ type: 'http-result', id, status, body: response })), false);
    }
    open(control, id, path) {
        const roomId = this.options.roomId();
        const parsed = new URL(path, 'http://local');
        const segments = parsed.pathname.split('/');
        if (!roomId || segments.length !== 3 || segments[2] !== roomId || !/^[\w-]+$/.test(segments[1])
            || !/^[\w-]{1,64}$/.test(parsed.searchParams.get('sessionId') ?? '') || this.sockets.size >= 16) {
            (0, socketUtils_1.sendFrame)(control, Buffer.from(JSON.stringify({ type: 'open-failed', id })), false);
            return;
        }
        const tunnel = new ws_1.default(`${this.broker}/relay/data?code=${this.code}&id=${encodeURIComponent(id)}`, {
            headers: { Authorization: `Bearer ${this.secret}` }, handshakeTimeout: relayTunnel_1.RELAY_TIMEOUT_MS,
            maxPayload: 1024 * 1024, perMessageDeflate: false
        });
        this.track(tunnel);
        tunnel.once('open', () => {
            if (control !== this.control || control.readyState !== ws_1.default.OPEN) {
                (0, socketUtils_1.closeSocket)(tunnel);
                return;
            }
            // Fixed loopback origin + validated room path: a broker cannot turn the agent into an open proxy.
            const local = new ws_1.default(`${this.local}${parsed.pathname}${parsed.search}`, {
                handshakeTimeout: relayTunnel_1.RELAY_TIMEOUT_MS, maxPayload: 1024 * 1024, perMessageDeflate: false
            });
            this.track(local);
            (0, socketUtils_1.bridge)(tunnel, local);
        });
    }
    track(socket) {
        this.sockets.add(socket);
        (0, socketUtils_1.heartbeat)(socket);
        socket.once('close', () => this.sockets.delete(socket));
    }
}
exports.HostTunnelClient = HostTunnelClient;
