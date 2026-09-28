import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import type { StaticThrowTrajectoryInput, TrajectoryPoint } from '../../../shared/simulation/TrajectoryPrediction';
import { predictStaticThrowTrajectory } from '../../../shared/simulation/TrajectoryPrediction';

const MAX_POINTS = 32;
const pathBuffer = (): Vector3[] => Array.from({ length: MAX_POINTS }, (_, i) => new Vector3(0, 0, i * 0.001));
const directOutlineRadius = (_index: number, distance: number): number => Math.min(0.11, 0.012 + distance * 0.0033);
const directCoreRadius = (_index: number, distance: number): number => Math.min(0.06, 0.006 + distance * 0.0018);

/** ArenaScene uses this for the local first-person view in online play and practice. */
export class CoachGlassesGuide {
  private readonly directOutline: Mesh;
  private readonly directCore: Mesh;
  private readonly afterOutline: Mesh;
  private readonly afterCore: Mesh;
  private readonly markerOutline: Mesh;
  private readonly markerFill: Mesh;
  private readonly markerCenter: Mesh;
  private readonly materials: StandardMaterial[] = [];
  private readonly directBuffer = pathBuffer();
  private readonly afterBuffer = pathBuffer();
  private readonly trajectory: TrajectoryPoint[] = [];
  private lastSignature = '';

  constructor(scene: Scene) {
    const material = (name: string, color: Color3, alpha = 0.99): StandardMaterial => {
      const mat = new StandardMaterial(name, scene);
      mat.diffuseColor = Color3.Black();
      mat.emissiveColor = color;
      mat.disableLighting = true;
      mat.disableDepthWrite = true;
      mat.backFaceCulling = false;
      mat.alpha = alpha;
      this.materials.push(mat);
      return mat;
    };
    const dark = material('coach_glasses_outline_material', new Color3(0.005, 0.02, 0.055));
    const bright = material('coach_glasses_path_material', new Color3(0.08, 1.25, 1.5));
    const after = material('coach_glasses_after_material', new Color3(0.06, 0.8, 1.05), 0.9);
    const impact = material('coach_glasses_impact_material', new Color3(1.5, 0.23, 0.9));

    // WebGL lines stay one pixel wide on most GPUs. Tubes keep the path legible across the court.
    // The radius grows along the throw so the near-camera part does not fill the player's view.
    this.directOutline = MeshBuilder.CreateTube('coach_glasses_direct_outline', {
      path: this.directBuffer, radiusFunction: directOutlineRadius, tessellation: 6, updatable: true
    }, scene);
    this.directCore = MeshBuilder.CreateTube('coach_glasses_direct_core', {
      path: this.directBuffer, radiusFunction: directCoreRadius, tessellation: 6, updatable: true
    }, scene);
    this.afterOutline = MeshBuilder.CreateTube('coach_glasses_after_outline', {
      path: this.afterBuffer, radius: 0.075, tessellation: 6, updatable: true
    }, scene);
    this.afterCore = MeshBuilder.CreateTube('coach_glasses_after_core', {
      path: this.afterBuffer, radius: 0.037, tessellation: 6, updatable: true
    }, scene);
    for (const [mesh, mat, order] of [
      [this.directOutline, dark, 0], [this.directCore, bright, 1],
      [this.afterOutline, dark, 0], [this.afterCore, after, 1]
    ] as const) {
      mesh.material = mat;
      mesh.alphaIndex = order;
      mesh.isPickable = false;
    }

    // The dark rim stays visible against both pale floor markings and dark mats.
    this.markerOutline = MeshBuilder.CreateDisc('coach_glasses_impact_outline', { radius: 0.36, tessellation: 32 }, scene);
    this.markerFill = MeshBuilder.CreateDisc('coach_glasses_impact_fill', { radius: 0.27, tessellation: 32 }, scene);
    this.markerCenter = MeshBuilder.CreateDisc('coach_glasses_impact_center', { radius: 0.075, tessellation: 24 }, scene);
    for (const [mesh, mat, order] of [
      [this.markerOutline, dark, 0], [this.markerFill, impact, 1], [this.markerCenter, dark, 2]
    ] as const) {
      mesh.material = mat;
      mesh.alphaIndex = order;
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.isPickable = false;
    }
    this.hide();
  }

  update(input: StaticThrowTrajectoryInput | null, contextKey = ''): void {
    if (!input) { this.hide(); return; }
    const n = (v: number): string => (Math.round(v * 100) / 100).toString();
    const signature = [contextKey, input.origin.x, input.origin.y, input.origin.z,
      input.velocity.x, input.velocity.y, input.velocity.z,
      input.curveAccel.x, input.curveAccel.y, input.curveAccel.z, input.dropScale].map(numeric =>
        typeof numeric === 'number' ? n(numeric) : numeric).join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const points = predictStaticThrowTrajectory({ ...input, maxPoints: MAX_POINTS, output: this.trajectory });
    const bounce = points.findIndex(point => point.collision);
    const directEnd = bounce >= 0 ? bounce : points.length - 1;
    const hasDirect = this.writePath(this.directBuffer, points, 0, directEnd);
    if (hasDirect) {
      MeshBuilder.CreateTube('coach_glasses_direct_outline', {
        path: this.directBuffer, radiusFunction: directOutlineRadius, instance: this.directOutline
      });
      MeshBuilder.CreateTube('coach_glasses_direct_core', {
        path: this.directBuffer, radiusFunction: directCoreRadius, instance: this.directCore
      });
    }
    this.directOutline.setEnabled(hasDirect);
    this.directCore.setEnabled(hasDirect);

    const hasAfter = bounce >= 0 && this.writePath(this.afterBuffer, points, bounce, points.length - 1);
    if (hasAfter) {
      MeshBuilder.CreateTube('coach_glasses_after_outline', { path: this.afterBuffer, instance: this.afterOutline });
      MeshBuilder.CreateTube('coach_glasses_after_core', { path: this.afterBuffer, instance: this.afterCore });
    }
    this.afterOutline.setEnabled(hasAfter);
    this.afterCore.setEnabled(hasAfter);

    if (bounce >= 0) {
      const at = points[bounce].position;
      // Keep a floor impact from clipping half the target into the wood.
      for (const mesh of [this.markerOutline, this.markerFill, this.markerCenter]) {
        mesh.position.set(at.x, at.y + 0.2, at.z);
        mesh.setEnabled(true);
      }
    } else {
      this.markerOutline.setEnabled(false);
      this.markerFill.setEnabled(false);
      this.markerCenter.setEnabled(false);
    }
  }

  private writePath(buffer: Vector3[], points: TrajectoryPoint[], start: number, end: number): boolean {
    const count = Math.min(MAX_POINTS, end - start + 1);
    if (count < 2) return false;
    const last = points[start + count - 1].position;
    const previous = points[start + count - 2].position;
    const direction = new Vector3(last.x - previous.x, last.y - previous.y, last.z - previous.z);
    if (direction.lengthSquared() < 1e-8) direction.set(0, 0, 1);
    else direction.normalize();
    for (let i = 0; i < MAX_POINTS; i++) {
      if (i < count) {
        const p = points[start + i].position;
        buffer[i].set(p.x, p.y, p.z);
      } else {
        // Tube updates need a fixed point count. Keep the unused tail only millimeters long.
        const tail = (i - count + 1) * 0.0001;
        buffer[i].set(last.x + direction.x * tail, last.y + direction.y * tail, last.z + direction.z * tail);
      }
    }
    return true;
  }

  hide(): void {
    for (const mesh of [this.directOutline, this.directCore, this.afterOutline, this.afterCore,
      this.markerOutline, this.markerFill, this.markerCenter]) mesh.setEnabled(false);
    this.lastSignature = '';
  }

  dispose(): void {
    for (const mesh of [this.directOutline, this.directCore, this.afterOutline, this.afterCore,
      this.markerOutline, this.markerFill, this.markerCenter]) mesh.dispose();
    for (const material of this.materials) material.dispose();
  }
}
