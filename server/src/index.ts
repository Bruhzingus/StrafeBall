import { defineRoom, defineServer } from 'colyseus';
import { describeNetConfig } from '../../shared/netConfig';
import { DuelRoom } from './rooms/DuelRoom';
import { CourseRoom } from './rooms/CourseRoom';
import { EditRoom } from './rooms/EditRoom';
import { TunnelBroker } from './relay/TunnelBroker';
import { startHostAgent } from './relay/hostAgent';

const DEFAULT_PORT = 2567;

ensureGlobalWebSocket();

function readPort(): number {
  const raw = process.env.PORT ?? process.env.COLYSEUS_PORT;
  if (!raw) return DEFAULT_PORT;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

export const server = defineServer({
  rooms: {
    duel: defineRoom(DuelRoom),
    // Private ghost-relay course races (see CourseRoom) — fully separate from the duel netcode.
    course: defineRoom(CourseRoom),
    // Private real-time collaborative course editing (see EditRoom) — relay + lock arbiter only.
    coop: defineRoom(EditRoom)
  }
});

const port = readPort();
const privateHost = process.argv.includes('--private-host');

void server.listen(port, privateHost ? '127.0.0.1' : undefined).then(() => {
  const httpServer = server.transport.server;
  if (!httpServer) throw new Error('Relay tunnels require the existing HTTP/WebSocket transport.');
  if (privateHost) {
    const agent = startHostAgent(httpServer, port);
    server.onBeforeShutdown(() => agent.stop());
  } else {
    const broker = new TunnelBroker(httpServer);
    server.onBeforeShutdown(() => broker.close());
  }
  console.log(`Strafeball Colyseus server listening on ws://localhost:${port}`);
  console.log(`Network config: ${describeNetConfig()}`);
  console.log('Create a private room with client.create("duel", { name }) and join by roomId with client.joinById(roomId, { name }).');
}).catch((error) => {
  console.error('Unable to start Strafeball:', error);
  void server.gracefullyShutdown(false).finally(() => { process.exitCode = 1; });
});

function ensureGlobalWebSocket(): void {
  const globalScope = globalThis as typeof globalThis & {
    WebSocket?: unknown;
  };
  if (typeof globalScope.WebSocket === 'function') return;

  // Colyseus checks `client.readyState !== WebSocket.OPEN` during join/reconnect. Some droplet/PM2
  // runtimes have been exposing Node 22 without the expected global WebSocket, so provide the
  // runtime's existing ws implementation expli citly instead of depending on ambient globals.
  const wsModule = require('ws') as {
    WebSocket?: unknown;
  } | unknown;
  const candidate = (
    typeof wsModule === 'object' &&
    wsModule !== null &&
    'WebSocket' in wsModule
      ? (wsModule as { WebSocket?: unknown }).WebSocket
      : wsModule
  );
  if (typeof candidate === 'function') {
    (globalScope as { WebSocket?: unknown }).WebSocket = candidate;
  } else {
    throw new Error('Unable to initialize global WebSocket for Colyseus runtime.');
  }
}
