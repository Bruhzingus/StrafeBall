# Graphics performance choices

Reviewed September 26, 2026 against the current renderer and current browser captures. Competitive is now the default for fresh settings; explicit saved choices remain intact.

The ratings below describe likely savings when graphics are the bottleneck. They are not measured FPS increases. Headless browser captures establish appearance, but cannot represent the player's GPU or movement shimmer reliably.

## Applied selections

Following the user's selection of **1, 2 and 3**, both presets now use these defaults:

| Preset | Applied changes |
| --- | --- |
| Competitive | Reduced FX on by default, 512 shadow map, 90% scene resolution. |
| Polished | 35% floor reflection resolution, 8 AO samples, 1024 gym and outdoor shadow maps. |

The interface stays at full resolution. An explicitly saved Reduced FX choice takes precedence over the preset default; changing another setting does not lock that default to the old preset. Live preset switching updates scene resolution, shadows and the default effects choice. Existing developer tuning overrides continue to take precedence in Polished.

The tables below retain the original assessment of all five options. Options 4 and 5 remain suggestions.

## Competitive — five choices

Competitive already omits Polished's floor mirror, ambient occlusion, glow pass, and outdoor cascade shadows. There is less expensive decoration left to remove.

| Change | Likely performance effect | Visible difference and recommendation |
| --- | --- | --- |
| **1. Reduce cosmetic effects** using **Reduced FX** | Small normally; more useful during powerup bursts. | Fewer particles, trails, flashes and camera effects. The current court and characters stay readable without these. **Yes if FPS drops mainly during action.** |
| **2. Lower dynamic shadows from 1024 to 512** | Small to moderate GPU saving; shadow texture has one quarter as many pixels, but caster draw calls remain. | Shadows under players and cover become softer or more jagged. Current simple shapes do not need very detailed shadows. **A reasonable second choice; keep shadows on for depth cues.** |
| **3. Reduce render resolution to 90% per dimension** | Potentially substantial when pixel rendering is the bottleneck: 19% fewer scene pixels, not 19% more FPS. | The entire 3D view softens, including distant balls, wall text and court lines. Those are prominent in the current look. **Originally recommended only as a last resort; now applied at the user's request.** |
| **4. Reduce high anisotropic texture filtering from 16× to 8×** | Usually small and GPU-dependent. | Floor grain and angled wall signs can blur or shimmer farther away. These textures fill much of the current view. **Low priority; keep 16× unless testing shows a real benefit.** |
| **5. Disable FXAA** (edge smoothing) | Small: removes one full-screen pass. | Thin ceiling beams, rails and distant paint edges become rougher. The current image still has high-contrast edges that benefit from smoothing. **No, keep it on.** Existing jaggies are a reason to preserve useful AA, not discard it. |

Original Competitive recommendation: keep native resolution and AA, try Reduced FX for action-time dips, then a smaller shadow map if needed. The user's selected preset now also lowers scene resolution to 90%.

## Polished — five choices

The current look is dominated by warm lighting, wood texture and broad light halos. Those can survive lower-resolution secondary effects.

| Change | Likely performance effect | Visible difference and recommendation |
| --- | --- | --- |
| **1. Lower floor reflection resolution from 50% to 35%** | Moderate to high potential GPU saving in the gym; fewer reflection and blur pixels, though geometry still renders. | Reflections become softer. They are already blurred and subtle from normal standing views, while the floor texture remains sharp. **Yes — my first Polished tradeoff.** Preserve the mirror instead of removing its shine altogether. |
| **2. Reduce ambient-occlusion samples from 12 to 8** | Moderate potential GPU saving; keeps the depth/normal pass. Disabling AO entirely saves more. | Potentially noisier contact shading in corners and between bleacher steps. The current dark pads and strong lighting already separate shapes well. **Yes, try 8 first; turn it off only if still needed.** |
| **3. Lower shadow maps from 2048 to 1024** | Moderate potential saving; especially relevant to the outdoor course's two shadow cascades. Geometry work remains. | Less crisp shadows, most noticeable near feet and at long distances outdoors. **Yes to testing 1024.** The stylized court tolerates softer shadows better than blurry scene rendering. |
| **4. Lower glow texture resolution from 50% to 25%** | Small to moderate GPU saving in glow rendering and blur. | Light halos become broader or softer; the actual light strips and portal surfaces stay rendered normally. Current halos are already soft and decorative. **Yes, a good low-visibility reduction; keep glow intensity similar.** |
| **5. Lower MSAA from 4× to 2×, keeping FXAA on** | Potentially moderate, strongly GPU-dependent. | Slightly rougher rails, ceiling strips and court-line edges. These are visible in the current view, so removing AA entirely would hurt. **Try 2×; keep 4× if movement shimmer becomes distracting.** Do not go back to 8× for this style. |

My Polished choice: reduce reflection and glow resolution first, then AO samples. Keep native render scale (already 1.0), the lighting grade and texture detail. Supersampling above 1.0 is an expensive way to improve the remaining thin-edge shimmer.

## Changes already made without lowering preset quality

- Removed the orphaned full-scene geometry pass left behind when switching from Polished to Competitive. The SSAO stack now releases the buffer it owns, while preserving externally owned buffers.
- Filtered the Polished glow pass before unrelated meshes undergo render preparation, retaining the existing sources, occluders and ordering.
- Stopped updating half-court cone transforms once their exit animation has finished; reused constant court-line glow colors.
- Limited visible debug text rebuilding to five times per second and preserved scroll position. Hidden diagnostics do no update work.

No quantitative FPS gain is claimed for these changes. Regression tests cover graphics defaults, glow selection and SSAO cleanup. Selected reductions are baked into the presets; **Reduced FX** also remains adjustable in Settings.

## Evidence

- Competitive capture before the selected reductions: [gym spawn](../tmp/graphics-review/current-performance-gym-spawn.png).
- Polished capture before the selected reductions: [gym corner](../tmp/graphics-review/current-polished-gym-corner.png).
- Preset settings: [graphicsConfig.ts](../src/game/config/graphicsConfig.ts).
- Rendering passes and teardown: [PolishedPostFX.ts](../src/game/effects/PolishedPostFX.ts).
- Floor reflection design: [GymFloorMirror.ts](../src/game/map/GymFloorMirror.ts).
- Competitive lighting and shadows: [CompetitiveLighting.ts](../src/game/map/CompetitiveLighting.ts).

The captures use different views to inspect each mode; they are not a pixel-matched before/after benchmark. Capture artifacts live under ignored `tmp/` and can be regenerated with `scripts/graphics-shot.mjs --out-dir tmp/graphics-review`.
