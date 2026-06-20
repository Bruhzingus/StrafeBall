import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS } from '../shared/constants';
import {
  ALLOWED_MAT_PRESETS,
  ROOM_SETTINGS_LIMITS,
  canonicalizeRoomSettings,
  defaultRoomSettings,
  detectPresetId,
  recommendedRoomSettings,
  resolveMatchSettings,
  roomPhaseFromMatchStatus,
  teamShapeForFormat,
  validateRoomSettingsPatch
} from '../shared/roomSettings';

describe('roomSettings model', () => {
  it('derives the recommended 1v1 preset from current effective behavior', () => {
    const preset = recommendedRoomSettings('1v1');
    expect(preset.preset).toBe('1v1-recommended');
    expect(preset.format).toBe('1v1');
    expect(preset.dodgeballCount).toBe(GAME_CONSTANTS.map.ballCount);
    expect(preset.livesPerPlayer).toBe(GAME_CONSTANTS.match.playerLives);
    expect(preset.maxLiveBallBounces).toBe(GAME_CONSTANTS.ball.deadAfterBounces);
    expect(preset.halfCourtTimerSeconds).toBe(GAME_CONSTANTS.match.noBoundariesSeconds);
    expect(preset.matPreset).toBe(4);
    expect(preset.roundCount).toBe(1);
  });

  it('derives the recommended 2v2 preset from current effective behavior', () => {
    const preset = recommendedRoomSettings('2v2');
    expect(preset.preset).toBe('2v2-recommended');
    expect(preset.dodgeballCount).toBe(GAME_CONSTANTS.match.twoVTwoBallCount);
    expect(preset.livesPerPlayer).toBe(GAME_CONSTANTS.match.playerLives);
  });

  it('detectPresetId tags recommended configs and flips to custom on any edit', () => {
    expect(detectPresetId(recommendedRoomSettings('1v1'))).toBe('1v1-recommended');
    expect(detectPresetId(recommendedRoomSettings('2v2'))).toBe('2v2-recommended');
    const edited = { ...recommendedRoomSettings('1v1'), livesPerPlayer: 6 };
    expect(detectPresetId(edited)).toBe('custom');
  });

  it('resolveMatchSettings expands the team shape per format without hardcoding 1/2', () => {
    expect(teamShapeForFormat('1v1')).toEqual({ teamSize: 1, teamCount: 2, maxPlayers: 2 });
    expect(teamShapeForFormat('2v2')).toEqual({ teamSize: 2, teamCount: 2, maxPlayers: 4 });

    const oneVOne = resolveMatchSettings(defaultRoomSettings('1v1'));
    expect(oneVOne.teamSize).toBe(1);
    expect(oneVOne.maxPlayers).toBe(2);
    expect(oneVOne.scoreLimit).toBe(GAME_CONSTANTS.match.scoreLimit);

    const twoVTwo = resolveMatchSettings(defaultRoomSettings('2v2'));
    expect(twoVTwo.teamSize).toBe(2);
    expect(twoVTwo.maxPlayers).toBe(4);
  });

  it('canonicalize clamps out-of-range fields and snaps the mat preset', () => {
    const canon = canonicalizeRoomSettings({
      format: '1v1',
      livesPerPlayer: 99,
      dodgeballCount: 0,
      maxLiveBallBounces: -5,
      matPreset: 3,
      roundCount: 100,
      halfCourtTimerSeconds: 99999
    } as never);
    expect(canon.livesPerPlayer).toBe(ROOM_SETTINGS_LIMITS.lives.max);
    expect(canon.dodgeballCount).toBe(ROOM_SETTINGS_LIMITS.dodgeballs.min);
    expect(canon.maxLiveBallBounces).toBe(ROOM_SETTINGS_LIMITS.bounces.min);
    expect(ALLOWED_MAT_PRESETS).toContain(canon.matPreset);
    expect(canon.roundCount).toBe(ROOM_SETTINGS_LIMITS.rounds.max);
    expect(canon.halfCourtTimerSeconds).toBe(ROOM_SETTINGS_LIMITS.halfCourtTimer.max);
  });

  it('canonicalize falls back to 1v1 for a disallowed/larger format', () => {
    expect(canonicalizeRoomSettings({ format: '3v3' } as never).format).toBe('1v1');
    expect(canonicalizeRoomSettings({ format: '5v5' } as never).format).toBe('1v1');
  });

  it('maps match status to the unified lifecycle phase', () => {
    expect(roomPhaseFromMatchStatus('warmup')).toBe('lobby');
    expect(roomPhaseFromMatchStatus('countdown')).toBe('countdown');
    expect(roomPhaseFromMatchStatus('playing')).toBe('live');
    expect(roomPhaseFromMatchStatus('complete')).toBe('match-end');
  });
});

describe('validateRoomSettingsPatch', () => {
  const base = defaultRoomSettings('2v2');

  it('accepts an in-range numeric change and re-tags the preset', () => {
    const result = validateRoomSettingsPatch(base, { livesPerPlayer: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.livesPerPlayer).toBe(5);
      expect(result.settings.preset).toBe('custom');
    }
  });

  it('rejects an empty patch', () => {
    expect(validateRoomSettingsPatch(base, {})).toEqual({ ok: false, reason: 'empty-patch' });
    expect(validateRoomSettingsPatch(base, undefined)).toEqual({ ok: false, reason: 'empty-patch' });
  });

  it('rejects out-of-range and non-integer numeric values (no silent clamp)', () => {
    expect(validateRoomSettingsPatch(base, { livesPerPlayer: 7 })).toEqual({ ok: false, reason: 'invalid-field' });
    expect(validateRoomSettingsPatch(base, { livesPerPlayer: 0 })).toEqual({ ok: false, reason: 'invalid-field' });
    expect(validateRoomSettingsPatch(base, { livesPerPlayer: 3.5 })).toEqual({ ok: false, reason: 'invalid-field' });
    expect(validateRoomSettingsPatch(base, { dodgeballCount: 999 })).toEqual({ ok: false, reason: 'invalid-field' });
  });

  it('rejects an invalid mat preset but accepts an allowed one', () => {
    expect(validateRoomSettingsPatch(base, { matPreset: 3 })).toEqual({ ok: false, reason: 'invalid-field' });
    const ok = validateRoomSettingsPatch(base, { matPreset: 2 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.settings.matPreset).toBe(2);
  });

  it('rejects a disallowed/larger format', () => {
    expect(validateRoomSettingsPatch(base, { format: '3v3' as never })).toEqual({ ok: false, reason: 'invalid-format' });
  });

  it('rejects an unknown preset and applies a known one', () => {
    expect(validateRoomSettingsPatch(base, { preset: 'mystery' as never })).toEqual({ ok: false, reason: 'invalid-preset' });
    const applied = validateRoomSettingsPatch({ ...base, livesPerPlayer: 1 }, { preset: '2v2-recommended' });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.settings.preset).toBe('2v2-recommended');
      expect(applied.settings.livesPerPlayer).toBe(GAME_CONSTANTS.match.playerLives);
    }
  });
});
