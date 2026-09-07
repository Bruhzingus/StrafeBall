import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { type RawData } from 'ws';

export const MAX_BUFFER_BYTES = 1024 * 1024;
export function bytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export function closeSocket(socket: WebSocket, code = 4411, reason = 'Host agent not reachable'): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  if (socket.readyState === WebSocket.CONNECTING) { socket.terminate(); return; }
  socket.close(code, reason);
  const timer = setTimeout(() => socket.terminate(), 1000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}

/** Bound memory on slow consumers; preserve WebSocket message boundaries and binary/text flag. */
export function sendFrame(socket: WebSocket, data: RawData, binary: boolean): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount + bytes(data).length > MAX_BUFFER_BYTES) {
    closeSocket(socket, 4411, 'Tunnel backpressure limit');
    return;
  }
  socket.send(data, { binary }, (error) => { if (error) socket.terminate(); });
}

export function bridge(left: WebSocket, right: WebSocket, abnormalCode = 4411): void {
  // A joiner may write before the host's loopback connection opens. Queue rather than drop frames.
  for (const [source, destination] of [[left, right], [right, left]]) {
    const queue: Array<{ data: Buffer; binary: boolean }> = [];
    let queuedBytes = 0;
    source.on('message', (data, binary) => {
      if (destination.readyState !== WebSocket.CONNECTING) { sendFrame(destination, data, binary); return; }
      const frame = bytes(data);
      queuedBytes += frame.length;
      if (queuedBytes > MAX_BUFFER_BYTES) { closeSocket(source); closeSocket(destination); return; }
      queue.push({ data: frame, binary });
    });
    destination.once('open', () => {
      for (const frame of queue) sendFrame(destination, frame.data, frame.binary);
      queue.length = 0;
      queuedBytes = 0;
    });
    destination.once('close', () => { queue.length = 0; queuedBytes = 0; });
  }
  for (const [source, destination] of [[left, right], [right, left]]) {
    source.on('error', () => closeSocket(destination, abnormalCode, abnormalCode === 4410 ? 'Host disconnected' : 'Host agent not reachable'));
    source.on('close', (code, reason) => closeSocket(destination,
      code === 1000 || (code >= 3000 && code <= 4999) ? code : abnormalCode,
      reason.toString().slice(0, 100) || (abnormalCode === 4410 ? 'Host disconnected' : 'Host agent not reachable')));
  }
}

export function heartbeat(socket: WebSocket, intervalMs = 5000): void {
  let alive = true;
  socket.on('pong', () => { alive = true; });
  socket.on('error', () => socket.terminate());
  const timer = setInterval(() => {
    if (!alive) { socket.terminate(); return; }
    alive = false;
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, intervalMs);
  timer.unref();
  socket.once('close', () => clearInterval(timer));
}

/** Install after Colyseus.listen has bound its handlers. All other requests pass through verbatim. */
export function routeRequests(server: Server, owns: (url: string) => boolean,
  request: (req: IncomingMessage, res: ServerResponse) => void,
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  authorize: (req: IncomingMessage) => boolean = () => true): void {
  const requests = server.listeners('request');
  const upgrades = server.listeners('upgrade');
  server.removeAllListeners('request');
  server.removeAllListeners('upgrade');
  server.on('request', (req, res) => {
    if (!authorize(req)) { json(res, 403, {}); return; }
    if (owns(req.url ?? '/')) request(req, res);
    else for (const listener of requests) listener.call(server, req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!authorize(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (owns(req.url ?? '/')) upgrade(req, socket, head);
    else for (const listener of upgrades) listener.call(server, req, socket, head);
  });
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage, maxBytes = 8192, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
    };
    const fail = (error: Error) => { cleanup(); req.pause(); reject(error); };
    const aborted = () => fail(new Error('Request aborted'));
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes) { fail(new Error('Request too large')); return; }
      chunks.push(Buffer.from(chunk));
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString()); };
    const timer = setTimeout(() => fail(new Error('Request body timed out')), timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
    if (req.destroyed) aborted();
  });
}
