"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BUFFER_BYTES = void 0;
exports.bytes = bytes;
exports.closeSocket = closeSocket;
exports.sendFrame = sendFrame;
exports.bridge = bridge;
exports.heartbeat = heartbeat;
exports.routeRequests = routeRequests;
exports.json = json;
exports.readBody = readBody;
const ws_1 = __importDefault(require("ws"));
exports.MAX_BUFFER_BYTES = 1024 * 1024;
function bytes(data) {
    return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}
function closeSocket(socket, code = 4411, reason = 'Host agent not reachable') {
    if (socket.readyState === ws_1.default.CLOSED || socket.readyState === ws_1.default.CLOSING)
        return;
    if (socket.readyState === ws_1.default.CONNECTING) {
        socket.terminate();
        return;
    }
    socket.close(code, reason);
    const timer = setTimeout(() => socket.terminate(), 1000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
}
/** Bound memory on slow consumers; preserve WebSocket message boundaries and binary/text flag. */
function sendFrame(socket, data, binary) {
    if (socket.readyState !== ws_1.default.OPEN)
        return;
    if (socket.bufferedAmount + bytes(data).length > exports.MAX_BUFFER_BYTES) {
        closeSocket(socket, 4411, 'Tunnel backpressure limit');
        return;
    }
    socket.send(data, { binary }, (error) => { if (error)
        socket.terminate(); });
}
function bridge(left, right, abnormalCode = 4411) {
    // A joiner may write before the host's loopback connection opens. Queue rather than drop frames.
    for (const [source, destination] of [[left, right], [right, left]]) {
        const queue = [];
        let queuedBytes = 0;
        source.on('message', (data, binary) => {
            if (destination.readyState !== ws_1.default.CONNECTING) {
                sendFrame(destination, data, binary);
                return;
            }
            const frame = bytes(data);
            queuedBytes += frame.length;
            if (queuedBytes > exports.MAX_BUFFER_BYTES) {
                closeSocket(source);
                closeSocket(destination);
                return;
            }
            queue.push({ data: frame, binary });
        });
        destination.once('open', () => {
            for (const frame of queue)
                sendFrame(destination, frame.data, frame.binary);
            queue.length = 0;
            queuedBytes = 0;
        });
        destination.once('close', () => { queue.length = 0; queuedBytes = 0; });
    }
    for (const [source, destination] of [[left, right], [right, left]]) {
        source.on('error', () => closeSocket(destination, abnormalCode, abnormalCode === 4410 ? 'Host disconnected' : 'Host agent not reachable'));
        source.on('close', (code, reason) => closeSocket(destination, code === 1000 || (code >= 3000 && code <= 4999) ? code : abnormalCode, reason.toString().slice(0, 100) || (abnormalCode === 4410 ? 'Host disconnected' : 'Host agent not reachable')));
    }
}
function heartbeat(socket, intervalMs = 5000) {
    let alive = true;
    socket.on('pong', () => { alive = true; });
    socket.on('error', () => socket.terminate());
    const timer = setInterval(() => {
        if (!alive) {
            socket.terminate();
            return;
        }
        alive = false;
        if (socket.readyState === ws_1.default.OPEN)
            socket.ping();
    }, intervalMs);
    timer.unref();
    socket.once('close', () => clearInterval(timer));
}
/** Install after Colyseus.listen has bound its handlers. All other requests pass through verbatim. */
function routeRequests(server, owns, request, upgrade, authorize = () => true) {
    const requests = server.listeners('request');
    const upgrades = server.listeners('upgrade');
    server.removeAllListeners('request');
    server.removeAllListeners('upgrade');
    server.on('request', (req, res) => {
        if (!authorize(req)) {
            json(res, 403, {});
            return;
        }
        if (owns(req.url ?? '/'))
            request(req, res);
        else
            for (const listener of requests)
                listener.call(server, req, res);
    });
    server.on('upgrade', (req, socket, head) => {
        if (!authorize(req)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        if (owns(req.url ?? '/'))
            upgrade(req, socket, head);
        else
            for (const listener of upgrades)
                listener.call(server, req, socket, head);
    });
}
function json(res, status, body) {
    if (res.destroyed || res.writableEnded)
        return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}
function readBody(req, maxBytes = 8192, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let length = 0;
        const cleanup = () => {
            clearTimeout(timer);
            req.off('data', data);
            req.off('end', end);
            req.off('error', fail);
            req.off('aborted', aborted);
        };
        const fail = (error) => { cleanup(); req.pause(); reject(error); };
        const aborted = () => fail(new Error('Request aborted'));
        const data = (chunk) => {
            length += chunk.length;
            if (length > maxBytes) {
                fail(new Error('Request too large'));
                return;
            }
            chunks.push(Buffer.from(chunk));
        };
        const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString()); };
        const timer = setTimeout(() => fail(new Error('Request body timed out')), timeoutMs);
        req.on('data', data);
        req.once('end', end);
        req.once('error', fail);
        req.once('aborted', aborted);
        if (req.destroyed)
            aborted();
    });
}
