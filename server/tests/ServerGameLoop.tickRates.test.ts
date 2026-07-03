import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS, deriveCombatTimingConstants } from '../../shared/constants';
import { vec3 } from '../../shared/simulation/CollisionMath';
import { ACTIVE_NET_MODE, netModeConfig, type NetMode } from '../../shared/netConfig';
import {
  DEFAULT_TICK_PRESET_ID,
  TICK_PRESETS,
  isTickPresetId,
  tickPresetById,
  tickPresetForNetMode
} from '../../shared/tickPresets';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

/**
 * Parametrized tick-rate suite. The mat post-reset-immunity bug (a decrementing-float timer that
 * lost exactly one tick of grace at dyadic tick rates — masked at 90Hz, exposed at 128Hz) proved
 * that dt-accumulated timers checked at exact boundaries behave differently per rate. Now that the
 * tick rate is host-selectable, the representative timer/combat/lifecycle scenarios below must hold
 * EXACTLY at every selectable rate, not just the compiled default.
 */

// The 5 host-selectable preset modes, plus the compiled default as the regression anchor.
const RATES: NetMode[] = Array.from(
  new Set<NetMode>([...TICK_PRESETS.map((preset) => preset.netMode), ACTIVE_NET_MODE])
);

function playNow(loop: ServerGameLoop): void {
  loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };
}

function firstMat(loop: ServerGameLoop) {
  const id = Object.keys(loop.state.mats)[0];
  return loop.state.mats[id];
}

describe('tick presets (shared/tickPresets)', () => {
  it('every selectable preset resolves to a real NetMode config', () => {
    for (const preset of TICK_PRESETS) {
      const config = netModeConfig(preset.netMode);
      expect(config, `preset ${preset.id} -> ${preset.netMode}`).not.toBeNull();
      expect(config!.serverTickRate).toBeGreaterThan(0);
      expect(config!.clientInputRate).toBe(config!.serverTickRate); // residual≈0 requires equal rates
      expect(config!.snapshotRate).toBeGreaterThan(0);
      expect(config!.snapshotRate).toBeLessThanOrEqual(config!.serverTickRate);
      expect(config!.interpolationDelayMs).toBeGreaterThan(0);
    }
  });

  it('ids are unique and the default id is selectable', () => {
    const ids = TICK_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isTickPresetId(DEFAULT_TICK_PRESET_ID)).toBe(true);
  });

  it('invalid or missing ids fall back to the default preset', () => {
    expect(tickPresetById(undefined).id).toBe(DEFAULT_TICK_PRESET_ID);
    expect(tickPresetById('nonsense').id).toBe(DEFAULT_TICK_PRESET_ID);
    expect(tickPresetById('high').id).toBe('high');
    expect(isTickPresetId('extreme')).toBe(true);
    expect(isTickPresetId('A_128_128_96')).toBe(false); // raw NetModes are not selectable ids
  });

  it('reverse lookup labels a room by its broadcast netMode', () => {
    expect(tickPresetForNetMode('A_90_90_60')?.id).toBe('standard');
    expect(tickPresetForNetMode('A_144_144_100')).toBeNull(); // internal-only mode, no preset
  });
});

describe.each(RATES)('ServerGameLoop @ %s', (netMode) => {
  const timing = netModeConfig(netMode)!;

  it('resolves the mode into tick rate and stamps netMode on room state (surviving resets)', () => {
    const loop = new ServerGameLoop('room', { netMode });
    expect(loop.tickRate).toBe(timing.serverTickRate);
    expect(loop.netMode).toBe(netMode);
    expect(loop.state.netMode).toBe(netMode);

    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);
    // A room reset rebuilds RoomState from scratch; the creation-time mode must carry through.
    // Both connected players voting passes the 70% supermajority and triggers the reset.
    expect(loop.handleReset('a').ok).toBe(true);
    expect(loop.handleReset('b').ok).toBe(true);
    expect(loop.state.netMode).toBe(netMode);
  });

  it('derives combat lag-comp windows from THIS mode, preserving the sizing invariants', () => {
    const combat = deriveCombatTimingConstants({
      serverStepMs: 1000 / timing.serverTickRate,
      interpolationDelayMs: timing.interpolationDelayMs,
      snapshotIntervalMs: 1000 / timing.snapshotRate
    });
    // The relationships the lag-comp design depends on (see shared/constants.ts):
    expect(combat.catchHitGraceMs).toBeGreaterThan(combat.defenseMaxRewindMs);
    expect(combat.defenseHistoryMs).toBeGreaterThanOrEqual(
      combat.defenseMaxRewindMs + combat.catchActiveMs + combat.defenseInputGraceMs
    );
    expect(combat.catchRewindMs).toBeLessThanOrEqual(combat.defenseMaxRewindMs);
    expect(combat.defenseInputGraceMs).toBeGreaterThanOrEqual(60);
    if (netMode === ACTIVE_NET_MODE) {
      // Regression anchor: the per-room derivation at the compiled mode IS the frozen global.
      expect(combat).toEqual(GAME_CONSTANTS.combat);
    }
  });

  it('runs the pre-round countdown to completion in ~countdownSeconds of ticks', () => {
    const loop = new ServerGameLoop('room', { netMode });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    loop.state.match = {
      ...loop.state.match,
      status: 'countdown',
      countdownSeconds: GAME_CONSTANTS.match.countdownSeconds
    };

    const expectedTicks = Math.ceil(GAME_CONSTANTS.match.countdownSeconds * loop.tickRate);
    let ticksUntilPlaying = 0;
    for (let i = 0; i < expectedTicks + 2 && loop.state.match.status === 'countdown'; i += 1) {
      loop.step();
      ticksUntilPlaying += 1;
    }
    expect(loop.state.match.status).toBe('playing');
    // Allow the one-tick float wobble between dyadic and non-dyadic rates, never more.
    expect(Math.abs(ticksUntilPlaying - expectedTicks)).toBeLessThanOrEqual(1);
  });

  it('validates a live-ball hit and scores it (combat smoke at this rate)', () => {
    const loop = new ServerGameLoop('room', { netMode });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    loop.state.players.a.dash.charges = GAME_CONSTANTS.dash.maxCharges - 1;
    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      heldByPlayerId: null,
      heldHand: null,
      position: { ...loop.state.players.b.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
      velocity: vec3(0, 0, 24),
      bounceCount: 0
    };

    loop.step();
    const scoringTeam = loop.state.players.a.teamId;
    expect(loop.state.match.scoreByTeamId[scoringTeam]).toBeGreaterThan(0);
  });

  it('holds the mat post-reset knock immunity for EXACTLY the configured grace at this rate', () => {
    // Port of the boundary test that caught the original 128Hz dyadic-float bug, generalized to the
    // room's own tick rate. Step counts use loop.tickRate so the boundary lands exactly per rate.
    const loop = new ServerGameLoop('room', { netMode });
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);
    const mat = firstMat(loop);

    loop.state.players.a.movement.position = vec3(mat.position.x, 0, mat.position.z - 0.6);
    loop.state.players.a.movement.velocity = vec3(0, 0, 4);
    loop.step();
    expect(loop.state.mats[mat.id].knockedOver).toBe(true);

    // Stand back in hold-E range and reset the mat.
    loop.state.players.a.movement.position = vec3(mat.position.x, 0, mat.position.z - 1.8);
    loop.state.players.a.movement.velocity = vec3();
    let seq = 1;
    const restoreSteps = Math.ceil(GAME_CONSTANTS.mat.restoreHoldSeconds * loop.tickRate);
    for (let i = 0; i < restoreSteps; i += 1) {
      loop.handleInput('a', { interactHeld: true, sequence: seq }, seq);
      loop.step();
      seq += 1;
    }
    expect(loop.state.mats[mat.id].knockedOver).toBe(false);

    // Every contact tick inside the grace window must NOT knock it back over — at ANY tick rate.
    const protectedSteps = Math.max(1, Math.ceil(GAME_CONSTANTS.mat.postResetKnockImmunitySeconds * loop.tickRate));
    for (let i = 0; i < protectedSteps; i += 1) {
      loop.state.players.a.movement.position = vec3(mat.position.x, 0, mat.position.z - 0.6);
      loop.state.players.a.movement.velocity = vec3(0, 0, 4);
      loop.handleInput('a', { interactHeld: false, sequence: seq }, seq);
      loop.step();
      seq += 1;
    }
    expect(loop.state.mats[mat.id].knockedOver).toBe(false);

    // First tick past the grace: the same contact knocks it over again.
    loop.state.players.a.movement.position = vec3(mat.position.x, 0, mat.position.z - 0.6);
    loop.state.players.a.movement.velocity = vec3(0, 0, 4);
    loop.handleInput('a', { interactHeld: false, sequence: seq }, seq);
    loop.step();
    expect(loop.state.mats[mat.id].knockedOver).toBe(true);
  });
});
