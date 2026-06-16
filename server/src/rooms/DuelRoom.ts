import { Client, Room } from 'colyseus';
import type {
  CatchParryRequest,
  ClientMessage,
  DropRequest,
  InputCommand,
  PickupRequest,
  ResetRequest,
  ServerMessage,
  ThrowRequest
} from '../../../shared/protocol';
import type { PlayerInput } from '../../../shared/types';
import { ServerGameLoop } from '../simulation/ServerGameLoop';

export interface DuelRoomOptions {
  name?: string;
}

const TICK_RATE = 30;

export class DuelRoom extends Room {
  maxClients = 2;
  autoDispose = true;

  private game!: ServerGameLoop;

  onCreate(): void {
    this.setPrivate(true);
    this.game = new ServerGameLoop(this.roomId, {
      tickRate: TICK_RATE,
      logger: (message) => this.log(message)
    });
    this.log('room created');

    this.onMessage('input', (client, message: Partial<InputCommand> | PlayerInput | undefined) => {
      const input = message && 'input' in message
        ? message.input
        : message as Partial<PlayerInput> | undefined;
      if (!this.game.handleInput(client.sessionId, input)) {
        this.reject(client, 'input', 'unknown-player');
      }
    });

    this.onMessage('pickup', (client, _message: Partial<PickupRequest>) => {
      const result = this.game.handlePickup(client.sessionId);
      if (!result.ok) {
        this.log(`pickup rejected player=${client.sessionId} reason=${result.reason}`);
        this.reject(client, 'pickup', result.reason);
      } else if (result.log) {
        this.log(result.log);
      }
    });

    this.onMessage('drop', (client, message: Partial<DropRequest>) => {
      const result = this.game.handleDrop(client.sessionId, message.hand);
      if (!result.ok) this.reject(client, 'drop', result.reason);
    });

    this.onMessage('throw', (client, message: Partial<ThrowRequest>) => {
      const result = this.game.handleThrow(client.sessionId, {
        hand: message.hand,
        direction: message.direction,
        charge01: message.charge01
      });
      if (!result.ok) {
        this.log(`throw rejected player=${client.sessionId} reason=${result.reason}`);
        this.reject(client, 'throw', result.reason);
      } else if (result.log) {
        this.log(result.log);
      }
    });

    this.onMessage('catch-parry', (client, message: Partial<CatchParryRequest>) => {
      const result = this.game.handleCatchParry(client.sessionId, {
        hand: message.hand,
        facing: message.facing
      });
      if (!result.ok) this.reject(client, 'catch-parry', result.reason);
    });

    this.onMessage('reset', (client, _message: Partial<ResetRequest>) => {
      const result = this.game.handleReset(client.sessionId);
      if (!result.ok) this.reject(client, 'reset', result.reason);
    });

    this.onMessage('ping', (client, message: { clientTimeMs?: number }) => {
      client.send('pong', {
        type: 'pong',
        clientTimeMs: message.clientTimeMs ?? 0,
        serverTimeMs: Date.now()
      } satisfies ServerMessage);
    });

    this.setSimulationInterval(() => {
      this.broadcast('snapshot', this.game.step());
    }, 1000 / TICK_RATE);
  }

  onAuth(_client: Client, _options: DuelRoomOptions): boolean {
    const allowed = this.clients.length < this.maxClients;
    if (!allowed) this.log('join rejected reason=room-full');
    return allowed;
  }

  onJoin(client: Client, options: DuelRoomOptions): void {
    const player = this.game.addPlayer(client.sessionId, options.name);
    if (!player) {
      client.leave(4001);
      return;
    }
    this.log(`player joined id=${player.id} name="${player.name}" side=${player.spawnSide}`);

    client.send('joined-room', {
      type: 'joined-room',
      room: this.game.snapshot().room,
      playerId: player.id
    } satisfies ServerMessage);

    this.broadcast('player-joined', {
      type: 'player-joined',
      playerId: player.id
    } satisfies ServerMessage, { except: client });
  }

  onLeave(client: Client): void {
    this.game.removePlayer(client.sessionId);
    this.log(`player left id=${client.sessionId}`);
    this.broadcast('player-left', {
      type: 'player-left',
      playerId: client.sessionId
    } satisfies ServerMessage);
  }

  onDispose(): void {
    this.log('room disposed');
    this.game.dispose();
  }

  private reject(client: Client, request: ClientMessage['type'], reason: string): void {
    client.send('request-rejected', {
      type: 'request-rejected',
      request,
      reason
    } satisfies ServerMessage);
  }

  private log(message: string): void {
    console.log(`[duel ${this.roomId}] ${message}`);
  }
}
