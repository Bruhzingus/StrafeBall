import type { MusicHudState } from '../audio/MusicManager';

export class MusicHud {
  private readonly root: HTMLDivElement;
  private lastMarkup = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'music-hud';
    this.root.style.display = 'none';
    parent.appendChild(this.root);
  }

  update(state: MusicHudState | null): void {
    if (!state) {
      this.root.style.display = 'none';
      this.lastMarkup = '';
      return;
    }

    const markup = `
      <div class="music-hud-title">${escapeHtml(state.artist)} &mdash; ${escapeHtml(state.title)}</div>
      <div class="music-hud-time">${escapeHtml(state.currentLabel)} / ${escapeHtml(state.durationLabel)}</div>
    `;
    this.root.style.display = '';
    if (markup === this.lastMarkup) return;
    this.lastMarkup = markup;
    this.root.innerHTML = markup;
  }

  dispose(): void {
    this.root.remove();
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
