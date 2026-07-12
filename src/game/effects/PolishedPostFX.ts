/**
 * Client-only POLISHED-mode post pipeline (graphics overhaul Phases 4 + 5).
 *
 * ONE consolidated stack, built only for quality==='polished':
 *   1. SSAO2 (half-res, subtle) — contact depth in bleacher gaps, wall-floor joins, pad seams.
 *      Created FIRST so occlusion composes before tonemapping/AA. Skipped cleanly when the engine
 *      can't provide a geometry buffer (WebGL1).
 *   2. DefaultRenderingPipeline — FXAA + image processing. CRITICAL: `imageProcessingEnabled` binds
 *      the EXISTING scene.imageProcessingConfiguration (ACES + the polished exposure/contrast set in
 *      GymVisualRevamp.tuneSceneImageProcessing); Babylon then switches materials to
 *      applyByPostProcess, so tonemapping happens EXACTLY once — in the post pass, never doubled.
 *      `samples` stays 1: MSAA + SSAO2's geometry buffer conflict on some drivers (gray frame).
 *      Pipeline bloom exists but ships OFF — the GlowLayer below is the emissive-glow mechanism
 *      (scene-global threshold bloom is what caught HUD text planes in the failed past attempt).
 *   3. GlowLayer with includedOnlyMeshes — ONLY explicitly-registered emissive meshes glow (cove
 *      light strips, ceiling fixture lenses, scoreboard faces, portal energy). Registration goes
 *      through addPolishedGlowMesh, a safe no-op in Performance/Neutral.
 *
 * The standalone FxaaPostProcess is NOT constructed in polished (this pipeline's FXAA replaces it);
 * Performance/Neutral keep it and never build any of this. Nothing here is imported by server or
 * shared code.
 */

import {
  Camera,
  Color3,
  DefaultRenderingPipeline,
  GlowLayer,
  Mesh,
  Scene,
  SSAO2RenderingPipeline,
  StandardMaterial
} from '@babylonjs/core';
import { getGraphicsQuality } from '../config/graphicsConfig';
import { resolvePolishedConfig } from '../config/graphicsTuning';

let activeGlow: GlowLayer | null = null;
let activeGlowScene: Scene | null = null;
let activeOccluderMaterial: StandardMaterial | null = null;
const includedMeshes = new Set<Mesh>();
const emissiveMeshes = new Set<Mesh>();
const occluderMeshes = new Set<Mesh>();
const POLISHED_SSAO_PIPELINE = 'polished_ssao';
const POLISHED_DEFAULT_PIPELINE = 'polished_pipeline';

function unregisterIncludedMesh(mesh: Mesh): void {
  if (!includedMeshes.delete(mesh)) return;
  emissiveMeshes.delete(mesh);
  occluderMeshes.delete(mesh);
  if (activeGlow && activeGlowScene === mesh.getScene()) activeGlow.setMaterialForRendering(mesh);
  if (activeGlow && activeGlowScene === mesh.getScene()) activeGlow.removeIncludedOnlyMesh(mesh);
}

function registerIncludedMesh(mesh: Mesh | null | undefined, occluder: boolean): void {
  // Portal/pad constructors can run before PolishedPostFX. Keep those registrations until the
  // layer comes up, but never retain anything for Performance/Neutral scenes.
  if (!mesh || getGraphicsQuality() !== 'polished' || mesh.isDisposed()) return;
  if (occluder && emissiveMeshes.has(mesh)) return; // a true emitter always wins
  if (occluder) occluderMeshes.add(mesh);
  else {
    emissiveMeshes.add(mesh);
    occluderMeshes.delete(mesh);
  }
  if (!includedMeshes.has(mesh)) {
    includedMeshes.add(mesh);
    mesh.onDisposeObservable.addOnce(() => unregisterIncludedMesh(mesh));
  }
  if (activeGlow && activeGlowScene === mesh.getScene()) {
    activeGlow.addIncludedOnlyMesh(mesh);
    if (occluderMeshes.has(mesh) && activeOccluderMaterial) {
      activeGlow.setMaterialForRendering(mesh, activeOccluderMaterial);
    } else {
      activeGlow.setMaterialForRendering(mesh);
    }
  }
}

/**
 * Register a mesh with the polished GlowLayer (includedOnly mode — nothing glows unless listed).
 * Safe no-op before the pipeline exists or in Performance/Neutral. The mesh must carry emissive
 * color/texture for the glow to have anything to spread.
 */
export function addPolishedGlowMesh(mesh: Mesh | null | undefined): void {
  registerIncludedMesh(mesh, false);
}

/**
 * Register a mesh as a glow OCCLUDER. In includedOnly mode the glow texture renders ONLY listed
 * meshes, so a glowing strip BEHIND a court mat/divider bleeds straight through it as a blurry
 * smudge (the mat never wrote depth into the glow map). The fix is this: occluders are added to the
 * same included list and rendered with a shared pure-black override material. They write depth and
 * block glow behind them without sampling their real material, so even an emissive sign can safely
 * occlude without becoming a glow source. Emitters win deterministically if a mesh is registered
 * through both paths.
 */
export function addPolishedGlowOccluder(mesh: Mesh | null | undefined): void {
  registerIncludedMesh(mesh, true);
}

export class PolishedPostFX {
  private readonly scene: Scene;
  private readonly ssao: SSAO2RenderingPipeline | null;
  private readonly pipeline: DefaultRenderingPipeline;
  private readonly glow: GlowLayer | null;
  private readonly glowAnchor: Mesh | null;
  private readonly glowOccluderMaterial: StandardMaterial | null;
  private readonly attachedCameras = new Set<Camera>();

  constructor(scene: Scene, camera: Camera) {
    this.scene = scene;
    const cfg = resolvePolishedConfig();

    // --- 1. SSAO2 (before the pipeline so AO composes pre-tonemap) ---
    if (cfg.post.ssao.enabled && SSAO2RenderingPipeline.IsSupported) {
      const s = cfg.post.ssao;
      const ssao = new SSAO2RenderingPipeline(
        POLISHED_SSAO_PIPELINE,
        scene,
        { ssaoRatio: s.ssaoRatio, blurRatio: s.blurRatio },
        [camera]
      );
      ssao.base = s.base;
      ssao.totalStrength = s.totalStrength;
      ssao.radius = s.radius;
      ssao.maxZ = s.maxZGym;
      ssao.samples = s.samples;
      ssao.expensiveBlur = s.expensiveBlur;
      this.ssao = ssao;
    } else {
      this.ssao = null;
    }

    // --- 2. DefaultRenderingPipeline: FXAA + the ONE image-processing (tonemap) pass ---
    const pipeline = new DefaultRenderingPipeline(POLISHED_DEFAULT_PIPELINE, true /* hdr */, scene, [camera]);
    pipeline.fxaaEnabled = cfg.post.fxaa;
    pipeline.samples = 1; // NEVER MSAA while SSAO2 is active (geometry-buffer conflict)
    pipeline.imageProcessingEnabled = true; // binds scene.imageProcessingConfiguration → single tonemap
    pipeline.bloomEnabled = cfg.post.bloom.enabled;
    if (cfg.post.bloom.enabled) {
      pipeline.bloomThreshold = cfg.post.bloom.threshold;
      pipeline.bloomWeight = cfg.post.bloom.weight;
      pipeline.bloomKernel = cfg.post.bloom.kernel;
      pipeline.bloomScale = cfg.post.bloom.scale;
    }
    if (cfg.post.vignette.enabled) {
      pipeline.imageProcessing.vignetteEnabled = true;
      pipeline.imageProcessing.vignetteWeight = cfg.post.vignette.weight;
    }
    this.pipeline = pipeline;
    this.attachedCameras.add(camera);

    // --- 3. GlowLayer (includedOnly — the restrained emissive-glow mechanism) ---
    if (cfg.glow.enabled) {
      const glow = new GlowLayer('polished_glow', scene, {
        mainTextureRatio: cfg.glow.mainTextureRatio,
        blurKernelSize: cfg.glow.blurKernelSize
      });
      glow.intensity = cfg.glow.intensity;
      // includedOnly mode activates on the first addIncludedOnlyMesh call; until then the layer
      // would glow EVERY emissive mesh (sign text planes — the past failure). Guarantee the mode by
      // adding a throwaway include immediately: an empty mesh keeps the include-list semantics on.
      const anchor = new Mesh('polished_glow_anchor', scene);
      anchor.isVisible = false;
      glow.addIncludedOnlyMesh(anchor);
      const occluderMaterial = new StandardMaterial('polished_glow_occluder_material', scene);
      occluderMaterial.diffuseColor = Color3.Black();
      occluderMaterial.emissiveColor = Color3.Black();
      occluderMaterial.specularColor = Color3.Black();
      occluderMaterial.disableLighting = true;
      // Depth-only in the glow RTT: writing opaque black color/alpha is merged as black silhouettes
      // by some LDR WebGL paths. Color writes off preserves depth occlusion without touching output.
      occluderMaterial.disableColorWrite = true;
      this.glow = glow;
      this.glowAnchor = anchor;
      this.glowOccluderMaterial = occluderMaterial;
      activeGlow = glow;
      activeGlowScene = scene;
      activeOccluderMaterial = occluderMaterial;
      // Flush emitters that were built before the post stack (the scoreboard is the common case).
      for (const mesh of includedMeshes) {
        if (mesh.isDisposed() || mesh.getScene() !== scene) continue;
        glow.addIncludedOnlyMesh(mesh);
        if (occluderMeshes.has(mesh)) glow.setMaterialForRendering(mesh, occluderMaterial);
      }
    } else {
      this.glow = null;
      this.glowAnchor = null;
      this.glowOccluderMaterial = null;
    }
  }

  /** Retune SSAO reach when the active camera moves between the compact gym and the large yard. */
  setWorld(world: 'gym' | 'sandbox'): void {
    if (!this.ssao) return;
    const ssao = resolvePolishedConfig().post.ssao;
    this.ssao.maxZ = world === 'sandbox' ? ssao.maxZSandbox : ssao.maxZGym;
  }

  /** Live glow handle for the dev tuning panel. */
  get glowLayer(): GlowLayer | null {
    return this.glow;
  }

  /** Attach the polished post stack to the active render camera (player camera or Creator Build camera). */
  attachCamera(camera: Camera): void {
    if (this.attachedCameras.has(camera)) return;
    const manager = this.scene.postProcessRenderPipelineManager;
    if (this.ssao) manager.attachCamerasToRenderPipeline(POLISHED_SSAO_PIPELINE, camera, true);
    manager.attachCamerasToRenderPipeline(POLISHED_DEFAULT_PIPELINE, camera, true);
    this.attachedCameras.add(camera);
  }

  /** Detach when a camera stops rendering so editor/playtest swaps don't double-run the stack. */
  detachCamera(camera: Camera): void {
    if (!this.attachedCameras.delete(camera)) return;
    const manager = this.scene.postProcessRenderPipelineManager;
    if (this.ssao) manager.detachCamerasFromRenderPipeline(POLISHED_SSAO_PIPELINE, camera);
    manager.detachCamerasFromRenderPipeline(POLISHED_DEFAULT_PIPELINE, camera);
  }

  /** Make exactly this camera receive the polished post stack. */
  setActiveCamera(camera: Camera): void {
    for (const attached of [...this.attachedCameras]) {
      if (attached !== camera) this.detachCamera(attached);
    }
    this.attachCamera(camera);
  }

  /** Debug-only snapshot for the [graphics] audit. */
  getDebugInfo(): {
    ssao: boolean;
    ssaoMaxZ: number | null;
    fxaa: boolean;
    bloom: boolean;
    glow: boolean;
    glowIncludedCount: number;
  } {
    return {
      ssao: this.ssao !== null,
      ssaoMaxZ: this.ssao?.maxZ ?? null,
      fxaa: this.pipeline.fxaaEnabled,
      bloom: this.pipeline.bloomEnabled,
      glow: this.glow !== null,
      // Report our stable facade registry (Babylon moved its private list into ThinGlowLayer in v8).
      glowIncludedCount: [...includedMeshes].filter((mesh) => mesh.getScene() === this.scene).length
    };
  }

  dispose(): void {
    if (activeGlow === this.glow) {
      activeGlow = null;
      activeGlowScene = null;
      activeOccluderMaterial = null;
    }
    // Registrations are scene-owned. Clearing them here prevents stale meshes carrying into a new
    // ArenaScene even though their normal disposal happens a few lines later in ArenaScene.dispose.
    for (const mesh of [...includedMeshes]) {
      if (mesh.getScene() === this.scene) includedMeshes.delete(mesh);
    }
    for (const mesh of [...emissiveMeshes]) {
      if (mesh.getScene() === this.scene) emissiveMeshes.delete(mesh);
    }
    for (const mesh of [...occluderMeshes]) {
      if (mesh.getScene() === this.scene) occluderMeshes.delete(mesh);
    }
    for (const camera of [...this.attachedCameras]) this.detachCamera(camera);
    this.glow?.dispose();
    this.glowAnchor?.dispose();
    this.glowOccluderMaterial?.dispose();
    this.ssao?.dispose();
    this.pipeline.dispose();
  }
}
