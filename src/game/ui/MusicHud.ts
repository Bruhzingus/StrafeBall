import type { MusicHudState } from '../audio/MusicManager';
import './menus.css';

const TRACK_INTRO_MS = 4200;

export class MusicHud {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly time: HTMLDivElement;
  private lastTrack = '';
  private lastTime = '';
  private hideTimer: number | null = null;

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
      this.clearHideTimer();
      return;
    }

    const track = `${state.artist}\n${state.title}`;
    if (track !== this.lastTrack) {
      this.lastTrack = track;
      this.title.textContent = `${state.artist} — ${state.title}`;
      this.root.hidden = false;
      this.root.classList.add('music-hud--introduced');
      this.clearHideTimer();
      this.hideTimer = window.setTimeout(() => {
        this.hideTimer = null;
        this.root.classList.remove('music-hud--introduced');
      }, TRACK_INTRO_MS);
    }
    const time = `${state.currentLabel} / ${state.durationLabel}`;
    if (time !== this.lastTime) {
      this.lastTime = time;
      this.time.textContent = time;
    }
  }

  dispose(): void {
    this.clearHideTimer();
    this.root.remove();
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
