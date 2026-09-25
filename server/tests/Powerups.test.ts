import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../../shared/constants';
import { PowerupSystem } from '../src/simulation/PowerupSystem';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';
import { createRoomState } from '../../shared/simulation/MatchSim';
import { createPlayerState } from '../../shared/simulation/PlayerSim';
import { createBallState, holdBall, isBallCatchableInFlight, isBallPickupEligible } from '../../shared/simulation/BallSim';
import { createHandState, autoParryBall } from '../../shared/simulation/HandSim';
import { inflateCompactSnapshot, makeCompactSnapshot, makeTieredCompactSnapshot, mergeTieredCompactSnapshot } from '../../shared/snapshotCodec';
import { stepMovement } from '../../shared/simulation/MovementSim';
import { isIllegalHalfCourtPosition } from '../../shared/simulation/RuleSim';
import { MAT_SPECS, createBleacherTierSpecs } from '../../shared/simulation/MapGeometry';
import type { PlayerInput, PowerupKind, RoomState } from '../../shared/types';

const kinds: PowerupKind[] = ['adrenaline', 'speed', 'cannon', 'heal', 'magnet', 'bomb', 'shock', 'stun'];
const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
function setup(kind: PowerupKind = 'speed') {
  const room = createRoomState({ players: [createPlayerState('a', 'blue'), createPlayerState('b', 'red', 'positiveZ')] });
  room.match.status = 'playing'; room.players.b.movement.position = v(0, 0, 10);
  const system = new PowerupSystem(() => (kinds.indexOf(kind) + 0.1) / kinds.length); system.reset(room); system.drain();
  return { room, system };
}
function take(room: RoomState, system: PowerupSystem) {
  room.powerups!.spawns[0].waitSeconds = 0; system.beforeBalls(room, 0, 3);
  system.beforeBalls(room, C.powerup.rollSeconds, 3);
}
function input(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return { moveX: 0, moveZ: 0, lookYawRadians: 0, lookPitchRadians: 0, dashDirection: v(), ...overrides } as PlayerInput;
}
function stepPlayer(room: RoomState, dt: number, overrides: Partial<PlayerInput> = {}) {
  const p = room.players.a;
  const result = stepMovement(p.movement, p.movementInternal, p.dash, input(overrides), input(), dt, [], false);
  p.movement = result.movement; p.movementInternal = result.internal; p.dash = result.dash;
  return result;
}

describe('neutral zone and expanded gym', () => {
  it('keeps both teams legal through the full strip and penalizes beyond the opposing edge', () => {
    for (const side of ['negativeZ', 'positiveZ'] as const) for (const z of [-3, -2.9, 0, 2.9, 3]) expect(isIllegalHalfCourtPosition(side, v(0, 0, z))).toBe(false);
    expect(isIllegalHalfCourtPosition('negativeZ', v(0, 0, 3.1))).toBe(true);
    expect(isIllegalHalfCourtPosition('positiveZ', v(0, 0, -3.1))).toBe(true);
    expect(MAT_SPECS[0].x).toBe(-4.5 / 13 * C.map.halfWidth);
    expect(MAT_SPECS[0].z).toBe(-5.5 / 18 * C.map.halfLength);
    expect(createBleacherTierSpecs()[0].size.depth).toBe(C.map.halfLength * 1.45);
    const loop = new ServerGameLoop('bounds'); loop.addPlayer('a', 'A');
    expect(Math.abs(loop.state.players.a.movement.position.z)).toBeCloseTo(12 / 18 * C.map.halfLength);
    const { room } = setup(); room.players.a.movement.position = v(100, 0, 100); stepPlayer(room, 1 / 60);
    expect(room.players.a.movement.position.x).toBe(C.map.halfWidth - C.player.radius);
    expect(room.players.a.movement.position.z).toBe(C.map.halfLength - C.player.radius);
  });
});

describe('power-up inventory and replication', () => {
  it('locks activation throughout the pickup roll without consuming the item', () => {
    const { room, system } = setup('speed');
    room.powerups!.spawns[0].waitSeconds = 0;
    system.beforeBalls(room, 0, 3);
    expect(system.activate(room, 'a')).toBe(false);
    system.beforeBalls(room, C.powerup.rollSeconds - 0.01, 3);
    expect(system.activate(room, 'a')).toBe(false);
    expect(system.identity(room, 'a').kind).toBe('speed');
    system.beforeBalls(room, 0.01, 3);
    expect(system.activate(room, 'a')).toBe(true);
  });
  it('first spawns after exactly 20 simulated seconds; first player wins; next wait starts on pickup', () => {
    const { room, system } = setup();
    room.players.a.movement.position = v(5); system.beforeBalls(room, 19.99, 3);
    expect(room.powerups!.spawns[0].spawned).toBe(false);
    system.beforeBalls(room, 0.01, 3); expect(room.powerups!.spawns[0].spawned).toBe(true);
    system.beforeBalls(room, 50, 3); expect(room.powerups!.spawns[0].spawned).toBe(true);
    room.players.a.movement.position = room.players.b.movement.position = v(); system.beforeBalls(room, 0.01, 3);
    expect(system.identity(room, 'a').kind).toBe('speed'); expect(system.identity(room, 'b').kind).toBeNull();
    expect(room.powerups!.spawns[0].waitSeconds).toBe(20);
    room.players.b.movement.position = v(5); system.beforeBalls(room, 20, 3);
    expect(room.powerups!.spawns[0].spawned).toBe(true); // existing holder cannot take a second
  });
  it('broadcast full/compact/tiered snapshots never contain an unused identity; only holder gets it', () => {
    const { room, system } = setup('bomb'); take(room, system);
    const snap = { type: 'snapshot' as const, tick: 1, serverTimeMs: 1000, room };
    for (const payload of [snap, makeCompactSnapshot(snap), makeTieredCompactSnapshot(snap, { includePlayerLane: true, includeWorldLane: true })]) {
      expect(JSON.stringify(payload)).not.toContain('bomb');
    }
    expect(system.drain().privateMessages).toEqual([{ playerId: 'a', message: { kind: 'bomb', resetSerial: 0, reason: undefined } }]);
    expect(system.identity(room, 'b').kind).toBeNull();
    expect(inflateCompactSnapshot(makeCompactSnapshot(snap)).room.players.a.hasPowerup).toBe(true);
  });
  it.each(kinds)('activates %s and refuses dead/missing inventory', kind => {
    const { room, system } = setup(kind);
    expect(system.activate(room, 'a')).toBe(false); take(room, system);
    room.players.a.combatState = 'eliminated'; expect(system.activate(room, 'a')).toBe(false);
    room.players.a.combatState = 'alive'; expect(system.activate(room, 'a')).toBe(true);
    expect(room.players.a.hasPowerup).toBe(false); expect(system.activate(room, 'a')).toBe(false);
  });
  it.each(['cannon', 'heal', 'bomb'] as const)('retains %s when both hands are full', kind => {
    const { room, system } = setup(kind); take(room, system);
    room.players.a.hands.left.heldBallId = 'one'; room.players.a.hands.right.heldBallId = 'two';
    expect(system.activate(room, 'a')).toBe(false); expect(system.identity(room, 'a').kind).toBe(kind);
    expect(system.drain().privateMessages.at(-1)?.message.reason).toContain('Free a hand');
  });
  it('all new public state survives compact, fast-only and full resync lanes', () => {
    const { room, system } = setup('speed'); take(room, system); system.activate(room, 'a');
    room.players.a.armorBallIds = ['armor'];
    room.balls.bomb = createBallState('bomb', v(), { kind: 'bomb', armedAtMs: 200, fuseSeconds: 1.3 });
    room.balls.armor = createBallState('armor', v(), { phase: 'armor', armorPlayerId: 'a' });
    room.powerups!.stations.push({ id: 'station', placerId: 'a', teamId: 'blue', position: v(), remainingSeconds: 35, progress: { a: 6 } });
    const snap = { type: 'snapshot' as const, tick: 2, serverTimeMs: 500, room };
    const full = inflateCompactSnapshot(makeCompactSnapshot(snap));
    const tiered = mergeTieredCompactSnapshot(makeTieredCompactSnapshot(snap, { includePlayerLane: false, includeWorldLane: false }), full, 'a')!.snapshot;
    for (const state of [full.room, tiered.room]) {
      expect(state.players.a.movementInternal.buffs?.speedSeconds).toBe(15);
      expect(state.players.a.armorBallIds).toEqual(['armor']); expect(state.balls.bomb.fuseSeconds).toBe(1.3);
      expect(state.balls.armor.armorPlayerId).toBe('a'); expect(state.powerups!.stations[0].progress.a).toBe(6);
    }
  });
  it('2v2 rooms get two independent spawns mirrored across center; 1v1 gets one', () => {
    const { room } = setup();
    expect(room.powerups!.spawns).toHaveLength(1);
    const loop = new ServerGameLoop('two-spawns', { mode: '2v2', playersPerTeam: 2 });
    for (const id of ['a', 'b', 'c', 'd']) loop.addPlayer(id, id);
    const spawns = loop.state.powerups!.spawns;
    expect(spawns).toHaveLength(2);
    expect(spawns[0].x).toBeCloseTo(-C.map.halfWidth * C.powerup.twoVTwoSpawnOffsetFraction, 5);
    expect(spawns[1].x).toBeCloseTo(-spawns[0].x, 5);
    expect(spawns.every(s => s.z === 0)).toBe(true);
    // Taking one leaves the other up, and only the taken one restarts its 20 s wait.
    loop.state.match.status = 'playing'; loop.state.match.boundary.noBoundaries = true;
    for (const s of spawns) { s.spawned = true; s.waitSeconds = 0; }
    loop.state.players.a.movement.position = v(spawns[1].x, 0, 0);
    Object.values(loop.state.players).filter(p => p.id !== 'a').forEach(p => { p.movement.position = v(0, 0, -15); });
    loop.advance();
    expect(loop.state.players.a.hasPowerup).toBe(true);
    expect(spawns[0].spawned).toBe(true);
    expect(spawns[1].spawned).toBe(false); expect(spawns[1].waitSeconds).toBeGreaterThan(19);
  });
  it('pauses spawn during countdown/intermission and clears every artifact at reset', () => {
    const loop = new ServerGameLoop('paused'); loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'intermission'; loop.state.powerups!.spawns[0].waitSeconds = 12;
    loop.advance(); expect(loop.state.powerups!.spawns[0].waitSeconds).toBe(12);
    const { room, system } = setup('bomb'); take(room, system); system.activate(room, 'a');
    room.powerups!.stations.push({ id: 's', placerId: 'a', teamId: 'blue', position: v(), progress: {}, remainingSeconds: 20 });
    system.reset(room);
    expect(Object.values(room.balls)).toHaveLength(0); expect(room.powerups!.stations).toHaveLength(0);
    expect(room.players.a.movementInternal.buffs).toBeUndefined(); expect(room.players.a.hands.left.heldBallId).toBeNull();
    expect(system.identity(room, 'a').kind).toBeNull(); expect(room.powerups!.spawns[0].waitSeconds).toBe(20);
  });
});

describe('shared movement buffs', () => {
  it('adrenaline grants six, recharges in two seconds, and clamps back to three at expiry', () => {
    const { room, system } = setup('adrenaline'); take(room, system); system.activate(room, 'a');
    expect(room.players.a.dash.charges).toBe(6); room.players.a.dash.charges = 5;
    stepPlayer(room, 1); expect(room.players.a.dash.charges).toBe(5);
    stepPlayer(room, 1); expect(room.players.a.dash.charges).toBe(6);
    room.players.a.movementInternal.buffs!.adrenalineSeconds = 0; stepPlayer(room, 0.01);
    expect(room.players.a.dash.charges).toBe(3);
  });
  it('speed scales ground speed/acceleration and jump height, with identical replay results', () => {
    const { room, system } = setup('speed'); take(room, system); system.activate(room, 'a');
    const p = room.players.a, copy = structuredClone(p);
    const result = stepPlayer(room, 1 / 60, { moveZ: 1 });
    const replay = stepMovement(copy.movement, copy.movementInternal, copy.dash, input({ moveZ: 1 }), input(), 1 / 60, [], false);
    expect(replay).toEqual(result);
    const jump = stepPlayer(room, 0, { jumpPressed: true });
    expect(jump.movement.velocity.y).toBeCloseTo(C.player.jumpSpeed * Math.sqrt(1.25));
  });
  it('cannon refuses dash, airborne double-jump and backflip but permits ordinary jump', () => {
    const { room, system } = setup('cannon'); take(room, system); system.activate(room, 'a');
    expect(stepPlayer(room, 0.01, { dashPressed: true, backflipPressed: true }).internal.backflipActive).toBe(false);
    expect(room.players.a.dash.charges).toBe(3);
    expect(stepPlayer(room, 0, { jumpPressed: true }).movement.velocity.y).toBe(C.player.jumpSpeed);
    room.players.a.movement.position.y = 1;
    stepPlayer(room, 0.01, { jumpPressed: true }); expect(room.players.a.dash.charges).toBe(3);
  });
});

describe('special ball combat', () => {
  it('cannon is never catchable/parryable or floor-pickup eligible', () => {
    const { room } = setup(); const p = room.players.a;
    p.hands.left.heldBallId = 'one'; p.hands.right.heldBallId = 'two';
    const ball = createBallState('c', v(0, 1, 1), { kind: 'cannon', phase: 'live', velocity: v(0, 0, -42) });
    expect(isBallCatchableInFlight(ball)).toBe(false);
    expect(autoParryBall(p, p.hands, ball, v(0, 0, 1), 0).ok).toBe(false);
    ball.phase = 'dead'; expect(isBallPickupEligible(ball, v())).toBe(false);
  });
  it('cannon hits its owner, teammate, and both opponents once each while piercing the group', () => {
    const loop = new ServerGameLoop('cannon', { mode: '2v2', playersPerTeam: 2 });
    for (const id of ['a', 'b', 'c', 'd']) loop.addPlayer(id, id);
    loop.state.match.status = 'playing'; loop.state.match.boundary.noBoundaries = true;
    const p = loop.state.players.a;
    Object.values(loop.state.players).forEach(t => { t.movement.position = v(0, 0, 0); });
    loop.state.balls.cannon = createBallState('cannon', v(0, 1.4, -3), {
      kind: 'cannon', phase: 'live', ownerKind: 'player', ownerId: p.id,
      velocity: v(0, 0, C.ball.chargedThrowSpeed * C.powerup.cannonLaunchSpeedMultiplier),
      curveDistance: C.powerup.cannonSelfHitMinDistance + 1, throwId: 10
    });
    for (let i = 0; i < 24; i++) loop.advance();
    expect(Object.values(loop.state.players).map(t => t.lives)).toEqual([2, 2, 2, 2]);
    expect(loop.state.balls.cannon?.phase).toBe('live');
  });

  it('cannon requires a charge and a full release starts 25% slower without hitting its owner', () => {
    const loop = new ServerGameLoop('cannon-launch');
    loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'playing'; loop.state.match.boundary.noBoundaries = true;
    const p = loop.state.players.a;
    const ball = createBallState('cannon', p.movement.position, { kind: 'cannon' });
    loop.state.balls.cannon = holdBall(ball, p.id, 'left');
    p.hands.left = createHandState('left', { heldBallId: 'cannon', mode: 'holding' });

    expect(loop.handleThrow(p.id, { hand: 'left' })).toEqual({ ok: false, reason: 'charge-required' });
    p.hands.left = createHandState('left', { heldBallId: 'cannon', mode: 'charging', chargeSeconds: C.ball.maxChargeSeconds });
    expect(loop.handleThrow(p.id, { hand: 'left' }).ok).toBe(true);
    const thrown = loop.state.balls.cannon;
    expect(Math.hypot(thrown.velocity.x, thrown.velocity.y, thrown.velocity.z))
      .toBeCloseTo(C.ball.chargedThrowSpeed * C.powerup.cannonLaunchSpeedMultiplier, 6);
    expect(thrown.dropScale).toBe(0);
    for (let i = 0; i < 10; i++) loop.advance();
    expect(loop.state.players.a.lives).toBe(3);
  });

  it('cannon press starts charging and an early release throws weakly', () => {
    const loop = new ServerGameLoop('cannon-charge');
    loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'playing'; loop.state.match.boundary.noBoundaries = true;
    const p = loop.state.players.a;
    loop.state.balls.cannon = holdBall(createBallState('cannon', p.movement.position, { kind: 'cannon' }), p.id, 'left');
    p.hands.left = createHandState('left', { heldBallId: 'cannon', mode: 'holding' });

    loop.handleInput('a', { leftHandPressed: true, leftHandHeld: true, sequence: 1 }, 1);
    loop.step();
    expect(loop.state.balls.cannon.phase).toBe('held');
    expect(loop.state.players.a.hands.left.mode).toBe('charging');

    loop.handleInput('a', { leftHandReleased: true, sequence: 2 }, 2);
    loop.step();
    const thrown = loop.state.balls.cannon;
    expect(thrown.phase).toBe('live');
    expect(Math.hypot(thrown.velocity.x, thrown.velocity.y, thrown.velocity.z))
      .toBeLessThan(C.ball.chargedThrowSpeed * C.powerup.cannonLaunchSpeedMultiplier * 0.3);
    expect(thrown.dropScale).toBeGreaterThan(0.9);
  });

  it('throws bomb balls 25% slower than ordinary balls', () => {
    const loop = new ServerGameLoop('bomb-throw-speed');
    loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'playing'; loop.state.match.boundary.noBoundaries = true;
    const p = loop.state.players.a;
    const ball = createBallState('bomb', p.movement.position, { kind: 'bomb' });
    loop.state.balls.bomb = holdBall(ball, p.id, 'left');
    p.hands.left = createHandState('left', { heldBallId: 'bomb', mode: 'holding' });

    expect(loop.handleThrow(p.id, { hand: 'left' }).ok).toBe(true);
    const thrown = loop.state.balls.bomb;
    expect(Math.hypot(thrown.velocity.x, thrown.velocity.y, thrown.velocity.z))
      .toBeCloseTo(C.ball.quickThrowSpeed * C.powerup.bombThrowSpeedMultiplier, 6);
  });

  it('cannon survives three wall impacts, expires on the fourth, and dies instantly on the floor', () => {
    const loop = new ServerGameLoop('cannon-bounces');
    loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'playing'; loop.state.match.boundary.noBoundaries = true;
    loop.state.players.a.movement.position = v(0, 0, -10);
    loop.state.players.b.movement.position = v(0, 0, 10);
    loop.state.balls.cannon = createBallState('cannon', v(0, 5, 0), {
      kind: 'cannon', phase: 'live', ownerKind: 'player', ownerId: 'a', velocity: v(10, 0, 0), throwId: 11
    });
    const wallX = C.map.halfWidth - C.ball.radius * C.powerup.cannonFlightScale;

    for (let bounce = 1; bounce <= C.powerup.cannonMaxBounces; bounce += 1) {
      const cannon = loop.state.balls.cannon;
      expect(cannon).toBeTruthy();
      const towardPositive = bounce % 2 === 1;
      cannon.position = v(towardPositive ? wallX + 0.1 : -wallX - 0.1, 5, 0);
      cannon.velocity = v(towardPositive ? 10 : -10, 0, 0);
      loop.advance();
      if (bounce < C.powerup.cannonMaxBounces) {
        expect(loop.state.balls.cannon).toMatchObject({ phase: 'live', bounceCount: bounce });
      }
    }
    expect(loop.state.balls.cannon).toBeUndefined();

    loop.state.balls.floorCannon = createBallState('floorCannon', v(0, 0.5, 0), {
      kind: 'cannon', phase: 'live', ownerKind: 'player', ownerId: 'a', velocity: v(0, -1, 0), throwId: 12
    });
    loop.advance();
    expect(loop.state.balls.floorCannon).toBeUndefined();
  });
  it('bomb arms once with three beeps; re-holding preserves fuse; held explosion removes ball', () => {
    const { room, system } = setup('bomb'); take(room, system); system.activate(room, 'a');
    const id = room.players.a.hands.left.heldBallId!; const ball = room.balls[id];
    system.drain(); system.contact(room, ball, 100); system.contact(room, ball, 500);
    expect(ball.armedAtMs).toBe(100); expect(isBallCatchableInFlight(ball)).toBe(false);
    system.afterBalls(room, 0.7, () => {}); room.balls[id] = holdBall(ball, 'a', 'left');
    expect(room.balls[id].fuseSeconds).toBeCloseTo(1.3);
    system.afterBalls(room, 0.7, () => {}); const hits: string[] = [];
    system.afterBalls(room, 0.6, (_, p) => hits.push(p.id));
    expect(hits).toContain('a'); expect(room.balls[id]).toBeUndefined(); expect(room.players.a.hands.left.heldBallId).toBeNull();
    expect(system.drain().events.filter(e => e.effect === 'beep').map(e => e.stage)).toEqual([0, 1, 2]);
  });
  it('explosion damages both teams and thrower through life/stats path', () => {
    const loop = new ServerGameLoop('bomb'); loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B'); loop.state.match.status = 'playing';
    loop.state.players.a.movement.position = v(-1); loop.state.players.b.movement.position = v(1);
    loop.state.balls.bomb = createBallState('bomb', v(0, 0.8, 0), { kind: 'bomb', phase: 'dead', armedAtMs: 0, fuseSeconds: 0.001, bombThrowerId: 'a' });
    loop.advance(); expect(loop.state.players.a.lives).toBe(2); expect(loop.state.players.b.lives).toBe(2);
    expect(loop.state.players.a.matchStats.hits).toBe(2); expect(loop.state.balls.bomb).toBeUndefined();
  });
});

describe('magnet and healing', () => {
  it('never pulls live/held balls, fills hands then three armor, absorbs once and drops on expiry', () => {
    const { room, system } = setup('magnet'); take(room, system); system.activate(room, 'a');
    room.balls.live = createBallState('live', v(2, 1), { phase: 'live', velocity: v(0, 0, 20) });
    room.balls.held = holdBall(createBallState('held', v(2, 1)), 'b', 'left');
    for (let i = 0; i < 6; i++) room.balls[`loose${i}`] = createBallState(`loose${i}`, v(0.2, C.ball.radius));
    system.beforeBalls(room, 0.1, 3);
    expect(room.balls.live.velocity).toEqual(v(0, 0, 20)); expect(room.balls.held.phase).toBe('held');
    expect(room.players.a.hands.left.heldBallId).toBeTruthy(); expect(room.players.a.hands.right.heldBallId).toBeTruthy();
    expect(room.players.a.armorBallIds).toHaveLength(3); expect(room.balls.loose5.phase).toBe('loose');
    expect(system.absorb(room, room.players.a)).toBe(true); expect(room.players.a.armorBallIds).toHaveLength(2);
    room.players.a.movementInternal.buffs!.magnetSeconds = 0; system.beforeBalls(room, 0.1, 3);
    expect(room.players.a.armorBallIds).toHaveLength(0); expect(Object.values(room.balls).filter(b => b.phase === 'armor')).toHaveLength(0);
    expect(system.absorb(room, room.players.a)).toBe(false);
  });
  it('pickup while wearing armor takes an armor ball into a free hand before hunting the floor', () => {
    const loop = new ServerGameLoop('armor-grab'); loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'playing';
    const a = loop.state.players.a;
    a.movementInternal.buffs = { speedSeconds: 0, adrenalineSeconds: 0, magnetSeconds: 10, cannonLocked: false };
    loop.state.balls.armor1 = createBallState('armor1', a.movement.position, { phase: 'armor', armorPlayerId: 'a' });
    a.armorBallIds = ['armor1'];
    // Hands full: pickup does nothing to the armor.
    a.hands.left = createHandState('left', { heldBallId: 'ball_0', mode: 'holding' });
    a.hands.right = createHandState('right', { heldBallId: 'ball_1', mode: 'holding' });
    expect(loop.handlePickup('a').ok).toBe(false); expect(a.armorBallIds).toEqual(['armor1']);
    // Free a hand: E moves the armor ball into it.
    a.hands.right = createHandState('right');
    expect(loop.handlePickup('a').ok).toBe(true);
    expect(loop.state.players.a.hands.right.heldBallId).toBe('armor1');
    expect(loop.state.balls.armor1.phase).toBe('held'); expect(loop.state.balls.armor1.armorPlayerId).toBeUndefined();
    expect(loop.state.players.a.armorBallIds).toEqual([]);
  });
  it('distant stationary balls begin a gentle continuous pull after three seconds', () => {
    const { room, system } = setup('magnet'); take(room, system); system.activate(room, 'a');
    room.balls.far = createBallState('far', v(0, 0.22, 15)); system.beforeBalls(room, 3, 3);
    expect(room.balls.far.velocity.z).toBe(0); system.beforeBalls(room, 0.1, 3); expect(room.balls.far.velocity.z).toBeLessThan(0);
    system.beforeBalls(room, 0.1, 3); expect(room.balls.far.velocity.z).toBeLessThan(-0.5);
    expect(Math.abs(room.balls.far.velocity.z)).toBeLessThanOrEqual(C.powerup.distantMagnetSpeed);
  });
  it('heals teammates after continuous dwell; leaving resets, hits do not, enemies ignored, one use', () => {
    const { room, system } = setup('heal'); take(room, system); system.activate(room, 'a');
    expect(system.place(room, room.players.a, 'left', [])).toBe(true);
    const s = room.powerups!.stations[0]; room.players.a.movement.position = v(0, 0, 1.5); room.players.a.lives = 2;
    room.players.b.movement.position = v(0, 0, 1.5); room.players.b.lives = 1;
    system.beforeBalls(room, 6, 3); expect(s.progress.a).toBe(6); expect(s.progress.b).toBe(0);
    room.players.a.movement.position = v(4); system.beforeBalls(room, 0.1, 3); expect(s.progress.a).toBe(0);
    room.players.a.movement.position = v(0, 0, 1.5); system.beforeBalls(room, 6, 3); room.players.a.lives = 1;
    system.beforeBalls(room, 4, 3); expect(room.players.a.lives).toBe(2); expect(room.players.b.lives).toBe(1);
    expect(room.powerups!.stations).toHaveLength(0);
  });
  it('refuses out-of-court deployment, caps lives, and expires unused stations', () => {
    const { room, system } = setup('heal'); take(room, system); system.activate(room, 'a');
    room.players.a.movement.position = v(0, 0, C.map.halfLength - 0.1);
    expect(system.place(room, room.players.a, 'left', [])).toBe(false); expect(room.players.a.hands.left.heldBallId).toBeTruthy();
    room.players.a.movement.position = v(); expect(system.place(room, room.players.a, 'left', [])).toBe(true);
    room.players.a.movement.position.z = 1.5; system.beforeBalls(room, 11, 3); expect(room.players.a.lives).toBe(3);
    system.beforeBalls(room, 35, 3); expect(room.powerups!.stations).toHaveLength(0);
  });
});
