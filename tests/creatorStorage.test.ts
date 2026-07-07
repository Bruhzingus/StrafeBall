import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  blankCourseLayout,
  cloneLayout,
  committedCourseLayout,
  defaultCreatorLayout
} from '../src/game/practice/creator/CreatorLayout';
import {
  STORAGE_KEYS,
  createProject,
  deleteProject,
  duplicateProject,
  loadCurrentCourseLayout,
  loadProjectManual,
  loadProjectWorking,
  loadProjectsIndex,
  newestStoredLayout,
  parseStoredEnvelope,
  projectAutoKey,
  projectManualKey,
  renameProject,
  saveProjectAutosave,
  saveProjectManual,
  setActiveProject,
  type StoredLayoutEnvelope
} from '../src/game/practice/creator/CreatorStorage';

/** A distinct-but-valid variant of a layout (so a test can tell which slot won). */
function variantOf(layout: ReturnType<typeof defaultCreatorLayout>, tag = 'autosave variant') {
  const copy = cloneLayout(layout);
  copy.name = `${copy.name} (${tag})`.slice(0, 48);
  return copy;
}

/** In-memory localStorage stub (CreatorStorage reads globalThis.localStorage). */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear()
    }
  });
  return values;
}

describe('CreatorStorage — stored-envelope parsing (dual shape)', () => {
  it('parses the timestamped envelope shape, preserving savedAt and the layout', () => {
    const layout = defaultCreatorLayout();
    const parsed = parseStoredEnvelope({ savedAt: 1234, layout });
    expect(parsed).not.toBeNull();
    expect(parsed!.savedAt).toBe(1234);
    expect(parsed!.layout.name).toBe(layout.name);
    expect(parsed!.layout.objects.length).toBe(layout.objects.length);
  });

  it('parses a legacy bare layout as savedAt 0 (older than any timestamped save)', () => {
    const layout = defaultCreatorLayout();
    const parsed = parseStoredEnvelope(layout);
    expect(parsed).not.toBeNull();
    expect(parsed!.savedAt).toBe(0);
    expect(parsed!.layout.name).toBe(layout.name);
  });

  it('clamps a non-finite or negative savedAt to 0 instead of trusting it', () => {
    const layout = defaultCreatorLayout();
    expect(parseStoredEnvelope({ savedAt: Number.NaN, layout })!.savedAt).toBe(0);
    expect(parseStoredEnvelope({ savedAt: -50, layout })!.savedAt).toBe(0);
  });

  it('returns null for non-object junk', () => {
    expect(parseStoredEnvelope(null)).toBeNull();
    expect(parseStoredEnvelope(42)).toBeNull();
    expect(parseStoredEnvelope('layout')).toBeNull();
    expect(parseStoredEnvelope(undefined)).toBeNull();
  });
});

describe('CreatorStorage — newest stored state wins on open (autosave is the working copy)', () => {
  const baseline = defaultCreatorLayout();
  const env = (layout: ReturnType<typeof defaultCreatorLayout>, savedAt: number): StoredLayoutEnvelope => ({
    layout,
    savedAt
  });

  it('neither slot readable ⇒ null (caller falls back to committed default)', () => {
    expect(newestStoredLayout(null, null)).toBeNull();
  });

  it('only one slot present ⇒ that slot, regardless of which', () => {
    const autosave = env(variantOf(baseline), 0);
    const explicit = env(baseline, 100);
    expect(newestStoredLayout(autosave, null)).toBe(autosave);
    expect(newestStoredLayout(null, explicit)).toBe(explicit);
  });

  it('autosave strictly newer ⇒ autosave (recent edits are never dropped for an older explicit save)', () => {
    const autosave = env(variantOf(baseline), 200);
    expect(newestStoredLayout(autosave, env(baseline, 100))).toBe(autosave);
  });

  it('explicit save newer ⇒ explicit save', () => {
    const explicit = env(baseline, 300);
    expect(newestStoredLayout(env(variantOf(baseline), 200), explicit)).toBe(explicit);
  });

  it('tie on savedAt ⇒ the explicit save wins (their content matches in practice)', () => {
    const explicit = env(baseline, 100);
    expect(newestStoredLayout(env(variantOf(baseline), 100), explicit)).toBe(explicit);
  });

  it('legacy bare autosave (savedAt 0) never outranks a timestamped explicit save', () => {
    const explicit = env(baseline, 1);
    expect(newestStoredLayout(env(variantOf(baseline), 0), explicit)).toBe(explicit);
  });
});

describe('CreatorStorage — projects index (seed, migrate, CRUD)', () => {
  beforeEach(() => {
    installStorage();
  });

  it('fresh install ⇒ seeds one starter project (committed course) with a valid activeId', () => {
    const index = loadProjectsIndex();
    expect(index.entries.length).toBe(1);
    expect(index.activeId).toBe(index.entries[0].id);
    expect(index.entries[0].name).toBe(committedCourseLayout().name);
    const working = loadProjectWorking(index.activeId);
    expect(working).not.toBeNull();
    expect(working!.name).toBe(committedCourseLayout().name);
  });

  it('migrates legacy single-layout slots into the first project (both slots carried over)', () => {
    const older = defaultCreatorLayout();
    const newer = variantOf(older, 'newest edits');
    installStorage({
      [STORAGE_KEYS.legacyLayout]: JSON.stringify({ savedAt: 100, layout: older }),
      [STORAGE_KEYS.legacyAutosave]: JSON.stringify({ savedAt: 200, layout: newer })
    });
    const index = loadProjectsIndex();
    expect(index.entries.length).toBe(1);
    // The working copy is the NEWER legacy autosave; the explicit save survives as the manual slot.
    expect(loadProjectWorking(index.activeId)!.name).toBe(newer.name);
    expect(loadProjectManual(index.activeId)!.layout.name).toBe(older.name);
    expect(index.entries[0].name).toBe(newer.name);
  });

  it('migration is one-time: the legacy slots are ignored once the index exists', () => {
    const legacy = variantOf(defaultCreatorLayout(), 'legacy');
    installStorage({ [STORAGE_KEYS.legacyAutosave]: JSON.stringify({ savedAt: 50, layout: legacy }) });
    const first = loadProjectsIndex();
    // A later legacy write (e.g. an old tab) must not spawn a second project.
    globalThis.localStorage.setItem(
      STORAGE_KEYS.legacyAutosave,
      JSON.stringify({ savedAt: 999, layout: variantOf(defaultCreatorLayout(), 'stale tab') })
    );
    const again = loadProjectsIndex();
    expect(again.entries.length).toBe(1);
    expect(again.activeId).toBe(first.activeId);
    expect(loadProjectWorking(again.activeId)!.name).toBe(legacy.name);
  });

  it('createProject adds an entry, writes the working copy, and becomes active', () => {
    const seeded = loadProjectsIndex();
    const blank = blankCourseLayout();
    const created = createProject(blank);
    expect(created).not.toBeNull();
    const index = loadProjectsIndex();
    expect(index.entries.length).toBe(2);
    expect(index.activeId).toBe(created!.id);
    expect(index.activeId).not.toBe(seeded.activeId);
    expect(loadProjectWorking(created!.id)!.name).toBe(blank.name);
  });

  it('project saves refresh the listed summary (name + difficulty + updatedAt)', () => {
    const index = loadProjectsIndex();
    const layout = loadProjectWorking(index.activeId)!;
    layout.name = 'Renamed In Editor';
    layout.difficulty = 'expert';
    expect(saveProjectAutosave(index.activeId, layout)).toBe(true);
    const entry = loadProjectsIndex().entries.find((e) => e.id === index.activeId)!;
    expect(entry.name).toBe('Renamed In Editor');
    expect(entry.difficulty).toBe('expert');
  });

  it('manual + autosave are separate slots; the working copy is the newest of the two', () => {
    const index = loadProjectsIndex();
    // Force distinct envelope timestamps (a same-ms tie goes to the manual save by design).
    let fakeNow = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (fakeNow += 1000));
    try {
      const manual = variantOf(defaultCreatorLayout(), 'manual point');
      expect(saveProjectManual(index.activeId, manual)).toBe(true);
      const newer = variantOf(defaultCreatorLayout(), 'after more edits');
      expect(saveProjectAutosave(index.activeId, newer)).toBe(true);
      expect(loadProjectManual(index.activeId)!.layout.name).toBe(manual.name);
      expect(loadProjectWorking(index.activeId)!.name).toBe(newer.name);
    } finally {
      spy.mockRestore();
    }
  });

  it('renameProject renames both stored slots and the summary', () => {
    const index = loadProjectsIndex();
    saveProjectManual(index.activeId, loadProjectWorking(index.activeId)!);
    expect(renameProject(index.activeId, 'Fresh Name')).toBe(true);
    expect(loadProjectWorking(index.activeId)!.name).toBe('Fresh Name');
    expect(loadProjectManual(index.activeId)!.layout.name).toBe('Fresh Name');
    expect(loadProjectsIndex().entries[0].name).toBe('Fresh Name');
  });

  it('duplicateProject copies the content under "<name> (copy)" without changing the active project', () => {
    const index = loadProjectsIndex();
    const copy = duplicateProject(index.activeId);
    expect(copy).not.toBeNull();
    const after = loadProjectsIndex();
    expect(after.entries.length).toBe(2);
    expect(after.activeId).toBe(index.activeId);
    expect(copy!.name).toBe(`${index.entries[0].name} (copy)`.slice(0, 48));
    expect(loadProjectWorking(copy!.id)!.objects.length).toBe(loadProjectWorking(index.activeId)!.objects.length);
  });

  it('deleteProject removes the stored slots; deleting the active project activates another', () => {
    const first = loadProjectsIndex();
    const second = createProject(blankCourseLayout())!;
    expect(deleteProject(second.id)).toBe(true);
    const store = globalThis.localStorage;
    expect(store.getItem(projectAutoKey(second.id))).toBeNull();
    expect(store.getItem(projectManualKey(second.id))).toBeNull();
    const after = loadProjectsIndex();
    expect(after.entries.length).toBe(1);
    expect(after.activeId).toBe(first.activeId);
  });

  it('deleting the last project reseeds the starter course (never a broken/empty state)', () => {
    const index = loadProjectsIndex();
    expect(deleteProject(index.activeId)).toBe(true);
    const after = loadProjectsIndex();
    expect(after.entries.length).toBe(1);
    expect(after.activeId).not.toBe(index.activeId);
    expect(loadProjectWorking(after.activeId)!.name).toBe(committedCourseLayout().name);
  });

  it('setActiveProject switches the active id and rejects unknown ids', () => {
    const first = loadProjectsIndex();
    const second = createProject(blankCourseLayout())!;
    expect(setActiveProject(first.activeId)).toBe(true);
    expect(loadProjectsIndex().activeId).toBe(first.activeId);
    expect(setActiveProject('nope-missing')).toBe(false);
    expect(loadProjectsIndex().activeId).toBe(first.activeId);
    expect(setActiveProject(second.id)).toBe(true);
  });
});

describe('CreatorStorage — loadCurrentCourseLayout (what the yard plays)', () => {
  beforeEach(() => {
    installStorage();
  });

  it('returns the active project working copy when one exists', () => {
    const index = loadProjectsIndex();
    const edited = variantOf(defaultCreatorLayout(), 'live edits');
    saveProjectAutosave(index.activeId, edited);
    expect(loadCurrentCourseLayout().name).toBe(edited.name);
  });

  it('never seeds from the yard path: fresh store falls back to the committed default', () => {
    expect(loadCurrentCourseLayout().name).toBe(committedCourseLayout().name);
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.projects)).toBeNull();
  });

  it('migrates a legacy save so a pre-projects course keeps playing after the update', () => {
    const legacy = variantOf(defaultCreatorLayout(), 'pre-update course');
    installStorage({ [STORAGE_KEYS.legacyAutosave]: JSON.stringify({ savedAt: 10, layout: legacy }) });
    expect(loadCurrentCourseLayout().name).toBe(legacy.name);
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.projects)).not.toBeNull();
  });
});
