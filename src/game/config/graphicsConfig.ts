/**
 * Centralized client-only graphics configuration.
 *
 * This is the single switch + tunable set for the two graphics modes:
 *
 *   - GRAPHICS_MODE_COMPETITIVE  — the existing bright school-gym baseline. One HemisphericLight +
 *                                  one DirectionalLight key + one ShadowGenerator (CompetitiveLighting),
 *                                  a hidden gradient/HDR reflection env, ACES tone mapping in-material,
 *                                  and a single FXAA post. Performance-conscious; the shipping default.
 *
 *   - GRAPHICS_MODE_SHOWCASE     — a quality-first, client-only "make the gym look as good as possible
 *                                  on a strong desktop" mode. Phase 6: ONE fixture-aligned rig — six
 *                                  broad shadowless SpotLights under the visible ceiling fixtures, one
 *                                  hemispheric fill, and one subtle shadow-casting directional driving a
 *                                  single ShadowGenerator. FXAA only. No .env IBL, no SSAO, no bloom.
 *
 * NOTHING here is imported by server or shared code. None of it touches gameplay, collision, map
 * dimensions, networking, HUD/scoreboard behavior, or practice behavior — it only configures rendering.
 *
 * RETURN-TO-BASELINE (the one feature flag): leave ACTIVE_GRAPHICS_MODE = GRAPHICS_MODE_COMPETITIVE
 * (its default). That fully restores the current bright baseline; not one Showcase system is created.
 * For ad-hoc testing on a strong desktop without editing source, a localStorage override is honored:
 *   enable Showcase:  localStorage.setItem('strafeball.graphics.mode', 'showcase')
 *   back to baseline: localStorage.setItem('strafeball.graphics.mode', 'competitive')  (or removeItem)
 *   pick tier:        localStorage.setItem('strafeball.graphics.tier', 'ultra' | 'high')
 * The compiled constant always wins when no valid override is present.
 */

export const GRAPHICS_MODE_COMPETITIVE = 'competitive';
export const GRAPHICS_MODE_SHOWCASE = 'showcase';
export const GRAPHICS_MODE_NEUTRAL = 'neutral';
export type GraphicsMode = typeof GRAPHICS_MODE_COMPETITIVE | typeof GRAPHICS_MODE_SHOWCASE | typeof GRAPHICS_MODE_NEUTRAL;

/**
 * THE central switch. Default = Competitive so the bright baseline is never silently replaced. Flip to
 * GRAPHICS_MODE_SHOWCASE here (or via the localStorage override above) to opt into the showcase pass.
 */
export const ACTIVE_GRAPHICS_MODE: GraphicsMode = GRAPHICS_MODE_COMPETITIVE;

export const SHOWCASE_TIER_ULTRA = 'ultra';
export const SHOWCASE_TIER_HIGH = 'high';
export type ShowcaseTier = typeof SHOWCASE_TIER_ULTRA | typeof SHOWCASE_TIER_HIGH;

/** Default Showcase quality tier. Ultra targets a strong desktop GPU; High is the lighter fallback. */
export const DEFAULT_SHOWCASE_TIER: ShowcaseTier = SHOWCASE_TIER_ULTRA;

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Resolve the active graphics mode: localStorage override (if valid) else the compiled constant. */
export function resolveGraphicsMode(): GraphicsMode {
  const override = readLocalStorage('strafeball.graphics.mode');
  if (override === GRAPHICS_MODE_SHOWCASE || override === GRAPHICS_MODE_COMPETITIVE || override === GRAPHICS_MODE_NEUTRAL) {
    return override;
  }
  return ACTIVE_GRAPHICS_MODE;
}

/** Resolve the Showcase quality tier: localStorage override (if valid) else the compiled default. */
export function resolveShowcaseTier(): ShowcaseTier {
  const override = readLocalStorage('strafeball.graphics.tier');
  if (override === SHOWCASE_TIER_ULTRA || override === SHOWCASE_TIER_HIGH) return override;
  return DEFAULT_SHOWCASE_TIER;
}

/** True when the Showcase lighting pass should be built instead of the Competitive baseline. */
export function isShowcaseLightingEnabled(): boolean {
  return resolveGraphicsMode() === GRAPHICS_MODE_SHOWCASE;
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
 * A user-facing graphics preset = the (mode, tier) pair the settings UI exposes as one choice:
 *   - 'competitive'    → the bright baseline (no Showcase systems)
 *   - 'showcase-high'  → Showcase at the High tier (1024 shadows, reduced SSAO)
 *   - 'showcase-ultra' → Showcase at the Ultra tier (2048 shadows, full SSAO)
 * Persisted via the same localStorage keys the resolvers above read, so the choice survives reloads.
 * Graphics systems are built once at scene construction, so a swap takes effect after a reload.
 */
export type GraphicsPreset = typeof GRAPHICS_MODE_COMPETITIVE | typeof GRAPHICS_MODE_NEUTRAL | 'showcase-high' | 'showcase-ultra';

export const GRAPHICS_PRESETS: { value: GraphicsPreset; label: string }[] = [
  { value: 'competitive', label: 'Competitive (bright baseline)' },
  { value: 'neutral', label: 'Neutral (diagnostic baseline)' },
  { value: 'showcase-high', label: 'Showcase — High' },
  { value: 'showcase-ultra', label: 'Showcase — Ultra' }
];

/** The currently-selected preset, derived from the resolved mode + tier. */
export function getGraphicsPreset(): GraphicsPreset {
  const mode = resolveGraphicsMode();
  if (mode === GRAPHICS_MODE_COMPETITIVE) return 'competitive';
  if (mode === GRAPHICS_MODE_NEUTRAL) return 'neutral';
  return resolveShowcaseTier() === SHOWCASE_TIER_ULTRA ? 'showcase-ultra' : 'showcase-high';
}

/** Persist a preset to localStorage (the resolvers + scene read it on next build/reload). */
export function persistGraphicsPreset(preset: GraphicsPreset): void {
  const writes: [string, string][] =
    preset === 'competitive' || preset === 'neutral'
      ? [['strafeball.graphics.mode', preset]]
      : [
          ['strafeball.graphics.mode', GRAPHICS_MODE_SHOWCASE],
          ['strafeball.graphics.tier', preset === 'showcase-ultra' ? SHOWCASE_TIER_ULTRA : SHOWCASE_TIER_HIGH]
        ];
  try {
    for (const [key, value] of writes) window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode) — ignore; the compiled default still applies.
  }
}

/**
 * Prefiltered Babylon environment (.env) used as hidden image-based lighting in Showcase mode only.
 * Centralized here so the asset path is trivially swappable. (The user-supplied
 * public/assets/environment/gym_indoor_lighting.env was not present; this points at the existing
 * prefiltered gym .env already shipped in the repo — swap this one constant if the asset moves.)
 */
export const SHOWCASE_ENV_FILE_URL = '/assets/textures/gym/Lighting/newman_cafeteria_2k.env';
export const SHOWCASE_ENV_TEXTURE_NAME = 'gym_showcase_env';

/**
 * Every Showcase tunable in one place (Part 1–6 of the spec). Read by ShowcaseLighting, ShowcasePostFX,
 * and the Showcase material pass in GymVisualRevamp. Tweak here; nothing is scattered as magic numbers.
 */
export const SHOWCASE_CONFIG = {
  /**
   * Phase 6 fixture-aligned rig. Six broad low-intensity SpotLights — one directly under each visible
   * ceiling fixture (positions REUSED from CEILING_FIXTURE_POSITIONS, never re-derived) — aimed straight
   * down with a very wide soft cone so they read as fluorescent fixture pools, never a theatrical
   * circle, and they NEVER cast shadows. One low HemisphericLight fills the room. One subtle
   * shadow-casting DirectionalLight is the ONLY shadow source (one ShadowGenerator). 6 + 1 + 1 = 8.
   */
  lights: {
    /** Broad ambient fill so walls/ceiling stay bright and fixture shadows never go black. */
    hemi: {
      intensity: 0.5,
      diffuse: [1.0, 0.985, 0.95] as [number, number, number],
      ground: [0.44, 0.47, 0.53] as [number, number, number],
      specular: [0.08, 0.08, 0.085] as [number, number, number]
    },
    /**
     * Six fixture SpotLights, one under each visible ceiling fixture, aimed STRAIGHT DOWN. Wide aperture
     * + low exponent = soft overlapping pools with no visible cone edge; low specular = soft floor
     * sheen, not a mirror glint. These NEVER cast shadows (only the shadowKey below does). Intensity is
     * a starting value — six overlapping pools sum to an even court; tune from screenshots if needed.
     */
    fixtureSpot: {
      angleRadians: 1.74, // ~100° — very broad fixture wash; cones overlap into an even field
      exponent: 2, // soft, slow falloff (no hard bright circle on the floor)
      intensity: 22, // restrained; six fixtures sum to an even court without hot spots
      range: 30, // metres before decay — reaches the floor with horizontal spread
      diffuse: [1.0, 0.985, 0.95] as [number, number, number], // neutral white, faint warm
      specular: [0.06, 0.06, 0.06] as [number, number, number] // soft sheen only, no mirror
    },
    /**
     * The SINGLE shadow-casting light: a low DirectionalLight, mostly straight down with a slight tilt
     * so player/mat/dummy + selected static shadows read with ONE consistent direction (no conflicting
     * shadow directions). Low intensity so it never makes one side brighter than the fixtures' field.
     */
    shadowKey: {
      intensity: 0.32,
      direction: [-0.22, -1, -0.16] as [number, number, number],
      diffuse: [1.0, 0.99, 0.96] as [number, number, number],
      specular: [0.12, 0.12, 0.12] as [number, number, number]
    }
  },

  /**
   * Showcase shadows (Phase 6): exactly ONE ShadowGenerator, bound to the single shadowKey directional
   * (the six fixture spots never cast). Map size by tier (2048 Ultra / 1024 High). Darkness in the
   * 0.14–0.20 band so player/mat/dummy + selected static shadows read as soft indoor shadows.
   */
  shadows: {
    mapSizeByTier: { [SHOWCASE_TIER_ULTRA]: 2048, [SHOWCASE_TIER_HIGH]: 1024 } as Record<ShowcaseTier, number>,
    /** Babylon darkness: 0 = black, 1 = invisible. Phase 6 band 0.14–0.20. */
    darkness: 0.18,
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
    /** THE Phase-8 SSAO kill switch. true = subtle SSAO2 in Showcase; false = no SSAO anywhere. */
    enabled: true,
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
    /** PBR simultaneous-light cap. The Phase-6 rig has exactly 8 scene lights (6 fixture spots + 1 hemi
     * + 1 shadow directional), and the large continuous floor/wall meshes sit within range of ALL six
     * fixtures plus the hemi and directional — so capping below 8 would deterministically drop real
     * contributors and make a single mesh light unevenly. PBR defaults to 4; 8 is the exact light count,
     * not a guess, and cannot be lower without losing even illumination across the court. */
    maxSimultaneousLights: 8,
    // Phase 7: roughness ~0.40 (0.38–0.42 band) so the probe reflection is a BROAD blur, not a mirror;
    // environmentIntensity is the probe reflection STRENGTH — moderate on the floor, weaker than the
    // visible fixture source. (specularIntensity unchanged.)
    floor: { roughness: 0.40, environmentIntensity: 0.22, specularIntensity: 0.45 },
    // wallPad/wall are StandardMaterial-driven in practice and receive NO probe reflection ("nearly
    // none"); these env values are inert without a reflectionTexture and are kept only for completeness.
    wallPad: { roughness: 0.5, environmentIntensity: 0.0 },
    coverMat: { roughness: 0.48, environmentIntensity: 0.08 }, // tiny satin response
    bleacher: { roughness: 0.6, environmentIntensity: 0.05 }, // less than the mats
    wall: { roughness: 0.74, environmentIntensity: 0.0 }, // nearly none (no reflectionTexture wired)
    /** Ceiling is a StandardMaterial (no PBR roughness): expressed as a near-zero specular response,
     * the StandardMaterial equivalent of the 0.82–0.90 roughness intent. */
    ceiling: { specular: [0.012, 0.012, 0.011] as [number, number, number], specularPower: 8 }
  }
} as const;
