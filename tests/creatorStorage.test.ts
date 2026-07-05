import { describe, it, expect } from 'vitest';
import { cloneLayout, defaultCreatorLayout } from '../src/game/practice/creator/CreatorLayout';
import {
  parseStoredEnvelope,
  shouldOfferAutosaveRecovery,
  type StoredLayoutEnvelope
} from '../src/game/practice/creator/CreatorStorage';

/** A distinct-but-valid variant of a layout (content differs ⇒ recovery has something to offer). */
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

describe('CreatorStorage — autosave recovery decision (newest wins)', () => {
  const baseline = defaultCreatorLayout();
  const env = (layout: ReturnType<typeof defaultCreatorLayout>, savedAt: number): StoredLayoutEnvelope => ({
    layout,
    savedAt
  });

  it('no autosave ⇒ never recovers', () => {
    expect(shouldOfferAutosaveRecovery(null, env(baseline, 100), baseline)).toBe(false);
    expect(shouldOfferAutosaveRecovery(null, null, baseline)).toBe(false);
  });

  it('autosave strictly newer than the explicit save AND different content ⇒ recovers', () => {
    const autosave = env(variantOf(baseline), 200);
    expect(shouldOfferAutosaveRecovery(autosave, env(baseline, 100), baseline)).toBe(true);
  });

  it('autosave newer but identical to the baseline ⇒ nothing to recover', () => {
    const autosave = env(cloneLayout(baseline), 200);
    expect(shouldOfferAutosaveRecovery(autosave, env(baseline, 100), baseline)).toBe(false);
  });

  it('tie on savedAt ⇒ the explicit save wins', () => {
    const autosave = env(variantOf(baseline), 100);
    expect(shouldOfferAutosaveRecovery(autosave, env(baseline, 100), baseline)).toBe(false);
  });

  it('autosave older than the explicit save ⇒ explicit wins', () => {
    const autosave = env(variantOf(baseline), 50);
    expect(shouldOfferAutosaveRecovery(autosave, env(baseline, 100), baseline)).toBe(false);
  });

  it('legacy bare autosave (savedAt 0) never outranks a timestamped explicit save', () => {
    const autosave = env(variantOf(baseline), 0);
    expect(shouldOfferAutosaveRecovery(autosave, env(baseline, 1), baseline)).toBe(false);
  });

  it('legacy bare autosave with NO explicit save recovers when it differs from the baseline', () => {
    const autosave = env(variantOf(baseline), 0);
    expect(shouldOfferAutosaveRecovery(autosave, null, baseline)).toBe(true);
  });

  it('no explicit save and autosave matches the baseline (e.g. published course) ⇒ no recovery', () => {
    const autosave = env(cloneLayout(baseline), 500);
    expect(shouldOfferAutosaveRecovery(autosave, null, baseline)).toBe(false);
  });
});
