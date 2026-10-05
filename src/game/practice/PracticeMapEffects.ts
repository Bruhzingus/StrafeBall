import { GAME_CONSTANTS as C } from '../../../shared/constants';
import { lavaLevelFor, mapEffectWarningSeconds } from '../../../shared/simulation/MapEffectSim';
import type { PowerupEvent } from '../../../shared/protocol';
import type { MapEffectKind, MapEffectState, Vec3 } from '../../../shared/types';

const KINDS: MapEffectKind[] = ['moon', 'lava', 'frenzy'];
const CENTER: Vec3 = { x: 0, y: 1, z: 0 };

/** Local version of the server's spawn-clock map-effect roll and phase timers. */
export class PracticeMapEffects {
  state: MapEffectState | null = null;
  private events: PowerupEvent[] = [];

  constructor(private readonly rng: () => number = Math.random) {}

  tryStart(spawnIndex: number, position: Vec3, resetSerial: number): void {
    if (this.state || this.rng() >= C.mapEffect.chance) return;
    const kind = KINDS[Math.min(KINDS.length - 1, Math.max(0, Math.floor(this.rng() * KINDS.length)))];
    this.state = { kind, phase: 'warning', remainingSeconds: mapEffectWarningSeconds(kind), spawnIndex, lavaLevel: 0 };
    this.emit('map-warning', position, kind, resetSerial);
  }

  update(dt: number, resetSerial: number): void {
    const effect = this.state;
    if (!effect) return;
    effect.remainingSeconds -= Math.max(0, dt);
    if (effect.phase === 'warning' && effect.remainingSeconds <= 1e-7) {
      effect.phase = 'active';
      effect.remainingSeconds = effect.kind === 'moon' ? C.mapEffect.moonSeconds
        : effect.kind === 'lava' ? C.mapEffect.lavaRiseSeconds + C.mapEffect.lavaHoldSeconds
          : C.mapEffect.frenzySeconds;
      this.emit('map-start', CENTER, effect.kind, resetSerial);
    } else if (effect.phase === 'active' && effect.remainingSeconds <= 1e-7) {
      if (effect.kind === 'lava') {
        effect.phase = 'ending';
        effect.remainingSeconds = C.mapEffect.lavaRecedeSeconds;
      } else {
        this.emit('map-end', CENTER, effect.kind, resetSerial);
        this.state = null;
        return;
      }
    } else if (effect.phase === 'ending' && effect.remainingSeconds <= 1e-7) {
      this.emit('map-end', CENTER, effect.kind, resetSerial);
      this.state = null;
      return;
    }
    if (effect.kind === 'lava') effect.lavaLevel = lavaLevelFor(effect);
  }

  drainEvents(): PowerupEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  reset(): void {
    this.state = null;
    this.events = [];
  }

  private emit(effect: PowerupEvent['effect'], position: Vec3, mapKind: MapEffectKind, resetSerial: number): void {
    this.events.push({ type: 'powerup-event', effect, position: { ...position }, mapKind, resetSerial });
  }
}
