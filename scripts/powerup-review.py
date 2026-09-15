from pathlib import Path

def edit(p,a,b):
 s=Path(p).read_text(encoding='utf-8'); assert a in s,(p,a); Path(p).write_text(s.replace(a,b),encoding='utf-8')
p='server/tests/ServerGameLoop.test.ts'
edit(p,'loop.state.players.b.movement.position = vec3(0, 0, 14);','loop.state.players.b.movement.position = vec3(0, 0, GAME_CONSTANTS.map.halfLength - 4);')
edit(p,'const startZ = -6;', 'const startZ = -8; // Clear of the scaled mat row.')
p='server/src/simulation/ServerGameLoop.ts'
edit(p,'          this.tryHit(resolved, prevPos, resolved.position);','          const hit = this.tryHit(resolved, prevPos, resolved.position);\n          if (hit) { resolved = hit; combatDone = true; }')
edit(p,"          if (this.state.balls[ballId].phase === 'held') continue;", "          const presentBall = this.state.balls[ballId];\n          if (presentBall.phase === 'held' || presentBall.phase === 'armor' || presentBall.kind === 'cannon' || (presentBall.armedAtMs !== undefined && evalTime >= presentBall.armedAtMs)) continue;")
# Freeze buff timers while the round is paused, preserving shared prediction representation.
edit(p,'    player.movementInternal = result.internal;','    if (this.state.match.status !== \'playing\') result.internal.buffs = player.movementInternal.buffs;\n    player.movementInternal = result.internal;')
p='src/game/ui/Hud.ts'
edit(p,'i < TUNING.dash.maxCharges; i++','i < GAME_CONSTANTS.powerup.adrenalineMaxCharges; i++')
edit(p,'      const seg = this.staminaWidgetSegs[i];','      const seg = this.staminaWidgetSegs[i];\n      seg.style.display = i < maxCharges ? \'\' : \'none\';')
edit(p,'    this.updateStaminaWidget(\n      local ? this.staminaWidgetValue(local.dash.charges, local.dash.rechargeTimerSeconds) : 0,\n      TUNING.dash.maxCharges\n    );','''    const adrenaline = (local?.movementInternal.buffs?.adrenalineSeconds ?? 0) > 0;
    const maxCharges = adrenaline ? GAME_CONSTANTS.powerup.adrenalineMaxCharges : TUNING.dash.maxCharges;
    this.updateStaminaWidget(local ? this.staminaWidgetValue(local.dash.charges, local.dash.rechargeTimerSeconds,
      maxCharges, adrenaline ? GAME_CONSTANTS.powerup.adrenalineRechargeSeconds : TUNING.dash.rechargeSeconds) : 0, maxCharges);''')
edit(p,'private staminaWidgetValue(charges: number, rechargeTimerSeconds: number): number {','private staminaWidgetValue(charges: number, rechargeTimerSeconds: number, maxCharges: number = TUNING.dash.maxCharges, rechargeSeconds: number = TUNING.dash.rechargeSeconds): number {')
edit(p,'const clampedCharges = Math.min(TUNING.dash.maxCharges, Math.max(0, Math.floor(charges)));','const clampedCharges = Math.min(maxCharges, Math.max(0, Math.floor(charges)));')
edit(p,'if (clampedCharges >= TUNING.dash.maxCharges) return TUNING.dash.maxCharges;','if (clampedCharges >= maxCharges) return maxCharges;')
edit(p,'rechargeTimerSeconds / TUNING.dash.rechargeSeconds','rechargeTimerSeconds / rechargeSeconds')
if "import { GAME_CONSTANTS }" not in Path(p).read_text(encoding='utf-8'):
 s=Path(p).read_text(encoding='utf-8');Path(p).write_text("import { GAME_CONSTANTS } from '../../../shared/constants';\n"+s,encoding='utf-8')
# Scale remaining original gym placements.
p='src/game/practice/LobbyModePortals.ts'
s=Path(p).read_text(encoding='utf-8');s="import { TUNING } from '../config/tuning';\n"+s;Path(p).write_text(s,encoding='utf-8')
edit(p,'0, -11.15)', '0, -11.15 / 18 * TUNING.map.halfLength)')
edit(p,'new Vector3(3.35,', 'new Vector3(3.35 / 13 * TUNING.map.halfWidth,')
edit('src/game/config/tuning.ts','position: { x: 0, y: 0.9, z: 11 }','position: { x: 0, y: 0.9, z: 11 / 18 * GAME_CONSTANTS.map.halfLength }')
