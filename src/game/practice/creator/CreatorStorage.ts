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

import { CreatorLayout, validateLayout } from './CreatorLayout';

const KEY_PREFIX = 'strafeball:creator-sandbox:v1';
export const STORAGE_KEYS = {
  layout: `${KEY_PREFIX}:layout`,
  autosave: `${KEY_PREFIX}:autosave`,
  slots: `${KEY_PREFIX}:slots`
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

/** Quick-save to the single local layout slot. */
export function saveLocalLayout(layout: CreatorLayout): boolean {
  return writeKey(STORAGE_KEYS.layout, JSON.stringify(layout));
}

/** Load the quick-save slot, validated. Returns null when absent/unreadable. */
export function loadLocalLayout(): CreatorLayout | null {
  const raw = readKey(STORAGE_KEYS.layout);
  if (!raw) return null;
  try {
    return validateLayout(JSON.parse(raw)).layout;
  } catch {
    return null;
  }
}

export function saveAutosave(layout: CreatorLayout): boolean {
  return writeKey(STORAGE_KEYS.autosave, JSON.stringify(layout));
}

export function loadAutosave(): CreatorLayout | null {
  const raw = readKey(STORAGE_KEYS.autosave);
  if (!raw) return null;
  try {
    return validateLayout(JSON.parse(raw)).layout;
  } catch {
    return null;
  }
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
