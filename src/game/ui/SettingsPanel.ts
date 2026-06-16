import { settings, SENSITIVITY_MIN, SENSITIVITY_MAX } from '../config/Settings';

/**
 * A tiny always-visible settings panel (top-right) with a mouse-sensitivity slider. Marked
 * [data-no-lock] so clicking/dragging it doesn't grab pointer lock (see InputManager). Usable
 * while the cursor is free (before play, or after Esc); changes apply live and persist.
 *
 * The slider value is the raw radians-per-pixel sensitivity; we show a friendly x1000 readout.
 */
export class SettingsPanel {
  private readonly root: HTMLDivElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLSpanElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'settings-panel';
    this.root.setAttribute('data-no-lock', '');

    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Settings';

    const label = document.createElement('label');
    label.className = 'settings-row';

    const name = document.createElement('span');
    name.textContent = 'Sensitivity';

    this.readout = document.createElement('span');
    this.readout.className = 'settings-value';

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = String(SENSITIVITY_MIN);
    this.slider.max = String(SENSITIVITY_MAX);
    this.slider.step = '0.0001';
    this.slider.value = String(settings.mouseSensitivity);
    this.slider.addEventListener('input', this.onInput);
    // Keep keyboard focus off the slider so arrow keys / space stay with the game.
    this.slider.addEventListener('keydown', (e) => e.preventDefault());

    label.append(name, this.readout);
    this.root.append(title, label, this.slider);
    parent.appendChild(this.root);

    this.updateReadout();
  }

  dispose(): void {
    this.slider.removeEventListener('input', this.onInput);
    this.root.remove();
  }

  private onInput = (): void => {
    settings.setMouseSensitivity(parseFloat(this.slider.value));
    this.updateReadout();
  };

  private updateReadout(): void {
    this.readout.textContent = (settings.mouseSensitivity * 1000).toFixed(2);
  }
}
