import type { NetMode } from './netConfig';

/**
 * Host-selectable tick-rate presets — the curated, product-facing subset of `netConfig.ts`'s MODES
 * table. A preset is chosen ONCE, on the room-creation screen (alongside the 1v1/2v2 format pick),
 * and is locked for the room's lifetime: it is deliberately NOT a field of RoomSettings /
 * RoomSettingsPatch, so it is structurally impossible to change via `update-room-settings` (a
 * stronger guarantee than format's runtime 'format-locked' rejection). This file is the ONLY place
 * that decides which NetModes players can reach; everything else in MODES stays internal/test-only.
 */

export type TickPresetId = 'ultra-low' | 'standard' | 'high' | 'ultra-high' | 'extreme';

export interface TickPresetDefinition {
  id: TickPresetId;
  label: string;
  /** Short UI blurb shown under the label on the create-room screen. */
  description: string;
  netMode: NetMode;
}

export const TICK_PRESETS: readonly TickPresetDefinition[] = [
  {
    id: 'ultra-low',
    label: 'Ultra Low',
    description: '60Hz sim · 48Hz snapshots. Lowest bandwidth and server load.',
    netMode: 'A_60_60_48'
  },
  {
    id: 'standard',
    label: 'Standard',
    description: '90Hz sim · 60Hz snapshots. The stable baseline.',
    netMode: 'A_90_90_60'
  },
  {
    id: 'high',
    label: 'High',
    description: '128Hz sim · 90Hz snapshots. Crisper on strong connections.',
    netMode: 'A_128_128_90'
  },
  {
    id: 'ultra-high',
    label: 'Ultra High',
    description: '144Hz sim · 128Hz snapshots. High-refresh monitors + strong connections.',
    netMode: 'A_144_144_128'
  },
  {
    id: 'extreme',
    label: 'Extreme',
    description: '180Hz sim · 128Hz snapshots. Least battle-tested — expect rough edges.',
    netMode: 'A_180_180_128'
  }
];

/** Fallback when room creation omits or mis-sends a preset id. */
export const DEFAULT_TICK_PRESET_ID: TickPresetId = 'standard';

export function isTickPresetId(value: unknown): value is TickPresetId {
  return typeof value === 'string' && TICK_PRESETS.some((preset) => preset.id === value);
}

/** Resolve a (possibly absent/invalid) preset id to a definition; never throws, always falls back. */
export function tickPresetById(id: string | undefined): TickPresetDefinition {
  return (
    TICK_PRESETS.find((preset) => preset.id === id) ??
    (TICK_PRESETS.find((preset) => preset.id === DEFAULT_TICK_PRESET_ID) as TickPresetDefinition)
  );
}

/** Reverse lookup for UI display on the join side (label a room by the mode it broadcasts). */
export function tickPresetForNetMode(netMode: NetMode | undefined): TickPresetDefinition | null {
  return TICK_PRESETS.find((preset) => preset.netMode === netMode) ?? null;
}
