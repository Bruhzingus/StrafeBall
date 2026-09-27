import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3, type LinesMesh } from '@babylonjs/core';
import type { StaticThrowTrajectoryInput, TrajectoryPoint } from '../../../shared/simulation/TrajectoryPrediction';
import { predictStaticThrowTrajectory } from '../../../shared/simulation/TrajectoryPrediction';

const MAX_POINTS = 32;
const directPoints = (): Vector3[] => Array.from({ length: MAX_POINTS }, () => Vector3.Zero());

/** Only ArenaScene's local online view owns this object. No network or remote-player path references it. */
export class CoachGlassesGuide {
  private readonly direct: LinesMesh;
  private readonly after: LinesMesh;
  private readonly marker: Mesh;
  private readonly markerMaterial: StandardMaterial;
  private readonly directBuffer = directPoints();
  private readonly afterBuffer: Vector3[][] = Array.from({ length: MAX_POINTS - 1 }, () => [Vector3.Zero(), Vector3.Zero()]);
  private readonly trajectory: TrajectoryPoint[] = [];
  private lastSignature = '';

  constructor(scene: Scene) {
    this.direct = MeshBuilder.CreateLines('coach_glasses_direct', { points: this.directBuffer, updatable: true }, scene);
    this.direct.color = new Color3(0.52, 0.92, 0.98);
    this.direct.alpha = 0.55;
    this.direct.isPickable = false;
    this.after = MeshBuilder.CreateLineSystem('coach_glasses_after', { lines: this.afterBuffer, updatable: true }, scene);
    this.after.color = new Color3(0.42, 0.82, 0.94);
    this.after.alpha = 0.28;
    this.after.isPickable = false;
    this.marker = MeshBuilder.CreateTorus('coach_glasses_bounce', { diameter: 0.22, thickness: 0.012, tessellation: 12 }, scene);
    this.markerMaterial = new StandardMaterial('coach_glasses_bounce_material', scene);
    this.markerMaterial.diffuseColor = new Color3(0.48, 0.88, 0.98);
    this.markerMaterial.emissiveColor = new Color3(0.12, 0.28, 0.32);
    this.markerMaterial.alpha = 0.55;
    this.marker.material = this.markerMaterial;
    this.marker.rotation.x = Math.PI / 2;
    this.marker.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.marker.isPickable = false;
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
    for (let i = 0; i < MAX_POINTS; i++) {
      const p = points[Math.min(i, directEnd)]?.position ?? input.origin;
      this.directBuffer[i].set(p.x, p.y, p.z);
    }
    MeshBuilder.CreateLines('coach_glasses_direct', { points: this.directBuffer, instance: this.direct });
    this.direct.setEnabled(directEnd > 0);

    let afterCount = 0;
    if (bounce >= 0) {
      for (let i = bounce; i < points.length - 1 && afterCount < this.afterBuffer.length; i++) {
        const a = points[i].position;
        const b = points[i + 1].position;
        const pair = this.afterBuffer[afterCount++];
        pair[0].set(a.x, a.y, a.z);
        pair[1].set(a.x + (b.x - a.x) * 0.57, a.y + (b.y - a.y) * 0.57, a.z + (b.z - a.z) * 0.57);
      }
      const at = points[bounce].position;
      this.marker.position.set(at.x, at.y, at.z);
    }
    const tail = afterCount > 0 ? this.afterBuffer[afterCount - 1][1] : this.afterBuffer[0][0];
    for (let i = afterCount; i < this.afterBuffer.length; i++) {
      this.afterBuffer[i][0].copyFrom(tail);
      this.afterBuffer[i][1].copyFrom(tail);
    }
    MeshBuilder.CreateLineSystem('coach_glasses_after', { lines: this.afterBuffer, instance: this.after });
    this.after.setEnabled(afterCount > 0);
    this.marker.setEnabled(bounce >= 0);
  }

  hide(): void {
    this.direct.setEnabled(false);
    this.after.setEnabled(false);
    this.marker.setEnabled(false);
    this.lastSignature = '';
  }

  dispose(): void {
    this.direct.dispose();
    this.after.dispose();
    this.marker.dispose();
    this.markerMaterial.dispose();
  }
}
