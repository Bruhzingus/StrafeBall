"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHostAgent = startHostAgent;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const colyseus_1 = require("colyseus");
const DuelRoom_1 = require("../rooms/DuelRoom");
const HostTunnelClient_1 = require("./HostTunnelClient");
const socketUtils_1 = require("./socketUtils");
const relayTunnel_1 = require("../../../shared/relayTunnel");
/** Serve the prebuilt browser locally, avoiding HTTPS-page -> insecure localhost restrictions. */
function startHostAgent(server, port) {
    const root = (0, node_fs_1.realpathSync)((0, node_path_1.resolve)(process.env.HOST_CLIENT_DIR ?? (0, node_path_1.resolve)(__dirname, '../../../../../dist')));
    const indexPath = (0, node_path_1.resolve)(root, 'index.html');
    if (!(0, node_fs_1.existsSync)(indexPath))
        throw new Error(`Missing built client at ${indexPath}. Run npm run build:live first.`);
    let publishedRoom = null;
    const brokerUrl = process.env.RELAY_BROKER_URL ?? 'wss://strafeball.xyz/colyseus';
    const agent = new HostTunnelClient_1.HostTunnelClient({
        brokerUrl,
        localUrl: `ws://127.0.0.1:${port}`,
        roomId: () => publishedRoom && colyseus_1.matchMaker.getLocalRoomById(publishedRoom) ? publishedRoom : null,
        expired: () => publishedRoom !== null && !colyseus_1.matchMaker.getLocalRoomById(publishedRoom),
        onStatus: (message) => console.log(`[private host] ${message}`)
    });
    (0, socketUtils_1.routeRequests)(server, (url) => !url.startsWith('/matchmake/') && !/^\/[\w-]+\/[\w-]+\?/.test(url), (req, res) => {
        void (async () => {
            const url = new URL(req.url, `http://localhost:${port}`);
            if (url.pathname === '/private-host/session' && req.method === 'GET') {
                const room = publishedRoom && colyseus_1.matchMaker.getLocalRoomById(publishedRoom);
                (0, socketUtils_1.json)(res, room ? 200 : 404, room ? { roomId: publishedRoom } : { error: relayTunnel_1.RELAY_ERRORS.expired });
                return;
            }
            if (url.pathname === '/private-host/publish' && req.method === 'POST') {
                if (req.headers.origin !== `http://${req.headers.host}`) {
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
            && (!req.headers.origin || req.headers.origin === `http://${host}`);
    });
    agent.start();
    console.log(`[private host] Open http://localhost:${port}, enter your name and Create a match. Keep this window running.`);
    return agent;
}
