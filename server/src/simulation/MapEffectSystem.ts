import { GAME_CONSTANTS as C } from '../../../shared/constants';
import type { MapEffectKind, PlayerState, RoomState, Vec3 } from '../../../shared/types';
import type { PowerupEvent } from '../../../shared/protocol';
import { createBallState, markBallDead } from '../../../shared/simulation/BallSim';
import { createHandState } from '../../../shared/simulation/HandSim';
import { BLEACHER_LAYOUT } from '../../../shared/simulation/MapGeometry';
import { isInLava, LavaExposure, lavaLevelFor, mapEffectWarningSeconds } from '../../../shared/simulation/MapEffectSim';

const KINDS: MapEffectKind[] = ['moon', 'lava', 'frenzy'];
const alive = (p: PlayerState) => p.connected && p.combatState === 'alive' && p.lives > 0;

/** What the map-effect step needs from the game loop but can't do on room state alone. */
export interface MapEffectEnv {
  /** Cost this player a life with no scorer (environment damage: lava). */
  damage: (player: PlayerState) => void;
  /** Drop any per-ball server bookkeeping (history rings etc.) for a ball that was deleted. */
  forgetBall: (ballId: string) => void;
}

/**
 * Whole-court bonus events. Rolled from the power-up spawn clock (see PowerupSystem.beforeBalls);
 * when a roll wins, the normal item still spawns while an effect capsule and warning banner count
 * down, then the effect runs for everyone. State lives in room.mapEffect (world lane) so clients
 * render from it; the timers here measure simulated seconds like the rest of the loop.
 */
export class MapEffectSystem {
  private events: PowerupEvent[] = [];
  private lavaExposure = new Map<string, LavaExposure>();
  private frenzyBallIds: string[] = [];
  private frenzyTargetBalls = 0;
  private serial = 0;

  constructor(private readonly rng: () => number = Math.random) {}

  private emit(room: RoomState, effect: PowerupEvent['effect'], position: Vec3, mapKind: MapEffectKind): void {
    this.events.push({ type: 'powerup-event', effect, position: { ...position }, mapKind, resetSerial: room.resetVote.resetSerial });
  }

  drain(): PowerupEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  reset(room: RoomState): void {
    room.mapEffect = null;
    this.events = [];
    this.lavaExposure.clear();
    this.frenzyBallIds = [];
    this.frenzyTargetBalls = 0;
  }

  /**
   * Called when a power-up spawn clock completes. Returns true when the cycle also starts a map
   * effect; the caller still places the normal item.
   */
  tryStart(room: RoomState, spawnIndex: number, spawnPosition: Vec3): boolean {
    if (room.mapEffect) return false;
    if (this.rng() >= C.mapEffect.chance) return false;
    const kind = KINDS[Math.min(KINDS.length - 1, Math.floor(this.rng() * KINDS.length))];
    room.mapEffect = { kind, phase: 'warning', remainingSeconds: mapEffectWarningSeconds(kind), spawnIndex, lavaLevel: 0 };
    this.emit(room, 'map-warning', spawnPosition, kind);
    return true;
  }

  /** Runs only during live play, before the ball step. */
  step(room: RoomState, dt: number, env: MapEffectEnv, ballCount: number): void {
    const effect = room.mapEffect;
    if (!effect) return;
    effect.remainingSeconds -= dt;
    const center = { x: 0, y: 1, z: 0 };

    if (effect.phase === 'warning' && effect.remainingSeconds <= 1e-7) {
      effect.phase = 'active';
      effect.remainingSeconds = this.activeSeconds(effect.kind);
      if (effect.kind === 'frenzy') this.beginFrenzy(room, ballCount);
      this.emit(room, 'map-start', center, effect.kind);
    } else if (effect.phase === 'active') {
      if (effect.kind === 'frenzy') this.advanceFrenzy(room, effect.remainingSeconds);
      if (effect.remainingSeconds <= 1e-7) {
        if (effect.kind === 'lava') {
          effect.phase = 'ending';
          effect.remainingSeconds = C.mapEffect.lavaRecedeSeconds;
        } else {
          this.finish(room, env);
          return;
        }
      }
    } else if (effect.phase === 'ending' && effect.remainingSeconds <= 1e-7) {
      this.finish(room, env);
      return;
    }

    if (effect.kind === 'lava') {
      effect.lavaLevel = lavaLevelFor(effect);
      this.stepLava(room, dt, env, effect.lavaLevel);
    }
  }

  private activeSeconds(kind: MapEffectKind): number {
    if (kind === 'moon') return C.mapEffect.moonSeconds;
    if (kind === 'lava') return C.mapEffect.lavaRiseSeconds + C.mapEffect.lavaHoldSeconds;
    return C.mapEffect.frenzySeconds;
  }

  private finish(room: RoomState, env: MapEffectEnv): void {
    const effect = room.mapEffect;
    if (!effect) return;
    if (effect.kind === 'frenzy') this.removeFrenzyBalls(room, env);
    this.lavaExposure.clear();
    this.emit(room, 'map-end', { x: 0, y: 1, z: 0 }, effect.kind);
    room.mapEffect = null;
  }

  // --- lava -------------------------------------------------------------------------------------

  private stepLava(room: RoomState, dt: number, env: MapEffectEnv, lavaLevel: number): void {
    const m = C.mapEffect;
    const effect = room.mapEffect;
    for (const p of Object.values(room.players)) {
      if (!alive(p)) { this.lavaExposure.delete(p.id); continue; }
      const exposure = this.lavaExposure.get(p.id) ?? new LavaExposure();
      this.lavaExposure.set(p.id, exposure);
      if (exposure.step(isInLava(p.movement.position, lavaLevel), dt)) {
        env.damage(p);
        // Damage callbacks can reset the world. Never continue an old hazard into a new round.
        if (room.mapEffect !== effect) return;
      }
    }

    // Loose balls float on the surface and drift out toward the bleacher fronts.
    if (lavaLevel <= 0.05) return;
    const floatY = lavaLevel + C.ball.radius;
    const tierRun = BLEACHER_LAYOUT.tierRun;
    const innerEdge = C.map.halfWidth - BLEACHER_LAYOUT.wallInset - BLEACHER_LAYOUT.tierCount * tierRun;
    // Drift stops just short of the tier the surface is level with, so the ball parks against it.
    const driestTier = Math.min(BLEACHER_LAYOUT.tierCount - 1, Math.floor(lavaLevel / BLEACHER_LAYOUT.tierRise));
    const parkX = innerEdge + driestTier * tierRun - C.ball.radius - 0.05;
    for (const ball of Object.values(room.balls)) {
      if ((ball.kind ?? 'normal') !== 'normal') continue;
      if (ball.phase !== 'loose' && ball.phase !== 'dead') continue;
      if (ball.position.y > floatY + 0.02) continue;
      const side = ball.position.x >= 0 ? 1 : -1;
      const parked = Math.abs(ball.position.x) >= parkX;
      const vx = parked ? 0 : side * m.lavaBallDriftSpeed;
      room.balls[ball.id] = {
        ...ball,
        phase: parked ? 'loose' : 'dead',
        position: { ...ball.position, y: floatY },
        velocity: { x: vx, y: 0, z: ball.velocity.z * 0.85 },
        bounceCount: 0
      };
    }
  }

  // --- frenzy -----------------------------------------------------------------------------------

  private beginFrenzy(room: RoomState, ballCount: number): void {
    const m = C.mapEffect;
    this.frenzyTargetBalls = Math.max(0, Math.round(ballCount * (m.frenzyBallMultiplier - 1)));
    this.spawnFrenzyBalls(room, Math.min(1, this.frenzyTargetBalls));
  }

  private advanceFrenzy(room: RoomState, remainingSeconds: number): void {
    const total = this.frenzyTargetBalls;
    if (total <= 1) return;
    const elapsed = Math.max(0, C.mapEffect.frenzySeconds - remainingSeconds);
    // First drop is immediate; the last is due exactly five seconds after activation.
    const due = Math.min(total, 1 + Math.floor((elapsed + 1e-7) * (total - 1) / C.mapEffect.frenzySpawnSeconds));
    this.spawnFrenzyBalls(room, due - this.frenzyBallIds.length);
  }

  private spawnFrenzyBalls(room: RoomState, count: number): void {
    for (let i = 0; i < count; i += 1) {
      const id = `frenzy_${++this.serial}`;
      const x = (this.rng() * 2 - 1) * C.map.halfWidth * 0.6;
      const z = (this.rng() * 2 - 1) * C.map.halfLength * 0.6;
      // Spawn in flight with a small downward velocity; surface support decides when it settles.
      room.balls[id] = markBallDead(createBallState(id, { x, y: C.mapEffect.frenzyDropHeight, z }), { x: 0, y: -1, z: 0 });
      this.frenzyBallIds.push(id);
    }
  }

  private removeFrenzyBalls(room: RoomState, env: MapEffectEnv): void {
    const ids = new Set(this.frenzyBallIds);
    for (const p of Object.values(room.players)) {
      for (const hand of ['left', 'right'] as const) {
        if (ids.has(p.hands[hand].heldBallId ?? '')) p.hands[hand] = createHandState(hand);
      }
      if (p.armorBallIds?.length) p.armorBallIds = p.armorBallIds.filter((id) => !ids.has(id));
    }
    for (const id of ids) { delete room.balls[id]; env.forgetBall(id); }
    this.frenzyBallIds = [];
    this.frenzyTargetBalls = 0;
  }

  /** For tests: ids of the extra balls currently on the court. */
  get frenzyBalls(): readonly string[] { return this.frenzyBallIds; }
}
