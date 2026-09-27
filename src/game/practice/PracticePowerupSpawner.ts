import { GAME_CONSTANTS as C } from '../../../shared/constants';
import type { PowerupEvent, PowerupPrivateMessage } from '../../../shared/protocol';
import type { PowerupBuffs, PowerupKind, PowerupWorldState, Vec3 } from '../../../shared/types';
import { PracticeMapEffects } from './PracticeMapEffects';

const KINDS: PowerupKind[] = ['adrenaline', 'speed', 'cannon', 'heal', 'magnet', 'bomb', 'shock', 'stun', 'coachGlasses'];
const HAND_ITEMS: PowerupKind[] = ['cannon', 'heal', 'bomb', 'shock', 'stun'];
const SPAWN_HEIGHT = 1;
type GrenadeKind = Extract<PowerupKind, 'shock' | 'stun'>;

export interface PracticePowerupSpawnConfig {
  x: number;
  y?: number;
  z: number;
  /** Null means the normal random mystery roll. */
  kind: PowerupKind | null;
  initialDelaySeconds: number;
  respawnSeconds: number;
  autoActivate: boolean;
}

const DEFAULT_SPAWN: PracticePowerupSpawnConfig = {
  x: 0,
  z: 0,
  kind: null,
  initialDelaySeconds: C.powerup.respawnSeconds,
  respawnSeconds: C.powerup.respawnSeconds,
  autoActivate: false
};

/**
 * Local practice has no authoritative room, so this owns its spawn clock and walk-over inventory.
 * Its public state and pickup messages deliberately mirror the online PowerupSystem contract so the
 * existing presentation can render the capsule, play pickup feedback, and reveal the held kind.
 */
export class PracticePowerupSpawner {
  readonly mapEffects: PracticeMapEffects;
  readonly world: PowerupWorldState = {
    spawns: [{ x: 0, z: 0, spawned: false, waitSeconds: C.powerup.respawnSeconds }],
    stations: []
  };
  private heldKind: PowerupKind | null = null;
  private rollRemaining = 0;
  private respawnSeconds: number = C.powerup.respawnSeconds;
  private spawnConfigs: PracticePowerupSpawnConfig[] = [{ ...DEFAULT_SPAWN }];
  private usingDefaultSpawn = true;
  private autoActivatedKinds: PowerupKind[] = [];
  private queuedGrenadeKind: GrenadeKind | null = null;
  private queuedGrenades = 0;
  private privateMessage: PowerupPrivateMessage | null = null;
  private events: PowerupEvent[] = [];
  readonly buffs: PowerupBuffs = {
    speedSeconds: 0,
    adrenalineSeconds: 0,
    magnetSeconds: 0,
    coachGlassesSeconds: 0,
    cannonLocked: false,
    stunSeconds: 0
  };

  constructor(private readonly rng: () => number = Math.random, mapRng: () => number = Math.random) {
    this.mapEffects = new PracticeMapEffects(mapRng);
  }

  get identity(): PowerupPrivateMessage | null {
    return this.privateMessage;
  }

  get pendingGrenades(): number {
    return this.queuedGrenades;
  }

  get hasPowerup(): boolean {
    return this.heldKind !== null;
  }

  /** Replace center court with the authored course spawners. An empty list disables local spawns. */
  configureSpawns(configs: readonly PracticePowerupSpawnConfig[]): void {
    this.usingDefaultSpawn = false;
    this.spawnConfigs = configs.map(config => ({
      x: Number.isFinite(config.x) ? config.x : 0,
      y: config.y !== undefined && Number.isFinite(config.y) ? config.y : undefined,
      z: Number.isFinite(config.z) ? config.z : 0,
      kind: config.kind,
      initialDelaySeconds: Math.max(0, Number.isFinite(config.initialDelaySeconds) ? config.initialDelaySeconds : 0),
      respawnSeconds: Math.max(0.25, Number.isFinite(config.respawnSeconds) ? config.respawnSeconds : C.powerup.respawnSeconds),
      autoActivate: config.autoActivate === true
    }));
    this.clearRuntimeState();
    this.world.spawns = this.spawnConfigs.map(config => ({
      x: config.x,
      ...(config.y !== undefined ? { y: config.y } : {}),
      z: config.z,
      ...(config.kind ? { kind: config.kind } : {}),
      respawnSeconds: config.initialDelaySeconds > 0 ? config.initialDelaySeconds : config.respawnSeconds,
      spawned: config.initialDelaySeconds <= 0,
      waitSeconds: config.initialDelaySeconds
    }));
  }

  /** Restore the ordinary delayed random center-court box used by the practice gym. */
  configureDefaultSpawn(): void {
    this.usingDefaultSpawn = true;
    const config = {
      ...DEFAULT_SPAWN,
      initialDelaySeconds: this.respawnSeconds,
      respawnSeconds: this.respawnSeconds
    };
    this.spawnConfigs = [config];
    this.clearRuntimeState();
    this.world.spawns = [{ x: 0, z: 0, spawned: false, waitSeconds: this.respawnSeconds }];
  }

  /**
   * Practice lobby setting for quick iteration. It affects this countdown immediately and all
   * subsequent respawns, but never removes a power-up that is already waiting at center court.
   */
  setFastRespawnEnabled(enabled: boolean): void {
    this.respawnSeconds = enabled ? 2 : C.powerup.respawnSeconds;
    if (!this.usingDefaultSpawn) return;
    this.spawnConfigs[0].respawnSeconds = this.respawnSeconds;
    this.spawnConfigs[0].initialDelaySeconds = this.respawnSeconds;
    if (!enabled) return;
    for (const spawn of this.world.spawns) {
      if (!spawn.spawned) spawn.waitSeconds = Math.min(spawn.waitSeconds, this.respawnSeconds);
    }
  }

  update(dt: number, playerPosition?: Vec3, resetSerial = 0, hasFreeHand = true): void {
    const elapsed = Math.max(0, dt);
    let mapElapsed = this.mapEffects.state ? elapsed : 0;
    this.rollRemaining = Math.max(0, this.rollRemaining - elapsed);
    if (this.rollRemaining < 1e-6) this.rollRemaining = 0;
    this.buffs.speedSeconds = Math.max(0, this.buffs.speedSeconds - elapsed);
    this.buffs.adrenalineSeconds = Math.max(0, this.buffs.adrenalineSeconds - elapsed);
    this.buffs.magnetSeconds = Math.max(0, this.buffs.magnetSeconds - elapsed);
    this.buffs.coachGlassesSeconds = Math.max(0, (this.buffs.coachGlassesSeconds ?? 0) - elapsed);
    this.buffs.stunSeconds = Math.max(0, (this.buffs.stunSeconds ?? 0) - elapsed);
    let pickedUp = false;
    for (let spawnIndex = 0; spawnIndex < this.world.spawns.length; spawnIndex += 1) {
      const spawn = this.world.spawns[spawnIndex];
      const config = this.spawnConfigs[spawnIndex] ?? DEFAULT_SPAWN;
      if (!spawn.spawned) {
        const waitBeforeStep = spawn.waitSeconds;
        spawn.waitSeconds = Math.max(0, spawn.waitSeconds - elapsed);
        if (spawn.waitSeconds <= 1e-7) {
          if (this.usingDefaultSpawn) this.mapEffects.tryStart(spawnIndex, this.event('spawn', spawn, resetSerial).position, resetSerial);
          if (this.mapEffects.state && mapElapsed === 0) mapElapsed = Math.max(0, elapsed - waitBeforeStep);
          spawn.waitSeconds = 0;
          spawn.spawned = true;
          this.events.push(this.event('spawn', spawn, resetSerial));
        }
      }
      if (!spawn.spawned || this.heldKind || !playerPosition || pickedUp) continue;
      if (Math.hypot(playerPosition.x - spawn.x, playerPosition.z - spawn.z) > C.powerup.pickupRadius) continue;
      if (config.y !== undefined && Math.abs(playerPosition.y - config.y) > C.powerup.pickupRadius * 1.5) continue;

      const index = Math.min(KINDS.length - 1, Math.floor(this.rng() * KINDS.length));
      this.heldKind = config.kind ?? KINDS[Math.max(0, index)];
      // A labelled fixed box has nothing to reveal. Random boxes retain the normal roulette delay.
      this.rollRemaining = config.kind ? 0 : C.powerup.rollSeconds;
      this.privateMessage = { kind: this.heldKind, resetSerial, ...(config.kind ? { revealSeconds: 0 } : {}) };
      spawn.spawned = false;
      spawn.waitSeconds = config.respawnSeconds;
      spawn.respawnSeconds = config.respawnSeconds;
      this.events.push(this.event('pickup', spawn, resetSerial));
      pickedUp = true;
      if (config.autoActivate) {
        this.rollRemaining = 0;
        const activation = this.activate(hasFreeHand, playerPosition, resetSerial);
        if (activation.ok) this.autoActivatedKinds.push(activation.kind);
      }
    }

    for (const station of this.world.stations) {
      station.remainingSeconds = Math.max(0, station.remainingSeconds - elapsed);
      const inRange = !!playerPosition
        && Math.abs(playerPosition.y - station.position.y) <= 1.25
        && Math.hypot(playerPosition.x - station.position.x, playerPosition.z - station.position.z) <= C.powerup.healRadius;
      station.progress.practice = inRange ? (station.progress.practice ?? 0) + elapsed : 0;
      if (station.progress.practice + 1e-7 >= C.powerup.healSeconds && station.remainingSeconds > 0) {
        station.remainingSeconds = 0;
        this.events.push({ type: 'powerup-event', effect: 'heal', position: { ...station.position }, playerId: 'practice', resetSerial });
      }
    }
    this.world.stations = this.world.stations.filter(station => station.remainingSeconds > 0);
    this.mapEffects.update(mapElapsed, resetSerial);
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
    else if (kind === 'coachGlasses') this.buffs.coachGlassesSeconds = C.powerup.buffSeconds;
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
      position: { ...position },
      remainingSeconds: C.powerup.stationLifetimeSeconds,
      progress: {}
    }];
    this.events.push({ type: 'powerup-event', effect: 'place', position: { ...position }, playerId: 'practice', resetSerial });
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
    return [...events, ...this.mapEffects.drainEvents()];
  }

  drainAutoActivations(): PowerupKind[] {
    const kinds = this.autoActivatedKinds;
    this.autoActivatedKinds = [];
    return kinds;
  }

  reset(): void {
    this.clearRuntimeState();
    for (let i = 0; i < this.world.spawns.length; i += 1) {
      const spawn = this.world.spawns[i];
      const config = this.spawnConfigs[i] ?? DEFAULT_SPAWN;
      spawn.spawned = config.initialDelaySeconds <= 0;
      spawn.waitSeconds = config.initialDelaySeconds;
      spawn.respawnSeconds = config.initialDelaySeconds > 0 ? config.initialDelaySeconds : config.respawnSeconds;
    }
  }

  private clearRuntimeState(): void {
    this.heldKind = null;
    this.rollRemaining = 0;
    this.privateMessage = null;
    this.events = [];
    this.autoActivatedKinds = [];
    this.queuedGrenadeKind = null;
    this.queuedGrenades = 0;
    this.buffs.speedSeconds = 0;
    this.buffs.adrenalineSeconds = 0;
    this.buffs.magnetSeconds = 0;
    this.buffs.coachGlassesSeconds = 0;
    this.buffs.cannonLocked = false;
    this.buffs.stunSeconds = 0;
    this.world.stations = [];
    this.mapEffects.reset();
  }

  private event(effect: PowerupEvent['effect'], spawn: PowerupWorldState['spawns'][number], resetSerial: number): PowerupEvent {
    return {
      type: 'powerup-event',
      effect,
      position: { x: spawn.x, y: (spawn.y ?? 0) + SPAWN_HEIGHT, z: spawn.z },
      playerId: effect === 'pickup' ? 'practice' : undefined,
      resetSerial
    };
  }
}
