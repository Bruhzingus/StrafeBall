import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { PracticeMapEffects } from '../src/game/practice/PracticeMapEffects';
import { PracticePowerupSpawner } from '../src/game/practice/PracticePowerupSpawner';

describe('PracticeMapEffects', () => {
  it.each([['moon', 0], ['lava', 0.4], ['frenzy', 0.8]] as const)('can roll %s on a lobby spawn clock', (kind, roll) => {
    const values = [0, roll];
    const spawner = new PracticePowerupSpawner(() => 0, () => values.shift() ?? 1);
    spawner.update(C.powerup.respawnSeconds);
    expect(spawner.world.spawns[0].spawned).toBe(true);
    expect(spawner.mapEffects.state).toMatchObject({ kind, phase: 'warning', spawnIndex: 0 });
    expect(spawner.drainEvents().map(event => event.effect)).toContain('map-warning');
  });

  it('uses the online chance and leaves the ordinary item spawn intact', () => {
    const spawner = new PracticePowerupSpawner(() => 0, () => C.mapEffect.chance);
    spawner.update(C.powerup.respawnSeconds);
    expect(spawner.world.spawns[0].spawned).toBe(true);
    expect(spawner.mapEffects.state).toBeNull();
  });

  it('runs warning, active and ending phases with the shared durations', () => {
    const values = [0, 0.4];
    const effects = new PracticeMapEffects(() => values.shift() ?? 1);
    effects.tryStart(0, { x: 0, y: 1, z: 0 }, 3);
    effects.update(C.mapEffect.warningSeconds, 3);
    expect(effects.state?.phase).toBe('warning');
    expect(effects.state?.lavaLevel).toBe(0);
    effects.update(C.mapEffect.lavaWarningExtraSeconds, 3);
    expect(effects.state).toMatchObject({ kind: 'lava', phase: 'active', remainingSeconds: C.mapEffect.lavaRiseSeconds + C.mapEffect.lavaHoldSeconds });
    effects.update(C.mapEffect.lavaRiseSeconds, 3);
    expect(effects.state?.lavaLevel).toBeGreaterThan(0);
    effects.update(C.mapEffect.lavaHoldSeconds, 3);
    expect(effects.state).toMatchObject({ phase: 'ending', remainingSeconds: C.mapEffect.lavaRecedeSeconds });
    effects.update(C.mapEffect.lavaRecedeSeconds, 3);
    expect(effects.state).toBeNull();
    expect(effects.drainEvents().map(event => event.effect)).toEqual(['map-warning', 'map-start', 'map-end']);
  });
});
