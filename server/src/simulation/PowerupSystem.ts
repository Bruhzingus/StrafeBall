import { GAME_CONSTANTS as C } from '../../../shared/constants';
import type { BallState, HandSide, PlayerState, PowerupKind, PowerupSpawnState, RoomState, Vec3 } from '../../../shared/types';
import type { PowerupEvent, PowerupPrivateMessage } from '../../../shared/protocol';
import { createBallState, holdBall, isGrenadeKind, markBallDead } from '../../../shared/simulation/BallSim';
import { shockwaveBallVelocity, shockwavePlayerVelocity } from '../../../shared/simulation/ShockwaveSim';
import { createHandState, tryPickupBall } from '../../../shared/simulation/HandSim';
import { createBallCollisionBoxes } from '../../../shared/simulation/MapGeometry';

const KINDS: PowerupKind[] = ['adrenaline', 'speed', 'cannon', 'heal', 'magnet', 'bomb', 'shock', 'stun'];
const HAND_ITEMS: PowerupKind[] = ['cannon', 'bomb', 'heal', 'shock', 'stun'];
const alive = (p: PlayerState) => p.connected && p.combatState === 'alive' && p.lives > 0;
const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const SPAWN_HEIGHT = 1;

/** 1v1: one spawn at center court. 2v2: two, mirrored across center along the neutral line. */
function createSpawns(room: RoomState): PowerupSpawnState[] {
  const fresh = { spawned: false, waitSeconds: C.powerup.respawnSeconds };
  if (room.settings.format !== '2v2') return [{ x: 0, z: 0, ...fresh }];
  const offset = C.map.halfWidth * C.powerup.twoVTwoSpawnOffsetFraction;
  return [{ x: -offset, z: 0, ...fresh }, { x: offset, z: 0, ...fresh }];
}
const spawnPosition = (spawn: PowerupSpawnState): Vec3 => ({ x: spawn.x, y: SPAWN_HEIGHT, z: spawn.z });

/** Server-only inventory. No unused identity is ever placed in the public room state. */
export class PowerupSystem {
  private inventory = new Map<string, PowerupKind>();
  private serial = 0;
  private events: PowerupEvent[] = [];
  private privateMessages: { playerId: string; message: PowerupPrivateMessage }[] = [];
  private cannonHits = new Map<string, Set<string>>();
  private distantPulls = new Map<string, string>();

  constructor(private readonly rng: () => number = Math.random) {}

  private emit(room: RoomState, effect: PowerupEvent['effect'], position: Vec3, extra: Partial<PowerupEvent> = {}): void {
    this.events.push({ type: 'powerup-event', effect, position: { ...position }, resetSerial: room.resetVote.resetSerial, ...extra });
  }
  private notify(room: RoomState, playerId: string, reason?: string): void {
    this.privateMessages.push({ playerId, message: { kind: this.inventory.get(playerId) ?? null, resetSerial: room.resetVote.resetSerial, reason } });
  }
  identity(room: RoomState, playerId: string): PowerupPrivateMessage {
    return { kind: this.inventory.get(playerId) ?? null, resetSerial: room.resetVote.resetSerial };
  }
  drain() {
    const result = { events: this.events, privateMessages: this.privateMessages };
    this.events = []; this.privateMessages = [];
    return result;
  }
  reset(room: RoomState): void {
    this.inventory.clear(); this.cannonHits.clear(); this.distantPulls.clear(); this.events = []; this.privateMessages = [];
    room.powerups = { spawns: createSpawns(room), stations: [] };
    for (const p of Object.values(room.players)) {
      p.hasPowerup = false; p.armorBallIds = []; p.pendingGrenades = 0; delete p.movementInternal.buffs;
      for (const hand of ['left', 'right'] as const) {
        const ball = room.balls[p.hands[hand].heldBallId ?? ''];
        if (ball?.kind && ball.kind !== 'normal') p.hands[hand] = createHandState(hand);
      }
      this.notify(room, p.id);
    }
    for (const ball of Object.values(room.balls)) {
      if (ball.kind && ball.kind !== 'normal') delete room.balls[ball.id];
      else if (ball.phase === 'armor') room.balls[ball.id] = { ...markBallDead(ball), armorPlayerId: undefined };
    }
  }

  activate(room: RoomState, playerId: string): boolean {
    const p = room.players[playerId];
    const kind = this.inventory.get(playerId);
    const running = room.match.status === 'playing' || room.match.status === 'warmup';
    if (room.settings.powerupsEnabled === false || !p || !alive(p) || !running || !kind) return false;
    const hand = (['left', 'right'] as const).find(h => !p.hands[h].heldBallId);
    if (HAND_ITEMS.includes(kind) && !hand) {
      this.notify(room, playerId, 'Free a hand to use this power-up'); return false;
    }
    const buffs = p.movementInternal.buffs ??= { speedSeconds: 0, adrenalineSeconds: 0, magnetSeconds: 0, cannonLocked: false };
    if (kind === 'adrenaline') {
      buffs.adrenalineSeconds = C.powerup.buffSeconds;
      p.dash.charges = C.powerup.adrenalineMaxCharges; p.dash.rechargeTimerSeconds = 0;
    } else if (kind === 'speed') buffs.speedSeconds = C.powerup.buffSeconds;
    else if (kind === 'magnet') buffs.magnetSeconds = C.powerup.magnetSeconds;
    else if (hand) {
      const id = `powerball_${++this.serial}`;
      room.balls[id] = holdBall(createBallState(id, p.movement.position, { kind }), playerId, hand);
      p.hands[hand] = createHandState(hand, { heldBallId: id, mode: 'holding' });
      if (kind === 'cannon') buffs.cannonLocked = true;
      if (isGrenadeKind(kind)) p.pendingGrenades = C.powerup.grenadeCharges - 1;
    }
    this.inventory.delete(playerId); p.hasPowerup = false;
    this.notify(room, playerId);
    this.emit(room, 'activate', p.movement.position, { playerId, kind });
    return true;
  }

  place(room: RoomState, p: PlayerState, hand: HandSide, boxes = createBallCollisionBoxes()): boolean {
    const position = { x: p.movement.position.x + Math.sin(p.movement.yawRadians) * C.powerup.placementDistance,
      y: 0, z: p.movement.position.z + Math.cos(p.movement.yawRadians) * C.powerup.placementDistance };
    // The whole healing footprint must be on the court floor, never in stands or through cover.
    const radius = C.powerup.healRadius;
    if (Math.abs(position.x) + radius > C.map.halfWidth || Math.abs(position.z) + radius > C.map.halfLength ||
      p.movement.position.y > 0.1 || boxes.some(b => b.maxY > 0.1 && position.x + radius > b.minX && position.x - radius < b.maxX && position.z + radius > b.minZ && position.z - radius < b.maxZ)) {
      this.notify(room, p.id, 'Place on clear court floor'); return false;
    }
    const world = room.powerups!;
    world.stations = world.stations.filter(s => s.placerId !== p.id);
    world.stations.push({ id: `station_${++this.serial}`, placerId: p.id, teamId: p.teamId, position,
      remainingSeconds: C.powerup.stationLifetimeSeconds, progress: {} });
    delete room.balls[p.hands[hand].heldBallId!]; p.hands[hand] = createHandState(hand);
    this.emit(room, 'place', position, { playerId: p.id });
    return true;
  }

  /** Runs only during live play. Timers measure simulated seconds, including under server catch-up. */
  beforeBalls(room: RoomState, dt: number, livesCap: number, onSpawnClockComplete?: (spawnIndex: number, position: Vec3) => void): void {
    if (room.settings.powerupsEnabled === false) return;
    const world = room.powerups ??= { spawns: createSpawns(room), stations: [] };
    world.spawns.forEach((spawn, i) => {
      if (spawn.spawned) return;
      spawn.waitSeconds = Math.max(0, spawn.waitSeconds - dt);
      if (spawn.waitSeconds >= 1e-7) return;
      // A completed clock can also start a whole-court bonus effect. It never replaces the item.
      onSpawnClockComplete?.(i, spawnPosition(spawn));
      spawn.waitSeconds = 0; spawn.spawned = true; this.emit(room, 'spawn', spawnPosition(spawn));
    });
    for (const p of Object.values(room.players)) {
      if (!alive(p)) { this.inventory.delete(p.id); p.hasPowerup = false; }
      const spawn = alive(p) && !this.inventory.has(p.id)
        ? world.spawns.find(s => s.spawned && horizontal(p.movement.position, spawnPosition(s)) <= C.powerup.pickupRadius)
        : undefined;
      if (spawn) {
        this.inventory.set(p.id, KINDS[Math.min(KINDS.length - 1, Math.floor(this.rng() * KINDS.length))]);
        p.hasPowerup = true; spawn.spawned = false; spawn.waitSeconds = C.powerup.respawnSeconds;
        this.notify(room, p.id); this.emit(room, 'pickup', spawnPosition(spawn), { playerId: p.id });
      }
      this.syncLock(room, p);
      if (!alive(p) || (p.movementInternal.buffs?.magnetSeconds ?? 0) <= 0) this.dropArmor(room, p);
    }
    this.magnet(room, dt);
    for (const station of world.stations) {
      station.remainingSeconds -= dt;
      for (const p of Object.values(room.players)) {
        const eligible = alive(p) && p.teamId === station.teamId && p.movement.grounded && p.movement.position.y < 0.1 && horizontal(p.movement.position, station.position) <= C.powerup.healRadius;
        station.progress[p.id] = eligible ? (station.progress[p.id] ?? 0) + dt : 0;
        if (station.progress[p.id] + 1e-7 >= C.powerup.healSeconds && p.lives < livesCap && station.remainingSeconds > 0) {
          p.lives = Math.min(livesCap, p.lives + 1); station.remainingSeconds = 0;
          this.emit(room, 'heal', station.position, { playerId: p.id }); break;
        }
      }
    }
    world.stations = world.stations.filter(s => s.remainingSeconds > 0);
  }
  syncLock(room: RoomState, p: PlayerState): void {
    if (p.movementInternal.buffs) p.movementInternal.buffs.cannonLocked = (['left', 'right'] as const).some(h => room.balls[p.hands[h].heldBallId ?? '']?.kind === 'cannon');
  }
  private magnet(room: RoomState, dt: number): void {
    const magnets = Object.values(room.players).filter(p => alive(p) && (p.movementInternal.buffs?.magnetSeconds ?? 0) > 0);
    for (const ball of Object.values(room.balls)) {
      if (ball.phase === 'armor') {
        const p = room.players[ball.armorPlayerId ?? ''];
        if (p) ball.position = { ...p.movement.position, y: p.movement.position.y + 0.9 };
        else { room.balls[ball.id] = { ...markBallDead(ball), armorPlayerId: undefined }; }
        continue;
      }
      if ((ball.phase !== 'loose' && ball.phase !== 'dead') || (ball.kind && ball.kind !== 'normal')) { this.distantPulls.delete(ball.id); continue; }
      ball.settledSeconds = Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z) < 0.1 ? (ball.settledSeconds ?? 0) + dt : 0;
      const candidates = magnets.filter(p => (p.armorBallIds?.length ?? 0) < C.powerup.armorCap || !p.hands.left.heldBallId || !p.hands.right.heldBallId)
        .sort((a, b) => horizontal(a.movement.position, ball.position) - horizontal(b.movement.position, ball.position));
      const p = candidates.find(p => horizontal(p.movement.position, ball.position) <= C.powerup.magnetRadius || (ball.settledSeconds ?? 0) > C.powerup.stationarySeconds || this.distantPulls.get(ball.id) === p.id);
      if (!p) { this.distantPulls.delete(ball.id); continue; }
      const d = horizontal(p.movement.position, ball.position);
      if (d < 0.85 && Math.abs(p.movement.position.y - ball.position.y) < C.ball.pickupVerticalTolerance) {
        const pickup = tryPickupBall(p, p.hands, ball);
        if (pickup.ok) { p.hands = pickup.hands; room.balls[ball.id] = pickup.ball; }
        else if ((p.armorBallIds?.length ?? 0) < C.powerup.armorCap) {
          (p.armorBallIds ??= []).push(ball.id); ball.phase = 'armor'; ball.armorPlayerId = p.id;
          ball.velocity = { x: 0, y: 0, z: 0 }; this.emit(room, 'armor', p.movement.position, { playerId: p.id });
        }
        continue;
      }
      const nearby = d <= C.powerup.magnetRadius;
      // Counter floor friction as part of the force, so the weak long-distance pull remains visible.
      const accel = nearby ? C.powerup.magnetAcceleration : C.powerup.distantMagnetAcceleration;
      const cap = nearby ? C.powerup.magnetSpeed : C.powerup.distantMagnetSpeed;
      const vx = ball.velocity.x + (p.movement.position.x - ball.position.x) / Math.max(0.01, d) * accel * dt;
      const vz = ball.velocity.z + (p.movement.position.z - ball.position.z) / Math.max(0.01, d) * accel * dt;
      const scale = Math.min(1, cap / Math.max(0.01, Math.hypot(vx, vz)));
      ball.velocity = { x: vx * scale, y: ball.velocity.y, z: vz * scale }; ball.phase = 'dead';
      // Preserve stationary eligibility during the gentle journey from beyond 10m.
      if (!nearby) this.distantPulls.set(ball.id, p.id); else this.distantPulls.delete(ball.id);
    }
  }
  /**
   * Pickup (E) while wearing magnet armor: move the next armor ball into a free hand instead of
   * hunting the floor. Returns the hand it landed in, or null if there's no armor or no free hand.
   */
  takeArmorBall(room: RoomState, p: PlayerState): { hand: HandSide; ballId: string } | null {
    const hand = (['left', 'right'] as const).find(h => !p.hands[h].heldBallId);
    if (!hand) return null;
    while (p.armorBallIds?.length) {
      const id = p.armorBallIds[0];
      const ball = room.balls[id];
      if (!ball || ball.phase !== 'armor') { p.armorBallIds.shift(); continue; }
      p.armorBallIds.shift();
      room.balls[id] = { ...holdBall(ball, p.id, hand), armorPlayerId: undefined };
      p.hands[hand] = createHandState(hand, { heldBallId: id, mode: 'holding' });
      return { hand, ballId: id };
    }
    return null;
  }
  absorb(room: RoomState, p: PlayerState): boolean {
    const id = p.armorBallIds?.shift(); if (!id) return false;
    const ball = room.balls[id];
    // The spent armor ball remains physical but cannot immediately reattach on this tick.
    if (ball) room.balls[id] = { ...markBallDead(ball, { x: 5, y: 4, z: 0 }), position: { ...p.movement.position, x: p.movement.position.x + 1, y: p.movement.position.y + 1 }, armorPlayerId: undefined };
    this.emit(room, 'armor', p.movement.position, { playerId: p.id }); return true;
  }
  private dropArmor(room: RoomState, p: PlayerState): void {
    for (const id of p.armorBallIds ?? []) {
      const ball = room.balls[id]; if (!ball) continue;
      room.balls[id] = { ...markBallDead(ball), position: { ...p.movement.position, y: p.movement.position.y + C.ball.radius }, armorPlayerId: undefined };
    }
    p.armorBallIds = [];
  }
  cannonCanHit(ball: BallState, playerId: string): boolean {
    const key = `${ball.id}:${ball.throwId}`;
    const hits = this.cannonHits.get(key) ?? new Set<string>();
    if (hits.has(playerId)) return false;
    hits.add(playerId); this.cannonHits.set(key, hits); return true;
  }
  contact(room: RoomState, ball: BallState, nowMs: number): void {
    if (ball.kind === 'bomb' && ball.armedAtMs === undefined) {
      ball.armedAtMs = nowMs; ball.fuseSeconds = C.powerup.bombFuseSeconds;
      this.emit(room, 'beep', ball.position, { stage: 0 });
    }
    if (ball.kind === 'cannon') this.emit(room, 'thud', ball.position);
  }
  thrown(room: RoomState, ball: BallState, playerId: string): void {
    if (ball.kind === 'bomb' && ball.armedAtMs === undefined) ball.bombThrowerId = playerId;
    if (ball.kind === 'cannon') this.emit(room, 'cannon', ball.position, { playerId });
    const p = room.players[playerId];
    // Grenades come in a bundle: the next one lands in the hand that just threw until it is spent.
    if (p && isGrenadeKind(ball.kind) && (p.pendingGrenades ?? 0) > 0) {
      const hand = (['left', 'right'] as const).find(h => !p.hands[h].heldBallId);
      if (hand) {
        const id = `powerball_${++this.serial}`;
        room.balls[id] = holdBall(createBallState(id, p.movement.position, { kind: ball.kind }), playerId, hand);
        p.hands[hand] = createHandState(hand, { heldBallId: id, mode: 'holding' });
        p.pendingGrenades = (p.pendingGrenades ?? 1) - 1;
      }
    }
    this.syncLock(room, p);
  }

  /**
   * A grenade touched something: freeze it there and start the fuse. `target` is the player it
   * landed on (it rides them until it pops), or null for floor/wall/mat/bleacher/ceiling.
   */
  stick(room: RoomState, ball: BallState, nowMs: number, target: PlayerState | null): BallState {
    const stuck: BallState = {
      ...ball,
      phase: 'stuck',
      velocity: { x: 0, y: 0, z: 0 },
      stuckAtMs: nowMs,
      fuseSeconds: C.powerup.grenadeFuseSeconds,
      ...(target ? { stuckToPlayerId: target.id, position: { ...target.movement.position, y: target.movement.position.y + C.player.height * 0.55 } } : {})
    };
    this.emit(room, 'stick', stuck.position, { kind: ball.kind as PowerupKind, playerId: target?.id });
    return stuck;
  }

  /** The other half of the grenade step, driven by the loop because mats live there. */
  private detonate(room: RoomState, ball: BallState, knockMatsNear: (position: Vec3, radius: number) => void): void {
    const pos = ball.position;
    const dist = (p: PlayerState) => Math.hypot(p.movement.position.x - pos.x, p.movement.position.y + C.player.height / 2 - pos.y, p.movement.position.z - pos.z);
    if (ball.kind === 'shock') {
      const radius = C.powerup.shockRadius;
      for (const p of Object.values(room.players)) {
        if (!alive(p)) continue;
        const launched = shockwavePlayerVelocity(p.movement.position, p.movement.velocity, pos, p.movement.facing);
        if (!launched) continue;
        p.movement = {
          ...p.movement,
          velocity: launched,
          grounded: false, sliding: false, wallRunning: false
        };
        // Interrupt whatever they were winding up.
        p.movementInternal = { ...p.movementInternal, backflipActive: false, backflipTimer: 0, wallRunTimer: 0 };
        for (const h of ['left', 'right'] as const) {
          if (p.hands[h].mode === 'charging') p.hands[h] = { ...p.hands[h], mode: 'holding', chargeSeconds: 0 };
        }
      }
      for (const other of Object.values(room.balls)) {
        if (other.id === ball.id || (other.kind ?? 'normal') !== 'normal') continue;
        if (other.phase !== 'loose' && other.phase !== 'dead') continue;
        const launched = shockwaveBallVelocity(other.position, pos, other.velocity);
        if (!launched) continue;
        room.balls[other.id] = { ...markBallDead(other, launched), position: { ...other.position, y: other.position.y + 0.05 } };
      }
      knockMatsNear(pos, radius);
      this.emit(room, 'shock', pos);
    } else if (ball.kind === 'stun') {
      for (const p of Object.values(room.players)) {
        if (!alive(p) || dist(p) > C.powerup.stunRadius) continue;
        const buffs = p.movementInternal.buffs ??= { speedSeconds: 0, adrenalineSeconds: 0, magnetSeconds: 0, cannonLocked: false };
        buffs.stunSeconds = Math.max(buffs.stunSeconds ?? 0, C.powerup.stunSeconds);
      }
      this.emit(room, 'stun', pos);
    }
  }

  afterBalls(room: RoomState, dt: number, damage: (ball: BallState, p: PlayerState) => void, knockMatsNear: (position: Vec3, radius: number) => void = () => {}): void {
    for (const ball of Object.values(room.balls)) {
      if (isGrenadeKind(ball.kind)) {
        if (ball.phase !== 'stuck') continue;
        // Ride the player it landed on; if they're gone, pop where they were.
        const rider = ball.stuckToPlayerId ? room.players[ball.stuckToPlayerId] : undefined;
        if (rider) ball.position = { ...rider.movement.position, y: rider.movement.position.y + C.player.height * 0.55 };
        ball.fuseSeconds = (ball.fuseSeconds ?? C.powerup.grenadeFuseSeconds) - dt;
        if (ball.fuseSeconds > 1e-7) continue;
        this.detonate(room, ball, knockMatsNear);
        delete room.balls[ball.id];
        continue;
      }
      if (ball.kind === 'cannon' && ball.phase !== 'held' && (ball.bounceCount > 0 || ball.phase === 'dead' || ball.phase === 'loose')) {
        delete room.balls[ball.id]; this.cannonHits.delete(`${ball.id}:${ball.throwId}`); continue;
      }
      if (ball.kind === 'heal' && ball.phase !== 'held') { delete room.balls[ball.id]; continue; }
      if (ball.kind !== 'bomb' || ball.fuseSeconds === undefined) continue;
      const before = ball.fuseSeconds; ball.fuseSeconds -= dt;
      for (const stage of [1, 2]) {
        const threshold = C.powerup.bombFuseSeconds * (1 - stage / 3);
        if (before > threshold && ball.fuseSeconds <= threshold) this.emit(room, 'beep', ball.position, { stage });
      }
      if (ball.fuseSeconds > 1e-7) continue;
      // Snapshot victims before damage: friendly fire and simultaneous eliminations are intentional.
      const victims = Object.values(room.players).filter(p => alive(p) && Math.hypot(p.movement.position.x - ball.position.x, p.movement.position.y + C.player.height / 2 - ball.position.y, p.movement.position.z - ball.position.z) <= C.powerup.blastRadius);
      for (const p of victims) damage(ball, p);
      for (const p of Object.values(room.players)) for (const h of ['left', 'right'] as const) if (p.hands[h].heldBallId === ball.id) p.hands[h] = createHandState(h);
      this.emit(room, 'explode', ball.position); delete room.balls[ball.id];
    }
  }
}
