import { Color3, DynamicTexture, Material, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial, Texture, Vector3 } from '@babylonjs/core';
import { applyGymProbeToBallMaterial } from '../map/GymReflectionProbe';
import { registerGymMirrorMesh } from '../map/GymFloorMirror';
import { addPolishedGlowOccluder } from '../effects/PolishedPostFX';
import { TUNING } from '../config/tuning';

export type BallVisualVariant = 'normal' | 'live' | 'dead' | 'highlight';

const materialsByScene = new WeakMap<Scene, Map<BallVisualVariant, PBRMaterial>>();
const shadowMaterialsByScene = new WeakMap<Scene, StandardMaterial>();
const panelTexturesByScene = new WeakMap<Scene, DynamicTexture>();

export function createBallMesh(scene: Scene, name: string, position: Vector3, variant: BallVisualVariant = 'normal'): Mesh {
  const mesh = MeshBuilder.CreateSphere(
    name,
    { diameter: TUNING.ball.radius * 2, segments: 24 },
    scene
  );
  mesh.position.copyFrom(position);
  mesh.material = getBallMaterial(scene, variant);
  mesh.isPickable = false;
  // Polished Phase 3: balls reflect in the floor mirror (the mesh only — the blob shadow below is
  // excluded by the mirror facade). Safe no-op when no mirror exists (Performance/Neutral).
  registerGymMirrorMesh(mesh);
  // Glow occluder: EVERY ball instance (held in first person, thrown, idle — offline BallManager
  // and online networkBall_* all build here) must punch a hole in the glow map, or wall/portal
  // light halos bleed straight through the ball as bright bands. Auto-unregisters on dispose.
  addPolishedGlowOccluder(mesh);
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
  material.albedoTexture = getBallPanelTexture(scene);
  // Polished mode: balls reflect the gym's own reflection probe (no-op when no probe is active —
  // Performance/Neutral keep the gradient-environment sheen applyBallMaterial already set up).
  applyGymProbeToBallMaterial(material);
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

/** Rubber panel seams give the ball a recognizable surface against both wood and player jerseys.
 * One small, static, mipmapped texture is shared by every state and every online/offline ball. */
function getBallPanelTexture(scene: Scene): DynamicTexture {
  const existing = panelTexturesByScene.get(scene);
  if (existing) return existing;

  const texture = new DynamicTexture('ball_rubber_panel_texture', { width: 512, height: 256 }, scene, true);
  texture.hasAlpha = false;
  texture.anisotropicFilteringLevel = 4;
  texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = texture.getContext();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 256);
  // Longitudinal seams wrap continuously at the UV join. No extra geometry or outline pass.
  ctx.strokeStyle = '#39414b';
  ctx.lineWidth = 7;
  for (let x = 0; x <= 512; x += 128) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, 128);
  ctx.lineTo(512, 128);
  ctx.stroke();
  texture.update(false);
  panelTexturesByScene.set(scene, texture);
  return texture;
}

function applyBallMaterial(material: PBRMaterial, variant: BallVisualVariant): void {
  // Balls — especially the large first-person held ball — are always solid rubber. Keep them out
  // of every alpha/refraction path explicitly; relying on PBR defaults made graphics-pass overrides
  // able to make the foreground ball appear translucent even while `alpha` still reported 1.
  material.alpha = 1;
  material.transparencyMode = Material.MATERIAL_OPAQUE;
  material.useAlphaFromAlbedoTexture = false;
  material.subSurface.isRefractionEnabled = false;
  material.forceDepthWrite = true;
  material.metallic = 0;
  // Keep the hidden HDR environment's response on balls subtle — a soft sheen, never a bright
  // mirror smear. (Default PBR environmentIntensity is 1.0, which over-responds to the bright gym
  // environment.) Balls already read via their albedo + emissive glow.
  material.environmentIntensity = 0.25;
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
