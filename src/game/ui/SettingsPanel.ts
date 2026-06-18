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
  private readonly toggleButton: HTMLButtonElement;
  private readonly content: HTMLDivElement;
  private readonly sensitivitySlider: HTMLInputElement;
  private readonly sensitivityReadout: HTMLSpanElement;
  private readonly sfxSlider: HTMLInputElement;
  private readonly sfxReadout: HTMLSpanElement;
  private readonly musicSlider: HTMLInputElement;
  private readonly musicReadout: HTMLSpanElement;
  private readonly reducedEffectsToggle: HTMLInputElement;
  private readonly preventKeySteal = (event: KeyboardEvent): void => event.preventDefault();
  private expanded = false;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'settings-panel';
    this.root.setAttribute('data-no-lock', '');

    this.toggleButton = document.createElement('button');
    this.toggleButton.type = 'button';
    this.toggleButton.className = 'settings-toggle';
    this.toggleButton.textContent = 'Settings';
    this.toggleButton.addEventListener('click', this.toggleExpanded);

    this.content = document.createElement('div');
    this.content.className = 'settings-content';

    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Settings';

    const sensitivityLabel = this.row('Sensitivity');
    this.sensitivityReadout = sensitivityLabel.readout;
    this.sensitivitySlider = this.range(SENSITIVITY_MIN, SENSITIVITY_MAX, 0.0001, settings.mouseSensitivity);
    this.sensitivitySlider.addEventListener('input', this.onSensitivityInput);

    const sfxLabel = this.row('SFX');
    this.sfxReadout = sfxLabel.readout;
    this.sfxSlider = this.range(0, 1, 0.05, settings.sfxVolume);
    this.sfxSlider.addEventListener('input', this.onSfxInput);

    const musicLabel = this.row('Music');
    this.musicReadout = musicLabel.readout;
    this.musicSlider = this.range(0, 1, 0.05, settings.musicVolume);
    this.musicSlider.addEventListener('input', this.onMusicInput);

    const effectsLabel = document.createElement('label');
    effectsLabel.className = 'settings-row settings-row--toggle';
    const effectsName = document.createElement('span');
    effectsName.textContent = 'Reduced FX';
    this.reducedEffectsToggle = document.createElement('input');
    this.reducedEffectsToggle.type = 'checkbox';
    this.reducedEffectsToggle.checked = settings.reducedEffects;
    this.reducedEffectsToggle.addEventListener('input', this.onReducedEffectsInput);
    this.reducedEffectsToggle.addEventListener('keydown', this.preventKeySteal);
    effectsLabel.append(effectsName, this.reducedEffectsToggle);

    this.content.append(
      title,
      sensitivityLabel.label,
      this.sensitivitySlider,
      sfxLabel.label,
      this.sfxSlider,
      musicLabel.label,
      this.musicSlider,
      effectsLabel
    );
    this.root.append(this.toggleButton, this.content);
    parent.appendChild(this.root);

    this.syncExpanded();
    this.updateReadout();
  }

  dispose(): void {
    this.toggleButton.removeEventListener('click', this.toggleExpanded);
    this.sensitivitySlider.removeEventListener('input', this.onSensitivityInput);
    this.sfxSlider.removeEventListener('input', this.onSfxInput);
    this.musicSlider.removeEventListener('input', this.onMusicInput);
    this.reducedEffectsToggle.removeEventListener('input', this.onReducedEffectsInput);
    this.sensitivitySlider.removeEventListener('keydown', this.preventKeySteal);
    this.sfxSlider.removeEventListener('keydown', this.preventKeySteal);
    this.musicSlider.removeEventListener('keydown', this.preventKeySteal);
    this.reducedEffectsToggle.removeEventListener('keydown', this.preventKeySteal);
    this.root.remove();
  }

  private onSensitivityInput = (): void => {
    settings.setMouseSensitivity(parseFloat(this.sensitivitySlider.value));
    this.updateReadout();
  };

  private onSfxInput = (): void => {
    settings.setSfxVolume(parseFloat(this.sfxSlider.value));
    this.updateReadout();
  };

  private onMusicInput = (): void => {
    settings.setMusicVolume(parseFloat(this.musicSlider.value));
    this.updateReadout();
  };

  private onReducedEffectsInput = (): void => {
    settings.setReducedEffects(this.reducedEffectsToggle.checked);
    this.updateReadout();
  };

  private toggleExpanded = (): void => {
    this.expanded = !this.expanded;
    this.syncExpanded();
  };

  private syncExpanded(): void {
    this.root.classList.toggle('settings-panel--expanded', this.expanded);
    this.toggleButton.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
  }

  private updateReadout(): void {
    this.sensitivityReadout.textContent = (settings.mouseSensitivity * 1000).toFixed(2);
    this.sfxReadout.textContent = `${Math.round(settings.sfxVolume * 100)}%`;
    this.musicReadout.textContent = `${Math.round(settings.musicVolume * 100)}%`;
  }

  private row(labelText: string): { label: HTMLLabelElement; readout: HTMLSpanElement } {
    const label = document.createElement('label');
    label.className = 'settings-row';
    const name = document.createElement('span');
    name.textContent = labelText;
    const readout = document.createElement('span');
    readout.className = 'settings-value';
    label.append(name, readout);
    return { label, readout };
  }

  private range(min: number, max: number, step: number, value: number): HTMLInputElement {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);
    slider.addEventListener('keydown', this.preventKeySteal);
    return slider;
  }
}
