import { describe, it, expect } from 'vitest';
import { cloneLayout, defaultCreatorLayout } from '../src/game/practice/creator/CreatorLayout';
import {
  newestStoredLayout,
  parseStoredEnvelope,
  type StoredLayoutEnvelope
} from '../src/game/practice/creator/CreatorStorage';

/** A distinct-but-valid variant of a layout (so a test can tell which slot won). */
function variantOf(layout: ReturnType<typeof defaultCreatorLayout>) {
  const copy = cloneLayout(layout);
  copy.name = `${copy.name} (autosave variant)`;
  return copy;
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

  it('neither slot readable ⇒ null (caller falls back to published/committed)', () => {
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
