"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PowerupSystem = void 0;
const constants_1 = require("../../../shared/constants");
const BallSim_1 = require("../../../shared/simulation/BallSim");
const HandSim_1 = require("../../../shared/simulation/HandSim");
const MapGeometry_1 = require("../../../shared/simulation/MapGeometry");
const KINDS = ['adrenaline', 'speed', 'cannon', 'heal', 'magnet', 'bomb'];
const alive = (p) => p.connected && p.combatState === 'alive' && p.lives > 0;
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const center = { x: 0, y: 1, z: 0 };
/** Server-only inventory. No unused identity is ever placed in the public room state. */
class PowerupSystem {
    rng;
    inventory = new Map();
    serial = 0;
    events = [];
    privateMessages = [];
    cannonHits = new Map();
    distantPulls = new Map();
    constructor(rng = Math.random) {
        this.rng = rng;
    }
    emit(room, effect, position, extra = {}) {
        this.events.push({ type: 'powerup-event', effect, position: { ...position }, resetSerial: room.resetVote.resetSerial, ...extra });
    }
    notify(room, playerId, reason) {
        this.privateMessages.push({ playerId, message: { kind: this.inventory.get(playerId) ?? null, resetSerial: room.resetVote.resetSerial, reason } });
    }
    identity(room, playerId) {
        return { kind: this.inventory.get(playerId) ?? null, resetSerial: room.resetVote.resetSerial };
    }
    drain() {
        const result = { events: this.events, privateMessages: this.privateMessages };
        this.events = [];
        this.privateMessages = [];
        return result;
    }
    reset(room) {
        this.inventory.clear();
        this.cannonHits.clear();
        this.distantPulls.clear();
        this.events = [];
        this.privateMessages = [];
        room.powerups = { spawned: false, waitSeconds: constants_1.GAME_CONSTANTS.powerup.respawnSeconds, stations: [] };
        for (const p of Object.values(room.players)) {
            p.hasPowerup = false;
            p.armorBallIds = [];
            delete p.movementInternal.buffs;
            for (const hand of ['left', 'right']) {
                const ball = room.balls[p.hands[hand].heldBallId ?? ''];
                if (ball?.kind && ball.kind !== 'normal')
                    p.hands[hand] = (0, HandSim_1.createHandState)(hand);
            }
            this.notify(room, p.id);
        }
        for (const ball of Object.values(room.balls)) {
            if (ball.kind && ball.kind !== 'normal')
                delete room.balls[ball.id];
            else if (ball.phase === 'armor')
                room.balls[ball.id] = { ...(0, BallSim_1.markBallDead)(ball), armorPlayerId: undefined };
        }
    }
    activate(room, playerId) {
        const p = room.players[playerId];
        const kind = this.inventory.get(playerId);
        if (room.settings.powerupsEnabled === false || !p || !alive(p) || room.match.status !== 'playing' || !kind)
            return false;
        const hand = ['left', 'right'].find(h => !p.hands[h].heldBallId);
        if (['cannon', 'bomb', 'heal'].includes(kind) && !hand) {
            this.notify(room, playerId, 'Free a hand to use this power-up');
            return false;
        }
        const buffs = p.movementInternal.buffs ??= { speedSeconds: 0, adrenalineSeconds: 0, magnetSeconds: 0, cannonLocked: false };
        if (kind === 'adrenaline') {
            buffs.adrenalineSeconds = constants_1.GAME_CONSTANTS.powerup.buffSeconds;
            p.dash.charges = constants_1.GAME_CONSTANTS.powerup.adrenalineMaxCharges;
            p.dash.rechargeTimerSeconds = 0;
        }
        else if (kind === 'speed')
            buffs.speedSeconds = constants_1.GAME_CONSTANTS.powerup.buffSeconds;
        else if (kind === 'magnet')
            buffs.magnetSeconds = constants_1.GAME_CONSTANTS.powerup.magnetSeconds;
        else if (hand) {
            const id = `powerball_${++this.serial}`;
            room.balls[id] = (0, BallSim_1.holdBall)((0, BallSim_1.createBallState)(id, p.movement.position, { kind }), playerId, hand);
            p.hands[hand] = (0, HandSim_1.createHandState)(hand, { heldBallId: id, mode: 'holding' });
            if (kind === 'cannon')
                buffs.cannonLocked = true;
        }
        this.inventory.delete(playerId);
        p.hasPowerup = false;
        this.notify(room, playerId);
        this.emit(room, 'activate', p.movement.position, { playerId, kind });
        return true;
    }
    place(room, p, hand, boxes = (0, MapGeometry_1.createBallCollisionBoxes)()) {
        const position = { x: p.movement.position.x + Math.sin(p.movement.yawRadians) * constants_1.GAME_CONSTANTS.powerup.placementDistance,
            y: 0, z: p.movement.position.z + Math.cos(p.movement.yawRadians) * constants_1.GAME_CONSTANTS.powerup.placementDistance };
        // The whole healing footprint must be on the court floor, never in stands or through cover.
        const radius = constants_1.GAME_CONSTANTS.powerup.healRadius;
        if (Math.abs(position.x) + radius > constants_1.GAME_CONSTANTS.map.halfWidth || Math.abs(position.z) + radius > constants_1.GAME_CONSTANTS.map.halfLength ||
            p.movement.position.y > 0.1 || boxes.some(b => b.maxY > 0.1 && position.x + radius > b.minX && position.x - radius < b.maxX && position.z + radius > b.minZ && position.z - radius < b.maxZ)) {
            this.notify(room, p.id, 'Place on clear court floor');
            return false;
        }
        const world = room.powerups;
        world.stations = world.stations.filter(s => s.placerId !== p.id);
        world.stations.push({ id: `station_${++this.serial}`, placerId: p.id, teamId: p.teamId, position,
            remainingSeconds: constants_1.GAME_CONSTANTS.powerup.stationLifetimeSeconds, progress: {} });
        delete room.balls[p.hands[hand].heldBallId];
        p.hands[hand] = (0, HandSim_1.createHandState)(hand);
        this.emit(room, 'place', position, { playerId: p.id });
        return true;
    }
    /** Runs only during live play. Timers measure simulated seconds, including under server catch-up. */
    beforeBalls(room, dt, livesCap) {
        if (room.settings.powerupsEnabled === false)
            return;
        const world = room.powerups ??= { spawned: false, waitSeconds: constants_1.GAME_CONSTANTS.powerup.respawnSeconds, stations: [] };
        if (!world.spawned) {
            world.waitSeconds = Math.max(0, world.waitSeconds - dt);
            if (world.waitSeconds < 1e-7) {
                world.waitSeconds = 0;
                world.spawned = true;
                this.emit(room, 'spawn', center);
            }
        }
        for (const p of Object.values(room.players)) {
            if (!alive(p)) {
                this.inventory.delete(p.id);
                p.hasPowerup = false;
            }
            if (alive(p) && world.spawned && !this.inventory.has(p.id) && horizontal(p.movement.position, center) <= constants_1.GAME_CONSTANTS.powerup.pickupRadius) {
                this.inventory.set(p.id, KINDS[Math.min(5, Math.floor(this.rng() * KINDS.length))]);
                p.hasPowerup = true;
                world.spawned = false;
                world.waitSeconds = constants_1.GAME_CONSTANTS.powerup.respawnSeconds;
                this.notify(room, p.id);
                this.emit(room, 'pickup', center, { playerId: p.id });
            }
            this.syncLock(room, p);
            if (!alive(p) || (p.movementInternal.buffs?.magnetSeconds ?? 0) <= 0)
                this.dropArmor(room, p);
        }
        this.magnet(room, dt);
        for (const station of world.stations) {
            station.remainingSeconds -= dt;
            for (const p of Object.values(room.players)) {
                const eligible = alive(p) && p.teamId === station.teamId && p.movement.grounded && p.movement.position.y < 0.1 && horizontal(p.movement.position, station.position) <= constants_1.GAME_CONSTANTS.powerup.healRadius;
                station.progress[p.id] = eligible ? (station.progress[p.id] ?? 0) + dt : 0;
                if (station.progress[p.id] + 1e-7 >= constants_1.GAME_CONSTANTS.powerup.healSeconds && p.lives < livesCap && station.remainingSeconds > 0) {
                    p.lives = Math.min(livesCap, p.lives + 1);
                    station.remainingSeconds = 0;
                    this.emit(room, 'heal', station.position, { playerId: p.id });
                    break;
                }
            }
        }
        world.stations = world.stations.filter(s => s.remainingSeconds > 0);
    }
    syncLock(room, p) {
        if (p.movementInternal.buffs)
            p.movementInternal.buffs.cannonLocked = ['left', 'right'].some(h => room.balls[p.hands[h].heldBallId ?? '']?.kind === 'cannon');
    }
    magnet(room, dt) {
        const magnets = Object.values(room.players).filter(p => alive(p) && (p.movementInternal.buffs?.magnetSeconds ?? 0) > 0);
        for (const ball of Object.values(room.balls)) {
            if (ball.phase === 'armor') {
                const p = room.players[ball.armorPlayerId ?? ''];
                if (p)
                    ball.position = { ...p.movement.position, y: p.movement.position.y + 0.9 };
                else {
                    room.balls[ball.id] = { ...(0, BallSim_1.markBallDead)(ball), armorPlayerId: undefined };
                }
                continue;
            }
            if ((ball.phase !== 'loose' && ball.phase !== 'dead') || (ball.kind && ball.kind !== 'normal')) {
                this.distantPulls.delete(ball.id);
                continue;
            }
            ball.settledSeconds = Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z) < 0.1 ? (ball.settledSeconds ?? 0) + dt : 0;
            const candidates = magnets.filter(p => (p.armorBallIds?.length ?? 0) < constants_1.GAME_CONSTANTS.powerup.armorCap || !p.hands.left.heldBallId || !p.hands.right.heldBallId)
                .sort((a, b) => horizontal(a.movement.position, ball.position) - horizontal(b.movement.position, ball.position));
            const p = candidates.find(p => horizontal(p.movement.position, ball.position) <= constants_1.GAME_CONSTANTS.powerup.magnetRadius || (ball.settledSeconds ?? 0) > constants_1.GAME_CONSTANTS.powerup.stationarySeconds || this.distantPulls.get(ball.id) === p.id);
            if (!p) {
                this.distantPulls.delete(ball.id);
                continue;
            }
            const d = horizontal(p.movement.position, ball.position);
            if (d < 0.85 && Math.abs(p.movement.position.y - ball.position.y) < constants_1.GAME_CONSTANTS.ball.pickupVerticalTolerance) {
                const pickup = (0, HandSim_1.tryPickupBall)(p, p.hands, ball);
                if (pickup.ok) {
                    p.hands = pickup.hands;
                    room.balls[ball.id] = pickup.ball;
                }
                else if ((p.armorBallIds?.length ?? 0) < constants_1.GAME_CONSTANTS.powerup.armorCap) {
                    (p.armorBallIds ??= []).push(ball.id);
                    ball.phase = 'armor';
                    ball.armorPlayerId = p.id;
                    ball.velocity = { x: 0, y: 0, z: 0 };
                    this.emit(room, 'armor', p.movement.position, { playerId: p.id });
                }
                continue;
            }
            const nearby = d <= constants_1.GAME_CONSTANTS.powerup.magnetRadius;
            // Counter floor friction as part of the force, so the weak long-distance pull remains visible.
            const accel = nearby ? constants_1.GAME_CONSTANTS.powerup.magnetAcceleration : constants_1.GAME_CONSTANTS.powerup.distantMagnetAcceleration;
            const cap = nearby ? constants_1.GAME_CONSTANTS.powerup.magnetSpeed : constants_1.GAME_CONSTANTS.powerup.distantMagnetSpeed;
            const vx = ball.velocity.x + (p.movement.position.x - ball.position.x) / Math.max(0.01, d) * accel * dt;
            const vz = ball.velocity.z + (p.movement.position.z - ball.position.z) / Math.max(0.01, d) * accel * dt;
            const scale = Math.min(1, cap / Math.max(0.01, Math.hypot(vx, vz)));
            ball.velocity = { x: vx * scale, y: ball.velocity.y, z: vz * scale };
            ball.phase = 'dead';
            // Preserve stationary eligibility during the gentle journey from beyond 10m.
            if (!nearby)
                this.distantPulls.set(ball.id, p.id);
            else
                this.distantPulls.delete(ball.id);
        }
    }
    absorb(room, p) {
        const id = p.armorBallIds?.shift();
        if (!id)
            return false;
        const ball = room.balls[id];
        // The spent armor ball remains physical but cannot immediately reattach on this tick.
        if (ball)
            room.balls[id] = { ...(0, BallSim_1.markBallDead)(ball, { x: 5, y: 4, z: 0 }), position: { ...p.movement.position, x: p.movement.position.x + 1, y: p.movement.position.y + 1 }, armorPlayerId: undefined };
        this.emit(room, 'armor', p.movement.position, { playerId: p.id });
        return true;
    }
    dropArmor(room, p) {
        for (const id of p.armorBallIds ?? []) {
            const ball = room.balls[id];
            if (!ball)
                continue;
            room.balls[id] = { ...(0, BallSim_1.markBallDead)(ball), position: { ...p.movement.position, y: p.movement.position.y + constants_1.GAME_CONSTANTS.ball.radius }, armorPlayerId: undefined };
        }
        p.armorBallIds = [];
    }
    cannonCanHit(ball, playerId) {
        const key = `${ball.id}:${ball.throwId}`;
        const hits = this.cannonHits.get(key) ?? new Set();
        if (hits.has(playerId))
            return false;
        hits.add(playerId);
        this.cannonHits.set(key, hits);
        return true;
    }
    contact(room, ball, nowMs) {
        if (ball.kind === 'bomb' && ball.armedAtMs === undefined) {
            ball.armedAtMs = nowMs;
            ball.fuseSeconds = constants_1.GAME_CONSTANTS.powerup.bombFuseSeconds;
            this.emit(room, 'beep', ball.position, { stage: 0 });
        }
        if (ball.kind === 'cannon')
            this.emit(room, 'thud', ball.position);
    }
    thrown(room, ball, playerId) {
        if (ball.kind === 'bomb' && ball.armedAtMs === undefined)
            ball.bombThrowerId = playerId;
        if (ball.kind === 'cannon')
            this.emit(room, 'cannon', ball.position, { playerId });
        this.syncLock(room, room.players[playerId]);
    }
    afterBalls(room, dt, damage) {
        for (const ball of Object.values(room.balls)) {
            if (ball.kind === 'cannon' && ball.phase !== 'held' && (ball.bounceCount > 0 || ball.phase === 'dead' || ball.phase === 'loose')) {
                delete room.balls[ball.id];
                this.cannonHits.delete(`${ball.id}:${ball.throwId}`);
                continue;
            }
            if (ball.kind === 'heal' && ball.phase !== 'held') {
                delete room.balls[ball.id];
                continue;
            }
            if (ball.kind !== 'bomb' || ball.fuseSeconds === undefined)
                continue;
            const before = ball.fuseSeconds;
            ball.fuseSeconds -= dt;
            for (const stage of [1, 2]) {
                const threshold = constants_1.GAME_CONSTANTS.powerup.bombFuseSeconds * (1 - stage / 3);
                if (before > threshold && ball.fuseSeconds <= threshold)
                    this.emit(room, 'beep', ball.position, { stage });
            }
            if (ball.fuseSeconds > 1e-7)
                continue;
            // Snapshot victims before damage: friendly fire and simultaneous eliminations are intentional.
            const victims = Object.values(room.players).filter(p => alive(p) && Math.hypot(p.movement.position.x - ball.position.x, p.movement.position.y + constants_1.GAME_CONSTANTS.player.height / 2 - ball.position.y, p.movement.position.z - ball.position.z) <= constants_1.GAME_CONSTANTS.powerup.blastRadius);
            for (const p of victims)
                damage(ball, p);
            for (const p of Object.values(room.players))
                for (const h of ['left', 'right'])
                    if (p.hands[h].heldBallId === ball.id)
                        p.hands[h] = (0, HandSim_1.createHandState)(h);
            this.emit(room, 'explode', ball.position);
            delete room.balls[ball.id];
        }
    }
}
exports.PowerupSystem = PowerupSystem;
