import type { MusicHudState } from '../audio/MusicManager';
import './menus.css';

export class MusicHud {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly time: HTMLDivElement;
  private lastTrack = '';
  private lastTime = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'music-hud';
    this.root.hidden = true;
    this.title = document.createElement('div');
    this.title.className = 'music-hud-title';
    this.time = document.createElement('div');
    this.time.className = 'music-hud-time';
    this.root.append(this.title, this.time);
    parent.appendChild(this.root);
  }

  update(state: MusicHudState | null): void {
    if (!state) {
      this.root.hidden = true;
      this.lastTrack = '';
      return;
    }

    // Music is a permanent, compact playback reference. Keep it visible for the entire time a
    // track context exists instead of treating track changes as a temporary announcement.
    this.root.hidden = false;
    const track = `${state.artist}\n${state.title}`;
    if (track !== this.lastTrack) {
      this.lastTrack = track;
      this.title.textContent = `${state.artist} — ${state.title}`;
    }
    const time = `${state.currentLabel} / ${state.durationLabel}`;
    if (time !== this.lastTime) {
      this.lastTime = time;
      this.time.textContent = time;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
