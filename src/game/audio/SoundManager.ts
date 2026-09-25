/**
 * Tiny procedural sound layer — no audio files. Every effect is synthesized on the fly with
 * the WebAudio API (oscillators + a short noise buffer), so it ships zero assets and stays in
 * the spirit of the greybox prototype.
 *
 * Browsers start an AudioContext suspended until a user gesture; we lazily create the context
 * and resume it on the first pointer/key input (the same click that grabs pointer lock), so
 * sounds are audible from the first throw onward.
 */
import { settings } from '../config/Settings';
import type { PowerupKind } from '../../../shared/types';

interface AudioPoint {
  x: number;
  y: number;
  z: number;
}

interface LegacyAudioListener {
  setPosition?: (x: number, y: number, z: number) => void;
  setOrientation?: (x: number, y: number, z: number, xUp: number, yUp: number, zUp: number) => void;
}

const MIN_AUDIO_PARAM_VALUE = 0.0001;
const MIN_AUDIBLE_PEAK = 0.00001;

function mirrorX(p: AudioPoint): AudioPoint {
  return { x: -p.x, y: p.y, z: p.z };
}

export class SoundManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private unlockBound = false;

  constructor(private readonly masterVolume = 0.8) {
    this.installUnlock();
  }

  dispose(): void {
    this.removeUnlock();
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }

  /**
   * Layered, spatial power-up cues. `kind` is deliberately optional: pickup identities are
   * private, so only the local player's pickup gets a type-specific cue while everyone else
   * retains the anonymous pickup sound.
   */
  powerup(effect: string, position?: AudioPoint, listener?: AudioPoint, forward?: AudioPoint, stage = 0, kind?: PowerupKind): void {
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
    if (effect === 'explode') {
      // The bomb gets its own heavier transient and longer low tail so it reads over combat.
      note(85, 25, 0.85, 0.68);
      note(230, 42, 0.3, 0.32, 0, 'triangle');
      this.noiseBurst(0.43, 0.42, 1100, destination);
      note(48, 26, 0.8, 0.2, 0.1);
    } else if (effect === 'cannon') {
      note(110, 28, 0.75, 0.42);
      note(210, 46, 0.22, 0.22, 0, 'triangle');
      this.noiseBurst(0.35, 0.28, 750, destination);
      note(56, 30, 0.65, 0.12, 0.12);
    } else if (effect === 'beep') {
      // Loud and escalating: this is the one cue a player near an armed bomb must not miss.
      note(660 + stage * 260, 660 + stage * 260, 0.16 - stage * 0.02, 0.5 + stage * 0.12, 0, 'square');
      note(660 + stage * 260, 660 + stage * 260, 0.16 - stage * 0.02, 0.3, 0, 'triangle');
      note(1320 + stage * 520, 1320 + stage * 520, 0.08, 0.14);
    } else if (effect === 'healtick') {
      // One soft chime per second of heal dwell, stepping up so the player hears progress.
      const step = Math.max(0, Math.min(9, stage - 1));
      note(523 * Math.pow(2, step / 12), 523 * Math.pow(2, step / 12) * 1.003, 0.16, 0.085, 0, 'triangle');
      note(1046 * Math.pow(2, step / 12), 1046 * Math.pow(2, step / 12), 0.09, 0.03, 0.01);
    } else if (effect === 'roll-start') {
      // Soft intake and a short rising pair leave room for the individual roulette ticks.
      note(220, 440, 0.2, 0.07, 0, 'triangle');
      note(440, 660, 0.16, 0.045, 0.075);
      this.noiseBurst(0.07, 0.018, 2800, destination);
    } else if (effect === 'roll-tick') {
      const pitch = [523, 587, 659, 784][Math.max(0, stage - 1) % 4];
      note(pitch, pitch * 1.035, 0.075, 0.052, 0, 'triangle');
      note(pitch * 2, pitch * 2, 0.045, 0.012, 0.008);
    } else if (effect === 'roll-reveal') {
      note(392, 784, 0.24, 0.08, 0, 'triangle');
      note(784, 1047, 0.3, 0.055, 0.065);
      note(1175, 1175, 0.42, 0.032, 0.12);
      if (kind) this.powerup('pickup', undefined, undefined, undefined, 0, kind);
    } else if (effect === 'pickup') {
      // The item reveal is intentionally recognisable before the HUD is read. Remote players
      // receive no `kind`, preserving the mystery-item contract and the old neutral pickup cue.
      if (kind === 'adrenaline') {
        note(92, 56, 0.14, 0.15); note(98, 54, 0.13, 0.13, 0.11);
        note(660, 1320, 0.18, 0.085, 0.15, 'triangle');
      } else if (kind === 'speed') {
        note(260, 1560, 0.2, 0.13, 0, 'sine'); note(880, 1760, 0.12, 0.07, 0.055, 'triangle');
        this.noiseBurst(0.09, 0.035, 3600, destination);
      } else if (kind === 'cannon') {
        note(96, 52, 0.26, 0.17); note(280, 180, 0.18, 0.075, 0.01, 'square');
        note(740, 390, 0.14, 0.055, 0.09, 'triangle');
      } else if (kind === 'heal') {
        note(523, 523, 0.2, 0.09, 0, 'triangle'); note(784, 784, 0.22, 0.08, 0.08, 'triangle');
        note(262, 262, 0.42, 0.045, 0.04);
      } else if (kind === 'magnet') {
        note(420, 170, 0.18, 0.1, 0, 'square'); note(175, 440, 0.2, 0.08, 0.075, 'triangle');
        note(980, 1180, 0.11, 0.045, 0.12);
      } else if (kind === 'bomb') {
        note(150, 82, 0.25, 0.13); note(460, 460, 0.09, 0.11, 0.03, 'square');
        note(620, 620, 0.09, 0.11, 0.14, 'square');
      } else if (kind === 'shock') {
        this.noiseBurst(0.055, 0.13, 3600, destination);
        note(280, 1900, 0.15, 0.14, 0, 'sawtooth'); note(920, 520, 0.18, 0.055, 0.05, 'triangle');
      } else if (kind === 'stun') {
        note(1750, 2550, 0.13, 0.105, 0, 'square'); note(620, 320, 0.34, 0.08, 0.06, 'sine');
        note(3200, 2900, 0.26, 0.038, 0.1);
      } else {
        [440, 659, 880, 1320].forEach((f, i) => note(f, f * 1.002, 0.22, 0.095, i * 0.065, 'triangle'));
      }
    } else if (effect === 'spawn' || effect === 'heal') {
      const melody = effect === 'heal' ? [523, 659, 784, 1047] : [392, 587, 784];
      melody.forEach((f, i) => note(f, f * 1.002, 0.22, effect === 'spawn' ? 0.055 : 0.095, i * 0.065, 'triangle'));
      if (effect === 'heal') note(262, 262, 0.7, 0.08);
    } else if (effect === 'activate') {
      // Activation variants reinforce what was just picked up; the generic arpeggio remains a
      // safe fallback for mixed-version event streams without a public `kind`.
      if (kind === 'adrenaline') {
        note(76, 44, 0.16, 0.18); note(82, 42, 0.15, 0.15, 0.13);
        note(340, 1080, 0.26, 0.1, 0.08, 'triangle');
      } else if (kind === 'speed') {
        note(210, 2280, 0.24, 0.15, 0, 'sine'); note(1120, 2240, 0.12, 0.07, 0.07, 'triangle');
        this.noiseBurst(0.1, 0.045, 4200, destination);
      } else if (kind === 'cannon') {
        note(92, 42, 0.44, 0.22); note(310, 720, 0.23, 0.09, 0.035, 'triangle');
        note(720, 360, 0.18, 0.055, 0.12, 'square');
      } else if (kind === 'heal') {
        note(330, 660, 0.28, 0.095, 0, 'triangle'); note(880, 1320, 0.2, 0.075, 0.1, 'triangle');
        note(220, 220, 0.55, 0.04, 0.04);
      } else if (kind === 'magnet') {
        note(150, 780, 0.34, 0.12, 0, 'triangle'); note(920, 160, 0.3, 0.075, 0.04, 'square');
        note(1240, 980, 0.15, 0.04, 0.15);
      } else if (kind === 'bomb') {
        note(148, 78, 0.32, 0.15); note(510, 510, 0.1, 0.13, 0.05, 'square');
        note(680, 680, 0.1, 0.13, 0.18, 'square');
      } else if (kind === 'shock') {
        this.noiseBurst(0.07, 0.16, 4400, destination);
        note(180, 2200, 0.19, 0.16, 0, 'sawtooth'); note(680, 180, 0.32, 0.085, 0.06, 'triangle');
      } else if (kind === 'stun') {
        note(1480, 2480, 0.14, 0.13, 0, 'square'); note(2700, 2420, 0.62, 0.065, 0.09, 'sine');
        note(380, 190, 0.35, 0.07, 0.02);
      } else {
        note(180, 720, 0.23, 0.12, 0, 'triangle'); note(880, 880, 0.24, 0.075, 0.16);
        this.noiseBurst(0.14, 0.06, 2200, destination);
      }
    } else if (effect === 'thud') {
      note(90, 35, 0.3, 0.3); this.noiseBurst(0.08, 0.13, 420, destination);
    } else if (effect === 'armor') {
      note(1050, 420, 0.16, 0.12, 0, 'triangle'); note(1510, 690, 0.12, 0.045);
    } else if (effect === 'place') {
      note(160, 85, 0.13, 0.17); note(660, 880, 0.2, 0.07, 0.07);
    } else if (effect === 'stick') {
      // Grenade lands: a short metallic clack, then a quiet rising arm tone.
      note(1200, 300, 0.05, 0.18, 0, 'square'); this.noiseBurst(0.04, 0.1, 3200, destination);
      note(420, 980, 0.45, 0.06, 0.05, 'triangle');
    } else if (effect === 'shock') {
      // Shockwave: a deep whump with a fast upward sweep — big, but no crunch (nobody got hurt).
      note(70, 30, 0.5, 0.5); note(240, 1400, 0.22, 0.28, 0, 'sine');
      this.noiseBurst(0.22, 0.22, 900, destination);
    } else if (effect === 'stun') {
      // Stun: a piercing crack and a long ringing tail (the concussion "eeeee").
      this.noiseBurst(0.06, 0.55, 5200, destination);
      note(2400, 2400, 0.05, 0.4, 0, 'square');
      note(3100, 2900, 1.6, 0.11, 0.05, 'sine');
    } else if (effect === 'map-warning') {
      // Klaxon-ish two-tone: something is about to happen to the whole court.
      for (let i = 0; i < 3; i++) { note(520, 520, 0.14, 0.2, i * 0.32, 'square'); note(390, 390, 0.14, 0.2, i * 0.32 + 0.16, 'square'); }
    } else if (effect === 'map-start') {
      note(180, 90, 0.7, 0.32); note(660, 1320, 0.35, 0.14, 0.05, 'triangle');
      this.noiseBurst(0.3, 0.16, 600, destination);
    } else if (effect === 'map-end') {
      note(880, 440, 0.4, 0.12, 0, 'triangle'); note(440, 220, 0.5, 0.1, 0.12, 'triangle');
    } else if (effect === 'refuse') {
      note(180, 120, 0.12, 0.06, 0, 'triangle');
    }
  }

  /** Thrown-ball whoosh. `rate` shifts the pitch. */
  whoosh(rate = 1, gain = 1): void {
    this.tone('triangle', 520 * rate, 150 * rate, 0.16, 0.3 * gain);
    this.noiseBurst(0.13, 0.2 * gain, 1100 * rate);
  }

  ping(speed: number, gain = 1): void {
    this.pingTo(speed, gain);
  }

  pingAt(speed: number, position: AudioPoint, listenerPosition: AudioPoint, listenerForward?: AudioPoint, listenerUp?: AudioPoint, gain = 1): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;

    // Babylon's scene is left-handed, but the Web Audio listener/panner model is right-handed
    // (same convention as OpenAL). Feeding left-handed X straight in flips the perceived stereo
    // image — a ball on the player's left was panning to the right ear. Mirroring X at this single
    // chokepoint (every positional sound funnels through here) converts to the right-handed frame
    // Web Audio expects, without touching Babylon's own left-handed math anywhere else.
    this.setListenerPose(mirrorX(listenerPosition), listenerForward && mirrorX(listenerForward), listenerUp && mirrorX(listenerUp));

    const panner = ctx.createPanner();
    // Equal-power panning is cheaper than HRTF and enough for readable bounce direction.
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 4;
    panner.maxDistance = 42;
    panner.rolloffFactor = 1.15;
    const mirroredPosition = mirrorX(position);
    setAudioParam(panner.positionX, mirroredPosition.x, ctx.currentTime);
    setAudioParam(panner.positionY, mirroredPosition.y, ctx.currentTime);
    setAudioParam(panner.positionZ, mirroredPosition.z, ctx.currentTime);
    panner.connect(this.master);

    this.pingTo(speed, gain, panner);
    window.setTimeout(() => {
      try {
        panner.disconnect();
      } catch {
        // Some browsers throw if the node already disconnected during context teardown.
      }
    }, 700);
  }

  private pingTo(speed: number, gain = 1, destination?: AudioNode): void {
    const speedScale = Math.max(0.55, Math.min(1.15, 0.58 + speed / 52));
    const baseFreq = 460 * speedScale;

    // Core rubber impact: lower and less glassy than before.
    this.tone('sine', baseFreq * 1.2, baseFreq * 0.82, 0.12, 1.05 * gain, destination);
    // Hollow body resonance: the characteristic gym-ball "donk".
    this.tone('triangle', baseFreq * 0.72, baseFreq * 0.34, 0.32, 0.52 * gain, destination);
    // Echoing hollow tail: long decaying low resonance.
    this.tone('sine', baseFreq * 0.34, baseFreq * 0.28, 0.52, 0.32 * gain, destination);
    // Texture: short noise burst for the initial slap
    this.noiseBurst(0.07, 0.24 * gain, 650 * speedScale, destination);
  }

  footstep(speed = 1): void {
    const step = Math.max(0.2, Math.min(1, speed));
    this.tone('triangle', 170 + 35 * step, 118 + 24 * step, 0.045, 0.02 + 0.012 * step);
    this.noiseBurst(0.03, 0.007 + 0.004 * step, 520 + 180 * step);
  }

  squeak(intensity = 1, gain = 1): void {
    const grip = Math.max(0.35, Math.min(1.35, intensity));
    this.tone('square', 1120 * grip, 760 * grip, 0.08, 0.035 * grip * gain);
    this.tone('triangle', 760 * grip, 560 * grip, 0.11, 0.024 * grip * gain);
  }

  slideBrush(speed = 0, gain = 1): void {
    const scrape = Math.max(0.42, Math.min(1.15, 0.48 + speed / 18));
    this.filteredNoiseBurst({
      duration: 0.34 + 0.1 * Math.min(1, speed / 12),
      peak: 0.048 * scrape * gain,
      highpassHz: 90,
      lowpassHz: 1450,
      attackSeconds: 0.055
    });
    this.filteredNoiseBurst({
      duration: 0.28,
      peak: 0.022 * scrape * gain,
      highpassHz: 260,
      lowpassHz: 2200,
      attackSeconds: 0.075
    });
  }

  /** Legacy hook for impacts: now uses the rubber ping at standard speed. */
  thud(gain = 1): void {
    this.ping(24, gain);
  }

  /** Short, bright click for a successful catch. */
  click(): void {
    this.tone('square', 900, 720, 0.05, 0.12);
  }

  /** Short analog clock tick used for the final half-court countdown. */
  clockTick(remainingSeconds: number): void {
    if (settings.reducedEffects) return;
    const urgency = 1 + Math.max(0, (10 - remainingSeconds) * 0.035);
    this.tone('square', 1160 * urgency, 880 * urgency, 0.05, 0.048);
    this.tone('triangle', 460 * urgency, 360 * urgency, 0.085, 0.032);
    this.noiseBurst(0.022, 0.012, 1700 * urgency);
  }

  /** Short scoreboard confirmation when half court opens. */
  boundaryOpenConfirm(): void {
    if (settings.reducedEffects) return;
    this.tone('square', 420, 420, 0.12, 0.075);
    this.tone('triangle', 630, 520, 0.16, 0.05);
    this.noiseBurst(0.035, 0.01, 1300);
  }

  /**
   * Bright rising three-note arpeggio for a perfect backflip-QTE throw — a celebratory "ta-da".
   * `strength` (0..1) scales pitch + volume so near-perfect tiers get a subtler version.
   */
  perfectThrow(strength = 1): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    // C–E–G major triad, shifted up a touch as strength rises.
    const base = 660 + 120 * strength;
    const notes = [base, base * 1.26, base * 1.5];
    const peak = 0.12 + 0.08 * strength;
    notes.forEach((freq, i) => {
      const start = now + i * 0.07;
      const dur = 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain).connect(this.master!);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    });
  }

  /** High-school gym / basketball game-ending buzzer. */
  gameEndBuzzer(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;

    const now = ctx.currentTime;
    const duration = 1.55;

    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    const toneGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    oscA.type = 'square';
    oscB.type = 'sawtooth';
    oscA.frequency.setValueAtTime(185, now);
    oscB.frequency.setValueAtTime(193, now);
    oscA.detune.setValueAtTime(5, now);
    oscB.detune.setValueAtTime(-7, now);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(420, now);
    filter.Q.value = 0.7;

    toneGain.gain.setValueAtTime(0.0001, now);
    toneGain.gain.linearRampToValueAtTime(0.21, now + 0.02);
    toneGain.gain.linearRampToValueAtTime(0.18, now + duration - 0.16);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    oscA.connect(toneGain);
    oscB.connect(toneGain);
    toneGain.connect(filter).connect(this.master);

    oscA.start(now);
    oscB.start(now);
    oscA.stop(now + duration + 0.03);
    oscB.stop(now + duration + 0.03);

    this.noiseBurst(0.1, 0.015, 900);
  }

  private installUnlock(): void {
    if (this.unlockBound) return;
    this.unlockBound = true;
    window.addEventListener('pointerdown', this.resume);
    window.addEventListener('touchend', this.resume);
    window.addEventListener('keydown', this.resume);
  }

  private resume = (): void => {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === 'running') {
      this.removeUnlock();
      return;
    }
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      ctx.resume()
        .then(() => this.removeUnlock())
        .catch((e) => console.error('[audio] failed to resume context:', e));
    }
  };

  private removeUnlock(): void {
    if (!this.unlockBound) return;
    window.removeEventListener('pointerdown', this.resume);
    window.removeEventListener('touchend', this.resume);
    window.removeEventListener('keydown', this.resume);
    this.unlockBound = false;
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) {
      this.syncVolume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.syncVolume();
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  private syncVolume(): void {
    if (!this.master) return;
    this.master.gain.value = this.masterVolume * settings.sfxVolume;
  }

  // A single oscillator with a quick attack and exponential decay. freqEnd != freqStart sweeps
  // the pitch over the duration. exponentialRamp can't target 0, so we decay to near-silence.
  private tone(type: OscillatorType, freqStart: number, freqEnd: number, duration: number, peak: number, destination?: AudioNode): void {
    const ctx = this.ensureContext();
    const output = destination ?? this.master;
    if (!ctx || !output || !Number.isFinite(peak) || peak <= MIN_AUDIBLE_PEAK) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd !== freqStart) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), now + duration);
    gain.gain.setValueAtTime(MIN_AUDIO_PARAM_VALUE, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(MIN_AUDIO_PARAM_VALUE, peak), now + 0.006);
    gain.gain.exponentialRampToValueAtTime(MIN_AUDIO_PARAM_VALUE, now + duration);
    osc.connect(gain).connect(output);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  // A burst of low-passed white noise — the "air"/impact texture layered under the tones.
  private noiseBurst(duration: number, peak: number, filterFreq: number, destination?: AudioNode): void {
    const ctx = this.ensureContext();
    const output = destination ?? this.master;
    if (!ctx || !output || !Number.isFinite(peak) || peak <= MIN_AUDIBLE_PEAK) return;
    const now = ctx.currentTime;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(MIN_AUDIO_PARAM_VALUE, peak), now);
    gain.gain.exponentialRampToValueAtTime(MIN_AUDIO_PARAM_VALUE, now + duration);
    src.connect(filter).connect(gain).connect(output);
    src.start(now);
    src.stop(now + duration);
  }

  private filteredNoiseBurst(options: {
    duration: number;
    peak: number;
    highpassHz: number;
    lowpassHz: number;
    attackSeconds?: number;
    destination?: AudioNode;
  }): void {
    const ctx = this.ensureContext();
    const output = options.destination ?? this.master;
    if (!ctx || !output || !Number.isFinite(options.peak) || options.peak <= MIN_AUDIBLE_PEAK) return;

    const now = ctx.currentTime;
    const duration = Math.max(0.01, options.duration);
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let previous = 0;
    for (let i = 0; i < frames; i += 1) {
      const white = Math.random() * 2 - 1;
      previous = previous * 0.58 + white * 0.42;
      data[i] = previous;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = options.highpassHz;
    highpass.Q.value = 0.45;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = options.lowpassHz;
    lowpass.Q.value = 0.7;
    const gain = ctx.createGain();
    const attack = Math.min(duration * 0.4, options.attackSeconds ?? 0.008);
    gain.gain.setValueAtTime(MIN_AUDIO_PARAM_VALUE, now);
    gain.gain.linearRampToValueAtTime(Math.max(MIN_AUDIO_PARAM_VALUE, options.peak), now + attack);
    gain.gain.exponentialRampToValueAtTime(MIN_AUDIO_PARAM_VALUE, now + duration);
    src.connect(highpass).connect(lowpass).connect(gain).connect(output);
    src.start(now);
    src.stop(now + duration);
  }

  private setListenerPose(position: AudioPoint, forward?: AudioPoint, up?: AudioPoint): void {
    if (!this.ctx) return;
    const listener = this.ctx.listener;
    const now = this.ctx.currentTime;

    if ('positionX' in listener) {
      setAudioParam(listener.positionX, position.x, now);
      setAudioParam(listener.positionY, position.y, now);
      setAudioParam(listener.positionZ, position.z, now);
      if (forward && up && 'forwardX' in listener) {
        setAudioParam(listener.forwardX, forward.x, now);
        setAudioParam(listener.forwardY, forward.y, now);
        setAudioParam(listener.forwardZ, forward.z, now);
        setAudioParam(listener.upX, up.x, now);
        setAudioParam(listener.upY, up.y, now);
        setAudioParam(listener.upZ, up.z, now);
      }
      return;
    }

    const legacy = listener as unknown as LegacyAudioListener;
    legacy.setPosition?.(position.x, position.y, position.z);
    if (forward && up) legacy.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}

function setAudioParam(param: AudioParam, value: number, time: number): void {
  param.setValueAtTime(value, time);
}
