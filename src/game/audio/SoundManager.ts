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
    const urgency = 1 + Math.max(0, (10 - remainingSeconds) * 0.035);
    this.tone('square', 1160 * urgency, 880 * urgency, 0.05, 0.048);
    this.tone('triangle', 460 * urgency, 360 * urgency, 0.085, 0.032);
    this.noiseBurst(0.022, 0.012, 1700 * urgency);
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
