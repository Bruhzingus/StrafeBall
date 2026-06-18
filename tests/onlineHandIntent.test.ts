import { describe, expect, it } from 'vitest';
import {
  ONLINE_THROW_RELEASE_ACK_TIMEOUT_MS,
  hasPendingOnlineThrowRelease,
  onlineHandInputLooksEmpty,
  shouldClearPendingOnlineThrowRelease,
  type PendingOnlineThrowRelease
} from '../src/game/network/OnlineHandIntent';

describe('online hand intent', () => {
  it('treats a just-released hand as empty while the authoritative snapshot still shows the thrown ball', () => {
    const pending: PendingOnlineThrowRelease = { ballId: 'ball_0', releasedAtMs: 1000 };

    expect(hasPendingOnlineThrowRelease('ball_0', pending, 1050)).toBe(true);
    expect(onlineHandInputLooksEmpty('ball_0', pending, 1050)).toBe(true);
    expect(shouldClearPendingOnlineThrowRelease('ball_0', pending, 1050)).toBe(false);
  });

  it('clears the optimistic empty hand once the server catches up or the prediction times out', () => {
    const pending: PendingOnlineThrowRelease = { ballId: 'ball_0', releasedAtMs: 1000 };

    expect(shouldClearPendingOnlineThrowRelease(null, pending, 1100)).toBe(true);
    expect(shouldClearPendingOnlineThrowRelease('ball_1', pending, 1100)).toBe(true);
    expect(shouldClearPendingOnlineThrowRelease(
      'ball_0',
      pending,
      1000 + ONLINE_THROW_RELEASE_ACK_TIMEOUT_MS + 1
    )).toBe(true);
    expect(onlineHandInputLooksEmpty('ball_0', pending, 1000 + ONLINE_THROW_RELEASE_ACK_TIMEOUT_MS + 1)).toBe(false);
  });
});
