/**
 * Creator Sandbox — ability pad runtime (Playtest only).
 *
 * Ability pads are flat, walk-over marker modules that apply a movement effect when the player stands
 * on them during Playtest. Detection is a per-frame oriented-footprint test (the pad's scaled size IS
 * its trigger area, so resizing a pad resizes its effect zone), run AFTER the movement step so the
 * effect it writes into the player's velocity carries into the next tick.
 *
 * Kinds:
 *   - stamina : refills stamina (dash charges) — continuous while stood on.
 *   - backflip: clears the backflip cooldown so you can flip again — continuous while stood on.
 *   - speed   : Fortnite-style boost — sets horizontal velocity along the pad's facing (+ small hop).
 *   - bounce  : trampoline — launches the player straight up.
 * Speed/bounce are impulses: they re-trigger only after the player leaves + re-enters the pad (or a
 * short cooldown elapses), so a single touch fires once rather than every frame.
 *
 * Local/offline only. Never read by the server, shared simulation, prediction, or networking.
 */

import { Vector3 } from '@babylonjs/core';
import { PlayerController } from '../../player/PlayerController';
import { TUNING } from '../../config/tuning';
import { CreatorLayout, CreatorLayoutObject, objectDimensions, layoutSpawn } from './CreatorLayout';

export type PadKind = 'stamina' | 'backflip' | 'speed' | 'bounce';

const PAD_KIND_BY_TYPE: Record<string, PadKind> = {
  stamina_pad: 'stamina',
  backflip_pad: 'backflip',
  speed_pad: 'speed',
  bounce_pad: 'bounce'
};

/** The ability-pad kind for a module type, or null if it isn't an ability pad. */
export function padKind(type: string): PadKind | null {
  return PAD_KIND_BY_TYPE[type] ?? null;
}

export const PAD_TUNING = {
  /** Bounce pad: upward launch speed (m/s) at strength 1 (~2.5× a normal jump → a clear trampoline). */
  bounceLaunchSpeed: 13,
  /** Speed pad: horizontal boost speed (m/s) along the pad facing, at strength 1. */
  speedBoostSpeed: 15,
  /** Speed pad: small upward hop (m/s) so the boost reads as a launch and clears tiny lips. */
  speedBoostUp: 3,
  /** Seconds an impulse pad (bounce/speed) stays disarmed after firing while the player stays on it. */
  retriggerSeconds: 0.35,
  /** How far above the pad base the player's feet can be and still count as standing on it (m). */
  activationHeight: 1.7,
  /** How far below the pad base the feet can be and still count (small slack for uneven ground). */
  activationDepth: 0.6
} as const;

const DEG2RAD = Math.PI / 180;

export class CreatorPads {
  // Impulse pads disarm after firing; the timer counts down while the player stays on the pad and is
  // cleared the moment they step off, so leaving + returning re-fires immediately.
  private readonly cooldownById = new Map<string, number>();
  private readonly occupied = new Set<string>();
  // Most-recently-touched checkpoint (kill blocks respawn you here, or at spawn if none touched yet).
  private lastCheckpoint: { x: number; y: number; z: number; yaw: number } | null = null;

  /** Clear all per-pad state (call when entering a fresh Playtest run). */
  reset(): void {
    this.cooldownById.clear();
    this.occupied.clear();
    this.lastCheckpoint = null;
  }

  /** Run one frame of pad effects. Call in Playtest AFTER the player movement update. */
  update(dt: number, layout: CreatorLayout, player: PlayerController): void {
    for (const [id, t] of this.cooldownById) {
      const next = t - dt;
      if (next <= 0) this.cooldownById.delete(id);
      else this.cooldownById.set(id, next);
    }

    const p = player.root.position;
    const r = TUNING.player.radius;

    // Checkpoints: touching a checkpoint gate's trigger volume records it as the respawn point.
    for (const obj of layout.objects) {
      if (obj.type !== 'checkpoint_gate' || obj.visible === false) continue;
      const trig = obj.metadata?.trigger;
      const dims = objectDimensions(obj);
      const halfW = (trig ? trig.width : dims[0]) / 2;
      const height = trig ? trig.height : dims[1];
      const halfD = (trig ? trig.depth : dims[2]) / 2;
      if (this.insideOrientedBox(obj, p.x, p.y, p.z, halfW, height, halfD, r)) {
        const floorY = layout.ground.bounds.y ?? 0;
        this.lastCheckpoint = { x: obj.position[0], y: Math.max(floorY, obj.position[1]), z: obj.position[2], yaw: (obj.rotation[1] ?? 0) * DEG2RAD };
      }
    }

    // Kill blocks: entering one resets you to the last checkpoint (or spawn). Skip pads this frame.
    for (const obj of layout.objects) {
      if (obj.type !== 'kill_block' || obj.visible === false) continue;
      const [w, h, d] = objectDimensions(obj);
      if (this.insideOrientedBox(obj, p.x, p.y, p.z, w / 2, h, d / 2, r)) {
        const target = this.lastCheckpoint ?? layoutSpawn(layout);
        player.teleportTo(new Vector3(target.x, target.y, target.z), target.yaw, 0);
        return;
      }
    }

    const stillOn = new Set<string>();

    for (const obj of layout.objects) {
      const kind = padKind(obj.type);
      if (!kind || obj.visible === false) continue;
      if (!this.isOnPad(obj, p.x, p.y, p.z, r)) continue;
      stillOn.add(obj.id);

      if (kind === 'stamina') {
        player.dash.refill();
        continue;
      }
      if (kind === 'backflip') {
        player.backflip.cooldown = 0;
        continue;
      }
      // Impulse pads (speed / bounce): fire once per touch (gated by the re-trigger cooldown).
      if ((this.cooldownById.get(obj.id) ?? 0) > 0) continue;
      if (kind === 'bounce') this.applyBounce(obj, player);
      else this.applySpeed(obj, player);
      this.cooldownById.set(obj.id, PAD_TUNING.retriggerSeconds);
    }

    // Stepping off a pad clears its cooldown so returning re-fires without waiting.
    for (const id of this.occupied) {
      if (!stillOn.has(id)) this.cooldownById.delete(id);
    }
    this.occupied.clear();
    for (const id of stillOn) this.occupied.add(id);
  }

  /** Is the player's point inside an oriented (Y-rotated) box volume based at the object (checkpoint/kill)? */
  private insideOrientedBox(obj: CreatorLayoutObject, px: number, py: number, pz: number, halfW: number, height: number, halfD: number, radius: number): boolean {
    const base = obj.position[1];
    if (py < base - 0.2 || py > base + height + 0.2) return false;
    const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    const dx = px - obj.position[0];
    const dz = pz - obj.position[2];
    const lx = cos * dx - sin * dz;
    const lz = sin * dx + cos * dz;
    return Math.abs(lx) <= halfW + radius && Math.abs(lz) <= halfD + radius;
  }

  /** Oriented footprint test: is the player standing within (and roughly at the height of) the pad? */
  private isOnPad(obj: CreatorLayoutObject, px: number, py: number, pz: number, radius: number): boolean {
    const base = obj.position[1];
    if (py > base + PAD_TUNING.activationHeight || py < base - PAD_TUNING.activationDepth) return false;
    const [w, , d] = objectDimensions(obj);
    const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    const dx = px - obj.position[0];
    const dz = pz - obj.position[2];
    const lx = cos * dx - sin * dz;
    const lz = sin * dx + cos * dz;
    return Math.abs(lx) <= w / 2 + radius && Math.abs(lz) <= d / 2 + radius;
  }

  private applyBounce(obj: CreatorLayoutObject, player: PlayerController): void {
    const strength = clampStrength(obj.metadata?.padStrength);
    const launch = PAD_TUNING.bounceLaunchSpeed * strength;
    const v = player.movement.velocity;
    if (v.y < launch) v.y = launch;
    player.movement.grounded = false;
  }

  private applySpeed(obj: CreatorLayoutObject, player: PlayerController): void {
    const strength = clampStrength(obj.metadata?.padStrength);
    const boost = PAD_TUNING.speedBoostSpeed * strength;
    // Pad facing: local +Z after the object's Y-rotation (matches the on-pad direction chevron).
    const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
    const dirX = Math.sin(ry);
    const dirZ = Math.cos(ry);
    const v = player.movement.velocity;
    v.x = dirX * boost;
    v.z = dirZ * boost;
    if (v.y < PAD_TUNING.speedBoostUp) v.y = PAD_TUNING.speedBoostUp;
    player.movement.grounded = false;
  }
}

function clampStrength(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(0.1, Math.min(20, value));
}
