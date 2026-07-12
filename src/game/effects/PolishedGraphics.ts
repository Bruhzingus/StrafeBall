/**
 * Polished-mode live handle registry (client-only).
 *
 * Dumb storage for the rendering-system handles the polished mode creates across its build phases
 * (lights P0, probe P1, shadow generator P2, floor mirror P3, post pipeline/SSAO P4, glow P5,
 * sandbox sun/CSM P6). Two consumers:
 *
 *   1. The dev GraphicsTuningPanel drives values (light intensity, shadow darkness, exposure, …)
 *      onto these handles LIVE — no reload per tweak (the historical failure mode).
 *   2. The gym ⇄ sandbox world switch (Phase 6): the two worlds never render simultaneously, so
 *      exactly one shadow/reflection system pays per frame — enterSandboxWorld()/enterGymWorld()
 *      flip the handles accordingly.
 *
 * This module owns NO construction and NO disposal — creators register handles here and remain the
 * owners. Every field is optional: phases land incrementally, and Performance/Neutral modes register
 * nothing at all (every consumer must tolerate missing handles).
 */

import { RenderTargetTexture } from '@babylonjs/core';
import type { CascadedShadowGenerator, DirectionalLight, HemisphericLight, ShadowGenerator } from '@babylonjs/core';
import { resolvePolishedConfig } from '../config/graphicsTuning';
import { pauseGymFloorMirror, resumeGymFloorMirror } from '../map/GymFloorMirror';

export interface PolishedPostFxHandle {
  setWorld(world: 'gym' | 'sandbox'): void;
}

export interface PolishedHandles {
  hemi?: HemisphericLight;
  key?: DirectionalLight;
  shadowGenerator?: ShadowGenerator;
  postFx?: PolishedPostFxHandle;
  sandboxSun?: DirectionalLight;
  sandboxCsm?: CascadedShadowGenerator;
}

const handles: PolishedHandles = {};
let activeWorld: 'gym' | 'sandbox' = 'gym';

function setShadowRefresh(generator: ShadowGenerator | undefined, active: boolean): void {
  const map = generator?.getShadowMap();
  if (!map) return;
  map.refreshRate = active
    ? RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME
    : RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
}

function applyWorld(world: 'gym' | 'sandbox'): void {
  const cfg = resolvePolishedConfig();
  const sandbox = world === 'sandbox';

  handles.key?.setEnabled(!sandbox);
  setShadowRefresh(handles.shadowGenerator, !sandbox);
  handles.sandboxSun?.setEnabled(sandbox);
  setShadowRefresh(handles.sandboxCsm, sandbox);
  handles.postFx?.setWorld(world);

  const hemi = handles.hemi;
  if (hemi) {
    const h = sandbox ? cfg.sandbox.hemi : cfg.lights.hemi;
    hemi.intensity = h.intensity;
    hemi.diffuse.set(h.diffuse[0], h.diffuse[1], h.diffuse[2]);
    hemi.groundColor.set(h.ground[0], h.ground[1], h.ground[2]);
    if (!sandbox) {
      const specular = cfg.lights.hemi.specular;
      hemi.specular.set(specular[0], specular[1], specular[2]);
    }
  }

  if (sandbox) pauseGymFloorMirror();
  else resumeGymFloorMirror();
}

/** Merge-register handles (creators call this as each system comes up). */
export function registerPolishedHandles(next: Partial<PolishedHandles>): void {
  Object.assign(handles, next);
  // Systems are constructed in different phases. A late-created sun/post stack must immediately
  // inherit the current world instead of waiting for another enter/exit transition.
  applyWorld(activeWorld);
}

/** Read-only view for the tuning panel / world switch. Fields may be undefined — always guard. */
export function getPolishedHandles(): Readonly<PolishedHandles> {
  return handles;
}

/** Switch the polished renderer to the large outdoor course without paying for gym-only systems. */
export function enterSandboxWorld(): void {
  activeWorld = 'sandbox';
  applyWorld(activeWorld);
}

/** Restore the compact gym lighting/reflections/post ranges after leaving the course yard. */
export function enterGymWorld(): void {
  activeWorld = 'gym';
  applyWorld(activeWorld);
}

export function getPolishedWorld(): 'gym' | 'sandbox' {
  return activeWorld;
}

/** Drop every stored handle (scene teardown). Does NOT dispose — owners dispose their own systems. */
export function clearPolishedHandles(): void {
  for (const key of Object.keys(handles) as (keyof PolishedHandles)[]) delete handles[key];
  activeWorld = 'gym';
}
