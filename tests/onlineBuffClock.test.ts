import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaScene } from '../src/game/scenes/ArenaScene';
import { TUNING } from '../src/game/config/tuning';
import { createRoomState } from '../shared/simulation/MatchSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import type { PlayerState } from '../shared/types';

afterEach(() => vi.restoreAllMocks());

describe('online last-player buff clock', () => {
  it('uses the host timeline for both movement and cooldowns despite different PC clocks', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const local = createPlayerState('local', 'red');
    local.lastPlayerBuffUntilMs = 5100;
    const room = createRoomState({ players: [local] });
    room.match.mode = '2v2';
    let serverTimeMs = 5000;
    // Exercise the real scene prediction helpers without constructing the browser/GPU scene.
    const scene = Object.assign(Object.create(ArenaScene.prototype) as object, {
      multiplayer: {
        latestSnapshot: { type: 'snapshot', tick: 128, serverTimeMs: 4950, room },
        estimateServerTimeMs: () => serverTimeMs
      }
    }) as unknown as {
      deriveOnlineMovementScale(local: PlayerState): number;
      deriveOnlineCooldownRateScale(local: PlayerState): number;
    };
    expect(scene.deriveOnlineMovementScale(local)).toBe(TUNING.match.lastPlayerBuffMultiplier);
    expect(scene.deriveOnlineCooldownRateScale(local)).toBe(TUNING.match.lastPlayerBuffCooldownRateMultiplier);
    serverTimeMs = 5100;
    expect(scene.deriveOnlineMovementScale(local)).toBe(1);
    expect(scene.deriveOnlineCooldownRateScale(local)).toBe(1);
  });
});
