from pathlib import Path

def edit(p,a,b):
 s=Path(p).read_text(encoding='utf-8'); assert a in s,(p,a); Path(p).write_text(s.replace(a,b),encoding='utf-8')
edit('shared/simulation/MovementSim.ts','} as GameConstants;','} as unknown as GameConstants;')
edit('src/game/ui/Hud.ts','deflected: 0 };','deflected: 0, armor: 0 };')
edit('src/game/map/GymArena.ts',"import { TUNING }", "import { GAME_CONSTANTS } from '../../../shared/constants';\nimport { TUNING }")
edit('server/src/simulation/ServerGameLoop.ts','    input.backflipPressed ||= next.backflipPressed;','    input.activatePowerupPressed ||= next.activatePowerupPressed;\n    input.backflipPressed ||= next.backflipPressed;')
# Stationary remote magnets must keep attracting after the first force tick.
p='server/src/simulation/PowerupSystem.ts'
edit(p,'ball.settledSeconds = Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z) < 0.1 ?', 'ball.settledSeconds = (ball.settledSeconds ?? 0) > C.powerup.stationarySeconds || Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z) < 0.1 ?')
# Network client identity + event handling
p='src/game/network/MultiplayerClient.ts'
edit(p,"import {", "import {")
s=Path(p).read_text(encoding='utf-8');s="import type { PowerupPrivateMessage, PowerupEvent } from '../../../shared/protocol';\n"+s;Path(p).write_text(s,encoding='utf-8')
edit(p,'  public latestSnapshot: ServerSnapshot | null = null;','''  public latestSnapshot: ServerSnapshot | null = null;
  public powerupPrivate: PowerupPrivateMessage | null = null;
  private powerupEvents: PowerupEvent[] = [];
  drainPowerupEvents(): PowerupEvent[] { const events = this.powerupEvents; this.powerupEvents = []; return events; }''')
edit(p,"    room.onMessage('snapshot',", "    room.onMessage('powerup-private', (message: PowerupPrivateMessage) => { this.powerupPrivate = message; });\n    room.onMessage('powerup-event', (message: PowerupEvent) => { if (this.powerupEvents.length < 64) this.powerupEvents.push(message); });\n    room.onMessage('snapshot',")
edit(p,'    this.latestSnapshot = null;','    this.latestSnapshot = null;\n    this.powerupPrivate = null; this.powerupEvents = [];')
# input all reset latch sites
p='src/game/scenes/ArenaScene.ts'
edit(p,'  private latchBackflipPressed = false;', '  private latchBackflipPressed = false;\n  private latchPowerupPressed = false;')
edit(p,'    this.latchBackflipPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.backflip);','    this.latchPowerupPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.activatePowerup);\n    this.latchBackflipPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.backflip);')
edit(p,'this.latchBackflipPressed = false;', 'this.latchBackflipPressed = false;\n    this.latchPowerupPressed = false;')
edit(p,'      backflipPressed: this.latchBackflipPressed,','      activatePowerupPressed: this.latchPowerupPressed,\n      backflipPressed: this.latchBackflipPressed,')
edit(p,'    a.backflipPressed === b.backflipPressed &&', '    a.activatePowerupPressed === b.activatePowerupPressed &&\n    a.backflipPressed === b.backflipPressed &&')
edit('src/game/config/controls.ts',"  backflip: 'KeyQ',", "  backflip: 'KeyQ',\n  activatePowerup: 'KeyG', // Online only; G is free in gym matches (sandbox uses it for fly).")
