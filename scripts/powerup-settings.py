from pathlib import Path

def edit(p,a,b):
 s=Path(p).read_text(encoding='utf-8'); assert a in s,(p,a); Path(p).write_text(s.replace(a,b),encoding='utf-8')
p='shared/types.ts'
edit(p,'export interface RoomSettings {','export interface RoomSettings {\n  powerupsEnabled?: boolean;')
edit(p,'export interface MatchSettings {','export interface MatchSettings {\n  powerupsEnabled?: boolean;')
p='shared/roomSettings.ts'
edit(p,'  const shared = {','  const shared = {\n    powerupsEnabled: true,')
edit(p,'    a.format === b.format &&','    (a.powerupsEnabled !== false) === (b.powerupsEnabled !== false) &&\n    a.format === b.format &&')
edit(p,'    livesPerPlayer: clampIntField(input?.livesPerPlayer','    powerupsEnabled: typeof input?.powerupsEnabled === \'boolean\' ? input.powerupsEnabled : fallback.powerupsEnabled !== false,\n    livesPerPlayer: clampIntField(input?.livesPerPlayer')
edit(p,'    format: settings.format,','    powerupsEnabled: settings.powerupsEnabled !== false,\n    format: settings.format,')
edit(p,'  halfCourtTimerSeconds?: number;','  halfCourtTimerSeconds?: number;\n  powerupsEnabled?: boolean;')
edit(p,"  if (patch.matPreset !== undefined) {", "  if (patch.powerupsEnabled !== undefined) {\n    if (typeof patch.powerupsEnabled !== 'boolean') return { ok: false, reason: 'invalid-field' };\n    next.powerupsEnabled = patch.powerupsEnabled;\n  }\n  if (patch.matPreset !== undefined) {")
p='server/src/simulation/PowerupSystem.ts'
edit(p,"    if (!p || !alive(p) || room.match.status !== 'playing' || !kind)","    if (room.settings.powerupsEnabled === false || !p || !alive(p) || room.match.status !== 'playing' || !kind)")
edit(p,'    const world = room.powerups ??=', '    if (room.settings.powerupsEnabled === false) return;\n    const world = room.powerups ??=')
p='src/game/network/MultiplayerOverlay.ts'
edit(p,'    s.halfCourtTimerSeconds,','    s.halfCourtTimerSeconds,\n    s.powerupsEnabled,')
edit(p,"    if (action === 'set') {", "    if (action === 'powerups') { this.client.requestRoomSettings({ powerupsEnabled: room.settings.powerupsEnabled === false }); return; }\n    if (action === 'set') {")
edit(p,'    matRow(s.matPreset, editable)', '''    textRow('Power-ups', editable ? `<button class="multiplayer-control" data-action="powerups" type="button">${s.powerupsEnabled === false ? 'Off' : 'On'}</button>` : (s.powerupsEnabled === false ? 'Off' : 'On')),
    matRow(s.matPreset, editable)''')
p='src/game/powerups/PowerupPresentation.ts'
edit(p,'const active = !!room?.powerups;', 'const active = !!room?.powerups && room.settings.powerupsEnabled !== false;')
edit(p,'this.neutral.hidden = Math.abs(localPosition.z) > C.match.neutralZoneHalfDepth;', 'this.neutral.hidden = Math.abs(localPosition.z) > C.match.neutralZoneHalfDepth || Math.abs(localPosition.x) > C.map.halfWidth;')
# Draw all device child meshes even though the empty ball anchor is invisible.
# Give normal ball armor a subtle emissive band in shared renderer later.
p='shared/simulation/PlayerSim.ts'
s=Path(p).read_text(encoding='utf-8');s+='''
/** Preserve the active adrenaline capacity for catch/score/QTE rewards too. */
export function grantPlayerDashCharge(player: PlayerState): DashState {
  const max = (player.movementInternal.buffs?.adrenalineSeconds ?? 0) > 0 ? GAME_CONSTANTS.powerup.adrenalineMaxCharges : GAME_CONSTANTS.dash.maxCharges;
  const charges = Math.min(max, player.dash.charges + 1);
  return { ...player.dash, charges, rechargeTimerSeconds: charges >= max ? 0 : player.dash.rechargeTimerSeconds };
}
''';Path(p).write_text(s,encoding='utf-8')
p='server/src/simulation/ServerGameLoop.ts'
edit(p,'createPlayerState, grantDashCharge','createPlayerState, grantPlayerDashCharge')
for name in ['player','scorer','defender']: edit(p,f'grantDashCharge({name}.dash)',f'grantPlayerDashCharge({name})')
# Avoid awarding a simultaneous explosion wipe to whichever team is first in the roster.
edit(p,"    if (this.state.match.status !== 'playing') return;\n    const losingTeamId", "    if (this.state.match.status !== 'playing') return;\n    if (Object.values(this.state.players).every(p => !this.isPlayerAlive(p))) {\n      this.state.match = { ...this.state.match, status: 'countdown', countdownSeconds: GAME_CONSTANTS.match.countdownSeconds };\n      this.roundRebuildPending = true;\n      return;\n    }\n    const losingTeamId")
p='src/game/player/PlayerController.ts'
edit(p,'new Vector3(0, 0, -16)','new Vector3(0, 0, -16 / 18 * TUNING.map.halfLength)')
if 'import { TUNING }' not in Path(p).read_text(encoding='utf-8'):
 s=Path(p).read_text(encoding='utf-8');Path(p).write_text("import { TUNING } from '../config/tuning';\n"+s,encoding='utf-8')
