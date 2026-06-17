/**
 * Tiny procedural sound layer — no audio files. Every effect is synthesized on the fly with
 * the WebAudio API (oscillators + a short noise buffer), so it ships zero assets and stays in
 * the spirit of the greybox prototype.
 *
 * Browsers start an AudioContext suspended until a user gesture; we lazily create the context
 * and resume it on the first pointer/key input (the same click that grabs pointer lock), so
 * sounds are audible from the first throw onward.
 */
export class SoundManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private unlockBound = false;

  constructor(private readonly masterVolume = 0.8) {
    this.installUnlock();
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.resume);
    window.removeEventListener('keydown', this.resume);
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }

  /** Thrown-ball whoosh. `rate` shifts the pitch. */
  whoosh(rate = 1): void {
    this.tone('triangle', 520 * rate, 150 * rate, 0.16, 0.3);
    this.noiseBurst(0.13, 0.2, 1100 * rate);
  }

  ping(speed: number, gain = 1): void {
    const speedScale = Math.max(0.4, speed / 24);
    const baseFreq = 720 * speedScale;

    // Core rubber impact: sharp high start sweeping to resonance
    this.tone('sine', baseFreq * 1.5, baseFreq, 0.12, 1.2 * gain);
    // Hollow body resonance: the characteristic "donk"
    this.tone('triangle', baseFreq * 0.8, baseFreq * 0.4, 0.35, 0.6 * gain);
    // Echoing hollow tail: long decaying low resonance
    this.tone('sine', baseFreq * 0.4, baseFreq * 0.35, 0.6, 0.4 * gain);
    // Texture: short noise burst for the initial slap
    this.noiseBurst(0.08, 0.3 * gain, 900 * speedScale);
  }

  /** Legacy hook for impacts: now uses the rubber ping at standard speed. */
  thud(gain = 1): void {
    this.ping(24, gain);
  }

  /** Short, bright click for a successful catch. */
  click(): void {
    this.tone('square', 900, 720, 0.05, 0.12);
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
    oscA.frequency.setValueAtTime(760, now);
    oscB.frequency.setValueAtTime(782, now);
    oscA.detune.setValueAtTime(4, now);
    oscB.detune.setValueAtTime(-6, now);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1350, now);
    filter.Q.value = 0.9;

    toneGain.gain.setValueAtTime(0.0001, now);
    toneGain.gain.linearRampToValueAtTime(0.28, now + 0.02);
    toneGain.gain.linearRampToValueAtTime(0.24, now + duration - 0.16);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    oscA.connect(toneGain);
    oscB.connect(toneGain);
    toneGain.connect(filter).connect(this.master);

    oscA.start(now);
    oscB.start(now);
    oscA.stop(now + duration + 0.03);
    oscB.stop(now + duration + 0.03);

    this.noiseBurst(0.09, 0.02, 2200);
  }

  private installUnlock(): void {
    if (this.unlockBound) return;
    this.unlockBound = true;
    window.addEventListener('pointerdown', this.resume);
    window.addEventListener('keydown', this.resume);
  }

  private resume = (): void => {
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended') {
      console.log('[audio] user gesture detected: resuming AudioContext');
      ctx.resume().catch((e) => console.error('[audio] failed to resume context:', e));
    }
  };

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  // A single oscillator with a quick attack and exponential decay. freqEnd != freqStart sweeps
  // the pitch over the duration. exponentialRamp can't target 0, so we decay to near-silence.
  private tone(type: OscillatorType, freqStart: number, freqEnd: number, duration: number, peak: number): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd !== freqStart) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  // A burst of low-passed white noise — the "air"/impact texture layered under the tones.
  private noiseBurst(duration: number, peak: number, filterFreq: number): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
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
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + duration);
  }
}
