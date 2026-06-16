import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, Vector3 } from '@babylonjs/core';
import { ASSET_MANIFEST } from '../assets/AssetManifest';
import { TUNING } from '../config/tuning';

export type BallVisualVariant = 'normal' | 'super' | 'deflected';

const materialsByScene = new WeakMap<Scene, Map<BallVisualVariant, PBRMaterial>>();

export function createBallMesh(scene: Scene, name: string, position: Vector3, variant: BallVisualVariant = 'normal'): Mesh {
  const mesh = MeshBuilder.CreateSphere(
    name,
    { diameter: TUNING.ball.radius * 2, segments: 24 },
    scene
  );
  mesh.position.copyFrom(position);
  mesh.material = getBallMaterial(scene, variant);
  return mesh;
}

export function getBallMaterial(scene: Scene, variant: BallVisualVariant = 'normal'): PBRMaterial {
  let materials = materialsByScene.get(scene);
  if (!materials) {
    materials = new Map();
    materialsByScene.set(scene, materials);
  }

  const existing = materials.get(variant);
  if (existing) return existing;

  const material = new PBRMaterial(`ball_${variant}_material`, scene);
  applyBallMaterial(material, variant);
  materials.set(variant, material);
  return material;
}

export function ballVariantForState(state: { phase?: string; isSuper?: boolean }): BallVisualVariant {
  if (state.phase === 'deflected') return 'deflected';
  if (state.isSuper) return 'super';
  return 'normal';
}

function applyBallMaterial(material: PBRMaterial, variant: BallVisualVariant): void {
  const base = variant === 'normal' ? ASSET_MANIFEST.ball.material : ASSET_MANIFEST.superBall.material;
  material.albedoColor = new Color3(...base.diffuse);
  material.emissiveColor = base.emissive ? new Color3(...base.emissive) : Color3.Black();
  material.metallic = base.metallic ?? 0;
  material.roughness = base.roughness ?? 0.34;

  if (variant === 'deflected') {
    material.albedoColor = new Color3(1.0, 0.78, 0.12);
    material.emissiveColor = new Color3(0.22, 0.1, 0.01);
    material.roughness = 0.28;
  }
}
