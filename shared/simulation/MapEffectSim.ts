import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { MapEffectState } from '../types';
import { BLEACHER_LAYOUT } from './MapGeometry';

/**
 * Pure helpers for whole-court map effects, shared by the server (authoritative timers) and the
 * client (prediction + visuals) so both derive gravity, lava height, etc. from the same replicated
 * MapEffectState.
 */

/** World gravity multiplier for players. 1 unless moon gravity is running. */
export function mapEffectGravityScale(effect: MapEffectState | null | undefined): number {
  return effect?.kind === 'moon' && effect.phase === 'active' ? GAME_CONSTANTS.mapEffect.moonGravityScale : 1;
}

/** Highest the lava ever gets: a fraction of the bleacher stand, so only the top tier stays dry. */
export function lavaMaxHeight(): number {
  return BLEACHER_LAYOUT.tierCount * BLEACHER_LAYOUT.tierRise * GAME_CONSTANTS.mapEffect.lavaMaxHeightFraction;
}

/**
 * Lava surface height for the current effect state: ramps up over the rise, holds at the max,
 * ramps back down over the recede. 0 when lava isn't running.
 */
export function lavaLevelFor(effect: MapEffectState | null | undefined): number {
  if (!effect || effect.kind !== 'lava') return 0;
  const m = GAME_CONSTANTS.mapEffect;
  const max = lavaMaxHeight();
  if (effect.phase === 'warning') return 0;
  if (effect.phase === 'active') {
    const elapsed = m.lavaRiseSeconds + m.lavaHoldSeconds - effect.remainingSeconds;
    return max * Math.max(0, Math.min(1, elapsed / m.lavaRiseSeconds));
  }
  return max * Math.max(0, Math.min(1, effect.remainingSeconds / m.lavaRecedeSeconds));
}

/** True while a live ball should never die on a bounce (frenzy). */
export function mapEffectUnlimitedBounces(effect: MapEffectState | null | undefined): boolean {
  return effect?.kind === 'frenzy' && effect.phase === 'active';
}

const ballConstantsByScale = new Map<number, GameConstants>();

/** GAME_CONSTANTS with ball gravity scaled for the running map effect (cached per scale). */
export function ballConstantsForEffect(effect: MapEffectState | null | undefined): GameConstants {
  const scale = mapEffectGravityScale(effect);
  if (scale === 1) return GAME_CONSTANTS;
  let cached = ballConstantsByScale.get(scale);
  if (!cached) {
    cached = { ...GAME_CONSTANTS, ball: { ...GAME_CONSTANTS.ball, gravity: GAME_CONSTANTS.ball.gravity * scale } } as unknown as GameConstants;
    ballConstantsByScale.set(scale, cached);
  }
  return cached;
}
