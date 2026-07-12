/**
 * Live-tuning overlay for POLISHED_CONFIG (client-only, dev-only persistence).
 *
 * The historical graphics-overhaul failure mode was tune-by-reload: every value tweak required a
 * source edit + full reload, so looks were judged from memory and drifted badly. This module fixes
 * that: the dev GraphicsTuningPanel writes a partial override object to localStorage, and EVERY
 * polished rendering system reads its config through resolvePolishedConfig() — a deep merge of the
 * shipped POLISHED_CONFIG with those overrides. When a look is finalized, the panel's "Log baked
 * JSON" output is copied back into POLISHED_CONFIG in graphicsConfig.ts and the override key cleared.
 *
 * Overrides only ever come from the local browser's storage (the tuning panel is gated behind the
 * graphics debug flag), so shipping players always get exactly POLISHED_CONFIG.
 */

import { POLISHED_CONFIG, type PolishedConfig } from './graphicsConfig';

export const TUNING_OVERRIDES_STORAGE_KEY = 'strafeball.graphics.tuning.v1';

/** Recursive partial of PolishedConfig — what the tuning panel persists. */
export type PolishedConfigOverrides = DeepPartial<PolishedConfig>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function loadTuningOverrides(): PolishedConfigOverrides {
  try {
    const raw = window.localStorage.getItem(TUNING_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? (parsed as PolishedConfigOverrides) : {};
  } catch {
    return {};
  }
}

export function saveTuningOverrides(overrides: PolishedConfigOverrides): void {
  try {
    window.localStorage.setItem(TUNING_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // storage unavailable — live handles still hold the values for this session
  }
}

export function clearTuningOverrides(): void {
  try {
    window.localStorage.removeItem(TUNING_OVERRIDES_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * The polished config every rendering system reads: shipped POLISHED_CONFIG ⊕ dev overrides.
 * Returns a fresh deep-cloned object each call — callers may hold onto it without aliasing the
 * shipped block, and a caller mutating its copy can never corrupt another system's values.
 */
export function resolvePolishedConfig(): PolishedConfig {
  return deepMerge(structuredClone(POLISHED_CONFIG) as PolishedConfig, loadTuningOverrides());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge overrides into base, in place. Arrays (color/direction tuples) are replaced whole,
 * never merged element-wise — a half-overridden color would be meaningless. Unknown keys in the
 * overrides are ignored (stale keys from an older config shape can't corrupt the result), and a
 * type mismatch (override object where base has a primitive, or vice versa) keeps the base value.
 */
function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(overrides)) return base;
  const target = base as Record<string, unknown>;
  for (const [key, overrideValue] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(key in target) || overrideValue === undefined) continue; // unknown/absent keys ignored
    const baseValue = target[key];
    if (Array.isArray(baseValue)) {
      // Tuple (color/direction): replace whole if the override is an array of numbers, else keep base.
      if (Array.isArray(overrideValue) && overrideValue.length === baseValue.length) {
        target[key] = overrideValue.slice();
      }
    } else if (isPlainObject(baseValue)) {
      if (isPlainObject(overrideValue)) deepMerge(baseValue, overrideValue);
    } else if (typeof overrideValue === typeof baseValue) {
      target[key] = overrideValue;
    }
  }
  return base;
}
