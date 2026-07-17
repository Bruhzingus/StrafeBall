/**
 * Creator Sandbox — TRIGGER runtime (offline only).
 *
 * A `trigger_volume` is a walk-through box that applies an `action` to OTHER objects when a player or
 * a ball touches it. Detection reuses the pad volume tests (the scaled footprint IS the touch zone),
 * run AFTER the movement step like the pads so an effect written this frame is seen next frame.
 *
 * Targeting is two-channel and resolved LAZILY at fire time, never cached as pointers:
 *   - direct `targets` ids (remapped on copy/paste/prefab so links follow their objects);
 *   - a broadcast `channel`: every object whose `metadata.listenChannel` matches also responds.
 * An id that resolves to nothing (deleted target, layout truncated at the object cap, a co-op upsert
 * that hasn't arrived yet) is simply skipped — a dangling link does nothing, it never throws.
 *
 * Effects (each has an inverse, which is what `toggle`/`while` revert to):
 *   show ↔ hide            visual only (object-root enable)
 *   collide_on ↔ collide_off  the target's colliders + wall faces become (in)tangible live
 *   mover_start ↔ mover_stop   a moving platform's run state
 *   enable ↔ disable          whether a FUNCTIONAL object acts (pads/kill-blocks/triggers), via a
 *                             disabled-id set the pad runtime + this runtime both consult
 *   move                      displaces the target's colliders/faces/visual by `offset` (inverse = −offset)
 *   teleport_player           sends the player to the trigger's own position (targets ignored; no inverse)
 *
 * ALL of this is offline-only creator state — never read by the server, shared sim, prediction, or
 * networking. It sits beside CreatorPads/CreatorMovers and, like them, is reset between attempts.
 */

import { Vector3 } from '@babylonjs/core';
import { AABB } from '../../map/Collider';
import { PlayerController } from '../../player/PlayerController';
import { TUNING } from '../../config/tuning';
import {
  CreatorLayout,
  CreatorLayoutObject,
  CreatorTriggerSpec,
  TriggerAction,
  objectDimensions
} from './CreatorLayout';
import { insideOrientedVolume, segmentCrossesObjectTrigger } from './CreatorPads';
import type { CreatorWallFace } from './CreatorWorld';
import type { CreatorGeometry } from './CreatorGeometry';
import type { CreatorMovers, MoverOffset } from './CreatorMovers';
import type { Ball } from '../../ball/Ball';
import { BallState } from '../../ball/BallState';

type ProbePoint = { x: number; y: number; z: number };

/** The colliders, wall faces and (implicitly) visual node of one object — the effect surface. */
interface ObjectHandles {
  boxes: AABB[];
  faces: CreatorWallFace[];
}

export class CreatorTriggers {
  private layout: CreatorLayout | null = null;
  private geometry: CreatorGeometry | null = null;
  private movers: CreatorMovers | null = null;

  /** Effect surface per object id (colliders + faces), built once at bind. */
  private readonly handles = new Map<string, ObjectHandles>();

  // --- Live effect state (all keyed by TARGET object id) ---
  /** Net move offset currently applied to a target (so toggle/while can revert exactly). */
  private readonly moveOffset = new Map<string, { x: number; y: number; z: number }>();
  /** Objects a trigger has DISABLED — consulted by this runtime AND the pad runtime. */
  private readonly disabled = new Set<string>();
  /** Objects a trigger has hidden / made intangible (re-applied after a geometry rebuild). */
  private readonly hidden = new Set<string>();
  private readonly intangible = new Set<string>();

  // --- Per-trigger fire state (keyed by TRIGGER object id) ---
  private readonly firedOnce = new Set<string>(); // 'once': already fired this run
  private readonly occupied = new Set<string>(); // currently occupied (edge detection)
  private readonly toggleOn = new Set<string>(); // 'toggle': current side
  private previousPlayerPosition: ProbePoint | null = null;

  private balls: readonly Ball[] = [];
  private readonly scratch: MoverOffset = { x: 0, y: 0, z: 0 };

  /**
   * Bind to a freshly built world: the layout, the built colliders (matched by id prefix), the built
   * wall faces (matched by objectId), the geometry (for show/hide), the movers (for start/stop + so
   * trigger volumes mounted on a platform ride it), and the collider id prefix. Call after
   * build/rebuild; clears all live effect + fire state.
   */
  build(
    layout: CreatorLayout,
    collisionBoxes: readonly AABB[],
    runFaces: readonly CreatorWallFace[],
    bounceFaces: readonly CreatorWallFace[],
    geometry: CreatorGeometry | null,
    movers: CreatorMovers | null,
    idPrefix: string
  ): void {
    this.layout = layout;
    this.geometry = geometry;
    this.movers = movers;
    this.handles.clear();
    for (const obj of layout.objects) {
      const boxes = collisionBoxes.filter((b) => b.id?.startsWith(`${idPrefix}${obj.id}_`));
      const faces = [
        ...runFaces.filter((f) => f.objectId === obj.id),
        ...bounceFaces.filter((f) => f.objectId === obj.id)
      ];
      if (boxes.length > 0 || faces.length > 0) this.handles.set(obj.id, { boxes, faces });
    }
    this.reset();
  }

  /** Balls that can fire ball-activated triggers (host-owned; [] for none). */
  setBalls(balls: readonly Ball[]): void {
    this.balls = balls;
  }

  /** Ids a trigger has disabled — the pad runtime skips these so disable also silences pads/kills. */
  disabledObjects(): ReadonlySet<string> {
    return this.disabled;
  }

  /**
   * Clear all live effect + fire state and return every target to its authored look/solidity/place.
   * Called on a fresh attempt (playtest/run start, K reset, yard entry) so triggers are repeatable.
   */
  reset(): void {
    // Undo any lingering effects first, so re-entering a course doesn't leave a wall hidden/moved.
    for (const id of this.hidden) this.geometry?.setObjectVisible(id, true);
    for (const id of this.intangible) this.setTangible(id, true);
    for (const id of Array.from(this.moveOffset.keys())) this.translateTarget(id, 0, 0, 0);
    this.moveOffset.clear();
    this.disabled.clear();
    this.hidden.clear();
    this.intangible.clear();
    this.firedOnce.clear();
    this.occupied.clear();
    this.toggleOn.clear();
    this.previousPlayerPosition = null;
  }

  /**
   * One frame of trigger evaluation, AFTER the movement step. Returns true if a trigger teleported
   * the player this frame, so the host can clear the pad sweep (like a K reset) — a teleport must not
   * sweep a bogus segment through pads/gates.
   */
  update(dt: number, layout: CreatorLayout, player: PlayerController): boolean {
    this.layout = layout;
    const p = player.root.position;
    const r = TUNING.player.radius;
    // Mutable sweep origin: a teleport mid-loop nulls it, so triggers LATER in this same frame test
    // only the player's new point — without this, their sweep would span pre-jump → post-jump and a
    // teleport across the map could phantom-fire every thin trigger between the two points.
    let previous = this.previousPlayerPosition;
    let teleported = false;

    for (const obj of layout.objects) {
      if (obj.type !== 'trigger_volume') continue;
      const spec = obj.metadata?.triggerSpec;
      if (!spec) continue;
      if (this.disabled.has(obj.id)) {
        // A disabled trigger neither fires nor holds occupancy — but keep its occupied flag cleared so
        // re-enabling it requires a fresh entry rather than instantly firing.
        this.occupied.delete(obj.id);
        continue;
      }

      const occupiedNow = this.isTouched(obj, spec, p, previous, r);
      const wasOccupied = this.occupied.has(obj.id);
      if (occupiedNow) this.occupied.add(obj.id);
      else this.occupied.delete(obj.id);

      // Fire on the RISING edge (fresh entry) for once/every/toggle; 'while' tracks both edges.
      const entered = occupiedNow && !wasOccupied;
      const left = !occupiedNow && wasOccupied;

      let firedTeleport = false;
      switch (spec.fire) {
        case 'once':
          if (entered && !this.firedOnce.has(obj.id)) {
            this.firedOnce.add(obj.id);
            firedTeleport = this.applyAction(obj, spec, player, false);
          }
          break;
        case 'every':
          if (entered) firedTeleport = this.applyAction(obj, spec, player, false);
          break;
        case 'toggle':
          if (entered) {
            const on = !this.toggleOn.has(obj.id);
            if (on) this.toggleOn.add(obj.id);
            else this.toggleOn.delete(obj.id);
            firedTeleport = this.applyAction(obj, spec, player, !on);
          }
          break;
        case 'while':
          if (entered) firedTeleport = this.applyAction(obj, spec, player, false);
          else if (left) this.applyAction(obj, spec, player, true); // teleport can't be a 'while' action
          break;
      }
      if (firedTeleport) {
        teleported = true;
        previous = null;
      }
    }

    // `p` is the LIVE root position, so after a teleport this records the post-jump point.
    this.previousPlayerPosition = { x: p.x, y: p.y, z: p.z };
    return teleported;
  }

  /** Is this trigger touched by whatever can fire it (player and/or a non-held ball)? */
  private isTouched(
    obj: CreatorLayoutObject,
    spec: CreatorTriggerSpec,
    p: Vector3,
    previous: ProbePoint | null,
    r: number
  ): boolean {
    // Ride a moving platform: shift the PROBE by −offset instead of the volume by +offset (same test,
    // no per-frame volume rebuild). Zero for a static trigger.
    const off = this.moverOffset(obj.id);
    if (spec.by === 'player' || spec.by === 'any') {
      if (this.pointOrSweepInside(obj, p.x - off.x, p.y - off.y, p.z - off.z, previous, off, r)) return true;
    }
    if (spec.by === 'ball' || spec.by === 'any') {
      const br = TUNING.ball.radius;
      for (const ball of this.balls) {
        if (ball.state === BallState.Held) continue; // a held ball never fires (you'd carry it through)
        const b = ball.mesh.position;
        if (insideOrientedTriggerVolume(obj, b.x - off.x, b.y - off.y, b.z - off.z, br)) return true;
      }
    }
    return false;
  }

  private pointOrSweepInside(
    obj: CreatorLayoutObject,
    px: number,
    py: number,
    pz: number,
    previous: ProbePoint | null,
    off: MoverOffset,
    r: number
  ): boolean {
    if (insideOrientedTriggerVolume(obj, px, py, pz, r)) return true;
    // A fast player can cross a thin trigger between frames; sweep from the previous point (also
    // shifted into the platform's frame). Long jumps are teleports and deliberately ignored.
    if (!previous) return false;
    const from = { x: previous.x - off.x, y: previous.y - off.y, z: previous.z - off.z };
    const to = { x: px, y: py, z: pz };
    return segmentCrossesObjectTrigger(obj, from, to, r);
  }

  /**
   * Apply the trigger's action (or its inverse) to all resolved targets. Returns true if it teleported
   * the player. `inverse` is set for toggle-off and while-exit.
   */
  private applyAction(obj: CreatorLayoutObject, spec: CreatorTriggerSpec, player: PlayerController, inverse: boolean): boolean {
    const action = inverse ? inverseAction(spec.action) : spec.action;
    if (action === 'teleport_player') {
      // Teleport goes to the trigger's CURRENT position (authored + any mover offset). The caller
      // (update) nulls its sweep origin on a true return, so nothing sweeps across the jump.
      const off = this.moverOffset(obj.id);
      const yaw = (obj.rotation[1] ?? 0) * (Math.PI / 180);
      player.teleportTo(new Vector3(obj.position[0] + off.x, obj.position[1] + off.y, obj.position[2] + off.z), yaw, 0);
      return true;
    }

    const moveSign = inverse ? -1 : 1;
    for (const targetId of this.resolveTargets(obj, spec)) {
      this.applyToTarget(targetId, action, spec, moveSign);
    }
    return false;
  }

  private applyToTarget(targetId: string, action: TriggerAction, spec: CreatorTriggerSpec, moveSign: number): void {
    switch (action) {
      case 'show':
        this.hidden.delete(targetId);
        this.geometry?.setObjectVisible(targetId, true);
        break;
      case 'hide':
        this.hidden.add(targetId);
        this.geometry?.setObjectVisible(targetId, false);
        break;
      case 'collide_on':
        this.intangible.delete(targetId);
        this.setTangible(targetId, true);
        break;
      case 'collide_off':
        this.intangible.add(targetId);
        this.setTangible(targetId, false);
        break;
      case 'mover_start':
        this.movers?.setMoverRunning(targetId, true);
        break;
      case 'mover_stop':
        this.movers?.setMoverRunning(targetId, false);
        break;
      case 'enable':
        this.disabled.delete(targetId);
        break;
      case 'disable':
        this.disabled.add(targetId);
        break;
      case 'move': {
        const o = spec.offset ?? [0, 0, 0];
        const cur = this.moveOffset.get(targetId) ?? { x: 0, y: 0, z: 0 };
        this.translateTarget(targetId, cur.x + o[0] * moveSign, cur.y + o[1] * moveSign, cur.z + o[2] * moveSign);
        break;
      }
      // teleport_player handled by the caller (no target loop).
      case 'teleport_player':
        break;
    }
  }

  /** Direct target ids that still exist, unioned with channel listeners. Lazy — never cached. */
  private resolveTargets(trigger: CreatorLayoutObject, spec: CreatorTriggerSpec): string[] {
    const layout = this.layout;
    if (!layout) return [];
    const out = new Set<string>();
    if (spec.targets) {
      for (const id of spec.targets) {
        if (id !== trigger.id && layout.objects.some((o) => o.id === id)) out.add(id);
      }
    }
    if (spec.channel) {
      for (const o of layout.objects) {
        if (o.id !== trigger.id && o.metadata?.listenChannel === spec.channel) out.add(o.id);
      }
    }
    return Array.from(out);
  }

  /** Set a target's colliders + wall faces (in)tangible. Missing target ⇒ no-op (dangling link). */
  private setTangible(targetId: string, tangible: boolean): void {
    const h = this.handles.get(targetId);
    if (!h) return;
    for (const b of h.boxes) b.enabled = tangible;
    for (const f of h.faces) f.enabled = tangible;
  }

  /**
   * Move a target's colliders + faces + visual to net world offset (nx,ny,nz) from its authored
   * position. Tracks the applied offset so a second move (or a revert) is computed from the delta, and
   * so reset() can put everything back. No-op for a target with no collider handles (pure marker).
   */
  private translateTarget(targetId: string, nx: number, ny: number, nz: number): void {
    const cur = this.moveOffset.get(targetId) ?? { x: 0, y: 0, z: 0 };
    const dx = nx - cur.x;
    const dy = ny - cur.y;
    const dz = nz - cur.z;
    if (dx === 0 && dy === 0 && dz === 0) return;

    const h = this.handles.get(targetId);
    if (h) {
      for (const b of h.boxes) {
        b.minX += dx; b.maxX += dx; b.minY += dy; b.maxY += dy; b.minZ += dz; b.maxZ += dz;
        if (b.cx !== undefined) b.cx += dx;
        if (b.cz !== undefined) b.cz += dz;
        if (b.ramp) { b.ramp.centerX += dx; b.ramp.baseY += dy; b.ramp.centerZ += dz; }
      }
      for (const f of h.faces) { f.ox += dx; f.oz += dz; f.topY += dy; f.bottomY += dy; }
    }
    const node = this.geometry?.getObjectRoot(targetId);
    if (node) node.position.set(node.position.x + dx, node.position.y + dy, node.position.z + dz);

    if (nx === 0 && ny === 0 && nz === 0) this.moveOffset.delete(targetId);
    else this.moveOffset.set(targetId, { x: nx, y: ny, z: nz });
  }

  /** Current mover offset of an object (or {0,0,0}); lets a trigger volume ride a moving platform. */
  private moverOffset(objectId: string): MoverOffset {
    const s = this.scratch;
    s.x = 0; s.y = 0; s.z = 0;
    this.movers?.offsetOf(objectId, s);
    return s;
  }
}

/**
 * Oriented trigger-volume test using the object's metadata.trigger dims if present, else its scaled
 * footprint. Local to this module (CreatorPads' insideObjectTrigger reads obj.position directly; here
 * the caller has already shifted the probe into the object's frame for mover-ride support).
 */
function insideOrientedTriggerVolume(obj: CreatorLayoutObject, px: number, py: number, pz: number, radius: number): boolean {
  const trig = obj.metadata?.trigger;
  const dims = objectDimensions(obj);
  const halfW = (trig ? trig.width : dims[0]) / 2;
  const height = trig ? trig.height : dims[1];
  const halfD = (trig ? trig.depth : dims[2]) / 2;
  return insideOrientedVolume(obj, px, py, pz, halfW, height, halfD, radius);
}

/** The paired inverse of a trigger action (for toggle-off / while-exit). Symmetric. */
function inverseAction(action: TriggerAction): TriggerAction {
  switch (action) {
    case 'show': return 'hide';
    case 'hide': return 'show';
    case 'collide_on': return 'collide_off';
    case 'collide_off': return 'collide_on';
    case 'mover_start': return 'mover_stop';
    case 'mover_stop': return 'mover_start';
    case 'enable': return 'disable';
    case 'disable': return 'enable';
    case 'move': return 'move'; // inverse handled by negating the offset at apply time
    case 'teleport_player': return 'teleport_player'; // no inverse (rejected for toggle/while upstream)
  }
}
