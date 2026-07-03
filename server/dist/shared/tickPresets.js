"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TICK_PRESET_ID = exports.TICK_PRESETS = void 0;
exports.isTickPresetId = isTickPresetId;
exports.tickPresetById = tickPresetById;
exports.tickPresetForNetMode = tickPresetForNetMode;
exports.TICK_PRESETS = [
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
exports.DEFAULT_TICK_PRESET_ID = 'standard';
function isTickPresetId(value) {
    return typeof value === 'string' && exports.TICK_PRESETS.some((preset) => preset.id === value);
}
/** Resolve a (possibly absent/invalid) preset id to a definition; never throws, always falls back. */
function tickPresetById(id) {
    return (exports.TICK_PRESETS.find((preset) => preset.id === id) ??
        exports.TICK_PRESETS.find((preset) => preset.id === exports.DEFAULT_TICK_PRESET_ID));
}
/** Reverse lookup for UI display on the join side (label a room by the mode it broadcasts). */
function tickPresetForNetMode(netMode) {
    return exports.TICK_PRESETS.find((preset) => preset.netMode === netMode) ?? null;
}
