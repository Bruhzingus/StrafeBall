import { describe, expect, it } from 'vitest';
import type { PowerupKind } from '../shared/types';
import { resolvePowerupSoundKind } from '../src/game/powerups/PowerupPresentation';

const powerupKinds: PowerupKind[] = ['adrenaline', 'speed', 'cannon', 'heal', 'magnet', 'bomb', 'shock', 'stun'];

describe('power-up sound routing', () => {
  it('routes every public activation kind to its matching sound variant', () => {
    const routed = powerupKinds.map(kind => resolvePowerupSoundKind({ effect: 'activate', kind }, 'viewer', null));
    expect(routed).toEqual(powerupKinds);
    expect(new Set(routed).size).toBe(powerupKinds.length);
  });

  it('uses the private item identity only for the local player pickup', () => {
    expect(resolvePowerupSoundKind({ effect: 'pickup', playerId: 'viewer' }, 'viewer', 'magnet')).toBe('magnet');
    expect(resolvePowerupSoundKind({ effect: 'pickup', playerId: 'opponent' }, 'viewer', 'magnet')).toBeUndefined();
    expect(resolvePowerupSoundKind({ effect: 'pickup', playerId: 'opponent', kind: 'bomb' }, 'viewer', 'magnet')).toBeUndefined();
  });

  it('keeps generic fallbacks for events that do not expose a power-up kind', () => {
    expect(resolvePowerupSoundKind({ effect: 'activate' }, 'viewer', null)).toBeUndefined();
    expect(resolvePowerupSoundKind({ effect: 'map-start' }, 'viewer', 'shock')).toBeUndefined();
  });
});
