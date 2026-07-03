import { describe, expect, it } from 'vitest';
import { MultiplayerClient } from '../src/game/network/MultiplayerClient';
import type { PlayerInput } from '../shared/types';

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

function fullInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    sequence: 0,
    clientTimeMs: 0,
    moveX: 0,
    moveZ: 0,
    dashDirection: { x: 0, y: 0, z: 0 },
    lookYawRadians: 0,
    lookPitchRadians: 0,
    jumpPressed: false,
    jumpHeld: false,
    dashPressed: false,
    crouchPressed: false,
    crouchHeld: false,
    slidePressed: false,
    slideHeld: false,
    backflipPressed: false,
    pickupPressed: false,
    dropPressed: false,
    fakeThrowPressed: false,
    fakeThrowHeld: false,
    leftHandPressed: false,
    leftHandHeld: false,
    rightHandPressed: false,
    rightHandHeld: false,
    leftHandReleased: false,
    rightHandReleased: false,
    leftCatchAttemptId: 0,
    rightCatchAttemptId: 0,
    backflipThrowTier: 0,
    resetSerial: 0,
    interactHeld: false,
    ...overrides
  };
}

describe('MultiplayerClient room-control wiring', () => {
  it('passes the selected tick preset when creating a room', async () => {
    const client = new MultiplayerClient('ws://test');
    let captured: unknown = null;
    (client as unknown as { client: { create: (roomName: string, options: unknown) => Promise<never> } }).client = {
      create: async (roomName, options) => {
        expect(roomName).toBe('duel');
        captured = options;
        throw new Error('stop before opening a fake room');
      }
    };

    await client.createRoom('Host', '2v2', 'high');

    expect(captured).toEqual({ name: 'Host', mode: '2v2', tickPresetId: 'high' });
    expect(client.status).toBe('error');
  });

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

  it('sends compact input commands with timing on the wrapper', () => {
    const { client, sent } = clientWithFakeRoom();
    const previous = fullInput({
      sequence: 1,
      clientTimeMs: 1000,
      moveX: 1,
      lookYawRadians: 0.5,
      leftHandHeld: true
    });
    const current = fullInput({
      sequence: 2,
      clientTimeMs: 1010,
      moveX: 1,
      lookYawRadians: 0.5,
      leftHandHeld: false
    });

    client.sendInput(current, previous);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('input');
    expect(sent[0].payload).toEqual({
      type: 'input',
      playerId: 'me',
      sequence: 2,
      clientTimeMs: 1010,
      input: {
        lookYawRadians: 0.5,
        lookPitchRadians: 0,
        leftHandHeld: false
      }
    });
  });

  it('no-ops safely when offline (no room)', () => {
    const client = new MultiplayerClient('ws://test');
    expect(() => client.requestRoomSettings({ livesPerPlayer: 3 })).not.toThrow();
    expect(() => client.requestPreset('1v1-recommended')).not.toThrow();
    expect(() => client.requestStartMatch()).not.toThrow();
    expect(() => client.requestEndVote()).not.toThrow();
  });
});
