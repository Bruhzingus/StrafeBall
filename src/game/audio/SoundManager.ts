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

  constructor(private readonly masterVolume = 0.5) {
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

  /** Thrown-ball whoosh. `rate` shifts the pitch (the bot throws a touch lower than the player). */
  whoosh(rate = 1): void {
    this.tone('triangle', 520 * rate, 150 * rate, 0.16, 0.16);
    this.noiseBurst(0.13, 0.1, 1100 * rate);
  }

  /** Low impact thud for a ball striking the player / a target. `gain` scales the volume. */
  thud(gain = 1): void {
    this.tone('sine', 150, 55, 0.22, 0.5 * gain);
    this.noiseBurst(0.05, 0.18 * gain, 500);
  }

  /** Short, bright click for a successful catch. */
  click(): void {
    this.tone('square', 900, 720, 0.05, 0.12);
  }

  private installUnlock(): void {
    if (this.unlockBound) return;
    this.unlockBound = true;
    window.addEventListener('pointerdown', this.resume);
    window.addEventListener('keydown', this.resume);
  }

  private resume = (): void => {
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => undefined);
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
