import { Camera, DefaultRenderingPipeline, Scene, SSAO2RenderingPipeline } from '@babylonjs/core';
import { SHOWCASE_CONFIG, type ShowcaseTier } from '../config/graphicsConfig';

/**
 * Client-only SHOWCASE post-processing: subtle SSAO for room depth (Part 4) + a restrained emissive
 * bloom and FXAA (Part 5). Built ONLY in graphics mode "showcase"; in Competitive mode this class is
 * never constructed and the existing single FXAA post is used instead.
 *
 * Tone mapping is deliberately left to the project's existing in-material ACES image processing
 * (scene.imageProcessingConfiguration, configured in GymVisualRevamp.tuneSceneImageProcessing). The
 * DefaultRenderingPipeline here sets imageProcessingEnabled = false so tone mapping is applied exactly
 * once (in-material) — no double tone-map, no crushed blacks. The pipeline owns only FXAA + bloom.
 *
 * SSAO2 needs a WebGL2 / WebGPU geometry buffer; on a strong desktop that is available. If it is not
 * supported, SSAO is skipped cleanly (the rest of Showcase still renders). Disposed on scene teardown.
 */
export class ShowcasePostFX {
  private readonly ssao: SSAO2RenderingPipeline | null;
  private readonly pipeline: DefaultRenderingPipeline | null;
  private readonly tier: ShowcaseTier;
  private readonly ssaoSupported: boolean;

  constructor(scene: Scene, camera: Camera, tier: ShowcaseTier) {
    this.tier = tier;
    this.ssaoSupported = SSAO2RenderingPipeline.IsSupported;

    this.ssao = SHOWCASE_CONFIG.ssao.enabled && this.ssaoSupported ? this.createSsao(scene, camera, tier) : null;
    this.pipeline = this.createBloomFxaaPipeline(scene, camera);
  }

  private createSsao(scene: Scene, camera: Camera, tier: ShowcaseTier): SSAO2RenderingPipeline {
    const cfg = SHOWCASE_CONFIG.ssao;
    const t = cfg.byTier[tier];
    const ssao = new SSAO2RenderingPipeline('gym_showcase_ssao', scene, { ssaoRatio: t.ssaoRatio, blurRatio: t.blurRatio }, [camera]);
    // Subtle depth only: a high `base` keeps the gym bright (final = clamp(base + ssao)); modest
    // strength/radius so it darkens contact seams without greying walls or dirtying the room.
    ssao.base = cfg.base;
    ssao.totalStrength = cfg.totalStrength;
    ssao.radius = cfg.radius;
    ssao.maxZ = cfg.maxZ;
    ssao.samples = t.samples;
    ssao.expensiveBlur = t.expensiveBlur;
    ssao.textureSamples = t.textureSamples;
    return ssao;
  }

  private createBloomFxaaPipeline(scene: Scene, camera: Camera): DefaultRenderingPipeline {
    const cfg = SHOWCASE_CONFIG.post;
    const pipeline = new DefaultRenderingPipeline('gym_showcase_post', false, scene, [camera]);
    // Tone mapping stays in-material (ACES) — do NOT let the pipeline tone-map again.
    pipeline.imageProcessingEnabled = false;
    pipeline.fxaaEnabled = cfg.fxaa;
    pipeline.bloomEnabled = cfg.bloom.enabled;
    if (cfg.bloom.enabled) {
      pipeline.bloomThreshold = cfg.bloom.threshold;
      pipeline.bloomWeight = cfg.bloom.weight;
      pipeline.bloomKernel = cfg.bloom.kernel;
      pipeline.bloomScale = cfg.bloom.scale;
    }
    // Explicitly NO depth of field, chromatic aberration, grain, sharpen, vignette, or motion blur.
    pipeline.depthOfFieldEnabled = false;
    pipeline.chromaticAberrationEnabled = false;
    pipeline.grainEnabled = false;
    pipeline.sharpenEnabled = false;
    return pipeline;
  }

  /** Debug-only snapshot for the graphics report. */
  getDebugInfo(): {
    ssaoEnabled: boolean;
    ssaoSupported: boolean;
    ssaoRadius: number;
    ssaoStrength: number;
    ssaoBase: number;
    bloomEnabled: boolean;
    bloomThreshold: number;
    bloomWeight: number;
    fxaaEnabled: boolean;
    tier: ShowcaseTier;
  } {
    return {
      ssaoEnabled: this.ssao !== null,
      ssaoSupported: this.ssaoSupported,
      ssaoRadius: SHOWCASE_CONFIG.ssao.radius,
      ssaoStrength: SHOWCASE_CONFIG.ssao.totalStrength,
      ssaoBase: SHOWCASE_CONFIG.ssao.base,
      bloomEnabled: this.pipeline?.bloomEnabled ?? false,
      bloomThreshold: SHOWCASE_CONFIG.post.bloom.threshold,
      bloomWeight: SHOWCASE_CONFIG.post.bloom.weight,
      fxaaEnabled: this.pipeline?.fxaaEnabled ?? false,
      tier: this.tier
    };
  }

  dispose(): void {
    this.ssao?.dispose();
    this.pipeline?.dispose();
  }
}
