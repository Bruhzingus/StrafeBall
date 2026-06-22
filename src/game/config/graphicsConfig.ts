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
 *                                  on a strong desktop" mode. Roof-aligned SpotLights with real
 *                                  fixture-origin shadows, the prefiltered .env image-based lighting,
 *                                  SSAO, and a restrained bloom pass. Heavier than Competitive by design.
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
export type GraphicsMode = typeof GRAPHICS_MODE_COMPETITIVE | typeof GRAPHICS_MODE_SHOWCASE;

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
  if (override === GRAPHICS_MODE_SHOWCASE || override === GRAPHICS_MODE_COMPETITIVE) return override;
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
 * A user-facing graphics preset = the (mode, tier) pair the settings UI exposes as one choice:
 *   - 'competitive'    → the bright baseline (no Showcase systems)
 *   - 'showcase-high'  → Showcase at the High tier (1024 shadows, reduced SSAO)
 *   - 'showcase-ultra' → Showcase at the Ultra tier (2048 shadows, full SSAO)
 * Persisted via the same localStorage keys the resolvers above read, so the choice survives reloads.
 * Graphics systems are built once at scene construction, so a swap takes effect after a reload.
 */
export type GraphicsPreset = typeof GRAPHICS_MODE_COMPETITIVE | 'showcase-high' | 'showcase-ultra';

export const GRAPHICS_PRESETS: { value: GraphicsPreset; label: string }[] = [
  { value: 'competitive', label: 'Competitive (bright baseline)' },
  { value: 'showcase-high', label: 'Showcase — High' },
  { value: 'showcase-ultra', label: 'Showcase — Ultra' }
];

/** The currently-selected preset, derived from the resolved mode + tier. */
export function getGraphicsPreset(): GraphicsPreset {
  if (resolveGraphicsMode() === GRAPHICS_MODE_COMPETITIVE) return 'competitive';
  return resolveShowcaseTier() === SHOWCASE_TIER_ULTRA ? 'showcase-ultra' : 'showcase-high';
}

/** Persist a preset to localStorage (the resolvers + scene read it on next build/reload). */
export function persistGraphicsPreset(preset: GraphicsPreset): void {
  const writes: [string, string][] =
    preset === 'competitive'
      ? [['strafeball.graphics.mode', GRAPHICS_MODE_COMPETITIVE]]
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
  /** Roof-source lighting. Positions come from the gym's real fixture grid (see ShowcaseLighting). */
  lights: {
    /** Broad ambient fill so the room stays bright/clean even with directional roof pools. */
    hemi: {
      intensity: 0.5,
      diffuse: [1.0, 0.985, 0.95] as [number, number, number],
      ground: [0.42, 0.45, 0.52] as [number, number, number],
      specular: [0.08, 0.08, 0.085] as [number, number, number]
    },
    /**
     * Optional low, NON-shadowing directional fill — broad modeling only, no fake-sun shadow. Kept
     * weak so the roof spots own the shading direction. Aimed STRAIGHT DOWN (no horizontal tilt) so it
     * adds even top fill and never makes one half of the court brighter than the other.
     */
    fillDirectional: {
      enabled: true,
      intensity: 0.18,
      direction: [0, -1, 0] as [number, number, number],
      diffuse: [0.97, 0.975, 0.99] as [number, number, number]
    },
    /**
     * The roof light layout is a symmetric 2×3 grid DERIVED FROM MAP HALF-EXTENTS (not arbitrary
     * coordinates or the clustered visual-fixture positions): three columns across the width (X) —
     * left / centre / right — and two rows along the length (Z) — front / back. The four corner cells
     * are the primary shadow-casting spots (one per court quadrant); the two centre-column cells are
     * the unshadowed fills. ShowcaseLighting reads halfWidth/halfLength from TUNING and multiplies by
     * these fractions, so left/right and front/back are exactly mirrored.
     */
    roofGrid: {
      /** Primary columns at X = ±halfWidth·columnFractionX; the fill column is X = 0. 0.5 ⇒ a primary
       * sits directly over its court quadrant centre, which spreads light evenly across the width. */
      columnFractionX: 0.5,
      /** Front/back rows at Z = ±halfLength·rowFractionZ. 0.5 ⇒ a row sits over the quadrant centre. */
      rowFractionZ: 0.5,
      /** Each spot aims at the floor point below it: target = (x·f, 0, z·f). 1.0 = straight down over
       * the quadrant centre (the most even coverage). <1 pulls aim toward court centre (more central
       * overlap but a brighter centre / dimmer edges); >1 pushes outward. Kept at 1.0 so the previous
       * blown-out central floor pool is not re-created — the broad cones already overlap softly at the
       * seams. direction is computed as normalize(target − position); no guessed fixed vector. */
      targetInwardFraction: 1.0
    },
    /**
     * Four primary roof SpotLights, one per court quadrant (the four corner cells of the grid above),
     * each aimed straight down at its quadrant centre. Wide soft cones that read like broad fluorescent
     * fixtures, neutral white with a faint warm bias. These are the shadow-casting lights (Part 3).
     * Intensity is restrained and specular is low so the floor gets a soft sheen, not a blown-out pool.
     */
    primarySpot: {
      angleRadians: 1.55, // ~89° aperture — broad fixture pool, not a theatrical pencil beam
      exponent: 3, // low exponent = soft, broad, slow falloff across the pool
      intensity: 56, // restrained after the rebalance; physical inverse-square falloff to the floor
      range: 32, // metres before the spot fully decays (reaches floor + horizontal quadrant spread)
      diffuse: [1.0, 0.98, 0.94] as [number, number, number], // tiny warm bias
      // Low specular: the spots give a soft floor sheen, NOT a mirror — prevents the white floor pool.
      specular: [0.2, 0.2, 0.2] as [number, number, number]
    },
    /**
     * Two UNSHADOWED roof fill SpotLights over the centre column (front-centre + back-centre) — the
     * broadest, lowest cones. They fill the central seam and remove dead zones without painting a
     * visible floor circle. No ShadowGenerator is bound to these.
     */
    fillSpot: {
      enabled: true,
      angleRadians: 1.72, // broadest cone for the widest, softest fill
      exponent: 2,
      intensity: 32,
      range: 32,
      diffuse: [1.0, 0.985, 0.95] as [number, number, number],
      specular: [0.06, 0.06, 0.06] as [number, number, number]
    }
  },

  /**
   * Showcase shadows (Part 3): one ShadowGenerator per primary roof spot (4 total). Map size by tier;
   * restrained per-light darkness so four overlapping fixture shadows combine into soft indoor
   * shadowing, not black stacked stains.
   */
  shadows: {
    mapSizeByTier: { [SHOWCASE_TIER_ULTRA]: 2048, [SHOWCASE_TIER_HIGH]: 1024 } as Record<ShowcaseTier, number>,
    /** Babylon darkness: 0 = black, 1 = invisible. Spec band 0.12–0.20 per spotlight. */
    darkness: 0.16,
    bias: 0.0016,
    normalBias: 0.02,
    /** 'pcf' (default, broad support) or 'pcfsoft' (softer, slightly heavier). PCSS stays opt-in below. */
    filter: 'pcf' as 'pcf' | 'pcfsoft',
    /**
     * PCSS (contact-hardening soft shadows) is Showcase-only and OFF until visually validated against
     * the installed Babylon build — enabling blind can over-soften / self-shadow. Flip to true only
     * after inspection (spec Part 3).
     */
    usePcss: false
  },

  /**
   * SSAO (Part 4) — subtle room depth in bleacher gaps / wall-floor & wall-ceiling junctions / mat
   * contact / pad seams. Kept gentle with a raised `base` so it never turns the bright gym dark/dirty
   * or greys the walls.
   */
  ssao: {
    enabled: true,
    /** Final occlusion = clamp(base + ssao). A high base keeps it subtle and stops black-out. */
    base: 0.28,
    totalStrength: 0.9,
    radius: 1.4,
    maxZ: 60,
    /** Samples + render ratio scale with tier; expensive bilateral blur only at Ultra. */
    byTier: {
      [SHOWCASE_TIER_ULTRA]: { samples: 16, ssaoRatio: 1.0, blurRatio: 1.0, expensiveBlur: true, textureSamples: 4 },
      [SHOWCASE_TIER_HIGH]: { samples: 8, ssaoRatio: 0.75, blurRatio: 1.0, expensiveBlur: false, textureSamples: 2 }
    } as Record<ShowcaseTier, { samples: number; ssaoRatio: number; blurRatio: number; expensiveBlur: boolean; textureSamples: number }>
  },

  /**
   * Post-processing (Part 5). Tone mapping is intentionally NOT reconfigured here: the project already
   * applies ACES + a modest exposure in-material via scene.imageProcessingConfiguration
   * (GymVisualRevamp.tuneSceneImageProcessing), which is the safe path — Showcase reuses it untouched so
   * there is no double tone-map. This block only adds FXAA + a restrained emissive-only bloom.
   */
  post: {
    fxaa: true,
    bloom: {
      enabled: true,
      /** High threshold so only bright emissive fixtures / scoreboard LEDs bloom — court lines, balls,
       * and UI stay sharp. */
      threshold: 0.85,
      weight: 0.16,
      kernel: 32,
      scale: 0.5
    }
  },

  /**
   * Showcase material response (Part 1 + Part 6). Applied as an override pass ON TOP of the competitive
   * baseline material tuning, only in Showcase mode, so the baseline values are never mutated. Roughness
   * values sit inside the spec bands; environmentIntensity is raised vs Competitive so the .env reads as
   * broad soft ceiling-light streaks (mainly on the floor), never a mirror.
   */
  materials: {
    /** PBR simultaneous-light cap so floor/walls/mats/bleachers actually react to all roof spots + fill
     * (1 hemi + 1 fill dir + 4 primary + 2 fill = up to 8). PBR defaults to 4, which would drop lights. */
    maxSimultaneousLights: 8,
    // environmentIntensity kept modest: the substitute .env is a warm cafeteria capture, so a high
    // value tints the waxed floor yellow. 0.45 keeps a clear broad reflection without the yellow cast.
    floor: { roughness: 0.32, environmentIntensity: 0.45, specularIntensity: 0.45 },
    wallPad: { roughness: 0.5, environmentIntensity: 0.3 },
    coverMat: { roughness: 0.48, environmentIntensity: 0.32 },
    bleacher: { roughness: 0.6, environmentIntensity: 0.2 },
    wall: { roughness: 0.74, environmentIntensity: 0.06 },
    /** Ceiling is a StandardMaterial (no PBR roughness): expressed as a near-zero specular response,
     * the StandardMaterial equivalent of the 0.82–0.90 roughness intent. */
    ceiling: { specular: [0.012, 0.012, 0.011] as [number, number, number], specularPower: 8 }
  }
} as const;
