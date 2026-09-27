import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { createBallState, holdBall } from '../shared/simulation/BallSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import type { PowerupKind } from '../shared/types';
import { buildPowerupHudView, POWERUP_ITEMS } from '../src/game/powerups/PowerupHudView';
import type { PowerupPresentationRoom } from '../src/game/powerups/PowerupPresentation';

function practiceRoom(): PowerupPresentationRoom {
  return {
    practicePlayerId: 'practice',
    practiceBuffs: { speedSeconds: 0, adrenalineSeconds: 0, magnetSeconds: 0, cannonLocked: false },
    settings: { powerupsEnabled: true }, powerups: { spawns: [], stations: [] },
    resetVote: { resetSerial: 1 }, match: { currentRound: 1, status: 'warmup' }, players: {}, balls: {}
  };
}

const idle = { heldKind: null, rolling: false, rollKind: 'speed' as PowerupKind, waitSeconds: 20 };

describe('power-up HUD inventory and equipment', () => {
  it('keeps live speed visible through another roll, retains the revealed item, and follows activation through throwing', () => {
    const room = practiceRoom();
    room.practiceBuffs!.speedSeconds = 8;
    expect(buildPowerupHudView({ room, ...idle })).toMatchObject({ icon: 'speed', state: 'active', hint: 'Speed 8s' });

    const pickup = { heldKind: 'bomb' as const, rolling: true, rollKind: 'heal' as const, waitSeconds: 20 };
    expect(buildPowerupHudView({ room, ...pickup })).toMatchObject({
      icon: 'speed', hint: 'Speed 8s', state: 'active',
      selection: { icon: 'heal', color: POWERUP_ITEMS.heal.color, state: 'rolling', keybind: '' }
    });
    room.practiceBuffs!.speedSeconds = 6.2;
    const revealed = buildPowerupHudView({ room, ...pickup, rolling: false });
    expect(revealed).toMatchObject({ icon: 'speed', hint: 'Speed 7s', selection: { icon: 'bomb', state: 'held', keybind: 'G' } });
    expect(revealed!.progress).toBeCloseTo(6.2 / C.powerup.buffSeconds);

    room.practiceBuffs!.speedSeconds = 0;
    expect(buildPowerupHudView({ room, ...pickup, rolling: false })).toMatchObject({
      icon: 'bomb', hideMainIcon: true, selection: { icon: 'bomb', state: 'held', keybind: 'G' }
    });
    room.practiceHandItems = [{ kind: 'bomb', hand: 'right' }];
    const activated = buildPowerupHudView({ room, ...idle });
    expect(activated).toMatchObject({ icon: 'bomb', keybind: 'M2', state: 'held' });
    expect(activated!.selection).toBeUndefined();
    room.practiceHandItems = [];
    expect(buildPowerupHudView({ room, ...idle })).toBeNull();
  });

  it('uses every candidate color and never reveals the final inventory name during the roll', () => {
    const room = practiceRoom();
    for (const kind of Object.keys(POWERUP_ITEMS) as PowerupKind[]) {
      const view = buildPowerupHudView({ room, ...idle, heldKind: 'bomb', rolling: true, rollKind: kind, refusal: 'Free a hand' });
      expect(view).toMatchObject({ name: 'Power-up', hint: '', hideMainIcon: true, selection: { icon: kind, color: POWERUP_ITEMS[kind].color, state: 'rolling' } });
    }
    expect(buildPowerupHudView({ room, ...idle, heldKind: 'heal' })).toMatchObject({ selection: { icon: 'heal', state: 'held' } });
  });

  it('keeps every running buff and practice armor count in the status while inventory rolls', () => {
    const room = practiceRoom();
    Object.assign(room.practiceBuffs!, { speedSeconds: 2.5, adrenalineSeconds: 7.5, magnetSeconds: 11 });
    room.practiceArmorCount = 2;
    expect(buildPowerupHudView({ room, ...idle, heldKind: 'cannon', rolling: true })).toMatchObject({
      icon: 'speed', expiring: true, hint: `Speed 3s · Adrenaline 8s · Magnet 11s · Armor 2/${C.powerup.armorCap}`,
      selection: { state: 'rolling' }
    });
    Object.assign(room.practiceBuffs!, { speedSeconds: 0, adrenalineSeconds: 0, magnetSeconds: 0 });
    expect(buildPowerupHudView({ room, ...idle })).toMatchObject({ icon: 'armor', state: 'active', hint: `Armor 2/${C.powerup.armorCap}` });
    room.practiceArmorCount = 0;
    expect(buildPowerupHudView({ room, ...idle })).toBeNull();
  });

  it('retains equipped online heal, bomb, cannon, and grenades while another inventory item rolls', () => {
    const room = practiceRoom();
    const local = createPlayerState('viewer', 'blue');
    for (const kind of ['heal', 'bomb', 'cannon', 'shock', 'stun'] as const) {
      room.balls.item = holdBall(createBallState('item', { x: 0, y: 0, z: 0 }, { kind }), local.id, 'left');
      local.hands.left.heldBallId = 'item';
      const view = buildPowerupHudView({ room, local, ...idle, heldKind: 'speed', rolling: true });
      expect(view).toMatchObject({ icon: kind, keybind: 'M1', state: 'held', selection: { state: 'rolling' } });
    }
  });

  it('updates online grenade charges and removes the equipment after the last throw', () => {
    const room = practiceRoom();
    const local = createPlayerState('viewer', 'blue');
    room.balls.grenade = holdBall(createBallState('grenade', { x: 0, y: 0, z: 0 }, { kind: 'shock' }), local.id, 'right');
    local.hands.right.heldBallId = 'grenade';
    for (let remaining = C.powerup.grenadeCharges; remaining > 0; remaining--) {
      local.pendingGrenades = remaining - 1;
      expect(buildPowerupHudView({ room, local, ...idle })).toMatchObject({
        icon: 'shock', keybind: 'M2', hint: `${remaining} throw${Number(remaining) === 1 ? '' : 's'} left`, progress: remaining / C.powerup.grenadeCharges
      });
    }
    local.hands.right.heldBallId = null;
    expect(buildPowerupHudView({ room, local, ...idle })).toBeNull();
  });

  it('preserves practice grenade support and shows the second hand item in the status', () => {
    const room = practiceRoom();
    room.practiceGrenade = { kind: 'stun', hand: 'left', remaining: 2 };
    expect(buildPowerupHudView({ room, ...idle })).toMatchObject({ icon: 'stun', hint: '2 throws left', keybind: 'M1' });
    room.practiceHandItems = [{ kind: 'heal', hand: 'left' }, { kind: 'bomb', hand: 'right' }];
    expect(buildPowerupHudView({ room, ...idle })!.hint).toContain('BOMB BALL M2');
  });

  it('renders healing and spawn states when no item remains, with no stale side selection', () => {
    const room = practiceRoom();
    room.powerups!.stations.push({ id: 'heal', placerId: 'practice', teamId: 'blue', position: { x: 0, y: 0, z: 0 }, remainingSeconds: 10, progress: { practice: 3 } });
    const healing = buildPowerupHudView({ room, ...idle });
    expect(healing).toMatchObject({ icon: 'heal', state: 'active', progress: 3 / C.powerup.healSeconds });
    expect(healing!.selection).toBeUndefined();
    room.powerups!.stations = [];
    expect(buildPowerupHudView({ room, ...idle, waitSeconds: 5 })).toMatchObject({ state: 'waiting', hint: 'Power-up in 5s' });
    room.powerups!.spawns.push({ x: 0, z: 0, spawned: true, waitSeconds: 0 });
    expect(buildPowerupHudView({ room, ...idle })).toMatchObject({ state: 'empty', hint: 'Power-up available' });
  });

  it('waits for a private inventory identity and clears for disabled powerups or elimination', () => {
    const room = practiceRoom();
    const local = createPlayerState('viewer', 'blue', 'negativeZ', { hasPowerup: true });
    expect(buildPowerupHudView({ room, local, ...idle })).toMatchObject({ selection: { icon: 'mystery', state: 'rolling', keybind: '' } });
    expect(buildPowerupHudView({ room, local, ...idle, heldKind: 'heal', refusal: 'Free a hand' })).toMatchObject({ hint: 'Free a hand' });
    local.combatState = 'eliminated';
    expect(buildPowerupHudView({ room, local, ...idle, heldKind: 'heal', rolling: true })).toBeNull();
    room.settings.powerupsEnabled = false;
    expect(buildPowerupHudView({ room, ...idle, heldKind: 'heal' })).toBeNull();
  });
});
