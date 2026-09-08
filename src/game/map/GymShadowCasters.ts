import type { Mesh } from '@babylonjs/core';

/**
 * Tiny client-only dispatcher that decouples "register this mesh as a gym shadow caster" from which
 * shadow system is actually active this session.
 *
 * The gym runs exactly ONE shadow system at a time, chosen by the graphics mode:
 *   - Competitive/Neutral: a single 1024 ShadowGenerator on the directional key light.
 *   - Polished:            the same generator at 2048 with the full static+dynamic caster set.
 *
 * Call sites that produce dynamic casters (ArenaScene's mats / dummies, NetworkRenderer's remote
 * player bodies) call registerGymShadowCaster() and stay mode-agnostic. ArenaScene wires the active
 * system's registrar in right after it creates that system. Before any registrar is set, and in
 * either mode, registration is a safe no-op. Nothing here is imported by server or shared code.
 *
 * RETAINED REGISTRY: every live registration is also recorded here and REPLAYED into the next
 * registrar. A live graphics-preset swap disposes the old generator (which drops its caster list)
 * and builds a new one mid-session, so casters registered against the old system — remote players
 * who joined before the swap, most importantly — would otherwise silently stop casting shadows
 * until they respawned. Entries auto-remove when their mesh is disposed.
 */

export type GymShadowCasterRegistrar = (mesh: Mesh | null | undefined, includeDescendants?: boolean) => void;

let activeRegistrar: GymShadowCasterRegistrar | null = null;
/** Live registrations, retained across shadow-system swaps. Value = includeDescendants. */
const retained = new Map<Mesh, boolean>();

/**
 * Install the active shadow system's caster registrar, replacing any prior one, and replay every
 * retained registration into it so a rebuilt system starts with the full caster set.
 */
export function setActiveGymShadowRegistrar(registrar: GymShadowCasterRegistrar): void {
  activeRegistrar = registrar;
  for (const [mesh, includeDescendants] of retained) {
    if (!mesh.isDisposed()) registrar(mesh, includeDescendants);
  }
}

/** Drop the active registrar so later registrations no-op (e.g. on scene dispose). */
export function clearActiveGymShadowRegistrar(): void {
  activeRegistrar = null;
}

/**
 * Forget every retained registration. Scene teardown only — a preset swap must NOT call this, or the
 * rebuilt shadow system would come up with no dynamic casters.
 */
export function clearRetainedGymShadowCasters(): void {
  retained.clear();
}

/**
 * Register a dynamic shadow caster with whatever shadow system is active. `includeDescendants` adds the
 * mesh's child submeshes too (e.g. a dummy's parented head/torso/limbs). No-op if no system is active,
 * but the registration is still retained and replayed once one exists.
 */
export function registerGymShadowCaster(mesh: Mesh | null | undefined, includeDescendants = false): void {
  if (mesh && !mesh.isDisposed()) {
    const previous = retained.get(mesh);
    if (previous === undefined) {
      retained.set(mesh, includeDescendants);
      mesh.onDisposeObservable.addOnce(() => retained.delete(mesh));
    } else if (includeDescendants && !previous) {
      // A later descendant-inclusive registration widens an earlier root-only one; never narrows.
      retained.set(mesh, true);
    }
  }
  activeRegistrar?.(mesh, includeDescendants);
}
