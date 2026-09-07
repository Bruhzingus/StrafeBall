import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { matchMaker } from 'colyseus';
import { DuelRoom } from '../rooms/DuelRoom';
import { HostTunnelClient } from './HostTunnelClient';
import { json, readBody, routeRequests } from './socketUtils';
import { RELAY_ERRORS } from '../../../shared/relayTunnel';
import { DirectHostPeers } from './DirectHostPeers';

/** Serve the prebuilt browser locally, avoiding HTTPS-page -> insecure localhost restrictions. */
export function startHostAgent(server: Server, port: number): HostTunnelClient {
  const clientDir = resolve(process.env.HOST_CLIENT_DIR ?? resolve(__dirname, '../../../../../dist'));
  const root = existsSync(clientDir) ? realpathSync(clientDir) : clientDir;
  const indexPath = resolve(root, 'index.html');
  let publishedRoom: string | null = null;
  const brokerUrl = process.env.RELAY_BROKER_URL ?? 'wss://strafeball.xyz/colyseus';
  const roomId = () => publishedRoom && matchMaker.getLocalRoomById(publishedRoom) ? publishedRoom : null;
  const peers = new DirectHostPeers({ roomId, send: (id, payload) => agent.sendSignal(id, payload),
    closeSignal: id => agent.closeSignal(id), stunUrls: process.env.DIRECT_NO_STUN === '1' ? [] : undefined });
  const agent = new HostTunnelClient({
    brokerUrl,
    localUrl: `ws://127.0.0.1:${port}`,
    roomId,
    expired: () => publishedRoom !== null && !matchMaker.getLocalRoomById(publishedRoom),
    onStatus: (message) => console.log(`[private host] ${message}`),
    onSignalOpen: id => { if (process.env.DIRECT_DISABLED === '1') agent.closeSignal(id); else peers.open(id); },
    onSignal: (id, payload) => peers.signal(id, payload),
    onSignalClose: id => peers.signalClosed(id),
    onStop: () => peers.close()
  });
  routeRequests(server, (url) => !url.startsWith('/matchmake/') && !/^\/[\w-]+\/[\w-]+\?/.test(url), (req, res) => {
    void (async () => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname.startsWith('/private-host/')) {
        if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      }
      if (url.pathname === '/private-host/config' && req.method === 'GET') {
        json(res, 200, { code: agent.code, serverUrl: `ws://127.0.0.1:${port}`, brokerUrl }); return;
      }
      if (url.pathname === '/private-host/session' && req.method === 'GET') {
        const room = publishedRoom && matchMaker.getLocalRoomById(publishedRoom);
        json(res, room ? 200 : 404, room ? { roomId: publishedRoom } : { error: RELAY_ERRORS.expired });
        return;
      }
      if (url.pathname === '/private-host/publish' && req.method === 'POST') {
        if (!req.headers.origin) { json(res, 403, {}); return; }
        const { roomId, sessionId } = JSON.parse(await readBody(req));
        const room = typeof roomId === 'string' ? matchMaker.getLocalRoomById(roomId) : null;
        if (!(room instanceof DuelRoom) || !room.clients.some((client) => client.sessionId === sessionId)) {
          json(res, 404, {}); return;
        }
        if (publishedRoom && publishedRoom !== roomId && matchMaker.getLocalRoomById(publishedRoom)) {
          json(res, 409, { error: RELAY_ERRORS.active }); return;
        }
        publishedRoom = roomId;
        json(res, 200, { code: agent.code });
        console.log(`[private host] Match ready. Share ${agent.code}`);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 404, {}); return; }
      const pathname = decodeURIComponent(url.pathname);
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + sep)) { json(res, 404, {}); return; }
      // Small portable archives use the deployed UI. The localhost fallback serves the same
      // assets through this fixed HTTPS origin, so browsers without LNA support still work.
      if (!existsSync(indexPath)) {
        if (pathname !== '/' && pathname !== '/index.html' && !pathname.startsWith('/assets/') && pathname !== '/favicon.svg') {
          json(res, 404, {}); return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        res.once('close', () => { clearTimeout(timeout); controller.abort(); });
        try {
          const upstream = await fetch(`https://strafeball.xyz${pathname}`, { signal: controller.signal, redirect: 'error' });
          if (!upstream.ok) { json(res, 502, { error: 'Game website unavailable. Please try again.' }); return; }
          res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
          if (pathname === '/' || pathname === '/index.html') {
            const config = JSON.stringify({ code: agent.code, serverUrl: `ws://${req.headers.host}`, brokerUrl }).replace(/</g, '\\u003c');
            const html = (await upstream.text()).replace('<head>', `<head><script>window.__STRAFEBALL_HOST__=${config}</script>`);
            res.setHeader('Cache-Control', 'no-store');
            res.end(req.method === 'HEAD' ? undefined : html);
          } else if (req.method === 'HEAD') { await upstream.body?.cancel(); res.end(); }
          else if (upstream.body) Readable.fromWeb(upstream.body as any).on('error', () => res.destroy()).pipe(res);
          else res.end();
        } catch { if (!res.headersSent) json(res, 502, { error: 'Game website unavailable. Please try again.' }); else res.destroy(); }
        return;
      }
      if (!file.startsWith(root + sep) || !existsSync(file)) { json(res, 404, {}); return; }
      if (!realpathSync(file).startsWith(root + sep) || !statSync(file).isFile()) { json(res, 404, {}); return; }
      if (file === indexPath) {
        const config = JSON.stringify({ code: agent.code, serverUrl: `ws://${req.headers.host}`, brokerUrl }).replace(/</g, '\\u003c');
        const html = readFileSync(file, 'utf8').replace('<head>', `<head><script>window.__STRAFEBALL_HOST__=${config}</script>`);
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : html);
      } else {
        const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary' };
        res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size });
        if (req.method === 'HEAD') res.end();
        else createReadStream(file).on('error', () => res.destroy()).pipe(res);
      }
    })().catch(() => { json(res, 400, {}); if (!req.complete) res.once('finish', () => req.destroy()); });
  }, (_req, socket) => socket.destroy(), (req) => {
    // Apply to matchmaking and gameplay too: a foreign website must not drive the loopback server.
    const host = req.headers.host;
    return [`localhost:${port}`, `127.0.0.1:${port}`].includes(host ?? '')
      && (!req.headers.origin || req.headers.origin === `http://${host}` || req.headers.origin === 'https://strafeball.xyz');
  });
  agent.start();
  console.log(`[private host] Open http://localhost:${port}, enter your name and Create a match. Keep this window running.`);
  if (process.env.HOST_OPEN_BROWSER === '1') {
    const target = 'https://strafeball.xyz/?host=1';
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log(`[private host] Open ${target} in Chrome, or use the localhost link above.`));
    child.unref();
  }
  return agent;
}
