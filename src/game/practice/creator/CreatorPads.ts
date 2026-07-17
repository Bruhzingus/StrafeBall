/**
 * Creator Sandbox — ability pad runtime (Playtest only).
 *
 * Ability pads are flat, walk-over marker modules used by Creator Playtest and the live yard. They
 * apply a movement effect when the player stands on them. Detection is a per-frame oriented-footprint test (the pad's scaled size IS
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
import { CreatorLayout, CreatorLayoutObject, objectDimensions } from './CreatorLayout';
import type { CreatorMovers, MoverOffset } from './CreatorMovers';

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
  /** How far above the pad top the player's feet can be and still count as touching it (m). */
  activationHeight: 1.7,
  /** How far below the pad base the feet can be and still count (small slack for uneven ground). */
  activationDepth: 0.6,
  /** Long moves are teleports/free-fly landings, not a physical step across a pad. */
  maxSweepDistance: 24,
  /** Lift applied when launching a GROUNDED player so the ground snap can't re-glue them (m). */
  launchLift: 0.05
} as const;

const DEG2RAD = Math.PI / 180;
type PadProbePoint = { x: number; y: number; z: number };

/**
 * Pure oriented trigger-volume test shared by the pad runtime and the course-run controller: is the
 * point (px,py,pz) — padded by `radius` horizontally — inside the object's Y-rotated box volume of
 * half-width/height/half-depth, based at the object's Y? Babylon-free.
 */
export function insideOrientedVolume(
  obj: CreatorLayoutObject,
  px: number,
  py: number,
  pz: number,
  halfW: number,
  height: number,
  halfD: number,
  radius: number
): boolean {
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

/** Trigger-volume test using the object's metadata.trigger dims (falling back to its scaled size). */
export function insideObjectTrigger(obj: CreatorLayoutObject, px: number, py: number, pz: number, radius: number): boolean {
  const trig = obj.metadata?.trigger;
  const dims = objectDimensions(obj);
  const halfW = (trig ? trig.width : dims[0]) / 2;
  const height = trig ? trig.height : dims[1];
  const halfD = (trig ? trig.depth : dims[2]) / 2;
  return insideOrientedVolume(obj, px, py, pz, halfW, height, halfD, radius);
}

/**
 * Swept companion to insideObjectTrigger. It catches a player crossing a thin gate entirely between
 * render frames (high-strength speed pads and low frame rates can otherwise tunnel through it).
 * Very long segments are treated as teleports and deliberately ignored.
 */
export function segmentCrossesObjectTrigger(
  obj: CreatorLayoutObject,
  from: PadProbePoint,
  to: PadProbePoint,
  radius: number,
  maxDistance = PAD_TUNING.maxSweepDistance
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  if (dx * dx + dy * dy + dz * dz > maxDistance * maxDistance) return false;

  const trigger = obj.metadata?.trigger;
  const dims = objectDimensions(obj);
  const halfW = (trigger ? trigger.width : dims[0]) / 2 + radius;
  const halfD = (trigger ? trigger.depth : dims[2]) / 2 + radius;
  const minY = obj.position[1] - 0.2;
  const maxY = obj.position[1] + (trigger ? trigger.height : dims[1]) + 0.2;
  if (Math.max(from.y, to.y) < minY || Math.min(from.y, to.y) > maxY) return false;

  const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  const local = (point: PadProbePoint) => {
    const px = point.x - obj.position[0];
    const pz = point.z - obj.position[2];
    return { x: cos * px - sin * pz, z: sin * px + cos * pz };
  };
  const a = local(from);
  const b = local(to);
  return segmentIntersectsRect(a.x, a.z, b.x, b.z, halfW, halfD);
}

function segmentIntersectsRect(x0: number, z0: number, x1: number, z1: number, halfW: number, halfD: number): boolean {
  let tMin = 0;
  let tMax = 1;
  const clipAxis = (start: number, end: number, min: number, max: number): boolean => {
    const delta = end - start;
    if (Math.abs(delta) < 1e-6) return start >= min && start <= max;
    let a = (min - start) / delta;
    let b = (max - start) / delta;
    if (a > b) [a, b] = [b, a];
    tMin = Math.max(tMin, a);
    tMax = Math.min(tMax, b);
    return tMin <= tMax;
  };
  return clipAxis(x0, x1, -halfW, halfW) && clipAxis(z0, z1, -halfD, halfD);
}

export class CreatorPads {
  // Impulse pads disarm after firing; the timer counts down while the player stays on the pad and is
  // cleared the moment they step off, so leaving + returning re-fires immediately.
  private readonly cooldownById = new Map<string, number>();
  private readonly occupied = new Set<string>();
  private previousPlayerPosition: PadProbePoint | null = null;
  // Most-recently-touched checkpoint (kill blocks respawn you here, or at spawn if none touched yet).
  private lastCheckpoint: { x: number; y: number; z: number; yaw: number } | null = null;
  // Set per frame from update()'s args; kept as fields so the per-object helpers can read them without
  // threading two extra params through every call. Both are optional creator-trigger features.
  private movers: CreatorMovers | null = null;
  private disabledObjects: ReadonlySet<string> | null = null;
  private readonly scratchOffset: MoverOffset = { x: 0, y: 0, z: 0 };

  /** Clear all per-pad state (call when entering a fresh Playtest run). */
  reset(): void {
    this.cooldownById.clear();
    this.occupied.clear();
    this.previousPlayerPosition = null;
    this.lastCheckpoint = null;
  }

  /**
   * Forget only the swept-from position, so the NEXT frame's pad/kill sweep doesn't span a teleport.
   * Unlike reset() this keeps the player's checkpoint + pad cooldowns — a trigger teleport is a
   * shortcut, not a fresh run.
   */
  clearSweep(): void {
    this.previousPlayerPosition = null;
  }

  /**
   * Run one frame of pad effects. Call in Playtest / the live yard AFTER the player movement update.
   * Returns true when a kill block killed (and respawned) the player this frame, so the course-run
   * controller can reset a live timed run.
   *
   * `movers` lets a pad/kill/gate mounted on a moving platform ride it (its volume follows the
   * platform); `disabledObjects` is the trigger runtime's disabled-id set — a disabled pad/kill/gate
   * does nothing this frame. Both optional; omitting them is the pre-trigger behaviour exactly.
   */
  update(
    dt: number,
    layout: CreatorLayout,
    player: PlayerController,
    movers: CreatorMovers | null = null,
    disabledObjects: ReadonlySet<string> | null = null
  ): boolean {
    this.movers = movers;
    this.disabledObjects = disabledObjects;
    for (const [id, t] of this.cooldownById) {
      const next = t - dt;
      if (next <= 0) this.cooldownById.delete(id);
      else this.cooldownById.set(id, next);
    }

    const p = player.root.position;
    const previous = this.previousPlayerPosition;
    const r = TUNING.player.radius;

    // Checkpoints: touching a checkpoint gate's trigger volume records it as the respawn point.
    for (const obj of layout.objects) {
      if (obj.type !== 'checkpoint_gate') continue;
      if (this.isDisabled(obj.id)) continue;
      const off = this.offsetFor(obj.id);
      if (insideObjectTrigger(obj, p.x - off.x, p.y - off.y, p.z - off.z, r)) {
        const floorY = layout.ground.bounds.y ?? 0;
        const checkpoint = {
          x: obj.position[0] + off.x,
          y: Math.max(floorY, obj.position[1] + off.y),
          z: obj.position[2] + off.z,
          yaw: (obj.rotation[1] ?? 0) * DEG2RAD
        };
        this.lastCheckpoint = checkpoint;
        player.setRespawn(new Vector3(checkpoint.x, checkpoint.y, checkpoint.z), checkpoint.yaw);
      }
    }

    // Kill blocks: entering one resets you to the last checkpoint (or spawn). Skip pads this frame.
    for (const obj of layout.objects) {
      if (obj.type !== 'kill_block') continue;
      if (this.isDisabled(obj.id)) continue;
      const off = this.offsetFor(obj.id);
      const [w, h, d] = objectDimensions(obj);
      if (insideOrientedVolume(obj, p.x - off.x, p.y - off.y, p.z - off.z, w / 2, h, d / 2, r)) {
        if (this.lastCheckpoint) {
          const target = this.lastCheckpoint;
          player.teleportTo(new Vector3(target.x, target.y, target.z), target.yaw, 0);
        } else {
          // The host owns the correct reset point: editor Playtest may intentionally use a temporary
          // test spawn, while the live yard always configures the real course spawn.
          player.resetPosition();
        }
        // Death is a fresh start: refill stamina + clear the backflip cooldown, same as a K reset —
        // the attempt that killed you shouldn't also drain the retry.
        player.dash.refill();
        player.backflip.cooldown = 0;
        this.rememberPlayerPosition(player.root.position);
        return true;
      }
    }

    const stillOn = new Set<string>();

    for (const obj of layout.objects) {
      const kind = padKind(obj.type);
      if (!kind) continue;
      if (this.isDisabled(obj.id)) continue;
      if (!this.isOnPad(obj, p.x, p.y, p.z, r, previous, this.offsetFor(obj.id))) continue;
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
    this.rememberPlayerPosition(p);
    return false;
  }

  /**
   * Oriented footprint test. Uses the current point plus a short XZ sweep from the previous point so a
   * fast render tick cannot skip over a walk-over pad. `off` is the pad's live mover offset (0 for a
   * static pad): the probe (current AND previous) is shifted by −off, which is equivalent to moving
   * the pad by +off, so a pad mounted on a platform tests against where the platform now is.
   */
  private isOnPad(
    obj: CreatorLayoutObject,
    px: number,
    py: number,
    pz: number,
    radius: number,
    previous: PadProbePoint | null,
    off: MoverOffset
  ): boolean {
    const sx = px - off.x;
    const sy = py - off.y;
    const sz = pz - off.z;
    const prevX = previous ? previous.x - off.x : 0;
    const prevY = previous ? previous.y - off.y : 0;
    const prevZ = previous ? previous.z - off.z : 0;

    const base = obj.position[1];
    const [w, h, d] = objectDimensions(obj);
    const minY = base - PAD_TUNING.activationDepth;
    const maxY = base + Math.max(0, h) + PAD_TUNING.activationHeight;
    const probeMinY = previous ? Math.min(prevY, sy) : sy;
    const probeMaxY = previous ? Math.max(prevY, sy) : sy;
    if (probeMaxY < minY || probeMinY > maxY) return false;

    const halfW = w / 2 + radius;
    const halfD = d / 2 + radius;
    const current = this.padLocalPoint(obj, sx, sz);
    if (this.localPointInPad(current.x, current.z, halfW, halfD)) return true;

    if (!previous) return false;
    const sweepDx = sx - prevX;
    const sweepDz = sz - prevZ;
    if (sweepDx * sweepDx + sweepDz * sweepDz > PAD_TUNING.maxSweepDistance * PAD_TUNING.maxSweepDistance) {
      return false;
    }
    const prev = this.padLocalPoint(obj, prevX, prevZ);
    return this.localSegmentIntersectsPad(prev.x, prev.z, current.x, current.z, halfW, halfD);
  }

  private isDisabled(objectId: string): boolean {
    return this.disabledObjects?.has(objectId) ?? false;
  }

  /** The pad's current mover offset (or {0,0,0}); shared scratch, so read before the next call. */
  private offsetFor(objectId: string): MoverOffset {
    const s = this.scratchOffset;
    s.x = 0; s.y = 0; s.z = 0;
    this.movers?.offsetOf(objectId, s);
    return s;
  }

  private padLocalPoint(obj: CreatorLayoutObject, px: number, pz: number): { x: number; z: number } {
    const ry = (obj.rotation[1] ?? 0) * DEG2RAD;
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    const dx = px - obj.position[0];
    const dz = pz - obj.position[2];
    return { x: cos * dx - sin * dz, z: sin * dx + cos * dz };
  }

  private localPointInPad(x: number, z: number, halfW: number, halfD: number): boolean {
    return Math.abs(x) <= halfW && Math.abs(z) <= halfD;
  }

  private localSegmentIntersectsPad(x0: number, z0: number, x1: number, z1: number, halfW: number, halfD: number): boolean {
    return segmentIntersectsRect(x0, z0, x1, z1, halfW, halfD);
  }

  private rememberPlayerPosition(position: Vector3): void {
    this.previousPlayerPosition = { x: position.x, y: position.y, z: position.z };
  }

  private applyBounce(obj: CreatorLayoutObject, player: PlayerController): void {
    const strength = clampStrength(obj.metadata?.padStrength);
    const launch = PAD_TUNING.bounceLaunchSpeed * strength;
    const v = player.movement.velocity;
    if (v.y < launch) v.y = launch;
    this.liftOffGround(player);
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
    this.liftOffGround(player);
  }

  /**
   * A launch from the GROUND must also lift the player out of ground-snap range. The movement pass
   * re-grounds purely by position (updateGroundState) and its end-of-frame snap (groundSnapDistance
   * 0.67m > one frame of launch rise) glues a grounded player straight back to the floor with the
   * launch velocity intact — so walking onto a pad did nothing while jumping into it worked. The
   * small hop puts the next frame's ground check into its airborne branch, where the launch carries.
   */
  private liftOffGround(player: PlayerController): void {
    if (player.movement.grounded) player.root.position.y += PAD_TUNING.launchLift;
    player.movement.grounded = false;
  }
}

function clampStrength(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(0.1, Math.min(20, value));
}
