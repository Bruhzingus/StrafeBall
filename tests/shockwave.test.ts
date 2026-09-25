import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { stepMovement } from '../shared/simulation/MovementSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import { shockwavePlayerVelocity } from '../shared/simulation/ShockwaveSim';
import type { PlayerInput, Vec3 } from '../shared/types';

const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const neutralInput = (): PlayerInput => ({
  moveX: 0,
  moveZ: 0,
  lookYawRadians: 0,
  lookPitchRadians: 0,
  dashDirection: v()
} as PlayerInput);

describe('shockwave launch', () => {
  it('adds a point-blank blast to jump momentum and carries a perfectly aligned player across the court', () => {
    const player = createPlayerState('jumper', 'blue');
    const start = v(0, 0.05, -18.7);
    const blast = v(0, 0.1, -19.3);
    const launched = shockwavePlayerVelocity(
      start,
      v(0, C.player.jumpSpeed, 0),
      blast,
      v(0, 0, 1)
    );

    expect(launched).not.toBeNull();
    expect(launched!.z).toBeGreaterThan(60);
    expect(launched!.y).toBeGreaterThan(C.powerup.shockPlayerLift);

    let movement = { ...player.movement, position: start, velocity: launched!, grounded: false };
    let internal = player.movementInternal;
    let dash = player.dash;
    let maxZ = start.z;
    const input = neutralInput();

    for (let tick = 0; tick < 180; tick += 1) {
      const result = stepMovement(movement, internal, dash, input, input, 1 / 60, [], false);
      movement = result.movement;
      internal = result.internal;
      dash = result.dash;
      maxZ = Math.max(maxZ, movement.position.z);
      if (tick > 0 && movement.grounded) break;
    }

    // The arena wall clamps the final position; reaching its far edge is the full-court launch.
    expect(maxZ).toBeGreaterThan(C.map.halfLength - C.player.radius - 0.1);
  });
});
