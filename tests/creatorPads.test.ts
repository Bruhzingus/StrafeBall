import { Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { CreatorPads, PAD_TUNING } from '../src/game/practice/creator/CreatorPads';
import { validateLayout, type CreatorLayout, type Vec3Tuple } from '../src/game/practice/creator/CreatorLayout';
import type { PlayerController } from '../src/game/player/PlayerController';

function bouncePadLayout(position: Vec3Tuple = [0, 0, 0], rotationY = 0): CreatorLayout {
  return validateLayout({
    name: 'pad test',
    ground: { bounds: { width: 40, depth: 40, y: 0 }, material: 'ground' },
    objects: [
      {
        id: 'bounce',
        type: 'bounce_pad',
        position,
        rotation: [0, rotationY, 0],
        scale: [1, 1, 1],
        metadata: { label: 'BOUNCE', padStrength: 1 }
      }
    ]
  }).layout;
}

function fakePlayer(position: Vector3): PlayerController {
  const player = {
    root: { position: position.clone() },
    movement: { velocity: Vector3.Zero(), grounded: true },
    dash: { refill: () => undefined },
    backflip: { cooldown: 1 },
    teleportTo(pos: Vector3) {
      this.root.position.copyFrom(pos);
    }
  };
  return player as unknown as PlayerController;
}

describe('CreatorPads', () => {
  it('launches when the player is on a bounce pad footprint', () => {
    const pads = new CreatorPads();
    const player = fakePlayer(new Vector3(0, 0, 0));

    pads.update(1 / 60, bouncePadLayout(), player);

    expect(player.movement.velocity.y).toBe(PAD_TUNING.bounceLaunchSpeed);
    expect(player.movement.grounded).toBe(false);
  });

  it('launches when a fast frame crosses the bounce pad footprint', () => {
    const pads = new CreatorPads();
    const layout = bouncePadLayout();
    const player = fakePlayer(new Vector3(-4, 0, 0));

    pads.update(1 / 60, layout, player);
    expect(player.movement.velocity.y).toBe(0);

    player.root.position.set(4, 0, 0);
    player.movement.velocity.set(480, 0, 0);
    pads.update(1 / 60, layout, player);

    expect(player.movement.velocity.y).toBe(PAD_TUNING.bounceLaunchSpeed);
    expect(player.movement.grounded).toBe(false);
  });

  it('does not fire from a long teleport sweep across the pad', () => {
    const pads = new CreatorPads();
    const layout = bouncePadLayout();
    const player = fakePlayer(new Vector3(-40, 0, 0));

    pads.update(1 / 60, layout, player);
    player.root.position.set(40, 0, 0);
    pads.update(1 / 60, layout, player);

    expect(player.movement.velocity.y).toBe(0);
    expect(player.movement.grounded).toBe(true);
  });
});
