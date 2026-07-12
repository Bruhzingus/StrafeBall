/**
 * Creator Sandbox — local persistence (browser localStorage) + JSON file import/export.
 *
 * The browser cannot safely write back into the project's source folder, so persistence is split:
 *   - localStorage for fast local iteration (multiple named course PROJECTS, each with an autosave
 *     working copy + an explicit quick-save restore point, plus prefabs);
 *   - JSON export/import for preserving or sharing a layout.
 *
 * Projects model (v2): a small index records every course the player has (id + summary metadata),
 * and each project stores two timestamped layout envelopes under its own keys:
 *   - `project:<id>:auto`   — the autosave working copy (what loads; written on every settle);
 *   - `project:<id>:manual` — the explicit quick-save (the manual "Load" restore point).
 * The newest of the two is the project's working state — the same "autosave IS the working copy"
 * rule the single-layout model used, now per project. Legacy single-layout keys are migrated into a
 * first project once, then ignored. The ACTIVE project's working state is what the live yard plays —
 * there is no separate "publish" step (a v1 "published" slot existed pre-projects; it became
 * unreachable once an active project always exists, so it was removed rather than left dead).
 *
 * Every localStorage and JSON operation is wrapped so a missing/full/private-mode/corrupt store never
 * crashes the game. No network access; no plaintext secrets are ever written.
 */

import {
  COURSE_DIFFICULTIES,
  committedCourseLayout,
  CourseDifficulty,
  CREATOR_LIMITS,
  CreatorLayout,
  CreatorPrefab,
  MAX_PREFABS,
  sanitizePrefabs,
  validateLayout
} from './CreatorLayout';

const KEY_PREFIX = 'strafeball:creator-sandbox:v1';
export const STORAGE_KEYS = {
  // Legacy single-layout slots (read once for migration; never written again).
  legacyLayout: `${KEY_PREFIX}:layout`,
  legacyAutosave: `${KEY_PREFIX}:autosave`,
  // Older builds could have only a published live-course copy (for example after clearing the
  // editor's working slots). It is a migration fallback so that course is not lost on upgrade.
  legacyPublished: `${KEY_PREFIX}:published`,
  // Multi-project index: `{ activeId, entries: ProjectSummary[] }`. Per-project layouts live under
  // projectAutoKey(id) / projectManualKey(id).
  projects: `${KEY_PREFIX}:projects`,
  // Saved multi-object assemblies ("Save selection as prefab"), stamped from the hotbar.
  prefabs: `${KEY_PREFIX}:prefabs`,
  // One-time first-run editor help card ('1' once dismissed).
  onboarded: `${KEY_PREFIX}:onboarded`
} as const;

export function projectAutoKey(id: string): string {
  return `${KEY_PREFIX}:project:${id}:auto`;
}

export function projectManualKey(id: string): string {
  return `${KEY_PREFIX}:project:${id}:manual`;
}

function safeLocalStorage(): Storage | null {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
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

function removeKey(key: string): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// --- Timestamped envelopes (per-project auto + manual slots) --------------------------------------
//
// Each slot stores `{ savedAt, layout }` so opening can tell which state is newer. The autosave IS
// the working copy: whichever slot is newest is what loads — the most recent edits are never
// silently dropped in favour of an older explicit save. Reads accept BOTH shapes — the envelope AND
// the legacy bare layout written by older builds (bare ⇒ savedAt 0, i.e. "older than any
// timestamped explicit save") — so upgrading never loses an existing save.

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
 * The newest stored working state (pure; unit-tested): the autosave vs the explicit quick-save. A
 * tie — or a legacy bare autosave vs a timestamped explicit save — goes to the explicit save (their
 * content is identical in practice: an explicit save refreshes the autosave). Null when neither slot
 * holds anything readable.
 */
export function newestStoredLayout(
  autosave: StoredLayoutEnvelope | null,
  explicitLocal: StoredLayoutEnvelope | null
): StoredLayoutEnvelope | null {
  if (!autosave) return explicitLocal;
  if (!explicitLocal) return autosave;
  return autosave.savedAt > explicitLocal.savedAt ? autosave : explicitLocal;
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

// --- Projects index -------------------------------------------------------------------------------

/** Listing metadata for one course project. A cached summary — the layout itself stays the truth. */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  difficulty: CourseDifficulty | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectsIndex {
  /** Always a valid entry id after loadProjectsIndex() (the index is seeded when empty). */
  activeId: string;
  entries: ProjectSummary[];
}

export function createProjectId(): string {
  return `p${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeSummary(raw: unknown): ProjectSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return null;
  const now = Date.now();
  return {
    id: r.id.trim().slice(0, 64),
    name: (typeof r.name === 'string' ? r.name : '').slice(0, CREATOR_LIMITS.maxNameLength) || 'Untitled Course',
    description: (typeof r.description === 'string' ? r.description : '').slice(0, CREATOR_LIMITS.maxDescriptionLength),
    difficulty: (COURSE_DIFFICULTIES as readonly string[]).includes(String(r.difficulty))
      ? (r.difficulty as CourseDifficulty)
      : null,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : now
  };
}

/** The raw index, or null when missing/unreadable. Entries are sanitized and de-duplicated by id. */
function readIndexRaw(): { activeId: string | null; entries: ProjectSummary[] } | null {
  const raw = readKey(STORAGE_KEYS.projects);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { activeId?: unknown; entries?: unknown };
    if (!parsed || typeof parsed !== 'object') return null;
    const entries: ProjectSummary[] = [];
    const seen = new Set<string>();
    for (const item of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const summary = sanitizeSummary(item);
      if (summary && !seen.has(summary.id)) {
        seen.add(summary.id);
        entries.push(summary);
      }
    }
    const activeId = typeof parsed.activeId === 'string' && seen.has(parsed.activeId) ? parsed.activeId : null;
    return { activeId, entries };
  } catch {
    return null;
  }
}

function writeIndex(index: { activeId: string | null; entries: ProjectSummary[] }): boolean {
  return writeKey(STORAGE_KEYS.projects, JSON.stringify(index));
}

function summaryFromLayout(id: string, layout: CreatorLayout, createdAt?: number): ProjectSummary {
  const now = Date.now();
  return {
    id,
    name: layout.name || 'Untitled Course',
    description: layout.description ?? '',
    difficulty: layout.difficulty ?? null,
    createdAt: createdAt ?? now,
    updatedAt: now
  };
}

/**
 * One-time migration of the legacy single-layout slots into the first project. Runs only while the
 * projects index does not exist yet; both legacy envelopes carry over (autosave → auto slot,
 * explicit quick-save → manual slot) so nothing an existing user saved is lost. The legacy keys are
 * left in place — once the index exists they are never read again.
 */
function migrateLegacyIfNeeded(): void {
  if (readIndexRaw()) return;
  const legacyAuto = readEnvelope(STORAGE_KEYS.legacyAutosave);
  const legacyManual = readEnvelope(STORAGE_KEYS.legacyLayout);
  const legacyPublished = readEnvelope(STORAGE_KEYS.legacyPublished);
  const newest = newestStoredLayout(legacyAuto, legacyManual) ?? legacyPublished;
  if (!newest) return; // nothing to migrate; seeding happens lazily in loadProjectsIndex
  const id = createProjectId();
  // A published-only course becomes the working copy. When normal working slots exist, they retain
  // precedence exactly as the old loader did and both auto/manual restore points survive unchanged.
  if (legacyAuto) writeKey(projectAutoKey(id), JSON.stringify(legacyAuto));
  else if (!legacyManual && legacyPublished) writeKey(projectAutoKey(id), JSON.stringify(legacyPublished));
  if (legacyManual) writeKey(projectManualKey(id), JSON.stringify(legacyManual));
  writeIndex({ activeId: id, entries: [summaryFromLayout(id, newest.layout)] });
}

/** Seed the index with one project holding the committed starter course (fresh install). */
function seedStarterProject(): ProjectsIndex {
  const layout = committedCourseLayout();
  const id = createProjectId();
  writeEnvelope(projectAutoKey(id), layout);
  const index = { activeId: id, entries: [summaryFromLayout(id, layout)] };
  writeIndex(index);
  return { activeId: id, entries: index.entries };
}

/**
 * The projects index, migrated + seeded so there is always at least one project and a valid
 * activeId. This is the editor's entry point; the live yard uses loadCurrentCourseLayout(), which
 * never seeds (no writes from the render path unless a legacy save needed migrating).
 */
export function loadProjectsIndex(): ProjectsIndex {
  migrateLegacyIfNeeded();
  const raw = readIndexRaw();
  if (!raw || raw.entries.length === 0) return seedStarterProject();
  if (!raw.activeId) {
    const fixed = { activeId: raw.entries[0].id, entries: raw.entries };
    writeIndex(fixed);
    return { activeId: fixed.activeId, entries: fixed.entries };
  }
  return { activeId: raw.activeId, entries: raw.entries };
}

export function setActiveProject(id: string): boolean {
  const raw = readIndexRaw();
  if (!raw || !raw.entries.some((e) => e.id === id)) return false;
  return writeIndex({ activeId: id, entries: raw.entries });
}

/** Refresh a project's cached summary from its layout (called on every project write). */
function updateSummary(id: string, layout: CreatorLayout): void {
  const raw = readIndexRaw();
  if (!raw) return;
  const entry = raw.entries.find((e) => e.id === id);
  if (!entry) return;
  entry.name = layout.name || 'Untitled Course';
  entry.description = layout.description ?? '';
  entry.difficulty = layout.difficulty ?? null;
  entry.updatedAt = Date.now();
  writeIndex(raw);
}

/**
 * Create a new project from the given layout, write its working copy, and make it active.
 * Returns null when storage is unavailable/full.
 */
export function createProject(layout: CreatorLayout): ProjectSummary | null {
  const index = loadProjectsIndex();
  const id = createProjectId();
  if (!writeEnvelope(projectAutoKey(id), layout)) return null;
  const summary = summaryFromLayout(id, layout);
  if (!writeIndex({ activeId: id, entries: [...index.entries, summary] })) {
    removeKey(projectAutoKey(id));
    return null;
  }
  return summary;
}

/** Rename a project on disk (both stored envelopes + the summary). For NON-active projects — the
 *  editor renames its active project through the in-memory layout instead. */
export function renameProject(id: string, name: string): boolean {
  const clean = name.trim().slice(0, CREATOR_LIMITS.maxNameLength);
  if (!clean) return false;
  const raw = readIndexRaw();
  const entry = raw?.entries.find((e) => e.id === id);
  if (!raw || !entry) return false;
  for (const key of [projectAutoKey(id), projectManualKey(id)]) {
    const envelope = readEnvelope(key);
    if (envelope) {
      envelope.layout.name = clean;
      writeKey(key, JSON.stringify(envelope));
    }
  }
  entry.name = clean;
  entry.updatedAt = Date.now();
  return writeIndex(raw);
}

/** Duplicate a project (both slots), naming the copy "<name> (copy)". Does not change the active. */
export function duplicateProject(id: string): ProjectSummary | null {
  const raw = readIndexRaw();
  const source = raw?.entries.find((e) => e.id === id);
  if (!raw || !source) return null;
  const auto = readEnvelope(projectAutoKey(id));
  const manual = readEnvelope(projectManualKey(id));
  const newest = newestStoredLayout(auto, manual);
  if (!newest) return null;
  const copyName = `${source.name} (copy)`.slice(0, CREATOR_LIMITS.maxNameLength);
  const newId = createProjectId();
  let wroteAny = false;
  for (const [envelope, key] of [
    [auto, projectAutoKey(newId)],
    [manual, projectManualKey(newId)]
  ] as const) {
    if (!envelope) continue;
    const copy: StoredLayoutEnvelope = { savedAt: envelope.savedAt, layout: { ...envelope.layout, name: copyName } };
    if (writeKey(key, JSON.stringify(copy))) wroteAny = true;
  }
  if (!wroteAny) return null;
  const summary: ProjectSummary = { ...summaryFromLayout(newId, newest.layout), name: copyName };
  const at = raw.entries.findIndex((e) => e.id === id);
  raw.entries.splice(at + 1, 0, summary);
  if (!writeIndex(raw)) {
    removeKey(projectAutoKey(newId));
    removeKey(projectManualKey(newId));
    return null;
  }
  return summary;
}

/**
 * Delete a project and its stored layouts. If it was the active project, the first remaining entry
 * becomes active; deleting the last project reseeds the starter course so the editor never opens on
 * a broken state.
 */
export function deleteProject(id: string): boolean {
  const raw = readIndexRaw();
  if (!raw || !raw.entries.some((e) => e.id === id)) return false;
  removeKey(projectAutoKey(id));
  removeKey(projectManualKey(id));
  const entries = raw.entries.filter((e) => e.id !== id);
  if (entries.length === 0) {
    removeKey(STORAGE_KEYS.projects);
    seedStarterProject();
    return true;
  }
  const activeId = raw.activeId === id ? entries[0].id : raw.activeId;
  return writeIndex({ activeId, entries });
}

// --- Per-project layout slots ---------------------------------------------------------------------

/** Write the project's autosave working copy (also refreshes its listed summary). */
export function saveProjectAutosave(id: string, layout: CreatorLayout): boolean {
  const ok = writeEnvelope(projectAutoKey(id), layout);
  if (ok) updateSummary(id, layout);
  return ok;
}

/** Write the project's explicit quick-save restore point (also refreshes its listed summary). */
export function saveProjectManual(id: string, layout: CreatorLayout): boolean {
  const ok = writeEnvelope(projectManualKey(id), layout);
  if (ok) updateSummary(id, layout);
  return ok;
}

/** The explicit quick-save slot WITH its timestamp (the manual "Load" restore point). */
export function loadProjectManual(id: string): StoredLayoutEnvelope | null {
  return readEnvelope(projectManualKey(id));
}

/** The project's working state: the newest of (autosave, explicit quick-save). */
export function loadProjectWorking(id: string): CreatorLayout | null {
  return newestStoredLayout(readEnvelope(projectAutoKey(id)), readEnvelope(projectManualKey(id)))?.layout ?? null;
}

/**
 * The layout the game treats as "the map" right now: the ACTIVE project's working state, else the
 * committed default. BOTH the Creator editor (on open) and the live Movement Sandbox (on build) read
 * this, so the most recent edits to whichever course is active always load. Never seeds a project
 * (no writes from the yard's build path), but does run the one-time legacy migration so a
 * pre-projects save keeps playing. If migration could not persist (quota), the legacy slots are
 * still honoured directly.
 */
export function loadCurrentCourseLayout(): CreatorLayout {
  migrateLegacyIfNeeded();
  const raw = readIndexRaw();
  if (raw?.activeId) {
    const working = loadProjectWorking(raw.activeId);
    if (working) return working;
  } else {
    const legacy = newestStoredLayout(readEnvelope(STORAGE_KEYS.legacyAutosave), readEnvelope(STORAGE_KEYS.legacyLayout));
    if (legacy) return legacy.layout;
  }
  return committedCourseLayout();
}

// --- First-run onboarding flag --------------------------------------------------------------------

export function hasSeenOnboarding(): boolean {
  return readKey(STORAGE_KEYS.onboarded) === '1';
}

export function markOnboardingSeen(): void {
  writeKey(STORAGE_KEYS.onboarded, '1');
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
