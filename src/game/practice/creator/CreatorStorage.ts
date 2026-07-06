/**
 * Creator Sandbox — local persistence (browser localStorage) + JSON file import/export.
 *
 * The browser cannot safely write back into the project's source folder, so persistence is split:
 *   - localStorage for fast local iteration (quick save / load / named slots / optional autosave);
 *   - JSON export/import for preserving or sharing a layout (and manually copying it into the
 *     project's default layout file to commit later).
 *
 * Every localStorage and JSON operation is wrapped so a missing/full/private-mode/corrupt store never
 * crashes the game. No network access; no plaintext secrets are ever written.
 */

import {
  committedCourseLayout,
  CreatorLayout,
  CreatorPrefab,
  MAX_PREFABS,
  sanitizePrefabs,
  validateLayout
} from './CreatorLayout';

const KEY_PREFIX = 'strafeball:creator-sandbox:v1';
export const STORAGE_KEYS = {
  layout: `${KEY_PREFIX}:layout`,
  autosave: `${KEY_PREFIX}:autosave`,
  slots: `${KEY_PREFIX}:slots`,
  // The user's "published" layout: what the LIVE Movement Sandbox plays (read on its build). Lets a
  // user save their own course and play it after a reload, even on the web (localStorage only).
  published: `${KEY_PREFIX}:published`,
  // Saved multi-object assemblies ("Save selection as prefab"), stamped from the hotbar.
  prefabs: `${KEY_PREFIX}:prefabs`
} as const;

const MAX_SLOTS = 8;

function safeLocalStorage(): Storage | null {
  try {
    const ls = window.localStorage;
    // Probe (private mode can throw on write).
    const probe = `${KEY_PREFIX}:__probe`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

export function isStorageAvailable(): boolean {
  return safeLocalStorage() !== null;
}

function writeKey(key: string, value: string): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(key, value);
    return true;
  } catch {
    return false; // quota exceeded etc.
  }
}

function readKey(key: string): string | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    return ls.getItem(key);
  } catch {
    return null;
  }
}

// --- Timestamped envelopes (quick-save + autosave slots) -----------------------------------------
//
// The quick-save and autosave slots store `{ savedAt, layout }` so opening can tell which state is
// newer. The autosave IS the working copy: whichever slot is newest is what loads — the most recent
// edits are never silently dropped in favour of an older explicit save. Reads accept BOTH shapes —
// the envelope AND the legacy bare layout written by older builds (bare ⇒ savedAt 0, i.e. "older
// than any timestamped explicit save") — so upgrading never loses an existing save.

/** A layout + when it was written (ms epoch). savedAt = 0 marks the legacy bare-layout shape. */
export interface StoredLayoutEnvelope {
  layout: CreatorLayout;
  savedAt: number;
}

/** Pure + exported for tests: interpret a parsed JSON value as a stored envelope (either shape). */
export function parseStoredEnvelope(parsed: unknown): StoredLayoutEnvelope | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as { savedAt?: unknown; layout?: unknown };
  try {
    if (typeof candidate.savedAt === 'number' && candidate.layout && typeof candidate.layout === 'object') {
      const savedAt = Number.isFinite(candidate.savedAt) ? Math.max(0, candidate.savedAt) : 0;
      return { layout: validateLayout(candidate.layout).layout, savedAt };
    }
    // Legacy bare layout (pre-envelope builds): valid, but never outranks a timestamped save.
    return { layout: validateLayout(parsed).layout, savedAt: 0 };
  } catch {
    return null;
  }
}

/**
 * The newest locally stored working state (pure; unit-tested): the autosave vs the explicit
 * quick-save. A tie — or a legacy bare autosave vs a timestamped explicit save — goes to the
 * explicit save (their content is identical in practice: an explicit save refreshes the autosave).
 * Null when neither slot holds anything readable.
 */
export function newestStoredLayout(
  autosave: StoredLayoutEnvelope | null,
  explicitLocal: StoredLayoutEnvelope | null
): StoredLayoutEnvelope | null {
  if (!autosave) return explicitLocal;
  if (!explicitLocal) return autosave;
  return autosave.savedAt > explicitLocal.savedAt ? autosave : explicitLocal;
}

/**
 * The layout the game treats as "the map" right now: the newest locally stored working state
 * (autosave or explicit quick-save), else the published course, else the committed default. BOTH
 * the Creator editor (on open) and the live Movement Sandbox (on build) read this, so the most
 * recent edits always load. Going back to an older state is manual-only in the editor: Load (last
 * explicit save), Load Course (published), or Revert to Default Map (committed).
 */
export function loadCurrentCourseLayout(): CreatorLayout {
  return (
    newestStoredLayout(loadAutosaveStored(), loadLocalStored())?.layout ??
    loadPublishedLayout() ??
    committedCourseLayout()
  );
}

function writeEnvelope(key: string, layout: CreatorLayout): boolean {
  return writeKey(key, JSON.stringify({ savedAt: Date.now(), layout }));
}

function readEnvelope(key: string): StoredLayoutEnvelope | null {
  const raw = readKey(key);
  if (!raw) return null;
  try {
    return parseStoredEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Quick-save to the single local layout slot (timestamped). */
export function saveLocalLayout(layout: CreatorLayout): boolean {
  return writeEnvelope(STORAGE_KEYS.layout, layout);
}

/** Quick-save slot WITH its timestamp (newest-wins comparisons). */
export function loadLocalStored(): StoredLayoutEnvelope | null {
  return readEnvelope(STORAGE_KEYS.layout);
}

export function saveAutosave(layout: CreatorLayout): boolean {
  return writeEnvelope(STORAGE_KEYS.autosave, layout);
}

/** Autosave slot WITH its timestamp (newest-wins comparisons). */
export function loadAutosaveStored(): StoredLayoutEnvelope | null {
  return readEnvelope(STORAGE_KEYS.autosave);
}

// --- Published course (the live Movement Sandbox reads this) ------------------------------------

/** Publish a layout as the live Movement Course (what the sandbox plays after a reload). */
export function savePublishedLayout(layout: CreatorLayout): boolean {
  return writeKey(STORAGE_KEYS.published, JSON.stringify(layout));
}

/** The user's published course, validated. Returns null when none has been saved. */
export function loadPublishedLayout(): CreatorLayout | null {
  const raw = readKey(STORAGE_KEYS.published);
  if (!raw) return null;
  try {
    return validateLayout(JSON.parse(raw)).layout;
  } catch {
    return null;
  }
}

/** Remove any published course (revert the live sandbox to the committed layout on next build). */
export function clearPublishedLayout(): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.removeItem(STORAGE_KEYS.published);
    return true;
  } catch {
    return false;
  }
}

// --- Prefab library (multi-object assemblies; bounded; validated on read) ------------------------

export function loadPrefabLibrary(): CreatorPrefab[] {
  const raw = readKey(STORAGE_KEYS.prefabs);
  if (!raw) return [];
  try {
    return sanitizePrefabs(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function savePrefabLibrary(prefabs: CreatorPrefab[]): boolean {
  return writeKey(STORAGE_KEYS.prefabs, JSON.stringify(prefabs.slice(0, MAX_PREFABS)));
}

// --- Named slots (a small recent list) ----------------------------------------------------------

type SlotMap = Record<string, CreatorLayout>;

function readSlots(): SlotMap {
  const raw = readKey(STORAGE_KEYS.slots);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: SlotMap = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[name] = validateLayout(value).layout;
    }
    return out;
  } catch {
    return {};
  }
}

export function listSlotNames(): string[] {
  return Object.keys(readSlots());
}

export function saveSlot(name: string, layout: CreatorLayout): boolean {
  const clean = name.trim().slice(0, 48);
  if (!clean) return false;
  const slots = readSlots();
  slots[clean] = layout;
  // Bound the number of slots: drop the oldest extra keys.
  const names = Object.keys(slots);
  while (names.length > MAX_SLOTS) {
    const drop = names.shift();
    if (drop) delete slots[drop];
  }
  return writeKey(STORAGE_KEYS.slots, JSON.stringify(slots));
}

export function loadSlot(name: string): CreatorLayout | null {
  const slots = readSlots();
  return slots[name] ?? null;
}

export function deleteSlot(name: string): boolean {
  const slots = readSlots();
  if (!(name in slots)) return false;
  delete slots[name];
  return writeKey(STORAGE_KEYS.slots, JSON.stringify(slots));
}

// --- JSON file export / import ------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 48) || 'creator-layout';
}

/** Trigger a browser download of the layout as a readable .json file. */
export function exportLayoutToFile(layout: CreatorLayout): void {
  const json = JSON.stringify(layout, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(layout.name)}.json`;
  a.style.display = 'none';
  a.setAttribute('data-no-lock', '');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke shortly after so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export interface ImportResult {
  layout: CreatorLayout;
  problems: string[];
}

/** Read + validate a user-selected .json file. Rejects on read/parse failure (caller shows an error). */
export function importLayoutFromFile(file: File): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error('File is too large to be a layout.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      try {
        const text = typeof reader.result === 'string' ? reader.result : '';
        const parsed = JSON.parse(text);
        const { layout, problems } = validateLayout(parsed);
        resolve({ layout, problems });
      } catch {
        reject(new Error('That file is not valid layout JSON.'));
      }
    };
    reader.readAsText(file);
  });
}
