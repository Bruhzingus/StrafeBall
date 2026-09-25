import { GAME_CONSTANTS as C } from '../../../shared/constants';
import type { PowerupEvent, PowerupPrivateMessage } from '../../../shared/protocol';
import type { PowerupBuffs, PowerupKind, PowerupWorldState, Vec3 } from '../../../shared/types';

const KINDS: PowerupKind[] = ['adrenaline', 'speed', 'cannon', 'heal', 'magnet', 'bomb', 'shock', 'stun'];
const HAND_ITEMS: PowerupKind[] = ['cannon', 'heal', 'bomb', 'shock', 'stun'];
const SPAWN_HEIGHT = 1;
type GrenadeKind = Extract<PowerupKind, 'shock' | 'stun'>;

/**
 * Local practice has no authoritative room, so this owns its spawn clock and walk-over inventory.
 * Its public state and pickup messages deliberately mirror the online PowerupSystem contract so the
 * existing presentation can render the capsule, play pickup feedback, and reveal the held kind.
 */
export class PracticePowerupSpawner {
  readonly world: PowerupWorldState = {
    spawns: [{ x: 0, z: 0, spawned: false, waitSeconds: C.powerup.respawnSeconds }],
    stations: []
  };
  private heldKind: PowerupKind | null = null;
  private rollRemaining = 0;
  private respawnSeconds: number = C.powerup.respawnSeconds;
  private queuedGrenadeKind: GrenadeKind | null = null;
  private queuedGrenades = 0;
  private privateMessage: PowerupPrivateMessage | null = null;
  private events: PowerupEvent[] = [];
  readonly buffs: PowerupBuffs = {
    speedSeconds: 0,
    adrenalineSeconds: 0,
    magnetSeconds: 0,
    cannonLocked: false,
    stunSeconds: 0
  };

  constructor(private readonly rng: () => number = Math.random) {}

  get identity(): PowerupPrivateMessage | null {
    return this.privateMessage;
  }

  get pendingGrenades(): number {
    return this.queuedGrenades;
  }

  /**
   * Practice lobby setting for quick iteration. It affects this countdown immediately and all
   * subsequent respawns, but never removes a power-up that is already waiting at center court.
   */
  setFastRespawnEnabled(enabled: boolean): void {
    this.respawnSeconds = enabled ? 2 : C.powerup.respawnSeconds;
    if (!enabled) return;
    for (const spawn of this.world.spawns) {
      if (!spawn.spawned) spawn.waitSeconds = Math.min(spawn.waitSeconds, this.respawnSeconds);
    }
  }

  update(dt: number, playerPosition?: Vec3, resetSerial = 0): void {
    const elapsed = Math.max(0, dt);
    this.rollRemaining = Math.max(0, this.rollRemaining - elapsed);
    if (this.rollRemaining < 1e-6) this.rollRemaining = 0;
    this.buffs.speedSeconds = Math.max(0, this.buffs.speedSeconds - elapsed);
    this.buffs.adrenalineSeconds = Math.max(0, this.buffs.adrenalineSeconds - elapsed);
    this.buffs.magnetSeconds = Math.max(0, this.buffs.magnetSeconds - elapsed);
    this.buffs.stunSeconds = Math.max(0, (this.buffs.stunSeconds ?? 0) - elapsed);
    for (const spawn of this.world.spawns) {
      if (!spawn.spawned) {
        spawn.waitSeconds = Math.max(0, spawn.waitSeconds - elapsed);
        if (spawn.waitSeconds <= 1e-7) {
          spawn.waitSeconds = 0;
          spawn.spawned = true;
          this.events.push(this.event('spawn', spawn, resetSerial));
        }
      }
      if (!spawn.spawned || this.heldKind || !playerPosition) continue;
      if (Math.hypot(playerPosition.x - spawn.x, playerPosition.z - spawn.z) > C.powerup.pickupRadius) continue;

      const index = Math.min(KINDS.length - 1, Math.floor(this.rng() * KINDS.length));
      this.heldKind = KINDS[Math.max(0, index)];
      this.rollRemaining = C.powerup.rollSeconds;
      this.privateMessage = { kind: this.heldKind, resetSerial };
      spawn.spawned = false;
      spawn.waitSeconds = this.respawnSeconds;
      this.events.push(this.event('pickup', spawn, resetSerial));
    }

    for (const station of this.world.stations) {
      station.remainingSeconds = Math.max(0, station.remainingSeconds - elapsed);
      const inRange = !!playerPosition
        && playerPosition.y < 0.1
        && Math.hypot(playerPosition.x - station.position.x, playerPosition.z - station.position.z) <= C.powerup.healRadius;
      station.progress.practice = inRange ? (station.progress.practice ?? 0) + elapsed : 0;
      if (station.progress.practice + 1e-7 >= C.powerup.healSeconds && station.remainingSeconds > 0) {
        station.remainingSeconds = 0;
        this.events.push({ type: 'powerup-event', effect: 'heal', position: { ...station.position }, playerId: 'practice', resetSerial });
      }
    }
    this.world.stations = this.world.stations.filter(station => station.remainingSeconds > 0);
  }

  activate(hasFreeHand: boolean, position: Vec3, resetSerial = 0): { ok: true; kind: PowerupKind } | { ok: false } {
    const kind = this.heldKind;
    if (!kind || this.rollRemaining > 0) return { ok: false };
    if (HAND_ITEMS.includes(kind) && !hasFreeHand) {
      this.privateMessage = { kind, resetSerial, reason: 'Free a hand to use this power-up' };
      return { ok: false };
    }

    if (kind === 'adrenaline') this.buffs.adrenalineSeconds = C.powerup.buffSeconds;
    else if (kind === 'speed') this.buffs.speedSeconds = C.powerup.buffSeconds;
    else if (kind === 'magnet') this.buffs.magnetSeconds = C.powerup.magnetSeconds;
    else if (kind === 'shock' || kind === 'stun') {
      this.queuedGrenadeKind = kind;
      this.queuedGrenades = Math.max(0, C.powerup.grenadeCharges - 1);
    }

    this.heldKind = null;
    this.rollRemaining = 0;
    this.privateMessage = { kind: null, resetSerial };
    this.events.push({
      type: 'powerup-event', effect: 'activate', position: { ...position }, playerId: 'practice', kind, resetSerial
    });
    return { ok: true, kind };
  }

  /** Consume the next grenade only after the currently held grenade was actually thrown. */
  takeGrenadeAfterThrow(kind: GrenadeKind): GrenadeKind | null {
    if (this.queuedGrenadeKind !== kind || this.queuedGrenades <= 0) return null;
    this.queuedGrenades -= 1;
    if (this.queuedGrenades === 0) this.queuedGrenadeKind = null;
    return kind;
  }

  placeHeal(position: Vec3, resetSerial = 0): void {
    this.world.stations = [{
      id: 'practice_heal_station',
      placerId: 'practice',
      teamId: 'practice',
      position: { x: position.x, y: 0, z: position.z },
      remainingSeconds: C.powerup.stationLifetimeSeconds,
      progress: {}
    }];
    this.events.push({ type: 'powerup-event', effect: 'place', position: { ...position, y: 0 }, playerId: 'practice', resetSerial });
  }

  applyStun(seconds = C.powerup.stunSeconds): void {
    this.buffs.stunSeconds = Math.max(this.buffs.stunSeconds ?? 0, seconds);
  }

  emit(effect: PowerupEvent['effect'], position: Vec3, resetSerial = 0, stage?: number): void {
    this.events.push({ type: 'powerup-event', effect, position: { ...position }, playerId: 'practice', resetSerial, stage });
  }

  drainEvents(): PowerupEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  reset(): void {
    this.heldKind = null;
    this.rollRemaining = 0;
    this.privateMessage = null;
    this.events = [];
    this.queuedGrenadeKind = null;
    this.queuedGrenades = 0;
    this.buffs.speedSeconds = 0;
    this.buffs.adrenalineSeconds = 0;
    this.buffs.magnetSeconds = 0;
    this.buffs.cannonLocked = false;
    this.buffs.stunSeconds = 0;
    this.world.stations = [];
    for (const spawn of this.world.spawns) {
      spawn.spawned = false;
      spawn.waitSeconds = this.respawnSeconds;
    }
  }

  private event(effect: PowerupEvent['effect'], spawn: PowerupWorldState['spawns'][number], resetSerial: number): PowerupEvent {
    return {
      type: 'powerup-event',
      effect,
      position: { x: spawn.x, y: SPAWN_HEIGHT, z: spawn.z },
      playerId: effect === 'pickup' ? 'practice' : undefined,
      resetSerial
    };
  }
}
