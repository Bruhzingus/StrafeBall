/**
 * Course Race — ghost rendering for remote racers.
 *
 * Each remote racer is a translucent capsule + head + floating nametag, smoothed toward the
 * latest relayed pose (15 Hz batches from the CourseRoom). Ghosts are pure visuals: no collision,
 * no picking, no gameplay reads — racers pass through each other by design. Local/offline path
 * only; disposed with the race session.
 */

import {
  Color3,
  DynamicTexture,
  Material,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3
} from '@babylonjs/core';
import type { RacePose } from '../../../shared/courseRace';

/** Distinct, readable tints cycled by join order. */
const GHOST_COLORS: readonly Color3[] = [
  new Color3(0.35, 0.65, 1.0), // blue
  new Color3(1.0, 0.55, 0.25), // orange
  new Color3(0.45, 0.9, 0.45), // green
  new Color3(0.85, 0.45, 0.95), // purple
  new Color3(1.0, 0.85, 0.3), // gold
  new Color3(0.4, 0.9, 0.9), // teal
  new Color3(0.95, 0.5, 0.6) // pink
];

/** Position smoothing rate (1/s). High enough to track 15 Hz updates without visible stepping. */
const SMOOTHING_RATE = 12;
/** Snap instead of glide when a pose jumps this far (spawn/teleport/checkpoint respawn). */
const SNAP_DISTANCE = 12;

interface Ghost {
  root: TransformNode;
  /** Unrotated node the nametag hangs from — a billboard under the yaw-rotated root misbehaves. */
  nameNode: TransformNode;
  meshes: Mesh[];
  materials: StandardMaterial[];
  nameTexture: DynamicTexture;
  target: RacePose;
  hasTarget: boolean;
  colorIndex: number;
}

export class CourseGhosts {
  private readonly ghosts = new Map<string, Ghost>();
  private nextColorIndex = 0;

  constructor(private readonly scene: Scene) {}

  /** Feed the latest relayed pose for a racer (creates their ghost on first sight). */
  setPose(id: string, name: string, pose: RacePose): void {
    let ghost = this.ghosts.get(id);
    if (!ghost) {
      ghost = this.buildGhost(id, name);
      this.ghosts.set(id, ghost);
      ghost.root.position.set(pose.x, pose.y, pose.z);
      ghost.nameNode.position.set(pose.x, pose.y, pose.z);
      ghost.root.rotation.y = pose.yaw;
    }
    ghost.target = pose;
    ghost.hasTarget = true;
  }

  /** Keep the roster and ghosts in sync — removes ghosts for racers no longer present. */
  retainOnly(ids: ReadonlySet<string>): void {
    for (const [id, ghost] of this.ghosts) {
      if (!ids.has(id)) {
        this.disposeGhost(ghost);
        this.ghosts.delete(id);
      }
    }
  }

  /** Per-frame smoothing toward each ghost's latest pose. */
  update(dt: number): void {
    const alpha = 1 - Math.exp(-SMOOTHING_RATE * dt);
    for (const ghost of this.ghosts.values()) {
      if (!ghost.hasTarget) continue;
      const p = ghost.root.position;
      const t = ghost.target;
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      const dz = t.z - p.z;
      if (dx * dx + dy * dy + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) {
        p.set(t.x, t.y, t.z);
      } else {
        p.set(p.x + dx * alpha, p.y + dy * alpha, p.z + dz * alpha);
      }
      // The nametag node tracks position only (never rotates) so its billboard stays upright.
      ghost.nameNode.position.copyFrom(p);
      // Shortest-arc yaw approach so a turn through ±π doesn't spin the long way round.
      let dyaw = t.yaw - ghost.root.rotation.y;
      dyaw = ((dyaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      ghost.root.rotation.y += dyaw * alpha;
    }
  }

  clear(): void {
    for (const ghost of this.ghosts.values()) this.disposeGhost(ghost);
    this.ghosts.clear();
    this.nextColorIndex = 0;
  }

  dispose(): void {
    this.clear();
  }

  // ---------------------------------------------------------------------------------------------

  private buildGhost(id: string, name: string): Ghost {
    const root = new TransformNode(`race_ghost_${id}`, this.scene);
    const color = GHOST_COLORS[this.nextColorIndex % GHOST_COLORS.length];
    const colorIndex = this.nextColorIndex;
    this.nextColorIndex += 1;

    const bodyMat = new StandardMaterial(`race_ghost_body_${id}`, this.scene);
    bodyMat.diffuseColor = color;
    bodyMat.emissiveColor = color.scale(0.45);
    bodyMat.alpha = 0.42;
    bodyMat.specularColor = new Color3(0, 0, 0);
    bodyMat.transparencyMode = Material.MATERIAL_ALPHABLEND;

    // Torso capsule + head sphere — enough silhouette to read a racer at a glance.
    const body = MeshBuilder.CreateCapsule(`race_ghost_capsule_${id}`, { height: 1.5, radius: 0.34, tessellation: 10 }, this.scene);
    body.position.y = 0.95;
    const head = MeshBuilder.CreateSphere(`race_ghost_head_${id}`, { diameter: 0.42, segments: 10 }, this.scene);
    head.position.y = 1.85;
    // Small visor block so the ghost's facing is readable.
    const visor = MeshBuilder.CreateBox(`race_ghost_visor_${id}`, { width: 0.3, height: 0.1, depth: 0.12 }, this.scene);
    visor.position.set(0, 1.87, 0.2);

    const meshes = [body, head, visor];
    for (const mesh of meshes) {
      mesh.material = bodyMat;
      mesh.parent = root;
      mesh.isPickable = false;
    }

    // Floating nametag (billboarded, name-sized texture).
    const texWidth = 512;
    const texHeight = 128;
    const nameTexture = new DynamicTexture(`race_ghost_name_${id}`, { width: texWidth, height: texHeight }, this.scene, true);
    nameTexture.hasAlpha = true;
    const ctx = nameTexture.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, texWidth, texHeight);
    ctx.font = '900 64px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(8, 14, 28, 0.9)';
    ctx.strokeText(name, texWidth / 2, texHeight / 2, texWidth - 24);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, texWidth / 2, texHeight / 2, texWidth - 24);
    nameTexture.update(true);

    const nameMat = new StandardMaterial(`race_ghost_name_mat_${id}`, this.scene);
    nameMat.diffuseTexture = nameTexture;
    nameMat.emissiveTexture = nameTexture;
    nameMat.opacityTexture = nameTexture;
    nameMat.emissiveColor = new Color3(1, 1, 1);
    nameMat.disableLighting = true;
    nameMat.backFaceCulling = false;

    // The nametag hangs from its OWN unrotated node (tracked to the ghost's position each frame in
    // update()) rather than the yaw-rotated root — a BILLBOARDMODE plane under a rotated parent
    // renders skewed/backwards as the parent turns.
    const nameNode = new TransformNode(`race_ghost_name_node_${id}`, this.scene);
    const namePlane = MeshBuilder.CreatePlane(`race_ghost_name_plane_${id}`, { width: 1.7, height: 0.42 }, this.scene);
    namePlane.position.y = 2.35;
    namePlane.material = nameMat;
    namePlane.parent = nameNode;
    namePlane.isPickable = false;
    namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    meshes.push(namePlane);

    return {
      root,
      nameNode,
      meshes,
      materials: [bodyMat, nameMat],
      nameTexture,
      target: { x: 0, y: 0, z: 0, yaw: 0 },
      hasTarget: false,
      colorIndex
    };
  }

  private disposeGhost(ghost: Ghost): void {
    for (const mesh of ghost.meshes) mesh.dispose();
    for (const material of ghost.materials) material.dispose();
    ghost.nameTexture.dispose();
    ghost.nameNode.dispose();
    ghost.root.dispose();
  }
}
