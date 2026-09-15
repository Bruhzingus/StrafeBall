from pathlib import Path

def edit(p,a,b):
 s=Path(p).read_text(encoding='utf-8'); assert a in s,(p,a); Path(p).write_text(s.replace(a,b),encoding='utf-8')
p='src/game/audio/SoundManager.ts'
edit(p,'  /** Thrown-ball whoosh.', '''  /** Layered, spatial power-up cues. Short transients leave room for ball/catch information. */
  powerup(effect: string, position?: AudioPoint, listener?: AudioPoint, forward?: AudioPoint, stage = 0): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
    let destination: AudioNode = this.master;
    if (position && listener) {
      this.setListenerPose(mirrorX(listener), forward && mirrorX(forward));
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse'; panner.refDistance = 4;
      panner.maxDistance = 50; panner.rolloffFactor = 0.85;
      panner.positionX.value = -position.x; panner.positionY.value = position.y; panner.positionZ.value = position.z;
      panner.connect(this.master); destination = panner;
      window.setTimeout(() => panner.disconnect(), 2200);
    }
    const note = (frequency: number, end: number, duration: number, volume: number, delay = 0, type: OscillatorType = 'sine') => {
      const osc = ctx.createOscillator(), amp = ctx.createGain();
      const start = ctx.currentTime + delay;
      osc.type = type; osc.frequency.setValueAtTime(frequency, start); osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), start + duration);
      amp.gain.setValueAtTime(0.0001, start); amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + 0.008);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(amp); amp.connect(destination); osc.start(start); osc.stop(start + duration + 0.02);
      osc.onended = () => { osc.disconnect(); amp.disconnect(); };
    };
    if (effect === 'cannon' || effect === 'explode') {
      note(effect === 'cannon' ? 110 : 75, 28, 0.75, 0.42);
      note(210, 46, 0.22, 0.22, 0, 'triangle');
      this.noiseBurst(0.35, 0.28, 750, destination);
      note(56, 30, 0.65, 0.12, 0.12);
    } else if (effect === 'beep') {
      note(660 + stage * 260, 660 + stage * 260, 0.15 - stage * 0.025, 0.19, 0, 'triangle');
      note(1320 + stage * 520, 1320 + stage * 520, 0.07, 0.045);
    } else if (effect === 'pickup' || effect === 'spawn' || effect === 'heal') {
      const melody = effect === 'heal' ? [523, 659, 784, 1047] : effect === 'pickup' ? [440, 659, 880, 1320] : [392, 587, 784];
      melody.forEach((f, i) => note(f, f * 1.002, 0.22, effect === 'spawn' ? 0.055 : 0.095, i * 0.065, 'triangle'));
      if (effect === 'heal') note(262, 262, 0.7, 0.08);
    } else if (effect === 'activate') {
      note(180, 720, 0.23, 0.12, 0, 'triangle'); note(880, 880, 0.24, 0.075, 0.16);
      this.noiseBurst(0.14, 0.06, 2200, destination);
    } else if (effect === 'thud') {
      note(90, 35, 0.3, 0.3); this.noiseBurst(0.08, 0.13, 420, destination);
    } else if (effect === 'armor') {
      note(1050, 420, 0.16, 0.12, 0, 'triangle'); note(1510, 690, 0.12, 0.045);
    } else if (effect === 'place') {
      note(160, 85, 0.13, 0.17); note(660, 880, 0.2, 0.07, 0.07);
    } else if (effect === 'refuse') {
      note(180, 120, 0.12, 0.06, 0, 'triangle');
    }
  }

  /** Thrown-ball whoosh.''')
p='src/game/scenes/ArenaScene.ts'
s=Path(p).read_text(encoding='utf-8');s="import { PowerupPresentation } from '../powerups/PowerupPresentation';\n"+s;Path(p).write_text(s,encoding='utf-8')
edit(p,'  private readonly sound: SoundManager;', '  private readonly sound: SoundManager;\n  private readonly powerupPresentation: PowerupPresentation;')
edit(p,'    this.sound = new SoundManager();','    this.sound = new SoundManager();\n    this.powerupPresentation = new PowerupPresentation(this.scene, this.sound);')
edit(p,'    this.sound.dispose();','    this.powerupPresentation.dispose();\n    this.sound.dispose();')
edit(p,'    this.elapsed += dt;', '''    this.elapsed += dt;
    const powerupSnapshot = this.multiplayer.latestSnapshot;
    this.powerupPresentation.update(powerupSnapshot?.room ?? null, this.multiplayer.localPlayerId,
      this.player.movement.state.position, this.multiplayer.powerupPrivate, this.multiplayer.drainPowerupEvents(), dt);''')
p='src/game/network/NetworkRenderer.ts'
s=Path(p).read_text(encoding='utf-8');s="import { updateSpecialBall } from '../powerups/PowerupPresentation';\n"+s;Path(p).write_text(s,encoding='utf-8')
edit(p,'      this.updateBallEffects(visual, ball, dt);','''      this.updateBallEffects(visual, ball, dt);
      updateSpecialBall(visual.mesh, ball, performance.now() / 1000);
      if (ball.phase === 'armor' && ball.armorPlayerId) {
        const player = players.find(p => p.id === ball.armorPlayerId);
        if (player) {
          const index = player.armorBallIds?.indexOf(ball.id) ?? 0;
          const angle = performance.now() / 1000 * 1.6 + index * Math.PI * 2 / 3;
          visual.mesh.position.set(player.movement.position.x + Math.sin(angle) * 0.67,
            player.movement.position.y + 0.85 + Math.sin(angle * 2) * 0.12, player.movement.position.z + Math.cos(angle) * 0.67);
        }
      }''')
# Don't erase a private pickup just because the older public snapshot has not arrived yet.
edit('src/game/powerups/PowerupPresentation.ts','    if (local && !local.hasPowerup) this.heldKind = null;','    if (local?.combatState === \'eliminated\') this.heldKind = null;')
