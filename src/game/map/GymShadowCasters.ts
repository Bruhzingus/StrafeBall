import type { Mesh } from '@babylonjs/core';

/**
 * Tiny client-only dispatcher that decouples "register this mesh as a gym shadow caster" from which
 * shadow system is actually active this session.
 *
 * The gym runs exactly ONE of two shadow systems, chosen once at scene build by the graphics mode:
 *   - Competitive: a single ShadowGenerator on the directional key light (CompetitiveLighting).
 *   - Showcase:    four ShadowGenerators, one per primary roof SpotLight (ShowcaseLighting).
 *
 * Call sites that produce dynamic casters (ArenaScene's mats / dummies, NetworkRenderer's remote
 * player bodies) call registerGymShadowCaster() and stay mode-agnostic. ArenaScene wires the active
 * system's registrar in once, right after it creates that system. Before any registrar is set, and in
 * either mode, registration is a safe no-op. Nothing here is imported by server or shared code.
 */

export type GymShadowCasterRegistrar = (mesh: Mesh | null | undefined, includeDescendants?: boolean) => void;

let activeRegistrar: GymShadowCasterRegistrar | null = null;

/** Install the active shadow system's caster registrar (Competitive or Showcase). Replaces any prior. */
export function setActiveGymShadowRegistrar(registrar: GymShadowCasterRegistrar): void {
  activeRegistrar = registrar;
}

/** Drop the active registrar so later registrations no-op (e.g. on scene dispose). */
export function clearActiveGymShadowRegistrar(): void {
  activeRegistrar = null;
}

/**
 * Register a dynamic shadow caster with whatever shadow system is active. `includeDescendants` adds the
 * mesh's child submeshes too (e.g. a dummy's parented head/torso/limbs). No-op if no system is active.
 */
export function registerGymShadowCaster(mesh: Mesh | null | undefined, includeDescendants = false): void {
  activeRegistrar?.(mesh, includeDescendants);
}
