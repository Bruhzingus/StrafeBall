import { settings, SENSITIVITY_MIN, SENSITIVITY_MAX } from '../config/Settings';
import { GRAPHICS_PRESETS, getGraphicsPreset, persistGraphicsPreset, type GraphicsPreset } from '../config/graphicsConfig';

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
  private readonly lobbyMusicSlider: HTMLInputElement;
  private readonly lobbyMusicReadout: HTMLSpanElement;
  private readonly battleMusicSlider: HTMLInputElement;
  private readonly battleMusicReadout: HTMLSpanElement;
  private readonly reducedEffectsToggle: HTMLInputElement;
  private readonly graphicsSelect: HTMLSelectElement;
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

    const lobbyMusicLabel = this.row('Lobby Music');
    this.lobbyMusicReadout = lobbyMusicLabel.readout;
    this.lobbyMusicSlider = this.range(0, 1, 0.05, settings.lobbyMusicVolume);
    this.lobbyMusicSlider.addEventListener('input', this.onLobbyMusicInput);

    const battleMusicLabel = this.row('Battle Music');
    this.battleMusicReadout = battleMusicLabel.readout;
    this.battleMusicSlider = this.range(0, 1, 0.05, settings.battleMusicVolume);
    this.battleMusicSlider.addEventListener('input', this.onBattleMusicInput);

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

    // Graphics preset selector. Lighting/post are built once at scene construction, so a change is
    // persisted and applied with a reload (the dropdown swaps Competitive ↔ Showcase High/Ultra).
    const graphicsRow = document.createElement('label');
    graphicsRow.className = 'settings-row settings-row--select';
    const graphicsName = document.createElement('span');
    graphicsName.textContent = 'Graphics';
    this.graphicsSelect = document.createElement('select');
    this.graphicsSelect.className = 'settings-select';
    for (const preset of GRAPHICS_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.value;
      option.textContent = preset.label;
      this.graphicsSelect.append(option);
    }
    this.graphicsSelect.value = getGraphicsPreset();
    this.graphicsSelect.addEventListener('change', this.onGraphicsPresetChange);
    this.graphicsSelect.addEventListener('keydown', this.preventKeySteal);
    graphicsRow.append(graphicsName, this.graphicsSelect);

    const graphicsHint = document.createElement('div');
    graphicsHint.className = 'settings-hint';
    graphicsHint.textContent = 'Changing graphics reloads the page.';

    this.content.append(
      title,
      sensitivityLabel.label,
      this.sensitivitySlider,
      sfxLabel.label,
      this.sfxSlider,
      lobbyMusicLabel.label,
      this.lobbyMusicSlider,
      battleMusicLabel.label,
      this.battleMusicSlider,
      effectsLabel,
      graphicsRow,
      graphicsHint
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
    this.lobbyMusicSlider.removeEventListener('input', this.onLobbyMusicInput);
    this.battleMusicSlider.removeEventListener('input', this.onBattleMusicInput);
    this.reducedEffectsToggle.removeEventListener('input', this.onReducedEffectsInput);
    this.graphicsSelect.removeEventListener('change', this.onGraphicsPresetChange);
    this.graphicsSelect.removeEventListener('keydown', this.preventKeySteal);
    this.sensitivitySlider.removeEventListener('keydown', this.preventKeySteal);
    this.sfxSlider.removeEventListener('keydown', this.preventKeySteal);
    this.lobbyMusicSlider.removeEventListener('keydown', this.preventKeySteal);
    this.battleMusicSlider.removeEventListener('keydown', this.preventKeySteal);
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

  private onLobbyMusicInput = (): void => {
    settings.setLobbyMusicVolume(parseFloat(this.lobbyMusicSlider.value));
    this.updateReadout();
  };

  private onBattleMusicInput = (): void => {
    settings.setBattleMusicVolume(parseFloat(this.battleMusicSlider.value));
    this.updateReadout();
  };

  private onReducedEffectsInput = (): void => {
    settings.setReducedEffects(this.reducedEffectsToggle.checked);
    this.updateReadout();
  };

  private onGraphicsPresetChange = (): void => {
    const preset = this.graphicsSelect.value as GraphicsPreset;
    if (preset === getGraphicsPreset()) return;
    persistGraphicsPreset(preset);
    // Graphics systems (lights, shadows, post-processing, materials) are built once when the scene is
    // constructed, so the swap takes effect on a fresh scene — reload to apply cleanly.
    window.location.reload();
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
    this.lobbyMusicReadout.textContent = `${Math.round(settings.lobbyMusicVolume * 100)}%`;
    this.battleMusicReadout.textContent = `${Math.round(settings.battleMusicVolume * 100)}%`;
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
