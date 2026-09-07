// Standalone, manual-signaling Phase 0 process. No broker, signaling service, or fallback.
import { createInterface } from 'node:readline';
import { defineRoom, defineServer } from 'colyseus';
import { WebSocket } from 'ws';
import { DuelRoom } from '../../src/rooms/DuelRoom';
import { SpikePeer } from './peer';

if (typeof globalThis.WebSocket !== 'function') Object.assign(globalThis, { WebSocket });
const server = defineServer({ rooms: { duel: defineRoom(DuelRoom) } });
const port = Number(process.env.P2P_SPIKE_PORT ?? 2577);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid P2P_SPIKE_PORT');
const peers = new Set<SpikePeer>();
const terminal = createInterface({ input: process.stdin, output: process.stdout });
let negotiating = false;
server.onBeforeShutdown(async () => { terminal.close(); await Promise.all([...peers].map((peer) => peer.close())); });

void server.listen(port, '127.0.0.1').then(() => {
  console.log(`P2P SPIKE READY ws://127.0.0.1:${port}`);
  console.log('Open the spike page in host mode and Create a normal 1v1 room. Give its room ID to your guest.');
  console.log('Paste the guest offer as one JSON line here. Copy the ANSWER JSON back to that guest.');
  terminal.on('line', (line) => {
    if (negotiating) { console.log('Wait for the current answer.'); return; }
    if (!line.trim()) return;
    if (peers.size >= 4) { console.log('Restart the spike to begin another set of experiments.'); return; }
    negotiating = true;
    const peer = new SpikePeer(process.env.P2P_SPIKE_NO_STUN === '1' ? [] : undefined);
    peers.add(peer);
    void Promise.resolve().then(() => peer.answer(JSON.parse(line))).then((answer) => {
      console.log('ANSWER ' + JSON.stringify(answer));
    }).catch(async (error) => { console.error(error.message); peers.delete(peer); await peer.close(); })
      .finally(() => { negotiating = false; });
  });
}).catch((error) => { console.error(error); void server.gracefullyShutdown(); });
