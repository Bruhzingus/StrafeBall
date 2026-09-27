import type { MapEffectKind, PowerupKind } from '../../../shared/types';

export type PowerupIconKind = PowerupKind | MapEffectKind | 'mystery' | 'armor';

// Keep the silhouettes distinct at HUD size. All ink inherits the item's HUD
// colour, so the equipped slot, rolling reel, and map banner use one visual key.
const ICON_PATHS: Record<PowerupIconKind, string> = {
  adrenaline: '<path d="M18 3 7 18h8l-1 11 11-16h-8z" fill="currentColor" stroke="none"/>',
  speed: '<path d="m13 7 9 9-9 9m9-18 8 9-8 9M2 10h6M1 16h7M2 22h6"/>',
  cannon: '<circle cx="20" cy="17" r="9" fill="currentColor" fill-opacity=".2"/><path d="M17 12a6 6 0 0 1 6 1M3 8h8M1 15h6M3 22h6"/>',
  heal: '<path d="M10 5h12l3 5v17H7V10z"/><path d="M12 5V3h8v2M7 10h18M5 28h22"/><path d="M14 13h4v4h4v4h-4v4h-4v-4h-4v-4h4z" fill="currentColor" stroke="none"/>',
  magnet: '<path d="M6 5v13a10 10 0 0 0 20 0V5h-6v13a4 4 0 0 1-8 0V5z" fill="currentColor" fill-opacity=".16"/><path d="M6 11h6m8 0h6"/>',
  bomb: '<circle cx="14" cy="20" r="9" fill="currentColor" fill-opacity=".2"/><path d="m18 12 2-4 4 1M9 17a6 6 0 0 1 4-3M24 3v2m4 1-2 1m3 4-2-1"/>',
  shock: '<circle cx="16" cy="16" r="3" fill="currentColor" stroke="none"/><path d="M10 10a8.5 8.5 0 0 0 0 12m12-12a8.5 8.5 0 0 1 0 12M6 6a14 14 0 0 0 0 20M26 6a14 14 0 0 1 0 20"/>',
  stun: '<rect x="9" y="10" width="12" height="18" rx="3"/><path d="M12 10V7h6v3m-1-3 3-3a2.2 2.2 0 0 1 3 3l-2 2M4 13l-2-1m3 8H2m23-7 3-1m-3 8h3"/><path d="M10 17h10v5H10z" fill="currentColor" stroke="none"/>',
  coachGlasses: '<rect x="2" y="11" width="12" height="10" rx="2"/><rect x="18" y="11" width="12" height="10" rx="2"/><path d="M14 14q2-2 4 0M2 13l-2-1m30 1 2-1M5 14l6 5m10-5 6 5"/>',
  moon: '<path d="M24.5 22.5A12 12 0 0 1 11 3.6 12.5 12.5 0 1 0 28.4 21a12 12 0 0 1-3.9 1.5Z" fill="currentColor" fill-opacity=".2"/>',
  lava: '<path d="M10 23c-5-6 0-11 3-14 0 4 2 4 2 4s5-5 2-10c9 6 12 15 5 20M14 23c-2-3-1-5 2-8 0 3 4 4 3 8M3 28c3-3 6 3 9 0s6 3 9 0 6 3 8 0"/>',
  frenzy: '<circle cx="16" cy="8" r="4.5" fill="currentColor" fill-opacity=".18"/><circle cx="8" cy="22" r="4.5" fill="currentColor" fill-opacity=".18"/><circle cx="24" cy="22" r="4.5" fill="currentColor" fill-opacity=".18"/><path d="m6 6-3 4m22-4 4 5M14 28h4"/>',
  mystery: '<path d="M10 10a6 6 0 0 1 12 0c0 4-6 4-6 9"/><circle cx="16" cy="26" r="1.8" fill="currentColor" stroke="none"/>',
  armor: '<path d="m16 3 11 4v8c0 7-7 12-11 14C12 27 5 22 5 15V7z" fill="currentColor" fill-opacity=".16"/><path d="m11 16 3 3 7-7"/>',
};

/** Trusted static SVG only; the containing HUD element supplies the accessible label. */
export function powerupIconMarkup(kind: PowerupIconKind): string {
  return `<svg class="powerup-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[kind]}</svg>`;
}
