"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.server = void 0;
const colyseus_1 = require("colyseus");
const netConfig_1 = require("../../shared/netConfig");
const DuelRoom_1 = require("./rooms/DuelRoom");
const CourseRoom_1 = require("./rooms/CourseRoom");
const EditRoom_1 = require("./rooms/EditRoom");
const TunnelBroker_1 = require("./relay/TunnelBroker");
const hostAgent_1 = require("./relay/hostAgent");
const DEFAULT_PORT = 2567;
ensureGlobalWebSocket();
function readPort() {
    const raw = process.env.PORT ?? process.env.COLYSEUS_PORT;
    if (!raw)
        return DEFAULT_PORT;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}
exports.server = (0, colyseus_1.defineServer)({
    rooms: {
        duel: (0, colyseus_1.defineRoom)(DuelRoom_1.DuelRoom),
        // Private ghost-relay course races (see CourseRoom) — fully separate from the duel netcode.
        course: (0, colyseus_1.defineRoom)(CourseRoom_1.CourseRoom),
        // Private real-time collaborative course editing (see EditRoom) — relay + lock arbiter only.
        coop: (0, colyseus_1.defineRoom)(EditRoom_1.EditRoom)
    }
});
const port = readPort();
const privateHost = process.argv.includes('--private-host');
void exports.server.listen(port, privateHost ? '127.0.0.1' : undefined).then(() => {
    const httpServer = exports.server.transport.server;
    if (!httpServer)
        throw new Error('Relay tunnels require the existing HTTP/WebSocket transport.');
    if (privateHost) {
        const agent = (0, hostAgent_1.startHostAgent)(httpServer, port);
        exports.server.onBeforeShutdown(() => agent.stop());
    }
    else {
        const broker = new TunnelBroker_1.TunnelBroker(httpServer);
        exports.server.onBeforeShutdown(() => broker.close());
    }
    console.log(`Strafeball Colyseus server listening on ws://localhost:${port}`);
    console.log(`Network config: ${(0, netConfig_1.describeNetConfig)()}`);
    console.log('Create a private room with client.create("duel", { name }) and join by roomId with client.joinById(roomId, { name }).');
}).catch((error) => {
    console.error('Unable to start Strafeball:', error);
    void exports.server.gracefullyShutdown(false).finally(() => { process.exitCode = 1; });
});
function ensureGlobalWebSocket() {
    const globalScope = globalThis;
    if (typeof globalScope.WebSocket === 'function')
        return;
    // Colyseus checks `client.readyState !== WebSocket.OPEN` during join/reconnect. Some droplet/PM2
    // runtimes have been exposing Node 22 without the expected global WebSocket, so provide the
    // runtime's existing ws implementation expli citly instead of depending on ambient globals.
    const wsModule = require('ws');
    const candidate = (typeof wsModule === 'object' &&
        wsModule !== null &&
        'WebSocket' in wsModule
        ? wsModule.WebSocket
        : wsModule);
    if (typeof candidate === 'function') {
        globalScope.WebSocket = candidate;
    }
    else {
        throw new Error('Unable to initialize global WebSocket for Colyseus runtime.');
    }
}
