/**
 * Centralized client-only graphics configuration.
 *
 * This is the single switch + tunable set for the graphics modes:
 *
 *   - GRAPHICS_MODE_POLISHED     — the DEFAULT. The finished, polished look: the proven Competitive
 *                                  lighting rig parameterized with POLISHED_CONFIG values, plus (added
 *                                  phase-by-phase) the gym reflection probe, full static+dynamic
 *                                  shadows, the planar floor mirror, DefaultRenderingPipeline + SSAO2,
 *                                  GlowLayer emissives, and the sandbox sun/sky/CSM atmosphere.
 *
 *   - GRAPHICS_MODE_PERFORMANCE  — the previous bright school-gym baseline (formerly 'competitive'),
 *                                  kept as the max-FPS/clarity escape hatch. One HemisphericLight +
 *                                  one DirectionalLight key + one 1024 ShadowGenerator, gradient env,
 *                                  ACES in-material, a single FXAA post. NEVER constructs a polished
 *                                  system.
 *
 *   - GRAPHICS_MODE_NEUTRAL      — diagnostic truth baseline (dev-only; hidden unless the graphics
 *                                  debug flag is set). Tonemapping off, no env, minimal rig.
 *
 * NOTHING here is imported by server or shared code. None of it touches gameplay, collision, map
 * dimensions, networking, HUD/scoreboard behavior, or practice behavior — it only configures rendering.
 *
 * RETURN-TO-BASELINE: set localStorage 'strafeball.graphics.mode' = 'performance' (or pick the
 * Performance preset in Settings). That fully restores the pre-overhaul baseline; not one polished
 * system is created. The compiled default is 'polished'.
 *
 * MIGRATION: older builds persisted 'competitive' / 'showcase' (+ 'strafeball.graphics.tier').
 * resolveGraphicsMode() migrates those once (competitive→performance, showcase→polished, tier key
 * deleted) and writes the new value back.
 *
 * Live tuning: POLISHED_CONFIG values are read through resolvePolishedConfig() (graphicsTuning.ts),
 * which overlays dev-tuning overrides from localStorage. Ship values live HERE; the tuning panel is
 * how they get discovered, then they are baked back into POLISHED_CONFIG.
 */

export const GRAPHICS_MODE_POLISHED = 'polished';
export const GRAPHICS_MODE_PERFORMANCE = 'performance';
export const GRAPHICS_MODE_NEUTRAL = 'neutral';
/** Legacy mode strings (pre-overhaul) — accepted ONLY by the migration shim in resolveGraphicsMode. */
export const GRAPHICS_MODE_COMPETITIVE = 'competitive';
export const GRAPHICS_MODE_SHOWCASE = 'showcase';
export type GraphicsMode = typeof GRAPHICS_MODE_POLISHED | typeof GRAPHICS_MODE_PERFORMANCE | typeof GRAPHICS_MODE_NEUTRAL;

/** THE central switch. Default = Polished; Performance is the opt-in escape hatch. */
export const ACTIVE_GRAPHICS_MODE: GraphicsMode = GRAPHICS_MODE_POLISHED;

const MODE_STORAGE_KEY = 'strafeball.graphics.mode';
const LEGACY_TIER_STORAGE_KEY = 'strafeball.graphics.tier';
export const GRAPHICS_DEBUG_STORAGE_KEY = 'strafeball.debug.graphics';

export const SHOWCASE_TIER_ULTRA = 'ultra';
export const SHOWCASE_TIER_HIGH = 'high';
export type ShowcaseTier = typeof SHOWCASE_TIER_ULTRA | typeof SHOWCASE_TIER_HIGH;

/** Legacy Showcase tier default — only read by the retired Showcase modules until Phase 7 deletes them. */
export const DEFAULT_SHOWCASE_TIER: ShowcaseTier = SHOWCASE_TIER_ULTRA;

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode) — ignore; the compiled default still applies.
  }
}

function removeLocalStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Resolve the active graphics mode: localStorage override (if valid) else the compiled constant.
 * Migrates legacy persisted values ONCE (write-back), so the migration cost is a single load:
 *   'showcase'    → 'polished'     (the polished mode supersedes the old showcase experiment)
 *   'competitive' → 'performance'  (the user explicitly chose the old baseline — keep their look)
 * The legacy tier key is deleted alongside.
 */
export function resolveGraphicsMode(): GraphicsMode {
  const stored = readLocalStorage(MODE_STORAGE_KEY);
  if (stored === GRAPHICS_MODE_POLISHED || stored === GRAPHICS_MODE_PERFORMANCE || stored === GRAPHICS_MODE_NEUTRAL) {
    return stored;
  }
  if (stored === GRAPHICS_MODE_SHOWCASE) {
    writeLocalStorage(MODE_STORAGE_KEY, GRAPHICS_MODE_POLISHED);
    removeLocalStorage(LEGACY_TIER_STORAGE_KEY);
    return GRAPHICS_MODE_POLISHED;
  }
  if (stored === GRAPHICS_MODE_COMPETITIVE) {
    writeLocalStorage(MODE_STORAGE_KEY, GRAPHICS_MODE_PERFORMANCE);
    removeLocalStorage(LEGACY_TIER_STORAGE_KEY);
    return GRAPHICS_MODE_PERFORMANCE;
  }
  return ACTIVE_GRAPHICS_MODE;
}

/**
 * The one quality question every construction site asks. 'performance'/'neutral' take the exact
 * pre-overhaul code paths (bit-identical rendering); 'polished' layers the overhaul systems on top of
 * the Competitive rig with POLISHED_CONFIG values.
 */
export function getGraphicsQuality(): GraphicsMode {
  return resolveGraphicsMode();
}

/** True when the graphics debug flag is set (tuning panel, [graphics] audit, neutral preset in UI). */
export function isGraphicsDebugFlagEnabled(): boolean {
  return readLocalStorage(GRAPHICS_DEBUG_STORAGE_KEY) === '1';
}

/** Legacy Showcase tier resolver — only the retired Showcase modules read it (Phase 7 deletes both). */
export function resolveShowcaseTier(): ShowcaseTier {
  const override = readLocalStorage(LEGACY_TIER_STORAGE_KEY);
  if (override === SHOWCASE_TIER_ULTRA || override === SHOWCASE_TIER_HIGH) return override;
  return DEFAULT_SHOWCASE_TIER;
}

/**
 * @deprecated The 'showcase' mode no longer resolves (migrated to 'polished'), so this is always
 * false. Kept so the retired Showcase modules compile until Phase 7 deletes them.
 */
export function isShowcaseLightingEnabled(): boolean {
  return false;
}

/**
 * True when Neutral — the diagnostic truth baseline — is active: current geometry/materials, one
 * hemi + one directional + one ShadowGenerator, FXAA only, no env/reflection source, and none of the
 * fake-lighting decal overlays (wax sheen, glints, falloff pools, wall-bounce glow, etc.).
 */
export function isNeutralModeEnabled(): boolean {
  return resolveGraphicsMode() === GRAPHICS_MODE_NEUTRAL;
}

/**
 * A user-facing graphics preset — now 1:1 with the mode. Persisted via the same localStorage key the
 * resolver reads, so the choice survives reloads. Graphics systems are built once at scene
 * construction, so a swap takes effect after a reload.
 */
export type GraphicsPreset = GraphicsMode;

/** Presets the settings UI offers. Neutral is dev-only (graphics debug flag) — players never see it. */
export function getGraphicsPresets(): { value: GraphicsPreset; label: string }[] {
  const presets: { value: GraphicsPreset; label: string }[] = [
    { value: GRAPHICS_MODE_POLISHED, label: 'Polished (default)' },
    // Keep the internal `performance` value for stored-setting compatibility. Competitive is the
    // player-facing name for the flat legacy renderer: maximum clarity/FPS, no polished Creator FX.
    { value: GRAPHICS_MODE_PERFORMANCE, label: 'Competitive (max FPS)' }
  ];
  if (isGraphicsDebugFlagEnabled()) {
    presets.push({ value: GRAPHICS_MODE_NEUTRAL, label: 'Neutral (diagnostic)' });
  }
  return presets;
}

/** The currently-selected preset (modes and presets are now 1:1). */
export function getGraphicsPreset(): GraphicsPreset {
  return resolveGraphicsMode();
}

/** Persist a preset to localStorage (the resolvers + scene read it on next build/reload). */
export function persistGraphicsPreset(preset: GraphicsPreset): void {
  writeLocalStorage(MODE_STORAGE_KEY, preset);
  removeLocalStorage(LEGACY_TIER_STORAGE_KEY);
}

/**
 * Name once used by the (removed) Showcase .env loader. Retained ONLY as a defensive guard key in
 * GymVisualRevamp.applyGymEnvironment so a stale texture from an old session can never be doubled.
 */
export const SHOWCASE_ENV_TEXTURE_NAME = 'gym_showcase_env';

// -------------------------------------------------------------------------------------------------
// POLISHED mode — the single tunable block for the graphics overhaul (plan: dreamy-chasing-quokka).
// Read ONLY through resolvePolishedConfig() (graphicsTuning.ts), which overlays dev-tuning-panel
// overrides — never import POLISHED_CONFIG directly from a rendering system. Ship values live here;
// the tuning panel discovers them live, then they are baked back into this block.
//
// Phase 0 seeds `lights` + `shadows` with the EXACT Competitive values (bit-identical rendering —
// the Phase 0 gate is pixel-comparable screenshots). Later phases consume the other blocks:
//   probe (P1) · shadows upgrade (P2) · mirror (P3) · post/ssao (P4) · glow (P5) · sandbox (P6).
// -------------------------------------------------------------------------------------------------

export type Tuple3 = [number, number, number];
export type Rgb3 = Tuple3;

export interface PolishedConfig {
  /**
   * Supersampling factor: the WebGL buffer renders at renderScale× the canvas size, then downsamples
   * to the screen (SSAA). This is the one AA technique that cleans EVERYTHING — geometric edges
   * (bleacher rails, center line), thin bright emissives (the light strips' sparkle), texture
   * shimmer, and specular — with no prepass/MSAA compatibility caveats. 1 = native; 1.5 = 2.25×
   * fragments. The single biggest quality lever AND the single biggest GPU cost — the tuning panel's
   * "Render scale" slider drives it live. Applied via engine.setHardwareScalingLevel(1/renderScale).
   */
  renderScale: number;
  /** Scene image processing (ACES stays on; these are the exposure/contrast lift values). */
  imageProcessing: { exposure: number; contrast: number };
  lights: {
    hemi: { intensity: number; diffuse: Rgb3; ground: Rgb3; specular: Rgb3 };
    key: { intensity: number; direction: Tuple3; diffuse: Rgb3; specular: Rgb3 };
  };
  shadows: {
    mapSize: number;
    /** Babylon darkness: 0 = black, 1 = invisible. */
    darkness: number;
    bias: number;
    normalBias: number;
    forceBackFacesOnly: boolean;
  };
  /** Gym reflection probe (Phase 1). Kill switch: enabled=false ⇒ today's gradient-env-only look. */
  probe: {
    enabled: boolean;
    resolution: number;
    /** Probe Y = wallHeight × this. */
    centerHeightFraction: number;
    /** Per-surface probe reflection strength (environmentIntensity on the receiver materials). */
    intensities: { wall: number; coverMat: number; bleacher: number; ball: number };
  };
  /** Planar floor mirror (Phase 3). */
  mirror: {
    enabled: boolean;
    /** MirrorTexture size ratio vs render size (0.5 = half-res). */
    ratio: number;
    blurKernel: number;
    /** environmentIntensity on the floor material while the mirror drives its reflection. */
    floorEnvironmentIntensity: number;
    /**
     * PBR specularIntensity on the floor while the mirror is live. Near-zero by design: the
     * analytic specular highlights of the key + hemi lights are view-dependent blobs that FOLLOW
     * the camera at a fixed angle across the glossy floor (the reported "two light reflections
     * that follow you"). With them suppressed, all floor shine comes from the mirror (real,
     * parallax-correct reflections) and the glowing strips it reflects.
     */
    floorSpecularIntensity: number;
    maxRenderListSize: number;
  };
  /** Post pipeline (Phase 4) + bloom block (present, ships OFF — GlowLayer is the emissive path). */
  post: {
    fxaa: boolean;
    /**
     * MSAA sample count on the DefaultRenderingPipeline (1 = off, 2/4/8 = MSAA). FXAA alone can't
     * resolve thin high-contrast GEOMETRIC edges (bleacher rails, the light strips) — it only smears
     * them; MSAA multisamples those edges properly. Kept alongside FXAA (FXAA still cleans up
     * shader/specular aliasing MSAA misses). 4 is the sweet spot on a mid GPU with the FPS headroom.
     */
    msaaSamples: number;
    ssao: {
      enabled: boolean;
      base: number;
      totalStrength: number;
      radius: number;
      maxZGym: number;
      maxZSandbox: number;
      samples: number;
      ssaoRatio: number;
      blurRatio: number;
      expensiveBlur: boolean;
    };
    bloom: { enabled: boolean; threshold: number; weight: number; kernel: number; scale: number };
    vignette: { enabled: boolean; weight: number };
  };
  /** GlowLayer emissives (Phase 5) — includedOnlyMeshes, per-mesh allow-list. */
  glow: {
    enabled: boolean;
    intensity: number;
    blurKernelSize: number;
    mainTextureRatio: number;
    /**
     * Emissive multipliers on the light SOURCES per group (applied to the source materials, not the
     * GlowLayer, so a group's bloom AND main-render brightness scale together — used to calm lights
     * the reference showed as over-bright). 1 = unchanged.
     */
    ceilingSourceScale: number; // ceiling fixtures (lens + housing) + ceiling perimeter cove
    wallSourceScale: number; // wall accent band cove
  };
  /** Outdoor sandbox atmosphere (Phase 6): sun + CSM + gradient sky dome + fog. */
  sandbox: {
    sun: { direction: Tuple3; intensity: number; diffuse: Rgb3; specular: Rgb3 };
    hemi: { intensity: number; diffuse: Rgb3; ground: Rgb3 };
    sky: { zenith: Rgb3; horizon: Rgb3; ground: Rgb3 };
    fog: { start: number; end: number };
    csm: {
      mapSize: number;
      cascades: number;
      lambda: number;
      darkness: number;
      bias: number;
      normalBias: number;
      shadowMaxZ: number;
      stabilizeCascades: boolean;
    };
  };
}

export const POLISHED_CONFIG: PolishedConfig = {
  // Reference-image grade: warmer + slightly punchier than the baseline (honey-toned court, gentle
  // contrast lift). Final calibration continues via the tuning panel against the reference render.
  // 1.0 = native (no supersampling). Supersampling is the big FPS cost — even 1.10× dipped the target
  // mid GPU below its 144 cap. With SSAO2 no longer stealing MSAA (forceGeometryBuffer), 4× MSAA
  // (nearly free on modern GPUs) handles the geometric edges (center line, bleacher rails) that were
  // the core complaint, so supersampling stays OFF by default. Raise the "Render scale" slider only
  // to further soften thin bright emissives (light strips) when FPS headroom allows.
  renderScale: 1.0,
  // Phase 7: baked from the user's live-tuned session (GraphicsTuningPanel "Log baked JSON",
  // reference-image calibration pass) — this IS the calibrated look, not a placeholder.
  imageProcessing: { exposure: 1.23, contrast: 1.11 },
  lights: {
    hemi: {
      intensity: 0.32,
      diffuse: [1.0, 0.95, 0.86],
      ground: [0.4, 0.42, 0.47],
      specular: [0.12, 0.12, 0.13]
    },
    key: {
      intensity: 1.23,
      direction: [-0.35, -1, -0.25],
      diffuse: [1.0, 0.96, 0.88],
      specular: [0.2, 0.2, 0.2]
    }
  },
  // Phase 2 shadow system (2048 PCF, backface-only against acne on the merged wall-pad panels),
  // darkness/bias retuned in the Phase 7 calibration pass.
  shadows: { mapSize: 2048, darkness: 0.15, bias: 0.0046, normalBias: 0.04, forceBackFacesOnly: true },
  probe: {
    enabled: true,
    resolution: 256,
    centerHeightFraction: 0.5,
    intensities: { wall: 0.04, coverMat: 0.12, bleacher: 0.06, ball: 0.3 }
  },
  // Phase 7 calibration: floorEnvironmentIntensity/blurKernel tuned against the reference image;
  // floorSpecularIntensity stays low so the mirror (not the analytic key/hemi highlights) owns the
  // floor's shine (see the interface comment above — this is the camera-following-blob fix).
  mirror: { enabled: true, ratio: 0.5, blurKernel: 20, floorEnvironmentIntensity: 0.69, floorSpecularIntensity: 0.05, maxRenderListSize: 120 },
  post: {
    fxaa: true,
    // MSAA 4×: 8× held 144 in open views but dropped to ~100 in dense corner views (every wall, the
    // full bleacher stack, and both goal areas resolving at once) — the MSAA resolve cost scales with
    // how much high-frequency geometry fills the frame. 4× is the sustainable geometric-edge AA that
    // keeps the cap even in the worst-case corner. Anisotropy 16× still handles all textured shimmer.
    msaaSamples: 4,
    ssao: {
      enabled: true,
      base: 0.35,
      totalStrength: 0.65,
      radius: 0.9,
      maxZGym: 55,
      maxZSandbox: 140,
      samples: 12,
      ssaoRatio: 0.5,
      blurRatio: 0.5,
      expensiveBlur: false
    },
    bloom: { enabled: false, threshold: 0.9, weight: 0.15, kernel: 48, scale: 0.5 },
    vignette: { enabled: false, weight: 0.3 }
  },
  // ceilingSourceScale 0.72 (−28%) / wallSourceScale 0.85 (−15%): the reference-image cove +
  // fixtures read a touch hot, so their emissive is calmed per group (also softens the bloom halo).
  glow: { enabled: true, intensity: 0.5, blurKernelSize: 32, mainTextureRatio: 0.5, ceilingSourceScale: 0.72, wallSourceScale: 0.85 },
  sandbox: {
    sun: { direction: [-0.45, -0.78, -0.32], intensity: 1.15, diffuse: [1.0, 0.96, 0.88], specular: [0.25, 0.24, 0.22] },
    hemi: { intensity: 0.55, diffuse: [0.72, 0.8, 0.92], ground: [0.4, 0.42, 0.4] },
    sky: { zenith: [0.24, 0.44, 0.71], horizon: [0.72, 0.8, 0.88], ground: [0.55, 0.6, 0.62] },
    fog: { start: 180, end: 600 },
    csm: {
      mapSize: 2048,
      cascades: 2,
      lambda: 0.7,
      darkness: 0.3,
      bias: 0.004,
      normalBias: 0.05,
      shadowMaxZ: 340,
      stabilizeCascades: true
    }
  }
};

/**
 * Every Showcase tunable in one place (Part 1–6 of the spec). Read by ShowcaseLighting, ShowcasePostFX,
 * and the Showcase material pass in GymVisualRevamp. Tweak here; nothing is scattered as magic numbers.
 */
export const SHOWCASE_CONFIG = {
  /**
   * Showcase lighting = EVEN ambient room light, not aimed sources (the old 6-spotlight rig pooled
   * under each fixture and read like stage lights). One broad HemisphericLight is the main fill; one
   * angled DirectionalLight is the key + the single ShadowGenerator. The visible ceiling fixtures stay
   * emissive housings — they are NOT light sources, so there are no spotlight pools. 1 hemi + 1 key = 2.
   */
  lights: {
    /**
     * Broad even room fill. Warm-white on upward faces; the GROUND colour is deliberately darker + cool
     * so downward-facing surfaces, corners, and under-bleacher areas fall off naturally — this is the
     * main "depth + darker corners" lever, no fake AO needed. Kept moderate so the key still models.
     */
    hemi: {
      intensityByTier: { [SHOWCASE_TIER_ULTRA]: 0.62, [SHOWCASE_TIER_HIGH]: 0.79 } as Record<ShowcaseTier, number>,
      diffuse: [1.0, 0.975, 0.93] as [number, number, number],
      ground: [0.26, 0.29, 0.36] as [number, number, number], // darker cool ground = natural corner depth
      specular: [0.06, 0.06, 0.07] as [number, number, number]
    },
    /**
     * The single directional KEY (and the only ShadowGenerator). Angled diagonally so it rakes across
     * the court and casts readable shadows that give the whole map depth — corners away from it stay
     * darker. Warm-neutral white. This is the dominant brightness source; the hemi is the fill.
     */
    key: {
      intensityByTier: { [SHOWCASE_TIER_ULTRA]: 0.95, [SHOWCASE_TIER_HIGH]: 1.08 } as Record<ShowcaseTier, number>,
      direction: [-0.35, -1, -0.25] as [number, number, number],
      diffuse: [1.0, 0.99, 0.95] as [number, number, number],
      specular: [0.16, 0.16, 0.16] as [number, number, number]
    }
  },

  /**
   * Showcase shadows: exactly ONE ShadowGenerator, bound to the directional key. Map size by tier
   * (2048 Ultra / 1024 High). Darkness in the 0.14–0.20 band so player/mat/dummy + selected static
   * shadows read as soft indoor shadows that give the court depth.
   */
  shadows: {
    mapSizeByTier: { [SHOWCASE_TIER_ULTRA]: 2048, [SHOWCASE_TIER_HIGH]: 1024 } as Record<ShowcaseTier, number>,
    /** Babylon darkness: 0 = black, 1 = invisible. */
    darknessByTier: { [SHOWCASE_TIER_ULTRA]: 0.22, [SHOWCASE_TIER_HIGH]: 0.28 } as Record<ShowcaseTier, number>,
    bias: 0.0016,
    normalBias: 0.02,
    /** 'pcf' (default, broad support) or 'pcfsoft' (softer, slightly heavier). */
    filter: 'pcf' as 'pcf' | 'pcfsoft'
  },

  /**
   * SSAO (Phase 8) — subtle contact depth in bleacher gaps / wall-floor & wall-ceiling joins / scoreboard
   * recess / mat contact / pad seams. Showcase-only, and `enabled` is THE single kill switch: set it to
   * false to remove SSAO entirely (no other change needed). Kept gentle with a raised `base` so it never
   * turns the bright gym dark/dirty, greys the walls, hazes the room, or halos.
   */
  ssao: {
    /** THE SSAO kill switch. RECOVERY: SSAO is OFF — the scene must pass a direct-light/material
     * baseline before SSAO is reconsidered. true = subtle SSAO2 in Showcase; false = no SSAO anywhere. */
    enabled: false,
    /** Final occlusion = clamp(base + ssao). A high base keeps it subtle and stops black-out. */
    base: 0.3,
    totalStrength: 0.7, // softened for subtlety (Phase 8): contact darkening only, no dirty haze
    radius: 1.3,
    maxZ: 55,
    /** Samples + render ratio scale with tier; expensive bilateral blur only at Ultra. */
    byTier: {
      [SHOWCASE_TIER_ULTRA]: { samples: 16, ssaoRatio: 1.0, blurRatio: 1.0, expensiveBlur: true, textureSamples: 4 },
      [SHOWCASE_TIER_HIGH]: { samples: 8, ssaoRatio: 0.75, blurRatio: 1.0, expensiveBlur: false, textureSamples: 2 }
    } as Record<ShowcaseTier, { samples: number; ssaoRatio: number; blurRatio: number; expensiveBlur: boolean; textureSamples: number }>
  },

  /**
   * INERT since Phase 6/8: bloom is forbidden and is NOT wired anywhere. FXAA is the standalone post in
   * ArenaScene (all modes). This block is retained only so the data isn't lost if a separate bloom test
   * is requested later; nothing reads it today.
   */
  post: {
    fxaa: true,
    bloom: {
      enabled: false,
      /** High threshold so only bright emissive fixtures / scoreboard LEDs bloom — court lines, balls,
       * and UI stay sharp. */
      threshold: 0.85,
      weight: 0.16,
      kernel: 32,
      scale: 0.5
    }
  },

  /**
   * Phase 7 static reflection probe. ONE Babylon ReflectionProbe centred at mid-court between floor and
   * ceiling, rendered once over an explicit static render list (see GymReflectionProbe). 256 to start;
   * 512 is permitted for High/Showcase only if 256 reads insufficient after screenshots.
   */
  reflectionProbe: {
    resolution: 256,
    /** Probe Y = wallHeight × this. 0.5 ⇒ roughly midway between floor and ceiling. */
    centerHeightFraction: 0.5
  },

  /**
   * Showcase material response (Part 1 + Part 6). Applied as an override pass ON TOP of the competitive
   * baseline material tuning, only in Showcase mode, so the baseline values are never mutated. Roughness
   * values sit inside the spec bands; environmentIntensity now scales the Phase-7 reflection PROBE (not
   * an HDR env) — broad blurred fixture response mainly on the floor, never a mirror.
   */
  materials: {
    /** PBR simultaneous-light cap. Showcase now has just 2 scene lights (1 hemi + 1 directional key),
     * so the PBR default of 4 is ample; no surface ever needs more than 2 simultaneously. */
    maxSimultaneousLights: 4,
    // Calmed maple response (Materials Pass B): roughness raised and environmentIntensity/specularIntensity
    // lowered so the probe reflection stays a faint blurred response rather than a wet/strong highlight,
    // matching the Competitive baseline in GYM_MATERIAL_TUNING.floor.
    floor: { albedoTint: [1.0, 0.99, 0.955] as [number, number, number], roughness: 0.58, environmentIntensity: 0.065, specularIntensity: 0.22 },
    coverMat: { roughness: 0.48, environmentIntensity: 0.08 }, // tiny satin response
    bleacher: { roughness: 0.8, environmentIntensity: 0.05 }, // matte like Neutral — no glossy highlight
    wall: { roughness: 0.74, environmentIntensity: 0.0 }, // nearly none (no reflectionTexture wired)
    /** Ceiling is a StandardMaterial (no PBR roughness): expressed as a near-zero specular response,
     * the StandardMaterial equivalent of the 0.82–0.90 roughness intent. */
    ceiling: { specular: [0.012, 0.012, 0.011] as [number, number, number], specularPower: 8 }
  }
} as const;
