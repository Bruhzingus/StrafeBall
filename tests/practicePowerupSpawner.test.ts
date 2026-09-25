import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { PracticePowerupSpawner } from '../src/game/practice/PracticePowerupSpawner';

describe('PracticePowerupSpawner', () => {
  it('spawns one center-court capsule after the practice-lobby countdown', () => {
    const spawner = new PracticePowerupSpawner();
    const spawn = spawner.world.spawns[0];

    expect(spawner.world.spawns).toHaveLength(1);
    expect(spawn).toMatchObject({ x: 0, z: 0, spawned: false, waitSeconds: C.powerup.respawnSeconds });

    spawner.update(C.powerup.respawnSeconds - 0.01);
    expect(spawn.spawned).toBe(false);
    spawner.update(0.01);
    expect(spawn).toMatchObject({ spawned: true, waitSeconds: 0 });
  });

  it('restarts the spawn countdown when practice is reset', () => {
    const spawner = new PracticePowerupSpawner();
    spawner.update(C.powerup.respawnSeconds);
    spawner.reset();

    expect(spawner.world.spawns[0]).toMatchObject({ spawned: false, waitSeconds: C.powerup.respawnSeconds });
  });

  it('uses a two-second respawn interval while the practice shortcut is enabled', () => {
    const spawner = new PracticePowerupSpawner();

    spawner.setFastRespawnEnabled(true);
    spawner.update(1.99);
    expect(spawner.world.spawns[0].spawned).toBe(false);
    expect(spawner.world.spawns[0].waitSeconds).toBeCloseTo(0.01);
    spawner.update(0.01);
    expect(spawner.world.spawns[0]).toMatchObject({ spawned: true, waitSeconds: 0 });
    spawner.update(0, { x: 0, y: 0, z: 0 });
    expect(spawner.world.spawns[0]).toMatchObject({ spawned: false, waitSeconds: 2 });
  });

  it('restores the normal respawn interval when the practice shortcut is disabled', () => {
    const spawner = new PracticePowerupSpawner();
    spawner.setFastRespawnEnabled(true);
    spawner.setFastRespawnEnabled(false);
    spawner.update(2);
    expect(spawner.world.spawns[0].spawned).toBe(true);
    spawner.update(0, { x: 0, y: 0, z: 0 });

    expect(spawner.world.spawns[0].spawned).toBe(false);
    expect(spawner.world.spawns[0].waitSeconds).toBe(C.powerup.respawnSeconds);
  });

  it('picks up a spawned capsule on walk-over and restarts its clock', () => {
    const spawner = new PracticePowerupSpawner(() => 0);
    const spawn = spawner.world.spawns[0];
    spawner.update(C.powerup.respawnSeconds, { x: 4, y: 0, z: 0 }, 7);
    spawner.drainEvents();

    spawner.update(0, { x: C.powerup.pickupRadius, y: 4, z: 0 }, 7);

    expect(spawn).toMatchObject({ spawned: false, waitSeconds: C.powerup.respawnSeconds });
    expect(spawner.identity).toEqual({ kind: 'adrenaline', resetSerial: 7 });
    expect(spawner.drainEvents()).toEqual([expect.objectContaining({
      type: 'powerup-event', effect: 'pickup', playerId: 'practice', resetSerial: 7
    })]);
  });

  it('uses horizontal pickup distance and does not take a second item while holding one', () => {
    const spawner = new PracticePowerupSpawner(() => 0.99);
    const spawn = spawner.world.spawns[0];
    spawner.update(C.powerup.respawnSeconds, { x: 0, y: 20, z: 0 });
    expect(spawner.identity?.kind).toBe('stun');

    spawner.update(C.powerup.respawnSeconds);
    expect(spawn.spawned).toBe(true);
    spawner.update(0, { x: 0, y: 0, z: 0 });
    expect(spawn.spawned).toBe(true);
  });

  it('activates a collected buff with the normal G-flow contract', () => {
    const spawner = new PracticePowerupSpawner(() => 0);
    spawner.update(C.powerup.respawnSeconds, { x: 0, y: 0, z: 0 }, 3);
    spawner.drainEvents();

    expect(spawner.activate(true, { x: 2, y: 0, z: 1 }, 3)).toEqual({ ok: false });
    expect(spawner.identity?.kind).toBe('adrenaline');
    spawner.update(C.powerup.rollSeconds - 0.01);
    expect(spawner.activate(true, { x: 2, y: 0, z: 1 }, 3)).toEqual({ ok: false });
    spawner.update(0.01);
    expect(spawner.activate(true, { x: 2, y: 0, z: 1 }, 3)).toEqual({ ok: true, kind: 'adrenaline' });
    expect(spawner.buffs.adrenalineSeconds).toBe(C.powerup.buffSeconds);
    expect(spawner.identity).toEqual({ kind: null, resetSerial: 3 });
    expect(spawner.drainEvents()).toEqual([expect.objectContaining({ effect: 'activate', kind: 'adrenaline' })]);

    spawner.update(1);
    expect(spawner.buffs.adrenalineSeconds).toBe(C.powerup.buffSeconds - 1);
  });

  it('keeps a hand item when both hands are occupied', () => {
    const bombRoll = (5.1 / 8);
    const spawner = new PracticePowerupSpawner(() => bombRoll);
    spawner.update(C.powerup.respawnSeconds, { x: 0, y: 0, z: 0 }, 4);

    expect(spawner.identity?.kind).toBe('bomb');
    spawner.update(C.powerup.rollSeconds);
    expect(spawner.activate(false, { x: 0, y: 0, z: 0 }, 4)).toEqual({ ok: false });
    expect(spawner.identity).toEqual({
      kind: 'bomb', resetSerial: 4, reason: 'Free a hand to use this power-up'
    });
  });

  it('heals before expiry, but not on the tick a station expires', () => {
    const spawner = new PracticePowerupSpawner();
    spawner.placeHeal({ x: 0, y: 0, z: 0 });
    spawner.drainEvents();

    spawner.update(C.powerup.stationLifetimeSeconds - C.powerup.healSeconds, { x: 10, y: 0, z: 0 });
    spawner.update(C.powerup.healSeconds, { x: 0, y: 0, z: 0 });

    expect(spawner.world.stations).toHaveLength(0);
    expect(spawner.drainEvents().filter(event => event.effect === 'heal')).toEqual([]);

    spawner.placeHeal({ x: 0, y: 0, z: 0 });
    spawner.drainEvents();
    spawner.update(C.powerup.healSeconds, { x: 0, y: 0, z: 0 });
    expect(spawner.drainEvents().filter(event => event.effect === 'heal')).toHaveLength(1);
  });

  it('queues the rest of a grenade bundle and dispenses each one only after a throw', () => {
    const shockRoll = 6.1 / 8;
    const spawner = new PracticePowerupSpawner(() => shockRoll);
    spawner.update(C.powerup.respawnSeconds, { x: 0, y: 0, z: 0 });

    spawner.update(C.powerup.rollSeconds);
    expect(spawner.activate(true, { x: 0, y: 0, z: 0 })).toEqual({ ok: true, kind: 'shock' });
    expect(spawner.pendingGrenades).toBe(C.powerup.grenadeCharges - 1);

    for (let remaining = C.powerup.grenadeCharges - 2; remaining >= 0; remaining -= 1) {
      expect(spawner.takeGrenadeAfterThrow('shock')).toBe('shock');
      expect(spawner.pendingGrenades).toBe(remaining);
    }
    expect(spawner.takeGrenadeAfterThrow('shock')).toBeNull();
  });
});
