from pathlib import Path

def edit(p,a,b):
 s=Path(p).read_text(encoding='utf-8'); assert a in s,(p,a); Path(p).write_text(s.replace(a,b),encoding='utf-8')
p='src/game/map/GymArena.ts'
edit(p,'  [-5, 8], [5, 8]\n];','  [-5, 8], [5, 8]\n].map(([x, z]) => [x / 13 * TUNING.map.halfWidth, z / 18 * TUNING.map.halfLength] as const);')
edit(p,'movingDummyAmplitude = 4.5;', 'movingDummyAmplitude = 4.5 / 13 * TUNING.map.halfWidth;')
edit(p,'const positions = [new Vector3(-3, 0.9, 8), new Vector3(0, 0.9, 9.5), new Vector3(3, 0.9, 8)];', 'const positions = [new Vector3(-3, 0.9, 8), new Vector3(0, 0.9, 9.5), new Vector3(3, 0.9, 8)].map(p => new Vector3(p.x / 13 * TUNING.map.halfWidth, p.y, p.z / 18 * TUNING.map.halfLength));')
edit(p,'new Vector3(0, 0.9, 7.5)', 'new Vector3(0, 0.9, 7.5 / 18 * TUNING.map.halfLength)')
p='server/src/simulation/PowerupSystem.ts'
edit(p,'  private cannonHits = new Map<string, Set<string>>();','  private cannonHits = new Map<string, Set<string>>();\n  private distantPulls = new Map<string, string>();')
edit(p,'this.inventory.clear(); this.cannonHits.clear();','this.inventory.clear(); this.cannonHits.clear(); this.distantPulls.clear();')
edit(p,"      if ((ball.phase !== 'loose' && ball.phase !== 'dead') || (ball.kind && ball.kind !== 'normal')) continue;", "      if ((ball.phase !== 'loose' && ball.phase !== 'dead') || (ball.kind && ball.kind !== 'normal')) { this.distantPulls.delete(ball.id); continue; }")
edit(p,'ball.settledSeconds = (ball.settledSeconds ?? 0) > C.powerup.stationarySeconds || Math.hypot', 'ball.settledSeconds = Math.hypot')
edit(p,'|| (ball.settledSeconds ?? 0) > C.powerup.stationarySeconds);','|| (ball.settledSeconds ?? 0) > C.powerup.stationarySeconds || this.distantPulls.get(ball.id) === p.id);')
edit(p,'      if (!p) continue;','      if (!p) { this.distantPulls.delete(ball.id); continue; }')
edit(p,'      if (!nearby) ball.settledSeconds = C.powerup.stationarySeconds + 1;', '      if (!nearby) this.distantPulls.set(ball.id, p.id); else this.distantPulls.delete(ball.id);')
p='shared/simulation/BallSim.ts'
edit(p,"    phase: 'held',", "    phase: 'held',\n    settledSeconds: 0,")
edit(p,"      phase: 'live',", "      phase: 'live',\n      settledSeconds: 0,")
# Keep early bomb history just long enough for a legitimate before-bounce rewind, never after.
p='server/src/simulation/ServerGameLoop.ts'
edit(p,"    if (!isBallCatchableInFlight(ball) && !this.recentHitByBallId.has(ball.id)) {", "    if (ball.kind === 'bomb' && ball.armedAtMs !== undefined && this.stepNowMs - ball.armedAtMs <= this.combatTiming.defenseMaxRewindMs) return;\n    if (!isBallCatchableInFlight(ball) && !this.recentHitByBallId.has(ball.id)) {")
