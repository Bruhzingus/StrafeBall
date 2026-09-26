"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHostAgent = startHostAgent;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_child_process_1 = require("node:child_process");
const node_stream_1 = require("node:stream");
const colyseus_1 = require("colyseus");
const DuelRoom_1 = require("../rooms/DuelRoom");
const HostTunnelClient_1 = require("./HostTunnelClient");
const socketUtils_1 = require("./socketUtils");
const relayTunnel_1 = require("../../../shared/relayTunnel");
const DirectHostPeers_1 = require("./DirectHostPeers");
/** Serve the prebuilt browser locally, avoiding HTTPS-page -> insecure localhost restrictions. */
function startHostAgent(server, port) {
    const clientDir = (0, node_path_1.resolve)(process.env.HOST_CLIENT_DIR ?? (0, node_path_1.resolve)(__dirname, '../../../../../dist'));
    const root = (0, node_fs_1.existsSync)(clientDir) ? (0, node_fs_1.realpathSync)(clientDir) : clientDir;
    const indexPath = (0, node_path_1.resolve)(root, 'index.html');
    let publishedRoom = null;
    const brokerUrl = process.env.RELAY_BROKER_URL ?? 'wss://strafeball.xyz/colyseus';
    const roomId = () => publishedRoom && colyseus_1.matchMaker.getLocalRoomById(publishedRoom) ? publishedRoom : null;
    const peers = new DirectHostPeers_1.DirectHostPeers({ roomId, send: (id, payload) => agent.sendSignal(id, payload),
        closeSignal: id => agent.closeSignal(id), stunUrls: process.env.DIRECT_NO_STUN === '1' ? [] : undefined });
    const agent = new HostTunnelClient_1.HostTunnelClient({
        brokerUrl,
        localUrl: `ws://127.0.0.1:${port}`,
        roomId,
        expired: () => publishedRoom !== null && !colyseus_1.matchMaker.getLocalRoomById(publishedRoom),
        onStatus: (message) => console.log(`[private host] ${message}`),
        onSignalOpen: id => { if (process.env.DIRECT_DISABLED === '1')
            agent.closeSignal(id);
        else
            peers.open(id); },
        onSignal: (id, payload) => peers.signal(id, payload),
        onSignalClose: id => peers.signalClosed(id),
        onStop: () => peers.close()
    });
    (0, socketUtils_1.routeRequests)(server, (url) => !url.startsWith('/matchmake/') && !/^\/[\w-]+\/[\w-]+\?/.test(url), (req, res) => {
        void (async () => {
            const url = new URL(req.url, `http://localhost:${port}`);
            if (url.pathname.startsWith('/private-host/')) {
                if (req.headers.origin)
                    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
                res.setHeader('Vary', 'Origin');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
                res.setHeader('Access-Control-Allow-Private-Network', 'true');
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
            }
            if (url.pathname === '/private-host/config' && req.method === 'GET') {
                (0, socketUtils_1.json)(res, 200, { code: agent.code, serverUrl: `ws://127.0.0.1:${port}`, brokerUrl });
                return;
            }
            if (url.pathname === '/private-host/session' && req.method === 'GET') {
                const room = publishedRoom && colyseus_1.matchMaker.getLocalRoomById(publishedRoom);
                (0, socketUtils_1.json)(res, room ? 200 : 404, room ? { roomId: publishedRoom } : { error: relayTunnel_1.RELAY_ERRORS.expired });
                return;
            }
            if (url.pathname === '/private-host/publish' && req.method === 'POST') {
                if (!req.headers.origin) {
                    (0, socketUtils_1.json)(res, 403, {});
                    return;
                }
                const { roomId, sessionId } = JSON.parse(await (0, socketUtils_1.readBody)(req));
                const room = typeof roomId === 'string' ? colyseus_1.matchMaker.getLocalRoomById(roomId) : null;
                if (!(room instanceof DuelRoom_1.DuelRoom) || !room.clients.some((client) => client.sessionId === sessionId)) {
                    (0, socketUtils_1.json)(res, 404, {});
                    return;
                }
                if (publishedRoom && publishedRoom !== roomId && colyseus_1.matchMaker.getLocalRoomById(publishedRoom)) {
                    (0, socketUtils_1.json)(res, 409, { error: relayTunnel_1.RELAY_ERRORS.active });
                    return;
                }
                publishedRoom = roomId;
                (0, socketUtils_1.json)(res, 200, { code: agent.code });
                console.log(`[private host] Match ready. Share ${agent.code}`);
                return;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                (0, socketUtils_1.json)(res, 404, {});
                return;
            }
            const pathname = decodeURIComponent(url.pathname);
            const file = (0, node_path_1.resolve)(root, '.' + (pathname === '/' ? '/index.html' : pathname));
            if (!file.startsWith(root + node_path_1.sep)) {
                (0, socketUtils_1.json)(res, 404, {});
                return;
            }
            // Small portable archives use the deployed UI. The localhost fallback serves the same
            // assets through this fixed HTTPS origin, so browsers without LNA support still work.
            if (!(0, node_fs_1.existsSync)(indexPath)) {
                if (pathname !== '/' && pathname !== '/index.html' && !pathname.startsWith('/assets/') && pathname !== '/favicon.svg') {
                    (0, socketUtils_1.json)(res, 404, {});
                    return;
                }
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30_000);
                res.once('close', () => { clearTimeout(timeout); controller.abort(); });
                try {
                    const upstream = await fetch(`https://strafeball.xyz${pathname}`, { signal: controller.signal, redirect: 'error' });
                    if (!upstream.ok) {
                        (0, socketUtils_1.json)(res, 502, { error: 'Game website unavailable. Please try again.' });
                        return;
                    }
                    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
                    if (pathname === '/' || pathname === '/index.html') {
                        const config = JSON.stringify({ code: agent.code, serverUrl: `ws://${req.headers.host}`, brokerUrl }).replace(/</g, '\\u003c');
                        const html = (await upstream.text()).replace('<head>', `<head><script>window.__STRAFEBALL_HOST__=${config}</script>`);
                        res.setHeader('Cache-Control', 'no-store');
                        res.end(req.method === 'HEAD' ? undefined : html);
                    }
                    else if (req.method === 'HEAD') {
                        await upstream.body?.cancel();
                        res.end();
                    }
                    else if (upstream.body)
                        node_stream_1.Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
                    else
                        res.end();
                }
                catch {
                    if (!res.headersSent)
                        (0, socketUtils_1.json)(res, 502, { error: 'Game website unavailable. Please try again.' });
                    else
                        res.destroy();
                }
                return;
            }
            if (!file.startsWith(root + node_path_1.sep) || !(0, node_fs_1.existsSync)(file)) {
                (0, socketUtils_1.json)(res, 404, {});
                return;
            }
            if (!(0, node_fs_1.realpathSync)(file).startsWith(root + node_path_1.sep) || !(0, node_fs_1.statSync)(file).isFile()) {
                (0, socketUtils_1.json)(res, 404, {});
                return;
            }
            if (file === indexPath) {
                const config = JSON.stringify({ code: agent.code, serverUrl: `ws://${req.headers.host}`, brokerUrl }).replace(/</g, '\\u003c');
                const html = (0, node_fs_1.readFileSync)(file, 'utf8').replace('<head>', `<head><script>window.__STRAFEBALL_HOST__=${config}</script>`);
                res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
                res.end(req.method === 'HEAD' ? undefined : html);
            }
            else {
                const mime = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary' };
                res.writeHead(200, { 'Content-Type': mime[(0, node_path_1.extname)(file)] ?? 'application/octet-stream', 'Content-Length': (0, node_fs_1.statSync)(file).size });
                if (req.method === 'HEAD')
                    res.end();
                else
                    (0, node_fs_1.createReadStream)(file).on('error', () => res.destroy()).pipe(res);
            }
        })().catch(() => { (0, socketUtils_1.json)(res, 400, {}); if (!req.complete)
            res.once('finish', () => req.destroy()); });
    }, (_req, socket) => socket.destroy(), (req) => {
        // Apply to matchmaking and gameplay too: a foreign website must not drive the loopback server.
        const host = req.headers.host;
        return [`localhost:${port}`, `127.0.0.1:${port}`].includes(host ?? '')
            && (!req.headers.origin || req.headers.origin === `http://${host}` || req.headers.origin === 'https://strafeball.xyz');
    });
    agent.start();
    console.log(`[private host] Open http://localhost:${port}, enter your name and Create a match. Keep this window running.`);
    if (process.env.HOST_OPEN_BROWSER === '1' || process.env.HOST_OPEN_BROWSER === 'local') {
        const target = process.env.HOST_OPEN_BROWSER === 'local'
            ? `http://localhost:${port}` : 'https://strafeball.xyz/?host=1';
        const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
        const child = (0, node_child_process_1.spawn)(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => console.log(`[private host] Open ${target} in Chrome, or use the localhost link above.`));
        child.unref();
    }
    return agent;
}
