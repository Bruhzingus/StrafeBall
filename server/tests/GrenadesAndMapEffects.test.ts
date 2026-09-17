import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../../shared/constants';
import { PowerupSystem } from '../src/simulation/PowerupSystem';
import { MapEffectSystem } from '../src/simulation/MapEffectSystem';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';
import { createRoomState } from '../../shared/simulation/MatchSim';
import { createPlayerState } from '../../shared/simulation/PlayerSim';
import { createBallState, isBallCatchableInFlight, isBallPickupEligible } from '../../shared/simulation/BallSim';
import { autoParryBall, createHandState } from '../../shared/simulation/HandSim';
import { stepMovement } from '../../shared/simulation/MovementSim';
import { lavaLevelFor, lavaMaxHeight, mapEffectGravityScale } from '../../shared/simulation/MapEffectSim';
import { BLEACHER_LAYOUT } from '../../shared/simulation/MapGeometry';
import type { PlayerInput, PowerupKind, RoomState } from '../../shared/types';

const kinds: PowerupKind[] = ['adrenaline', 'speed', 'cannon', 'heal', 'magnet', 'bomb', 'shock', 'stun'];
const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const floorY = C.ball.radius + 0.05;
/** Deterministic RNG: yields the given values in order, then repeats the last one. */
const seq = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
/** A roll that wins the map-effect chance and then picks the kind at `index` of ['moon','lava','frenzy']. */
const rollEffect = (index: number) => seq(0.01, (index + 0.5) / 3);

function input(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return { moveX: 0, moveZ: 0, lookYawRadians: 0, lookPitchRadians: 0, dashDirection: v(), ...overrides } as PlayerInput;
}

/** A playing 1v1 loop with the power-up RNG pinned to `kind` and players parked apart. */
function loopWith(kind: PowerupKind, name = 'grenade') {
  const loop = new ServerGameLoop(name);
  loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
  loop.state.match.status = 'playing'; loop.state.match.boundary.noBoundaries = true;
  (loop as unknown as { powerupSystem: PowerupSystem }).powerupSystem = new PowerupSystem(() => (kinds.indexOf(kind) + 0.1) / kinds.length);
  loop.state.players.a.movement.position = v(0, 0, -6);
  loop.state.players.b.movement.position = v(0, 0, 8);
  return loop;
}

function powerups(loop: ServerGameLoop): PowerupSystem {
  return (loop as unknown as { powerupSystem: PowerupSystem }).powerupSystem;
}

function advanceSeconds(loop: ServerGameLoop, seconds: number): void {
  const ticks = Math.ceil(seconds * (loop as unknown as { tickRate: number }).tickRate);
  for (let i = 0; i < ticks; i += 1) loop.advance();
}

function giveGrenade(loop: ServerGameLoop, kind: 'shock' | 'stun'): string {
  const system = powerups(loop);
  loop.state.powerups!.spawns[0].spawned = true;
  loop.state.players.a.movement.position = v(0, 0, 0);
  loop.advance(); // pickup
  loop.state.players.a.movement.position = v(0, 0, -6);
  expect(system.activate(loop.state, 'a')).toBe(true);
  const held = loop.state.players.a.hands.left.heldBallId ?? loop.state.players.a.hands.right.heldBallId;
  expect(held).toBeTruthy();
  expect(loop.state.balls[held!].kind).toBe(kind);
  return held!;
}

describe('grenades: shock + stun', () => {
  it('activation puts one in hand and queues a second; the second lands in hand after the throw', () => {
    const loop = loopWith('shock');
    const first = giveGrenade(loop, 'shock');
    expect(loop.state.players.a.pendingGrenades).toBe(C.powerup.grenadeCharges - 1);
    // Throw: release the hand holding it.
    const hand = loop.state.players.a.hands.left.heldBallId === first ? 'left' : 'right';
    expect(loop.handleThrow('a', { hand }).ok).toBe(true);
    expect(loop.state.balls[first].phase).toBe('live');
    const second = loop.state.players.a.hands[hand].heldBallId;
    expect(second).toBeTruthy(); expect(second).not.toBe(first);
    expect(loop.state.balls[second!].kind).toBe('shock');
    expect(loop.state.players.a.pendingGrenades).toBe(0);
    // Throwing the second does not conjure a third.
    expect(loop.handleThrow('a', { hand }).ok).toBe(true);
    expect(loop.state.players.a.hands[hand].heldBallId).toBeNull();
  });

  it('never bounces: the first surface it touches is where it sticks, then it pops after the fuse', () => {
    const loop = loopWith('shock');
    const id = giveGrenade(loop, 'shock');
    // Fling it straight down at the floor from chest height.
    loop.state.balls[id] = createBallState(id, v(3, 1.2, -6), { kind: 'shock', phase: 'live', ownerKind: 'player', ownerId: 'a', velocity: v(0, -12, 0), throwId: 5 });
    loop.state.players.a.hands.left = createHandState('left'); loop.state.players.a.hands.right = createHandState('right');
    for (let i = 0; i < 40 && loop.state.balls[id]?.phase !== 'stuck'; i++) loop.advance();
    const stuck = loop.state.balls[id];
    expect(stuck.phase).toBe('stuck');
    expect(stuck.velocity).toEqual(v());
    expect(stuck.position.y).toBeLessThan(0.5);
    expect(isBallPickupEligible(stuck, v(3, 0, -6))).toBe(false);
    expect(isBallCatchableInFlight(stuck)).toBe(false);
    advanceSeconds(loop, C.powerup.grenadeFuseSeconds + 0.1);
    expect(loop.state.balls[id]).toBeUndefined();
  });

  it('sticks to a player it crosses (not the thrower on release) and rides them', () => {
    const loop = loopWith('stun');
    const id = giveGrenade(loop, 'stun');
    loop.state.players.a.hands.left = createHandState('left'); loop.state.players.a.hands.right = createHandState('right');
    loop.state.players.b.movement.position = v(0, 0, 0);
    // Live, already past the self-stick guard, flying at b's chest.
    loop.state.balls[id] = createBallState(id, v(0, 1.0, -3), { kind: 'stun', phase: 'live', ownerKind: 'player', ownerId: 'a', velocity: v(0, 0, 20), throwId: 6, curveDistance: 5 });
    for (let i = 0; i < 30 && loop.state.balls[id]?.phase !== 'stuck'; i++) loop.advance();
    expect(loop.state.balls[id].phase).toBe('stuck');
    expect(loop.state.balls[id].stuckToPlayerId).toBe('b');
    loop.state.players.b.movement.position = v(4, 0, 4);
    loop.advance();
    expect(loop.state.balls[id].position.x).toBeCloseTo(4, 1);
  });

  it('shockwave flings nearby players and loose balls, knocks mats flat, cancels a charge — no lives lost', () => {
    const loop = loopWith('shock');
    const id = giveGrenade(loop, 'shock');
    loop.state.players.a.hands.left = createHandState('left'); loop.state.players.a.hands.right = createHandState('right');
    const mat = Object.keys(loop.state.mats)[0];
    const spec = loop.state.mats[mat];
    // Stuck grenade right next to a standing mat; b stands 2 m from it, mid charge-throw.
    const at = v(spec.position.x, 0.2, spec.position.z + 1.2);
    loop.state.balls[id] = createBallState(id, at, { kind: 'shock', phase: 'stuck', ownerKind: 'player', ownerId: 'a', fuseSeconds: 0.01, stuckAtMs: 0 });
    loop.state.players.b.movement.position = v(at.x + 2, 0, at.z);
    loop.state.players.b.hands.left = createHandState('left', { heldBallId: 'ball_0', mode: 'charging', chargeSeconds: 0.5 });
    loop.state.balls.ball_0 = { ...loop.state.balls.ball_0, phase: 'held', heldByPlayerId: 'b', heldHand: 'left', ownerKind: 'player', ownerId: 'b' };
    loop.state.balls.ball_1 = { ...loop.state.balls.ball_1, position: v(at.x - 1.5, floorY, at.z), phase: 'loose' };
    const livesBefore = loop.state.players.b.lives;
    loop.advance(); loop.advance();
    const b = loop.state.players.b;
    expect(loop.state.balls[id]).toBeUndefined();
    expect(b.lives).toBe(livesBefore);
    expect(b.movement.velocity.x).toBeGreaterThan(3);
    expect(b.movement.velocity.y).toBeGreaterThan(1);
    expect(b.hands.left.mode).toBe('holding'); expect(b.hands.left.chargeSeconds).toBe(0);
    expect(loop.state.mats[mat].knockedOver).toBe(true);
    expect(loop.state.balls.ball_1.velocity.x).toBeLessThan(-2);
    expect(loop.state.balls.ball_1.phase).toBe('dead');
  });

  it('stun applies to everyone in range including the thrower; stunned players are slowed and cannot dash', () => {
    const loop = loopWith('stun');
    const id = giveGrenade(loop, 'stun');
    loop.state.players.a.hands.left = createHandState('left'); loop.state.players.a.hands.right = createHandState('right');
    loop.state.balls[id] = createBallState(id, v(0, 0.3, 0), { kind: 'stun', phase: 'stuck', ownerKind: 'player', ownerId: 'a', fuseSeconds: 0.01, stuckAtMs: 0 });
    loop.state.players.a.movement.position = v(1.5, 0, 0);
    loop.state.players.b.movement.position = v(-1.5, 0, 0);
    loop.advance(); loop.advance();
    for (const id of ['a', 'b']) expect(loop.state.players[id].movementInternal.buffs?.stunSeconds).toBeGreaterThan(C.powerup.stunSeconds - 0.1);

    // Shared sim: top speed is scaled, dash refused, and the timer counts down.
    const p = loop.state.players.b;
    const dashBefore = p.dash.charges;
    let m = p.movement, int = p.movementInternal, d = p.dash;
    for (let i = 0; i < 90; i++) {
      const r = stepMovement(m, int, d, input({ moveZ: 1, dashPressed: i === 10 }), input(), 1 / 60, [], false);
      m = r.movement; int = r.internal; d = r.dash;
    }
    expect(d.charges).toBe(dashBefore);
    expect(m.speed).toBeLessThan(C.player.maxGroundSpeed * C.powerup.stunMoveMultiplier + 0.2);
    expect(int.buffs!.stunSeconds!).toBeLessThan(C.powerup.stunSeconds - 1);
  });

  it('grenades in flight cannot be caught or parried', () => {
    const ball = createBallState('g', v(0, 1, 0), { kind: 'shock', phase: 'live', ownerKind: 'player', ownerId: 'a', velocity: v(0, 0, 20) });
    expect(isBallCatchableInFlight(ball)).toBe(false);
    const defender = createPlayerState('d', 'red', 'positiveZ');
    defender.movement.position = v(0, 0, 3);
    const hands = { left: createHandState('left', { heldBallId: 'x' }), right: createHandState('right', { heldBallId: 'y' }) };
    const result = autoParryBall(defender, hands, ball, v(0, 0, -1), 0, v(0, 1.5, 3));
    expect(result.ok).toBe(false);
  });
});

describe('map effects', () => {
  function playingRoom(): RoomState {
    const room = createRoomState({ players: [createPlayerState('a', 'blue'), createPlayerState('b', 'red', 'positiveZ')] });
    room.match.status = 'playing';
    return room;
  }
  const env = { damage: (p: { lives: number }) => { p.lives -= 1; }, forgetBall: () => {} };

  it('rolls from the spawn clock: warning shows at the spawn, then the effect starts, then it ends', () => {
    const room = playingRoom();
    const system = new MapEffectSystem(rollEffect(0));
    expect(system.tryStart(room, 0, v(0, 1, 0))).toBe(true);
    expect(room.mapEffect).toMatchObject({ kind: 'moon', phase: 'warning', spawnIndex: 0 });
    expect(system.tryStart(room, 1, v())).toBe(false); // one at a time
    system.step(room, C.mapEffect.warningSeconds, env, 6);
    expect(room.mapEffect?.phase).toBe('active');
    expect(mapEffectGravityScale(room.mapEffect)).toBe(C.mapEffect.moonGravityScale);
    system.step(room, C.mapEffect.moonSeconds + 0.01, env, 6);
    expect(room.mapEffect).toBeNull();
    expect(system.drain().map(e => e.effect)).toEqual(['map-warning', 'map-start', 'map-end']);
  });

  it('a losing roll leaves the spawn to place a normal item', () => {
    const room = playingRoom();
    const system = new MapEffectSystem(() => 0.99);
    expect(system.tryStart(room, 0, v())).toBe(false);
    expect(room.mapEffect ?? null).toBeNull();
  });

  it('moon gravity: the shared sim falls slower for the same input', () => {
    const p = createPlayerState('a', 'blue');
    p.movement.position = v(0, 4, 0); p.movement.grounded = false;
    const fall = (scale: number) => {
      let m = p.movement, int = p.movementInternal, d = p.dash;
      for (let i = 0; i < 30; i++) { const r = stepMovement(m, int, d, input(), input(), 1 / 60, [], false, undefined, 1, 1, scale); m = r.movement; int = r.internal; d = r.dash; }
      return m.position.y;
    };
    expect(fall(C.mapEffect.moonGravityScale)).toBeGreaterThan(fall(1) + 0.5);
  });

  it('lava rises to just under the top bleacher tier, costs lives on a cadence, floats and herds balls', () => {
    const room = playingRoom();
    const system = new MapEffectSystem(rollEffect(1));
    expect(system.tryStart(room, 0, v())).toBe(true);
    expect(room.mapEffect?.kind).toBe('lava');
    system.step(room, C.mapEffect.warningSeconds, env, 6);
    expect(room.mapEffect?.phase).toBe('active');
    expect(lavaLevelFor(room.mapEffect)).toBe(0);
    // Fully risen: below the top tier, above the one beneath it.
    system.step(room, C.mapEffect.lavaRiseSeconds, env, 6);
    const level = room.mapEffect!.lavaLevel;
    expect(level).toBeCloseTo(lavaMaxHeight(), 5);
    expect(level).toBeLessThan(BLEACHER_LAYOUT.tierCount * BLEACHER_LAYOUT.tierRise);
    expect(level).toBeGreaterThan((BLEACHER_LAYOUT.tierCount - 1) * BLEACHER_LAYOUT.tierRise);

    // a is on the floor (in lava), b is up on the top tier (safe).
    room.players.a.movement.position = v(0, 0, 0);
    room.players.b.movement.position = v(13.8, BLEACHER_LAYOUT.tierCount * BLEACHER_LAYOUT.tierRise, 0);
    const livesA = room.players.a.lives, livesB = room.players.b.lives;
    system.step(room, C.mapEffect.lavaFirstDamageSeconds + 0.01, env, 6);
    expect(room.players.a.lives).toBe(livesA - 1);
    system.step(room, C.mapEffect.lavaDamageIntervalSeconds, env, 6);
    expect(room.players.a.lives).toBe(livesA - 2);
    expect(room.players.b.lives).toBe(livesB);

    // A loose ball on the floor pops up to the surface and drifts toward its nearest bleacher.
    room.balls.ball_0 = createBallState('ball_0', v(2, floorY, 1));
    system.step(room, 0.01, env, 6);
    expect(room.balls.ball_0.position.y).toBeCloseTo(level + C.ball.radius, 5);
    expect(room.balls.ball_0.velocity.x).toBeGreaterThan(0);
    // Parked at the tier it can't float over: no more drift, back to a grabbable loose ball.
    room.balls.ball_0 = { ...room.balls.ball_0, position: v(13.5, level + C.ball.radius, 1) };
    system.step(room, 0.01, env, 6);
    expect(room.balls.ball_0.velocity.x).toBe(0);
    expect(room.balls.ball_0.phase).toBe('loose');

    // Recedes, then clears.
    system.step(room, C.mapEffect.lavaHoldSeconds - C.mapEffect.lavaFirstDamageSeconds - C.mapEffect.lavaDamageIntervalSeconds, env, 6);
    expect(room.mapEffect?.phase).toBe('ending');
    system.step(room, C.mapEffect.lavaRecedeSeconds + 0.01, env, 6);
    expect(room.mapEffect).toBeNull();
  });

  it('frenzy triples the balls from the ceiling, keeps live balls alive through bounces, then cleans up', () => {
    const loop = new ServerGameLoop('frenzy'); loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'playing'; loop.state.match.boundary.noBoundaries = true;
    loop.state.players.a.movement.position = v(-10, 0, -15); loop.state.players.b.movement.position = v(10, 0, 15);
    const system = loop.mapEffectSystem;
    (system as unknown as { rng: () => number }).rng = rollEffect(2);
    const before = Object.keys(loop.state.balls).length;
    expect(system.tryStart(loop.state, 0, v())).toBe(true);
    advanceSeconds(loop, C.mapEffect.warningSeconds + 0.05);
    expect(loop.state.mapEffect?.phase).toBe('active');
    expect(Object.keys(loop.state.balls).length).toBe(before * C.mapEffect.frenzyBallMultiplier);
    expect(system.frenzyBalls.every(id => loop.state.balls[id].position.y > 1)).toBe(true);

    // A live ball thrown into the floor keeps flying live after several bounces.
    loop.state.balls.ball_0 = createBallState('ball_0', v(0, 1.2, -2), { phase: 'live', ownerKind: 'player', ownerId: 'a', velocity: v(0, -6, 14), throwId: 9 });
    advanceSeconds(loop, 1.5);
    expect(loop.state.balls.ball_0.bounceCount).toBeGreaterThan(1);
    expect(loop.state.balls.ball_0.phase).toBe('live');

    advanceSeconds(loop, C.mapEffect.frenzySeconds);
    expect(loop.state.mapEffect ?? null).toBeNull();
    expect(Object.keys(loop.state.balls).filter(id => id.startsWith('frenzy_'))).toHaveLength(0);
    expect(Object.keys(loop.state.balls).length).toBe(before);
  });

  it('lobby (warmup): power-ups spawn and can be used, bombs never cost lives, lava never rolls', () => {
    const loop = new ServerGameLoop('lobby'); loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    expect(loop.state.match.status).toBe('warmup');
    (loop as unknown as { powerupSystem: PowerupSystem }).powerupSystem = new PowerupSystem(() => (kinds.indexOf('bomb') + 0.1) / kinds.length);
    loop.state.players.a.movement.position = v(0, 0, 0);
    loop.state.players.b.movement.position = v(0, 0, 8);
    // The spawn clock runs in the lobby and the item can be picked up + activated.
    advanceSeconds(loop, C.powerup.respawnSeconds + 0.2);
    expect(loop.state.players.a.hasPowerup).toBe(true);
    expect(powerups(loop).activate(loop.state, 'a')).toBe(true);
    const bombId = loop.state.players.a.hands.left.heldBallId ?? loop.state.players.a.hands.right.heldBallId;
    expect(loop.state.balls[bombId!].kind).toBe('bomb');
    // Explode it at b's feet: fireworks only.
    const livesB = loop.state.players.b.lives;
    loop.state.balls[bombId!] = createBallState(bombId!, v(0, 0.3, 8), { kind: 'bomb', armedAtMs: 0, fuseSeconds: 0.01, bombThrowerId: 'a', phase: 'dead' });
    loop.state.players.a.hands.left = createHandState('left'); loop.state.players.a.hands.right = createHandState('right');
    loop.advance(); loop.advance();
    expect(loop.state.balls[bombId!]).toBeUndefined();
    expect(loop.state.players.b.lives).toBe(livesB);

    // Map effects roll in the lobby too, but a roll that would be lava lands on something else.
    const effects = loop.mapEffectSystem;
    for (let i = 0; i < 3; i++) {
      (effects as unknown as { rng: () => number }).rng = rollEffect(i);
      expect(effects.tryStart(loop.state, 0, v())).toBe(true);
      expect(loop.state.mapEffect!.kind).not.toBe('lava');
      effects.reset(loop.state);
    }
  });

  it('intermission: nothing spawns and nothing can be used', () => {
    const loop = new ServerGameLoop('paused'); loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'intermission';
    loop.state.players.a.movement.position = v(0, 0, 0);
    advanceSeconds(loop, C.powerup.respawnSeconds + 1);
    expect(loop.state.powerups!.spawns[0].spawned).toBe(false);
    expect(loop.state.players.a.hasPowerup).toBeFalsy();
  });

  it('a room reset clears a running effect', () => {
    const loop = new ServerGameLoop('reset'); loop.addPlayer('a', 'A'); loop.addPlayer('b', 'B');
    loop.state.match.status = 'playing';
    (loop.mapEffectSystem as unknown as { rng: () => number }).rng = rollEffect(0);
    expect(loop.mapEffectSystem.tryStart(loop.state, 0, v())).toBe(true);
    (loop as unknown as { performRoomReset: (id: string) => void }).performRoomReset('a');
    expect(loop.state.mapEffect ?? null).toBeNull();
  });
});
