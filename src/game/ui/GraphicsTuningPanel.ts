/**
 * Opt-in LIVE graphics tuning panel for the Polished mode (plan: dreamy-chasing-quokka, Phase 0).
 *
 * The historical graphics-overhaul failure was tune-by-reload; this panel is the countermeasure:
 * every slider drives the live rendering handles (scene image processing, lights, shadow generator —
 * later phases append mirror/SSAO/glow/sandbox controls) the moment it moves, and the values persist
 * as POLISHED_CONFIG overrides (see graphicsTuning.ts). When a look is final, "Log baked JSON" prints
 * the fully-resolved config to the console for baking back into POLISHED_CONFIG.
 *
 * Gated: constructed by ArenaScene only in Polished mode, when either the persisted
 * "Dev graphics tuning" setting is enabled (including live/public builds) or the legacy graphics
 * debug flag is set for automation. Marked data-no-lock so interacting with it doesn't grab pointer
 * lock (InputManager).
 */

import type { Scene } from '@babylonjs/core';
import { getPolishedHandles } from '../effects/PolishedGraphics';
import { getGymFloorMirror } from '../map/GymFloorMirror';
import { type PolishedConfig } from '../config/graphicsConfig';
import {
  clearTuningOverrides,
  loadTuningOverrides,
  resolvePolishedConfig,
  saveTuningOverrides,
  type PolishedConfigOverrides
} from '../config/graphicsTuning';

interface SliderDef {
  label: string;
  min: number;
  max: number;
  step: number;
  /** Current value from a freshly-resolved config. */
  read(cfg: PolishedConfig): number;
  /** Push the value onto the live scene/handles immediately. */
  apply(value: number, scene: Scene): void;
  /** Record the value into the persisted overrides object. */
  write(overrides: PolishedConfigOverrides, value: number): void;
}

/** Phase 0 slider set — later phases push more defs here as their systems land. */
function sliderDefs(): SliderDef[] {
  return [
    {
      label: 'Exposure',
      min: 0.6, max: 1.8, step: 0.01,
      read: (c) => c.imageProcessing.exposure,
      apply: (v, scene) => { scene.imageProcessingConfiguration.exposure = v; },
      write: (o, v) => { (o.imageProcessing ??= {}).exposure = v; }
    },
    {
      label: 'Contrast',
      min: 0.8, max: 1.4, step: 0.01,
      read: (c) => c.imageProcessing.contrast,
      apply: (v, scene) => { scene.imageProcessingConfiguration.contrast = v; },
      write: (o, v) => { (o.imageProcessing ??= {}).contrast = v; }
    },
    {
      label: 'Hemi fill',
      min: 0, max: 1.5, step: 0.01,
      read: (c) => c.lights.hemi.intensity,
      apply: (v) => { const h = getPolishedHandles().hemi; if (h) h.intensity = v; },
      write: (o, v) => { ((o.lights ??= {}).hemi ??= {}).intensity = v; }
    },
    {
      label: 'Key light',
      min: 0, max: 2, step: 0.01,
      read: (c) => c.lights.key.intensity,
      apply: (v) => { const k = getPolishedHandles().key; if (k) k.intensity = v; },
      write: (o, v) => { ((o.lights ??= {}).key ??= {}).intensity = v; }
    },
    {
      label: 'Shadow darkness',
      min: 0, max: 1, step: 0.01,
      read: (c) => c.shadows.darkness,
      apply: (v) => { getPolishedHandles().shadowGenerator?.setDarkness(v); },
      write: (o, v) => { (o.shadows ??= {}).darkness = v; }
    },
    {
      label: 'Shadow bias (×1000)',
      min: 0, max: 10, step: 0.1,
      read: (c) => c.shadows.bias * 1000,
      apply: (v) => { const g = getPolishedHandles().shadowGenerator; if (g) g.bias = v / 1000; },
      write: (o, v) => { (o.shadows ??= {}).bias = v / 1000; }
    },
    {
      label: 'Shadow normalBias (×100)',
      min: 0, max: 10, step: 0.1,
      read: (c) => c.shadows.normalBias * 100,
      apply: (v) => { const g = getPolishedHandles().shadowGenerator; if (g) g.normalBias = v / 100; },
      write: (o, v) => { (o.shadows ??= {}).normalBias = v / 100; }
    },
    {
      label: 'Mirror level',
      min: 0, max: 1, step: 0.01,
      read: (c) => c.mirror.floorEnvironmentIntensity,
      apply: (v, scene) => {
        const floor = scene.getMaterialByName('floor_material');
        if (floor && 'environmentIntensity' in floor) (floor as { environmentIntensity: number }).environmentIntensity = v;
      },
      write: (o, v) => { (o.mirror ??= {}).floorEnvironmentIntensity = v; }
    },
    {
      label: 'Mirror blur',
      min: 0, max: 96, step: 1,
      read: (c) => c.mirror.blurKernel,
      apply: (v) => { const m = getGymFloorMirror(); if (m) m.blurKernel = v; },
      write: (o, v) => { (o.mirror ??= {}).blurKernel = v; }
    },
    {
      // Direct-light specular on the floor — the camera-following highlight blobs. Near-zero by
      // default (the mirror owns the floor's shine); raise only if a hot polish glint is wanted.
      label: 'Floor specular',
      min: 0, max: 1, step: 0.01,
      read: (c) => c.mirror.floorSpecularIntensity,
      apply: (v, scene) => {
        const floor = scene.getMaterialByName('floor_material');
        if (floor && 'specularIntensity' in floor) (floor as { specularIntensity: number }).specularIntensity = v;
      },
      write: (o, v) => { (o.mirror ??= {}).floorSpecularIntensity = v; }
    }
  ];
}

export class GraphicsTuningPanel {
  private readonly root: HTMLDivElement;
  private overrides: PolishedConfigOverrides = loadTuningOverrides();
  private readonly rows: { def: SliderDef; input: HTMLInputElement; readout: HTMLSpanElement }[] = [];

  constructor(private readonly scene: Scene, parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'graphics-tuning-panel'; // stable id: the screenshot harness hides it in captures
    this.root.setAttribute('data-no-lock', '');
    Object.assign(this.root.style, {
      position: 'fixed', top: '12px', left: '12px', zIndex: '60',
      background: 'rgba(10, 14, 30, 0.92)', border: '1px solid rgba(120, 160, 255, 0.4)',
      borderRadius: '10px', padding: '10px 12px', width: '250px',
      font: '12px/1.45 system-ui, sans-serif', color: '#dfe7ff', pointerEvents: 'auto'
    } satisfies Partial<CSSStyleDeclaration>);

    const title = document.createElement('div');
    title.textContent = 'GRAPHICS TUNING (dev)';
    Object.assign(title.style, { fontWeight: '700', letterSpacing: '0.06em', marginBottom: '6px', color: '#9fc0ff' });
    this.root.appendChild(title);

    const cfg = resolvePolishedConfig();
    for (const def of sliderDefs()) this.addSlider(def, cfg);

    const buttons = document.createElement('div');
    Object.assign(buttons.style, { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' });
    buttons.append(
      this.button('Save', () => { saveTuningOverrides(this.overrides); this.flash('saved'); }),
      this.button('Reset', () => this.resetAll()),
      this.button('Log baked JSON', () => {
        // The full resolved config — copy this straight into POLISHED_CONFIG when the look is final.
        console.log('[graphics-tuning] baked POLISHED_CONFIG:\n' + JSON.stringify(resolvePolishedConfig(), null, 2));
        this.flash('logged to console');
      })
    );
    this.root.appendChild(buttons);

    this.status = document.createElement('div');
    Object.assign(this.status.style, { marginTop: '6px', minHeight: '14px', color: '#8fd6a8' });
    this.root.appendChild(this.status);

    parent.appendChild(this.root);
    // Re-apply any persisted overrides onto the live handles once, so a reload resumes the session.
    this.applyAll(resolvePolishedConfig());
  }

  private status!: HTMLDivElement;

  dispose(): void {
    this.root.remove();
  }

  private addSlider(def: SliderDef, cfg: PolishedConfig): void {
    const row = document.createElement('label');
    Object.assign(row.style, { display: 'block', margin: '5px 0' });
    const head = document.createElement('div');
    Object.assign(head.style, { display: 'flex', justifyContent: 'space-between' });
    const name = document.createElement('span');
    name.textContent = def.label;
    const readout = document.createElement('span');
    readout.style.color = '#ffd479';
    head.append(name, readout);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(def.read(cfg));
    input.style.width = '100%';
    input.addEventListener('keydown', (e) => e.preventDefault()); // never steal game keys
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      readout.textContent = v.toFixed(2);
      def.apply(v, this.scene);
      def.write(this.overrides, v);
    });
    readout.textContent = parseFloat(input.value).toFixed(2);

    row.append(head, input);
    this.root.appendChild(row);
    this.rows.push({ def, input, readout });
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    Object.assign(b.style, {
      background: 'rgba(90, 130, 255, 0.2)', color: '#cfe0ff', border: '1px solid rgba(120,160,255,0.5)',
      borderRadius: '6px', padding: '3px 8px', cursor: 'pointer', font: 'inherit'
    });
    b.addEventListener('click', onClick);
    return b;
  }

  /** Clear overrides and snap sliders + live handles back to the compiled POLISHED_CONFIG. */
  private resetAll(): void {
    clearTuningOverrides();
    this.overrides = {};
    const cfg = resolvePolishedConfig();
    for (const { def, input, readout } of this.rows) {
      const v = def.read(cfg);
      input.value = String(v);
      readout.textContent = v.toFixed(2);
      def.apply(v, this.scene);
    }
    this.flash('reset to compiled values');
  }

  /** Push every slider's config value onto the live handles (used once at construction). */
  private applyAll(cfg: PolishedConfig): void {
    for (const { def } of this.rows) def.apply(def.read(cfg), this.scene);
  }

  private flash(message: string): void {
    this.status.textContent = message;
    window.setTimeout(() => { if (this.status.textContent === message) this.status.textContent = ''; }, 1600);
  }
}
