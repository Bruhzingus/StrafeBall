import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';

export type BallVisualVariant = 'normal' | 'live' | 'dead' | 'highlight';

const materialsByScene = new WeakMap<Scene, Map<BallVisualVariant, PBRMaterial>>();
const shadowMaterialsByScene = new WeakMap<Scene, StandardMaterial>();

export function createBallMesh(scene: Scene, name: string, position: Vector3, variant: BallVisualVariant = 'normal'): Mesh {
  const mesh = MeshBuilder.CreateSphere(
    name,
    { diameter: TUNING.ball.radius * 2, segments: 24 },
    scene
  );
  mesh.position.copyFrom(position);
  mesh.material = getBallMaterial(scene, variant);
  mesh.isPickable = false;
  const shadow = createBallBlobShadow(scene, `${name}_blobShadow`, position);
  mesh.metadata = { ...(mesh.metadata ?? {}), ballBlobShadow: shadow };
  mesh.onDisposeObservable.add(() => {
    if (!shadow.isDisposed()) shadow.dispose();
  });
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

export function ballVariantForState(state: { phase?: string; isSuper?: boolean; highlighted?: boolean }): BallVisualVariant {
  if (state.phase === 'live' || state.phase === 'deflected') return 'live';
  if (state.highlighted) return 'highlight';
  return 'dead';
}

export function updateBallBlobShadow(mesh: Mesh): void {
  if (mesh.isDisposed()) return;
  const shadow = (mesh.metadata as { ballBlobShadow?: Mesh } | undefined)?.ballBlobShadow;
  if (!shadow || shadow.isDisposed()) return;

  const height = Math.max(0, mesh.position.y - TUNING.ball.radius);
  const scale = TUNING.ball.radius * 2.1 * (1 + Math.min(0.55, height * 0.08));
  shadow.position.set(mesh.position.x, 0.012, mesh.position.z);
  shadow.scaling.set(scale, 1, scale);
  shadow.setEnabled(mesh.isEnabled() && mesh.position.y >= TUNING.ball.radius * 0.45);
}

function applyBallMaterial(material: PBRMaterial, variant: BallVisualVariant): void {
  material.metallic = 0;
  if (variant === 'live') {
    material.albedoColor = new Color3(1.0, 0.08, 0.055);
    material.emissiveColor = new Color3(0.18, 0.018, 0.008);
    material.roughness = 0.32;
  } else if (variant === 'highlight') {
    material.albedoColor = new Color3(1.0, 0.95, 0.22);
    material.emissiveColor = new Color3(0.2, 0.14, 0.018);
    material.roughness = 0.3;
  } else {
    material.albedoColor = new Color3(1.0, 0.78, 0.08);
    material.emissiveColor = new Color3(0.12, 0.075, 0.01);
    material.roughness = 0.38;
  }
}

function createBallBlobShadow(scene: Scene, name: string, position: Vector3): Mesh {
  const shadow = MeshBuilder.CreateCylinder(name, { diameter: 1, height: 0.006, tessellation: 20 }, scene);
  shadow.material = getShadowMaterial(scene);
  shadow.isPickable = false;
  shadow.checkCollisions = false;
  shadow.position.set(position.x, 0.012, position.z);
  shadow.scaling.set(TUNING.ball.radius * 2.1, 1, TUNING.ball.radius * 2.1);
  return shadow;
}

function getShadowMaterial(scene: Scene): StandardMaterial {
  const existing = shadowMaterialsByScene.get(scene);
  if (existing) return existing;

  const material = new StandardMaterial('ball_blob_shadow_material', scene);
  material.diffuseColor = new Color3(0, 0, 0);
  material.emissiveColor = new Color3(0, 0, 0);
  material.alpha = 0.24;
  material.disableLighting = true;
  shadowMaterialsByScene.set(scene, material);
  return material;
}
