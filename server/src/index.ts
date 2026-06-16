import { defineRoom, defineServer } from 'colyseus';
import { DuelRoom } from './rooms/DuelRoom';

const DEFAULT_PORT = 2567;

function readPort(): number {
  const raw = process.env.PORT ?? process.env.COLYSEUS_PORT;
  if (!raw) return DEFAULT_PORT;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

export const server = defineServer({
  rooms: {
    duel: defineRoom(DuelRoom)
  }
});

const port = readPort();

void server.listen(port).then(() => {
  console.log(`Strafeball Colyseus server listening on ws://localhost:${port}`);
  console.log('Create a private room with client.create("duel", { name }) and join by roomId with client.joinById(roomId, { name }).');
});
