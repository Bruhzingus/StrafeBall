import { describe, expect, it } from 'vitest';
import { MultiplayerClient } from '../src/game/network/MultiplayerClient';

interface SentMessage {
  type: string;
  payload: unknown;
}

function clientWithFakeRoom(): { client: MultiplayerClient; sent: SentMessage[] } {
  const client = new MultiplayerClient('ws://test');
  const sent: SentMessage[] = [];
  // Inject a fake Colyseus room so we can assert the exact outbound message contract.
  (client as unknown as { room: unknown }).room = {
    send: (type: string, payload: unknown) => sent.push({ type, payload })
  };
  (client as unknown as { localPlayerId: string }).localPlayerId = 'me';
  return { client, sent };
}

describe('MultiplayerClient room-control wiring', () => {
  it('sends a partial update-room-settings patch', () => {
    const { client, sent } = clientWithFakeRoom();
    client.requestRoomSettings({ livesPerPlayer: 4, matPreset: 2 });
    expect(sent).toEqual([
      {
        type: 'update-room-settings',
        payload: { type: 'update-room-settings', playerId: 'me', settings: { livesPerPlayer: 4, matPreset: 2 } }
      }
    ]);
  });

  it('sends a preset as a settings patch', () => {
    const { client, sent } = clientWithFakeRoom();
    client.requestPreset('2v2-recommended');
    expect(sent).toEqual([
      {
        type: 'update-room-settings',
        payload: { type: 'update-room-settings', playerId: 'me', settings: { preset: '2v2-recommended' } }
      }
    ]);
  });

  it('sends start-match and end-vote requests', () => {
    const { client, sent } = clientWithFakeRoom();
    client.requestStartMatch();
    client.requestEndVote();
    expect(sent).toEqual([
      { type: 'start-match', payload: { type: 'start-match', playerId: 'me' } },
      { type: 'end-vote', payload: { type: 'end-vote', playerId: 'me' } }
    ]);
  });

  it('no-ops safely when offline (no room)', () => {
    const client = new MultiplayerClient('ws://test');
    expect(() => client.requestRoomSettings({ livesPerPlayer: 3 })).not.toThrow();
    expect(() => client.requestPreset('1v1-recommended')).not.toThrow();
    expect(() => client.requestStartMatch()).not.toThrow();
    expect(() => client.requestEndVote()).not.toThrow();
  });
});
