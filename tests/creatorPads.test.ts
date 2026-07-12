import { Vector3 } from '@babylonjs/core';
import { describe, expect, it, vi } from 'vitest';
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
  let respawnPosition = position.clone();
  let respawnYaw = 0;
  const player = {
    root: { position: position.clone() },
    movement: { velocity: Vector3.Zero(), grounded: true },
    dash: { refill: vi.fn() },
    backflip: { cooldown: 1 },
    setRespawn(pos: Vector3, yaw = 0) {
      respawnPosition = pos.clone();
      respawnYaw = yaw;
    },
    resetPosition() {
      this.teleportTo(respawnPosition.clone(), respawnYaw);
    },
    teleportTo(pos: Vector3, _yaw?: number) {
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

  it('lifts a GROUNDED player clear of the ground snap so walking onto the pad launches', () => {
    const pads = new CreatorPads();
    const player = fakePlayer(new Vector3(0, 0, 0));
    player.movement.grounded = true;

    pads.update(1 / 60, bouncePadLayout(), player);

    // Without the lift, the movement pass re-grounds by position and its snap glues the player back
    // to the floor with the launch velocity intact — the bounce only worked when already airborne.
    expect(player.root.position.y).toBe(PAD_TUNING.launchLift);
    expect(player.movement.grounded).toBe(false);
  });

  it('does not lift an already-airborne player', () => {
    const pads = new CreatorPads();
    const player = fakePlayer(new Vector3(0, 0.3, 0));
    player.movement.grounded = false;

    pads.update(1 / 60, bouncePadLayout(), player);

    expect(player.root.position.y).toBe(0.3);
    expect(player.movement.velocity.y).toBe(PAD_TUNING.bounceLaunchSpeed);
  });

  it('does not trigger while the player is airborne well above the pad surface', () => {
    const pads = new CreatorPads();
    const player = fakePlayer(new Vector3(0, 1, 0));
    player.movement.grounded = false;

    pads.update(1 / 60, bouncePadLayout(), player);

    expect(player.movement.velocity.y).toBe(0);
  });

  it('applies stamina/backflip refills and a rotated strength-scaled speed boost', () => {
    const pads = new CreatorPads();
    const player = fakePlayer(new Vector3(0, 0, 0));
    const layout = validateLayout({
      objects: [
        { id: 'stamina', type: 'stamina_pad', position: [0, 0, 0] },
        { id: 'backflip', type: 'backflip_pad', position: [0, 0, 0] },
        { id: 'speed', type: 'speed_pad', position: [0, 0, 0], rotation: [0, 90, 0], metadata: { padStrength: 2 } }
      ]
    }).layout;

    pads.update(1 / 60, layout, player);

    expect(player.dash.refill).toHaveBeenCalled();
    expect(player.backflip.cooldown).toBe(0);
    expect(player.movement.velocity.x).toBeCloseTo(PAD_TUNING.speedBoostSpeed * 2, 5);
    expect(player.movement.velocity.z).toBeCloseTo(0, 5);
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

  it('updates the player respawn when a checkpoint is touched', () => {
    const pads = new CreatorPads();
    const { layout } = validateLayout({
      name: 'checkpoint test',
      ground: { bounds: { width: 40, depth: 40, y: 0 }, material: 'ground' },
      objects: [
        {
          id: 'spawn',
          type: 'spawn_point',
          position: [0, 0, 0],
          rotation: [0, 90, 0],
          scale: [1, 1, 1],
          metadata: { defaultSpawn: true }
        },
        {
          id: 'checkpoint',
          type: 'checkpoint_gate',
          position: [12, 0, 4],
          rotation: [0, 180, 0],
          scale: [1, 1, 1],
          metadata: { triggerType: 'checkpoint', trigger: { width: 6, height: 5, depth: 2 } }
        }
      ]
    });
    const player = fakePlayer(new Vector3(12, 1, 4));

    pads.update(1 / 60, layout, player);
    player.root.position.set(0, 0, 0);
    player.resetPosition();

    expect(player.root.position.x).toBeCloseTo(12, 4);
    expect(player.root.position.y).toBeCloseTo(0, 4);
    expect(player.root.position.z).toBeCloseTo(4, 4);
  });
});
