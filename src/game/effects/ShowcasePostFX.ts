import { Camera, Scene, SSAO2RenderingPipeline } from '@babylonjs/core';
import { SHOWCASE_CONFIG, type ShowcaseTier } from '../config/graphicsConfig';

/**
 * Client-only SHOWCASE SSAO (Phase 8). A subtle SSAO2 ambient-occlusion pass that adds contact depth in
 * the gym's crevices — under bleachers, wall-floor & wall-ceiling joins, the scoreboard recess, pad
 * seams, and static mat contact. Built ONLY in Showcase mode AND only when SHOWCASE_CONFIG.ssao.enabled
 * is true (the single kill switch — flip it to false to remove SSAO entirely).
 *
 * SSAO-ONLY by design: no bloom, no tone mapping, no color grading, no DefaultRenderingPipeline. FXAA is
 * provided separately by the standalone post process in ArenaScene and stays active in every mode, so
 * there is no double-FXAA and no duplicate pipeline. Tone mapping remains the project's existing
 * in-material ACES (scene.imageProcessingConfiguration) — untouched here.
 *
 * SSAO2 needs a WebGL2 / WebGPU geometry buffer; if unsupported it is skipped cleanly (the rest of
 * Showcase still renders). Disposed on scene teardown. Exactly one SSAO2 pipeline is ever created.
 */
export class ShowcasePostFX {
  private readonly ssao: SSAO2RenderingPipeline | null;
  private readonly tier: ShowcaseTier;
  private readonly ssaoSupported: boolean;

  constructor(scene: Scene, camera: Camera, tier: ShowcaseTier) {
    this.tier = tier;
    this.ssaoSupported = SSAO2RenderingPipeline.IsSupported;
    this.ssao = SHOWCASE_CONFIG.ssao.enabled && this.ssaoSupported ? this.createSsao(scene, camera, tier) : null;
  }

  private createSsao(scene: Scene, camera: Camera, tier: ShowcaseTier): SSAO2RenderingPipeline {
    const cfg = SHOWCASE_CONFIG.ssao;
    const t = cfg.byTier[tier];
    const ssao = new SSAO2RenderingPipeline('gym_showcase_ssao', scene, { ssaoRatio: t.ssaoRatio, blurRatio: t.blurRatio }, [camera]);
    // Subtle depth only: a high `base` keeps the gym bright (final = clamp(base + ssao)); modest
    // strength/radius so it darkens contact seams without greying walls, hazing the room, or haloing.
    // maxZ bounds the effect so distant geometry isn't over-darkened.
    ssao.base = cfg.base;
    ssao.totalStrength = cfg.totalStrength;
    ssao.radius = cfg.radius;
    ssao.maxZ = cfg.maxZ;
    ssao.samples = t.samples;
    ssao.expensiveBlur = t.expensiveBlur;
    ssao.textureSamples = t.textureSamples;
    return ssao;
  }

  /** Debug-only snapshot for the graphics report. */
  getDebugInfo(): {
    ssaoEnabled: boolean;
    ssaoSupported: boolean;
    ssaoRadius: number;
    ssaoStrength: number;
    ssaoBase: number;
    tier: ShowcaseTier;
  } {
    return {
      ssaoEnabled: this.ssao !== null,
      ssaoSupported: this.ssaoSupported,
      ssaoRadius: SHOWCASE_CONFIG.ssao.radius,
      ssaoStrength: SHOWCASE_CONFIG.ssao.totalStrength,
      ssaoBase: SHOWCASE_CONFIG.ssao.base,
      tier: this.tier
    };
  }

  dispose(): void {
    this.ssao?.dispose();
  }
}
