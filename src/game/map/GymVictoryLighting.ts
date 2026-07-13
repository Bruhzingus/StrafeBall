/**
 * Client-only match-win light celebration: sweeps the gym's cove/strip lighting (the polished-mode
 * LED lines built by GymCoveLighting) to the WINNING team's color, holds it with a slow breathing
 * pulse while the victory beat plays, then eases back to the warm defaults when the room resets.
 *
 * Because the strips' emissive materials are already registered with the polished GlowLayer and the
 * floor MirrorTexture, recoloring the material emissive automatically recolors the bloom halo AND
 * the floor reflection — the whole gym reads as celebrating with zero extra render cost.
 *
 * Graceful no-op when the cove materials don't exist (Performance preset builds no cove lighting).
 * ArenaScene drives it: start on the winner event, stop on room reset / online exit.
 */

import { Color3, Observer, Scene, StandardMaterial } from '@babylonjs/core';

/** Saturated LED versions of the jersey colors (brighter than body materials so the strips pop). */
const TEAM_STRIP_COLOR: Record<string, Color3> = {
  blue: new Color3(0.2, 0.5, 1.0),
  red: new Color3(1.0, 0.2, 0.14)
};

/** Cove material names from GymCoveLighting (ceiling perimeter, wall band, bleacher step noses). */
const COVE_MATERIAL_NAMES = ['decor_cove_ceil_mat', 'decor_cove_band_mat', 'decor_cove_amber_mat'];

const SWEEP_IN_SECONDS = 1.4;
const SWEEP_OUT_SECONDS = 0.9;
/** Breathing pulse while held: ±10% around the team color, slow enough to feel like arena lighting. */
const PULSE_PERIOD_SECONDS = 1.8;
const PULSE_AMPLITUDE = 0.1;

interface CelebrationState {
  scene: Scene;
  observer: Observer<Scene>;
  mats: { mat: StandardMaterial; base: Color3 }[];
  target: Color3;
  phase: 'in' | 'hold' | 'out';
  /** 0→1 progress through the current sweep (in/out); pulse time while holding. */
  t: number;
}

let state: CelebrationState | null = null;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Emissive at sweep position p (0 = base warm color, 1 = full team color). */
function applyBlend(mats: CelebrationState['mats'], target: Color3, p: number, pulse = 1): void {
  for (const { mat, base } of mats) {
    mat.emissiveColor.set(
      (base.r + (target.r - base.r) * p) * pulse,
      (base.g + (target.g - base.g) * p) * pulse,
      (base.b + (target.b - base.b) * p) * pulse
    );
  }
}

function detach(): void {
  if (!state) return;
  state.scene.onBeforeRenderObservable.remove(state.observer);
  state = null;
}

/**
 * Sweep the gym strip lighting to the winner's team color. Safe to call again with a different
 * team (rebases from the ORIGINAL warm colors, not the mid-celebration ones) and safe when the
 * cove materials don't exist (no-op).
 */
export function startGymVictoryLighting(scene: Scene, winnerTeamId: string): void {
  const target = TEAM_STRIP_COLOR[winnerTeamId];
  if (!target) return;

  // Re-trigger while active: keep the captured warm bases, just retarget and sweep again.
  if (state && state.scene === scene) {
    state.target = target;
    state.phase = 'in';
    state.t = 0;
    return;
  }
  detach();

  const mats: CelebrationState['mats'] = [];
  for (const name of COVE_MATERIAL_NAMES) {
    const mat = scene.getMaterialByName(name);
    if (mat instanceof StandardMaterial) mats.push({ mat, base: mat.emissiveColor.clone() });
  }
  if (mats.length === 0) return; // Performance preset: no cove lighting, no celebration.

  const observer = scene.onBeforeRenderObservable.add(() => {
    if (!state) return;
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (state.phase === 'in') {
      state.t = Math.min(1, state.t + dt / SWEEP_IN_SECONDS);
      applyBlend(state.mats, state.target, easeInOut(state.t));
      if (state.t >= 1) {
        state.phase = 'hold';
        state.t = 0;
      }
    } else if (state.phase === 'hold') {
      state.t += dt;
      const pulse = 1 + Math.sin((state.t / PULSE_PERIOD_SECONDS) * Math.PI * 2) * PULSE_AMPLITUDE;
      applyBlend(state.mats, state.target, 1, pulse);
    } else {
      state.t = Math.min(1, state.t + dt / SWEEP_OUT_SECONDS);
      applyBlend(state.mats, state.target, 1 - easeInOut(state.t));
      if (state.t >= 1) detach();
    }
  });

  state = { scene, observer, mats, target, phase: 'in', t: 0 };
}

/** Ease the strips back to their warm defaults (instant restore + detach if `immediate`). */
export function stopGymVictoryLighting(immediate = false): void {
  if (!state) return;
  if (immediate || state.phase === 'out') {
    if (immediate) {
      applyBlend(state.mats, state.target, 0);
      detach();
    }
    return;
  }
  state.phase = 'out';
  state.t = 0;
}
