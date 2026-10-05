"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LavaExposure = void 0;
exports.mapEffectWarningSeconds = mapEffectWarningSeconds;
exports.isInLava = isInLava;
exports.mapEffectForPresentation = mapEffectForPresentation;
exports.mapEffectGravityScale = mapEffectGravityScale;
exports.lavaMaxHeight = lavaMaxHeight;
exports.lavaLevelFor = lavaLevelFor;
exports.mapEffectUnlimitedBounces = mapEffectUnlimitedBounces;
exports.ballConstantsForEffect = ballConstantsForEffect;
const constants_1 = require("../constants");
const MapGeometry_1 = require("./MapGeometry");
/**
 * Pure helpers for whole-court map effects, shared by the server (authoritative timers) and the
 * client (prediction + visuals) so both derive gravity, lava height, etc. from the same replicated
 * MapEffectState.
 */
function mapEffectWarningSeconds(kind) {
    return constants_1.GAME_CONSTANTS.mapEffect.warningSeconds
        + (kind === 'lava' ? constants_1.GAME_CONSTANTS.mapEffect.lavaWarningExtraSeconds : 0);
}
/** Movement positions are at the feet. Match the finite court sheet, with a contact tolerance. */
function isInLava(position, level) {
    return level > 0.05 && position.y < level - 0.05
        && Math.abs(position.x) <= constants_1.GAME_CONSTANTS.map.halfWidth
        && Math.abs(position.z) <= constants_1.GAME_CONSTANTS.map.halfLength;
}
/** Each entry gets a fresh grace period; safe ground never retains pending damage. */
class LavaExposure {
    untilDamage = constants_1.GAME_CONSTANTS.mapEffect.lavaFirstDamageSeconds;
    reset() { this.untilDamage = constants_1.GAME_CONSTANTS.mapEffect.lavaFirstDamageSeconds; }
    step(inLava, dt) {
        if (!inLava) {
            this.reset();
            return false;
        }
        this.untilDamage -= Math.max(0, dt);
        if (this.untilDamage > 1e-7)
            return false;
        // At most one hit per simulation step, with a full interval after it (no catch-up hits).
        this.untilDamage = constants_1.GAME_CONSTANTS.mapEffect.lavaDamageIntervalSeconds;
        return true;
    }
}
exports.LavaExposure = LavaExposure;
/** Extrapolate only the confirmed phase, bounded so a stalled connection cannot run the effect away. */
function mapEffectForPresentation(effect, ageSeconds) {
    if (!effect)
        return null;
    const view = { ...effect, remainingSeconds: Math.max(0, effect.remainingSeconds - Math.max(0, Math.min(0.5, ageSeconds))) };
    view.lavaLevel = lavaLevelFor(view);
    return view;
}
/** World gravity multiplier for players. 1 unless moon gravity is running. */
function mapEffectGravityScale(effect) {
    return effect?.kind === 'moon' && effect.phase === 'active' ? constants_1.GAME_CONSTANTS.mapEffect.moonGravityScale : 1;
}
/** Highest the lava ever gets: a fraction of the bleacher stand, so only the top tier stays dry. */
function lavaMaxHeight() {
    return MapGeometry_1.BLEACHER_LAYOUT.tierCount * MapGeometry_1.BLEACHER_LAYOUT.tierRise * constants_1.GAME_CONSTANTS.mapEffect.lavaMaxHeightFraction;
}
/**
 * Lava surface height for the current effect state: ramps up over the rise, holds at the max,
 * ramps back down over the recede. 0 when lava isn't running.
 */
function lavaLevelFor(effect) {
    if (!effect || effect.kind !== 'lava')
        return 0;
    const m = constants_1.GAME_CONSTANTS.mapEffect;
    const max = lavaMaxHeight();
    if (effect.phase === 'warning')
        return 0;
    if (effect.phase === 'active') {
        const elapsed = m.lavaRiseSeconds + m.lavaHoldSeconds - effect.remainingSeconds;
        return max * Math.max(0, Math.min(1, elapsed / m.lavaRiseSeconds));
    }
    return max * Math.max(0, Math.min(1, effect.remainingSeconds / m.lavaRecedeSeconds));
}
/** True while a live ball should never die on a bounce (frenzy). */
function mapEffectUnlimitedBounces(effect) {
    return effect?.kind === 'frenzy' && effect.phase === 'active';
}
const ballConstantsByScale = new Map();
/** GAME_CONSTANTS with ball gravity scaled for the running map effect (cached per scale). */
function ballConstantsForEffect(effect) {
    const scale = mapEffectGravityScale(effect);
    if (scale === 1)
        return constants_1.GAME_CONSTANTS;
    let cached = ballConstantsByScale.get(scale);
    if (!cached) {
        cached = { ...constants_1.GAME_CONSTANTS, ball: { ...constants_1.GAME_CONSTANTS.ball, gravity: constants_1.GAME_CONSTANTS.ball.gravity * scale } };
        ballConstantsByScale.set(scale, cached);
    }
    return cached;
}
