"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MapEffectSystem = void 0;
const constants_1 = require("../../../shared/constants");
const BallSim_1 = require("../../../shared/simulation/BallSim");
const HandSim_1 = require("../../../shared/simulation/HandSim");
const MapGeometry_1 = require("../../../shared/simulation/MapGeometry");
const MapEffectSim_1 = require("../../../shared/simulation/MapEffectSim");
const KINDS = ['moon', 'lava', 'frenzy'];
const alive = (p) => p.connected && p.combatState === 'alive' && p.lives > 0;
/**
 * Whole-court bonus events. Rolled from the power-up spawn clock (see PowerupSystem.beforeBalls);
 * when a roll wins, the normal item still spawns while an effect capsule and warning banner count
 * down, then the effect runs for everyone. State lives in room.mapEffect (world lane) so clients
 * render from it; the timers here measure simulated seconds like the rest of the loop.
 */
class MapEffectSystem {
    rng;
    events = [];
    lavaSeconds = new Map();
    lavaDamageDue = new Map();
    frenzyBallIds = [];
    serial = 0;
    constructor(rng = Math.random) {
        this.rng = rng;
    }
    emit(room, effect, position, mapKind) {
        this.events.push({ type: 'powerup-event', effect, position: { ...position }, mapKind, resetSerial: room.resetVote.resetSerial });
    }
    drain() {
        const out = this.events;
        this.events = [];
        return out;
    }
    reset(room) {
        room.mapEffect = null;
        this.events = [];
        this.lavaSeconds.clear();
        this.lavaDamageDue.clear();
        this.frenzyBallIds = [];
    }
    /**
     * Called when a power-up spawn clock completes. Returns true when the cycle also starts a map
     * effect; the caller still places the normal item.
     */
    tryStart(room, spawnIndex, spawnPosition) {
        if (room.mapEffect)
            return false;
        if (this.rng() >= constants_1.GAME_CONSTANTS.mapEffect.chance)
            return false;
        // The lobby is for messing around, not dying: lava never rolls before the match starts.
        const pool = room.match.status === 'warmup' ? KINDS.filter((k) => k !== 'lava') : KINDS;
        const kind = pool[Math.min(pool.length - 1, Math.floor(this.rng() * pool.length))];
        room.mapEffect = { kind, phase: 'warning', remainingSeconds: constants_1.GAME_CONSTANTS.mapEffect.warningSeconds, spawnIndex, lavaLevel: 0 };
        this.emit(room, 'map-warning', spawnPosition, kind);
        return true;
    }
    /** Runs only during live play, before the ball step. */
    step(room, dt, env, ballCount) {
        const effect = room.mapEffect;
        if (!effect)
            return;
        effect.remainingSeconds -= dt;
        const center = { x: 0, y: 1, z: 0 };
        if (effect.phase === 'warning' && effect.remainingSeconds <= 1e-7) {
            effect.phase = 'active';
            effect.remainingSeconds = this.activeSeconds(effect.kind);
            if (effect.kind === 'frenzy')
                this.spawnFrenzyBalls(room, ballCount);
            this.emit(room, 'map-start', center, effect.kind);
        }
        else if (effect.phase === 'active' && effect.remainingSeconds <= 1e-7) {
            if (effect.kind === 'lava') {
                effect.phase = 'ending';
                effect.remainingSeconds = constants_1.GAME_CONSTANTS.mapEffect.lavaRecedeSeconds;
            }
            else {
                this.finish(room, env);
                return;
            }
        }
        else if (effect.phase === 'ending' && effect.remainingSeconds <= 1e-7) {
            this.finish(room, env);
            return;
        }
        if (effect.kind === 'lava') {
            effect.lavaLevel = (0, MapEffectSim_1.lavaLevelFor)(effect);
            this.stepLava(room, dt, env, effect.lavaLevel);
        }
    }
    activeSeconds(kind) {
        if (kind === 'moon')
            return constants_1.GAME_CONSTANTS.mapEffect.moonSeconds;
        if (kind === 'lava')
            return constants_1.GAME_CONSTANTS.mapEffect.lavaRiseSeconds + constants_1.GAME_CONSTANTS.mapEffect.lavaHoldSeconds;
        return constants_1.GAME_CONSTANTS.mapEffect.frenzySeconds;
    }
    finish(room, env) {
        const effect = room.mapEffect;
        if (!effect)
            return;
        if (effect.kind === 'frenzy')
            this.removeFrenzyBalls(room, env);
        this.lavaSeconds.clear();
        this.lavaDamageDue.clear();
        this.emit(room, 'map-end', { x: 0, y: 1, z: 0 }, effect.kind);
        room.mapEffect = null;
    }
    // --- lava -------------------------------------------------------------------------------------
    stepLava(room, dt, env, lavaLevel) {
        const m = constants_1.GAME_CONSTANTS.mapEffect;
        for (const p of Object.values(room.players)) {
            if (!alive(p)) {
                this.lavaSeconds.delete(p.id);
                this.lavaDamageDue.delete(p.id);
                continue;
            }
            const inLava = lavaLevel > 0.05 && p.movement.position.y < lavaLevel - 0.05;
            // Time in lava accrues; time out of it only bleeds off at half speed, so hopping in place
            // doesn't reset the clock — you have to actually get up and stay up.
            const before = this.lavaSeconds.get(p.id) ?? 0;
            const after = inLava ? before + dt : Math.max(0, before - dt * 0.5);
            this.lavaSeconds.set(p.id, after);
            if (!inLava)
                continue;
            const due = this.lavaDamageDue.get(p.id) ?? m.lavaFirstDamageSeconds;
            if (after + 1e-7 >= due) {
                env.damage(p);
                this.lavaDamageDue.set(p.id, due + m.lavaDamageIntervalSeconds);
            }
        }
        // Loose balls float on the surface and drift out toward the bleacher fronts.
        if (lavaLevel <= 0.05)
            return;
        const floatY = lavaLevel + constants_1.GAME_CONSTANTS.ball.radius;
        const tierRun = MapGeometry_1.BLEACHER_LAYOUT.tierRun;
        const innerEdge = constants_1.GAME_CONSTANTS.map.halfWidth - MapGeometry_1.BLEACHER_LAYOUT.wallInset - MapGeometry_1.BLEACHER_LAYOUT.tierCount * tierRun;
        // Drift stops just short of the tier the surface is level with, so the ball parks against it.
        const driestTier = Math.min(MapGeometry_1.BLEACHER_LAYOUT.tierCount - 1, Math.floor(lavaLevel / MapGeometry_1.BLEACHER_LAYOUT.tierRise));
        const parkX = innerEdge + driestTier * tierRun - constants_1.GAME_CONSTANTS.ball.radius - 0.05;
        for (const ball of Object.values(room.balls)) {
            if ((ball.kind ?? 'normal') !== 'normal')
                continue;
            if (ball.phase !== 'loose' && ball.phase !== 'dead')
                continue;
            if (ball.position.y > floatY + 0.02)
                continue;
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
    spawnFrenzyBalls(room, ballCount) {
        const m = constants_1.GAME_CONSTANTS.mapEffect;
        const extra = Math.max(0, Math.round(ballCount * (m.frenzyBallMultiplier - 1)));
        for (let i = 0; i < extra; i += 1) {
            const id = `frenzy_${++this.serial}`;
            const x = (this.rng() * 2 - 1) * constants_1.GAME_CONSTANTS.map.halfWidth * 0.6;
            const z = (this.rng() * 2 - 1) * constants_1.GAME_CONSTANTS.map.halfLength * 0.6;
            room.balls[id] = (0, BallSim_1.markBallDead)((0, BallSim_1.createBallState)(id, { x, y: m.frenzyDropHeight, z }), { x: 0, y: 0, z: 0 });
            this.frenzyBallIds.push(id);
        }
    }
    removeFrenzyBalls(room, env) {
        const ids = new Set(this.frenzyBallIds);
        for (const p of Object.values(room.players)) {
            for (const hand of ['left', 'right']) {
                if (ids.has(p.hands[hand].heldBallId ?? ''))
                    p.hands[hand] = (0, HandSim_1.createHandState)(hand);
            }
            if (p.armorBallIds?.length)
                p.armorBallIds = p.armorBallIds.filter((id) => !ids.has(id));
        }
        for (const id of ids) {
            delete room.balls[id];
            env.forgetBall(id);
        }
        this.frenzyBallIds = [];
    }
    /** For tests: ids of the extra balls currently on the court. */
    get frenzyBalls() { return this.frenzyBallIds; }
}
exports.MapEffectSystem = MapEffectSystem;
