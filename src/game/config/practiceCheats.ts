/**
 * Offline-only practice / testing toggles.
 *
 * These are consulted ONLY by the local offline controllers (dash/backflip/catch/parry). Online play
 * is server-authoritative (shared/simulation + server), so this flag has no effect there and must
 * never be read from any networked path.
 */
export const practiceCheats = {
  /**
   * When true, abilities ignore their cooldowns/costs so they can be spammed while testing:
   * catches, stamina (dash charges), backflip, and parry. Toggled by a keybind (see controls.ts).
   */
  noCooldown: false
};
