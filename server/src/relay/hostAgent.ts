import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import type { Server } from 'node:http';
import { matchMaker } from 'colyseus';
import { DuelRoom } from '../rooms/DuelRoom';
import { HostTunnelClient } from './HostTunnelClient';
import { json, readBody, routeRequests } from './socketUtils';
import { RELAY_ERRORS } from '../../../shared/relayTunnel';

/** Serve the prebuilt browser locally, avoiding HTTPS-page -> insecure localhost restrictions. */
export function startHostAgent(server: Server, port: number): HostTunnelClient {
  const root = realpathSync(resolve(process.env.HOST_CLIENT_DIR ?? resolve(__dirname, '../../../../../dist')));
  const indexPath = resolve(root, 'index.html');
  if (!existsSync(indexPath)) throw new Error(`Missing built client at ${indexPath}. Run npm run build:live first.`);
  let publishedRoom: string | null = null;
  const brokerUrl = process.env.RELAY_BROKER_URL ?? 'wss://strafeball.xyz/colyseus';
  const agent = new HostTunnelClient({
    brokerUrl,
    localUrl: `ws://127.0.0.1:${port}`,
    roomId: () => publishedRoom && matchMaker.getLocalRoomById(publishedRoom) ? publishedRoom : null,
    expired: () => publishedRoom !== null && !matchMaker.getLocalRoomById(publishedRoom),
    onStatus: (message) => console.log(`[private host] ${message}`)
  });
  routeRequests(server, (url) => !url.startsWith('/matchmake/') && !/^\/[\w-]+\/[\w-]+\?/.test(url), (req, res) => {
    void (async () => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === '/private-host/session' && req.method === 'GET') {
        const room = publishedRoom && matchMaker.getLocalRoomById(publishedRoom);
        json(res, room ? 200 : 404, room ? { roomId: publishedRoom } : { error: RELAY_ERRORS.expired });
        return;
      }
      if (url.pathname === '/private-host/publish' && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, {}); return; }
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
      && (!req.headers.origin || req.headers.origin === `http://${host}`);
  });
  agent.start();
  console.log(`[private host] Open http://localhost:${port}, enter your name and Create a match. Keep this window running.`);
  return agent;
}
