/**
 * Creator Sandbox — local editor DOM UI.
 *
 * A single compact right-side toolbar (mode bar, module palette, selected-object inspector, grid/snap
 * panel) plus a build-controls help line, a transient toast, an entry prompt, and the password modal.
 * All plain DOM appended to #hud-root — it never touches the multiplayer scoreboard / overlay. Marked
 * `data-no-lock` so clicks don't grab pointer lock. Driven through the CreatorBridge implemented by the
 * editor; the UI holds no layout/scene state of its own.
 */

import {
  CREATOR_MATERIALS,
  CREATOR_MODULES,
  CreatorLayoutObject,
  CreatorObjectMetadata,
  moduleDef,
  objectDimensions,
  type CreatorModuleCategory
} from './CreatorLayout';

export interface CreatorSnapSettings {
  gridSnap: boolean;
  gridSize: number;
  rotationSnapDeg: number;
  scaleSnap: number;
  showGrid: boolean;
  showTriggers: boolean;
  showCollision: boolean;
  gizmo: 'move' | 'rotate' | 'scale' | 'off';
}

/** Everything the UI needs from the editor. The editor (CreatorEditor) implements this. */
export interface CreatorBridge {
  getMode(): 'build' | 'playtest';
  setMode(mode: 'build' | 'playtest'): void;

  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;

  quickSave(): void;
  quickLoad(): void;
  exportJson(): void;
  copyJson(): void;
  importJsonFile(file: File): void;
  resetLayout(): void;

  resetPlayer(): void;
  exitCreator(): void;
  lockCreator(): void;

  armModule(type: string | null): void;
  getArmedModule(): string | null;
  focusSelected(): void;

  getSelectedObject(): CreatorLayoutObject | null;
  setSelectedName(name: string): void;
  setSelectedTransform(field: 'position' | 'rotation', axis: 0 | 1 | 2, value: number): void;
  setSelectedDimension(axis: 0 | 1 | 2, value: number): void;
  setSelectedMaterial(id: string): void;
  setSelectedCollision(value: boolean): void;
  setSelectedVisible(value: boolean): void;
  setSelectedMetadata(patch: Partial<CreatorObjectMetadata>): void;
  duplicateSelected(): void;
  deleteSelected(): void;
  resetSelectedTransform(): void;

  getSnapSettings(): CreatorSnapSettings;
  setSnapSettings(patch: Partial<CreatorSnapSettings>): void;
}

const CATEGORY_LABELS: Record<CreatorModuleCategory, string> = {
  terrain: 'Terrain / Structure',
  marker: 'Course Markers',
  optional: 'Optional Markers'
};

export class CreatorUI {
  private readonly host: HTMLElement;
  private readonly toolbar: HTMLDivElement;
  private readonly modeBar: HTMLDivElement;
  private readonly hotbar: HTMLDivElement;
  private readonly inspectorEl: HTMLDivElement;
  private readonly snapEl: HTMLDivElement;
  private readonly helpEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private readonly entryPrompt: HTMLDivElement;
  private readonly entryFill: HTMLDivElement;
  private readonly modal: HTMLDivElement;
  private readonly modalMessage: HTMLDivElement;
  private readonly modalInput: HTMLInputElement;
  private readonly fileInput: HTMLInputElement;

  private readonly paletteButtons = new Map<string, HTMLButtonElement>();
  private readonly gizmoButtons = new Map<string, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private buildBtn!: HTMLButtonElement;
  private playtestBtn!: HTMLButtonElement;

  private inspectorObjectId: string | null = null;
  private toolbarVisible = false;
  private toastTimer: number | null = null;
  private modalSubmit: ((value: string) => void) | null = null;
  private modalCancel: (() => void) | null = null;
  // Don't focus the password field while gameplay keys (E / WASD / jump…) are still physically held
  // from opening the modal — otherwise the held key auto-repeats straight into the field. Mirrors the
  // matchmaking portal's "wait for interact release before focusing the name input" handling.
  private awaitingModalFocus = false;
  private readonly modalHeldKeys = new Set<string>();
  private modalFocusFallbackTimer: number | null = null;

  constructor(hostRoot: HTMLElement, private readonly bridge: CreatorBridge) {
    this.host = hostRoot;

    this.toolbar = el('div', 'creator-ui');
    this.toolbar.setAttribute('data-no-lock', '');
    this.modeBar = el('div', 'creator-modebar');
    this.inspectorEl = el('div', 'creator-section creator-inspector');
    this.snapEl = el('div', 'creator-section creator-snap');
    this.helpEl = el('div', 'creator-help');
    // Bottom hotbar (Fortnite-style): the clickable + keybindable tool/module strip.
    this.hotbar = el('div', 'creator-hotbar');
    this.hotbar.setAttribute('data-no-lock', '');

    this.buildModeBar();
    this.buildHotbar();
    this.buildSnapPanel();

    this.toolbar.append(this.modeBar, this.inspectorEl, this.snapEl, this.helpEl);
    this.host.appendChild(this.toolbar);
    this.host.appendChild(this.hotbar);

    this.toastEl = el('div', 'creator-toast');
    this.host.appendChild(this.toastEl);

    this.entryPrompt = el('div', 'creator-entry-prompt');
    this.entryPrompt.innerHTML =
      '<div class="creator-entry-title">CREATOR SANDBOX</div>' +
      '<div class="creator-entry-sub">Developer Layout Editor</div>' +
      '<div class="creator-entry-hint"><span class="key">E</span> hold to open</div>' +
      '<div class="creator-entry-bar"><div></div></div>';
    this.entryFill = this.entryPrompt.querySelector('.creator-entry-bar > div') as HTMLDivElement;
    this.host.appendChild(this.entryPrompt);

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.style.display = 'none';
    this.fileInput.setAttribute('data-no-lock', '');
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) this.bridge.importJsonFile(file);
      this.fileInput.value = '';
    });
    this.host.appendChild(this.fileInput);

    // --- Password modal ---
    this.modal = el('div', 'creator-modal-backdrop');
    this.modal.setAttribute('data-no-lock', '');
    const card = el('div', 'creator-modal');
    const title = el('div', 'creator-modal-title');
    title.textContent = 'Creator Access';
    this.modalMessage = el('div', 'creator-modal-message');
    this.modalInput = document.createElement('input');
    this.modalInput.type = 'password';
    this.modalInput.className = 'creator-modal-input';
    this.modalInput.autocomplete = 'off';
    this.modalInput.setAttribute('aria-label', 'Developer password');
    this.modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitModal();
      if (e.key === 'Escape') this.cancelModal();
    });
    const actions = el('div', 'creator-modal-actions');
    const cancelBtn = button('Cancel', 'creator-btn', () => this.cancelModal());
    const enterBtn = button('Enter', 'creator-btn creator-btn-primary', () => this.submitModal());
    actions.append(cancelBtn, enterBtn);
    card.append(title, this.modalInput, this.modalMessage, actions);
    this.modal.appendChild(card);
    this.host.appendChild(this.modal);

    this.setToolbarVisible(false);
    this.setEntryPromptVisible(false, 0);
    this.refresh();
  }

  // ---------------------------------------------------------------------------------------------
  // Mode bar
  // ---------------------------------------------------------------------------------------------

  private buildModeBar(): void {
    this.buildBtn = button('Build', 'creator-btn creator-mode-btn', () => this.bridge.setMode('build'));
    this.playtestBtn = button('Playtest', 'creator-btn creator-mode-btn', () => this.bridge.setMode('playtest'));
    const modeGroup = el('div', 'creator-mode-group');
    modeGroup.append(this.buildBtn, this.playtestBtn);

    this.undoBtn = button('Undo', 'creator-btn', () => this.bridge.undo());
    this.redoBtn = button('Redo', 'creator-btn', () => this.bridge.redo());

    const row1 = el('div', 'creator-modebar-row');
    row1.append(
      modeGroup,
      button('Save', 'creator-btn', () => this.bridge.quickSave()),
      button('Load', 'creator-btn', () => this.bridge.quickLoad())
    );
    const row2 = el('div', 'creator-modebar-row');
    row2.append(
      button('Export', 'creator-btn', () => this.bridge.exportJson()),
      button('Copy JSON', 'creator-btn', () => this.bridge.copyJson()),
      button('Import', 'creator-btn', () => this.fileInput.click()),
      this.undoBtn,
      this.redoBtn
    );
    const row3 = el('div', 'creator-modebar-row');
    row3.append(
      button('Reset Player', 'creator-btn', () => this.bridge.resetPlayer()),
      button('Reset Layout', 'creator-btn creator-btn-warn', () => this.bridge.resetLayout())
    );
    const row4 = el('div', 'creator-modebar-row');
    row4.append(
      button('Exit Creator', 'creator-btn', () => this.bridge.exitCreator()),
      button('Lock Creator', 'creator-btn creator-btn-warn', () => this.bridge.lockCreator())
    );
    this.modeBar.append(row1, row2, row3, row4);
  }

  // ---------------------------------------------------------------------------------------------
  // Bottom hotbar: tools cluster + module strip (Fortnite-style, clickable + keybindable)
  // ---------------------------------------------------------------------------------------------

  private buildHotbar(): void {
    // --- Tools cluster (gizmo modes + grid snap), each with its keybind ---
    const tools = el('div', 'creator-hotbar-tools');
    const toolDefs: Array<[string, string, CreatorSnapSettings['gizmo']]> = [
      ['Move', 'G', 'move'],
      ['Rotate', 'R', 'rotate'],
      ['Scale', 'T', 'scale'],
      ['Select', 'V', 'off']
    ];
    for (const [label, key, gizmo] of toolDefs) {
      const btn = this.hotbarButton(label, key, () => this.bridge.setSnapSettings({ gizmo }));
      this.gizmoButtons.set(gizmo, btn);
      tools.appendChild(btn);
    }
    tools.appendChild(this.hotbarButton('Focus', 'F', () => this.bridge.focusSelected()));
    this.hotbar.appendChild(tools);

    // --- Module strip, grouped, with number badges on the first ten ---
    const strip = el('div', 'creator-hotbar-strip');
    for (const category of ['terrain', 'marker', 'optional'] as CreatorModuleCategory[]) {
      const group = el('div', 'creator-hotbar-group');
      const groupTitle = el('div', 'creator-hotbar-grouptitle');
      groupTitle.textContent = CATEGORY_LABELS[category];
      group.appendChild(groupTitle);
      const chips = el('div', 'creator-hotbar-chips');
      for (const mod of CREATOR_MODULES.filter((m) => m.category === category)) {
        const globalIdx = CREATOR_MODULES.indexOf(mod);
        const keyBadge = globalIdx < 10 ? String((globalIdx + 1) % 10) : '';
        const btn = button('', 'creator-chip', () => {
          const armed = this.bridge.getArmedModule() === mod.type ? null : mod.type;
          this.bridge.armModule(armed);
          this.refreshPaletteArmed();
        });
        if (keyBadge) {
          const badge = el('span', 'creator-chip-key');
          badge.textContent = keyBadge;
          btn.appendChild(badge);
        }
        const labelSpan = el('span', 'creator-chip-label');
        labelSpan.textContent = mod.label;
        btn.appendChild(labelSpan);
        this.paletteButtons.set(mod.type, btn);
        chips.appendChild(btn);
      }
      group.appendChild(chips);
      strip.appendChild(group);
    }
    this.hotbar.appendChild(strip);
  }

  private hotbarButton(label: string, key: string, onClick: () => void, keyOnly = false): HTMLButtonElement {
    const btn = button('', `creator-hotbar-tool${keyOnly ? ' creator-hotbar-tool--keyonly' : ''}`, onClick);
    const badge = el('span', 'creator-chip-key');
    badge.textContent = key;
    const labelSpan = el('span', 'creator-chip-label');
    labelSpan.textContent = label;
    btn.append(badge, labelSpan);
    return btn;
  }

  private refreshPaletteArmed(): void {
    const armed = this.bridge.getArmedModule();
    for (const [type, btn] of this.paletteButtons) {
      btn.classList.toggle('creator-chip--armed', type === armed);
    }
    const gizmo = this.bridge.getSnapSettings().gizmo;
    for (const [mode, btn] of this.gizmoButtons) {
      btn.classList.toggle('creator-hotbar-tool--active', mode === gizmo);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Inspector (selected object)
  // ---------------------------------------------------------------------------------------------

  private buildInspector(obj: CreatorLayoutObject | null): void {
    this.inspectorEl.innerHTML = '';
    const header = el('div', 'creator-section-title');
    header.textContent = 'Selected Object';
    this.inspectorEl.appendChild(header);

    if (!obj) {
      const empty = el('div', 'creator-empty');
      empty.textContent = 'Nothing selected. Click an object in Build Mode, or pick a module and click to place.';
      this.inspectorEl.appendChild(empty);
      this.inspectorObjectId = null;
      return;
    }
    this.inspectorObjectId = obj.id;
    const def = moduleDef(obj.type);

    // Name + type
    const nameRow = el('div', 'creator-field');
    nameRow.appendChild(label('Name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'creator-text';
    nameInput.value = obj.name ?? '';
    nameInput.addEventListener('change', () => this.bridge.setSelectedName(nameInput.value));
    nameRow.appendChild(nameInput);
    this.inspectorEl.appendChild(nameRow);

    const typeRow = el('div', 'creator-field');
    typeRow.appendChild(label('Type'));
    const typeVal = el('div', 'creator-readonly');
    typeVal.textContent = def?.label ?? obj.type;
    typeRow.appendChild(typeVal);
    this.inspectorEl.appendChild(typeRow);

    // Position
    this.inspectorEl.appendChild(this.vectorRow('Position', obj.position, 1, (axis, v) => this.bridge.setSelectedTransform('position', axis, v)));
    // Rotation (degrees)
    this.inspectorEl.appendChild(this.vectorRow('Rotation°', obj.rotation, this.bridge.getSnapSettings().rotationSnapDeg, (axis, v) => this.bridge.setSelectedTransform('rotation', axis, v)));
    // Size (dimensions)
    const dims = objectDimensions(obj);
    this.inspectorEl.appendChild(this.vectorRow('Size (W,H,D)', dims, this.bridge.getSnapSettings().gridSize, (axis, v) => this.bridge.setSelectedDimension(axis, v)));

    // Material
    const matRow = el('div', 'creator-field');
    matRow.appendChild(label('Material'));
    const matSel = document.createElement('select');
    matSel.className = 'creator-select';
    for (const m of CREATOR_MATERIALS) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      matSel.appendChild(opt);
    }
    matSel.value = obj.material ?? def?.material ?? 'concrete';
    matSel.addEventListener('change', () => this.bridge.setSelectedMaterial(matSel.value));
    matRow.appendChild(matSel);
    this.inspectorEl.appendChild(matRow);

    // Collision + visible toggles
    const toggles = el('div', 'creator-field-row');
    toggles.append(
      this.checkbox('Collision', obj.collision !== false, (v) => this.bridge.setSelectedCollision(v)),
      this.checkbox('Visible', obj.visible !== false, (v) => this.bridge.setSelectedVisible(v))
    );
    this.inspectorEl.appendChild(toggles);

    // Marker-specific metadata
    if (def && def.category !== 'terrain') {
      this.buildMarkerMeta(obj);
    }

    // Action buttons
    const actions = el('div', 'creator-field-row');
    actions.append(
      button('Duplicate', 'creator-btn', () => this.bridge.duplicateSelected()),
      button('Reset T', 'creator-btn', () => this.bridge.resetSelectedTransform()),
      button('Delete', 'creator-btn creator-btn-warn', () => this.bridge.deleteSelected())
    );
    this.inspectorEl.appendChild(actions);
  }

  private buildMarkerMeta(obj: CreatorLayoutObject): void {
    const meta = obj.metadata ?? {};
    const wrap = el('div', 'creator-meta');

    const labelRow = el('div', 'creator-field');
    labelRow.appendChild(label('Label / Text'));
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'creator-text';
    labelInput.value = meta.label ?? '';
    labelInput.addEventListener('change', () => this.bridge.setSelectedMetadata({ label: labelInput.value }));
    labelRow.appendChild(labelInput);
    wrap.appendChild(labelRow);

    if (obj.type === 'spawn_point') {
      wrap.appendChild(this.checkbox('Default Spawn', !!meta.defaultSpawn, (v) => this.bridge.setSelectedMetadata({ defaultSpawn: v })));
    }

    if (obj.type === 'checkpoint_gate' || obj.type === 'finish_gate' || obj.type === 'start_pad') {
      // Trigger type
      const trigRow = el('div', 'creator-field');
      trigRow.appendChild(label('Trigger'));
      const sel = document.createElement('select');
      sel.className = 'creator-select';
      for (const t of ['none', 'start', 'checkpoint', 'finish']) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        sel.appendChild(opt);
      }
      sel.value = meta.triggerType ?? 'none';
      sel.addEventListener('change', () => this.bridge.setSelectedMetadata({ triggerType: sel.value as CreatorObjectMetadata['triggerType'] }));
      trigRow.appendChild(sel);
      wrap.appendChild(trigRow);

      const trig = meta.trigger ?? { width: 4, height: 4, depth: 4 };
      wrap.appendChild(
        this.vectorRow('Trigger (W,H,D)', [trig.width, trig.height, trig.depth], 0.5, (axis, v) => {
          const next = { ...(this.bridge.getSelectedObject()?.metadata?.trigger ?? trig) };
          if (axis === 0) next.width = v;
          else if (axis === 1) next.height = v;
          else next.depth = v;
          this.bridge.setSelectedMetadata({ trigger: next });
        })
      );

      if (obj.type === 'checkpoint_gate') {
        const cpRow = el('div', 'creator-field');
        cpRow.appendChild(label('Checkpoint #'));
        cpRow.appendChild(this.numberInput(meta.checkpointOrder ?? 1, 1, (v) => this.bridge.setSelectedMetadata({ checkpointOrder: Math.round(v) })));
        wrap.appendChild(cpRow);
      }
    }

    this.inspectorEl.appendChild(wrap);
  }

  // ---------------------------------------------------------------------------------------------
  // Grid / snap panel
  // ---------------------------------------------------------------------------------------------

  private buildSnapPanel(): void {
    const header = el('div', 'creator-section-title');
    header.textContent = 'Grid & Snapping';
    this.snapEl.appendChild(header);

    const s = this.bridge.getSnapSettings();

    this.snapEl.appendChild(this.checkbox('Grid snap', s.gridSnap, (v) => this.bridge.setSnapSettings({ gridSnap: v })));
    this.snapEl.appendChild(this.selectRow('Grid size', [0.25, 0.5, 1, 2, 5], s.gridSize, (v) => this.bridge.setSnapSettings({ gridSize: v })));
    this.snapEl.appendChild(this.selectRow('Rotation°', [5, 15, 30, 45, 90], s.rotationSnapDeg, (v) => this.bridge.setSnapSettings({ rotationSnapDeg: v })));
    this.snapEl.appendChild(this.selectRow('Scale snap', [0.25, 0.5, 1], s.scaleSnap, (v) => this.bridge.setSnapSettings({ scaleSnap: v })));

    const gizmoRow = el('div', 'creator-field');
    gizmoRow.appendChild(label('Gizmo'));
    const gsel = document.createElement('select');
    gsel.className = 'creator-select';
    for (const g of ['move', 'rotate', 'scale', 'off']) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      gsel.appendChild(opt);
    }
    gsel.value = s.gizmo;
    gsel.addEventListener('change', () => this.bridge.setSnapSettings({ gizmo: gsel.value as CreatorSnapSettings['gizmo'] }));
    gizmoRow.appendChild(gsel);
    this.snapEl.appendChild(gizmoRow);

    const showRow = el('div', 'creator-field-col');
    showRow.append(
      this.checkbox('Show grid', s.showGrid, (v) => this.bridge.setSnapSettings({ showGrid: v })),
      this.checkbox('Show trigger bounds', s.showTriggers, (v) => this.bridge.setSnapSettings({ showTriggers: v })),
      this.checkbox('Show collision bounds', s.showCollision, (v) => this.bridge.setSnapSettings({ showCollision: v }))
    );
    this.snapEl.appendChild(showRow);
  }

  // ---------------------------------------------------------------------------------------------
  // Public refresh / state
  // ---------------------------------------------------------------------------------------------

  refresh(): void {
    const mode = this.bridge.getMode();
    this.toolbar.dataset.mode = mode;
    this.buildBtn.classList.toggle('creator-mode-btn--active', mode === 'build');
    this.playtestBtn.classList.toggle('creator-mode-btn--active', mode === 'playtest');
    this.undoBtn.disabled = !this.bridge.canUndo();
    this.redoBtn.disabled = !this.bridge.canRedo();

    // In playtest, collapse the editing sections to the minimal overlay + hide the build hotbar.
    const editing = mode === 'build';
    this.hotbar.classList.toggle('creator-hotbar--visible', this.toolbarVisible && editing);
    this.inspectorEl.style.display = editing ? '' : 'none';
    this.snapEl.style.display = editing ? '' : 'none';
    this.helpEl.textContent = editing
      ? 'WASD fly · Space/Ctrl up/down · Shift faster · hold RMB look · LMB place/select · RMB-tap cancel · 1–0 pick module · G/R/T/V move/rotate/scale/select · F focus · B duplicate · Del delete · Ctrl+Z/Y undo/redo · Ctrl+S save · F1 playtest'
      : 'Playtest: real movement · F1 return to Build · Reset Player to respawn';

    this.refreshPaletteArmed();
    const selected = this.bridge.getSelectedObject();
    if (editing) {
      if ((selected?.id ?? null) !== this.inspectorObjectId) this.buildInspector(selected);
      else this.syncInspectorValues(selected);
    }
  }

  /** Update existing inspector inputs in place (skip the focused one) — used after gizmo drags. */
  private syncInspectorValues(obj: CreatorLayoutObject | null): void {
    if (!obj) return;
    const active = document.activeElement;
    const dims = objectDimensions(obj);
    const sets: Array<[string, number]> = [
      ['position-0', obj.position[0]], ['position-1', obj.position[1]], ['position-2', obj.position[2]],
      ['rotation-0', obj.rotation[0]], ['rotation-1', obj.rotation[1]], ['rotation-2', obj.rotation[2]],
      ['size-0', dims[0]], ['size-1', dims[1]], ['size-2', dims[2]]
    ];
    for (const [key, value] of sets) {
      const input = this.inspectorEl.querySelector<HTMLInputElement>(`input[data-key="${key}"]`);
      if (input && input !== active) input.value = roundForDisplay(value);
    }
  }

  setToolbarVisible(visible: boolean): void {
    this.toolbarVisible = visible;
    this.toolbar.classList.toggle('creator-ui--visible', visible);
    this.refresh();
  }

  setEntryPromptVisible(visible: boolean, progress: number): void {
    this.entryPrompt.classList.toggle('creator-entry-prompt--visible', visible);
    this.entryFill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('creator-toast--visible');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('creator-toast--visible'), 2600);
  }

  // --- Password modal ---

  openPasswordModal(onSubmit: (value: string) => void, onCancel: () => void): void {
    this.modalSubmit = onSubmit;
    this.modalCancel = onCancel;
    this.modalMessage.textContent = '';
    this.modalInput.value = '';
    this.modal.classList.add('creator-modal-backdrop--visible');

    // Defer focusing until the keys held to open the modal are released (so they don't type into it).
    this.awaitingModalFocus = true;
    this.modalHeldKeys.clear();
    window.addEventListener('keydown', this.onModalFocusKeyDown);
    window.addEventListener('keyup', this.onModalFocusKeyUp);
    // Fallback: if nothing is actually held (keys already released), focus shortly after opening.
    this.modalFocusFallbackTimer = window.setTimeout(() => {
      if (this.awaitingModalFocus && this.modalHeldKeys.size === 0) this.focusModalInput();
    }, 400);
  }

  private readonly onModalFocusKeyDown = (e: KeyboardEvent): void => {
    // Physically-held keys auto-repeat keydown here; track them so we only focus once all are up.
    if (this.awaitingModalFocus && GAMEPLAY_HOLD_CODES.has(e.code)) this.modalHeldKeys.add(e.code);
  };

  private readonly onModalFocusKeyUp = (e: KeyboardEvent): void => {
    if (!this.awaitingModalFocus) return;
    this.modalHeldKeys.delete(e.code);
    if (this.modalHeldKeys.size === 0) this.focusModalInput();
  };

  private focusModalInput(): void {
    if (!this.awaitingModalFocus) return;
    this.stopAwaitingModalFocus();
    this.modalInput.focus();
    this.modalInput.select();
  }

  private stopAwaitingModalFocus(): void {
    this.awaitingModalFocus = false;
    this.modalHeldKeys.clear();
    if (this.modalFocusFallbackTimer !== null) {
      window.clearTimeout(this.modalFocusFallbackTimer);
      this.modalFocusFallbackTimer = null;
    }
    window.removeEventListener('keydown', this.onModalFocusKeyDown);
    window.removeEventListener('keyup', this.onModalFocusKeyUp);
  }

  setModalMessage(message: string): void {
    this.modalMessage.textContent = message;
  }

  closePasswordModal(): void {
    this.stopAwaitingModalFocus();
    this.modal.classList.remove('creator-modal-backdrop--visible');
    this.modalInput.value = '';
    this.modalSubmit = null;
    this.modalCancel = null;
  }

  isModalOpen(): boolean {
    return this.modal.classList.contains('creator-modal-backdrop--visible');
  }

  private submitModal(): void {
    const value = this.modalInput.value;
    this.modalInput.value = '';
    this.modalSubmit?.(value);
  }

  private cancelModal(): void {
    const cancel = this.modalCancel;
    this.closePasswordModal();
    cancel?.();
  }

  dispose(): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.stopAwaitingModalFocus();
    this.toolbar.remove();
    this.hotbar.remove();
    this.toastEl.remove();
    this.entryPrompt.remove();
    this.modal.remove();
    this.fileInput.remove();
  }

  // ---------------------------------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------------------------------

  private vectorRow(labelText: string, values: readonly number[], step: number, onChange: (axis: 0 | 1 | 2, value: number) => void): HTMLDivElement {
    const row = el('div', 'creator-field');
    row.appendChild(label(labelText));
    const group = el('div', 'creator-vec');
    const keyBase = labelText.startsWith('Position') ? 'position' : labelText.startsWith('Rotation') ? 'rotation' : labelText.startsWith('Size') ? 'size' : 'trig';
    (['X', 'Y', 'Z'] as const).forEach((axisLabel, i) => {
      const input = this.numberInput(values[i] ?? 0, step, (v) => onChange(i as 0 | 1 | 2, v));
      input.dataset.key = `${keyBase}-${i}`;
      input.title = axisLabel;
      group.appendChild(input);
    });
    row.appendChild(group);
    return row;
  }

  private numberInput(value: number, step: number, onChange: (value: number) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'creator-number';
    input.step = String(step || 0.1);
    input.value = roundForDisplay(value);
    const commit = () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) onChange(v);
    };
    input.addEventListener('change', commit);
    return input;
  }

  private checkbox(text: string, checked: boolean, onChange: (value: boolean) => void): HTMLLabelElement {
    const wrap = document.createElement('label');
    wrap.className = 'creator-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    const span = document.createElement('span');
    span.textContent = text;
    wrap.append(box, span);
    return wrap;
  }

  private selectRow(labelText: string, options: number[], value: number, onChange: (value: number) => void): HTMLDivElement {
    const row = el('div', 'creator-field');
    row.appendChild(label(labelText));
    const sel = document.createElement('select');
    sel.className = 'creator-select';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = String(o);
      opt.textContent = String(o);
      sel.appendChild(opt);
    }
    sel.value = String(value);
    sel.addEventListener('change', () => onChange(parseFloat(sel.value)));
    row.appendChild(sel);
    return row;
  }
}

// Gameplay keys that might be physically held when the password modal opens (interact + movement);
// the field isn't focused until all of these are released so they can't auto-repeat into it.
const GAMEPLAY_HOLD_CODES = new Set<string>([
  'KeyE', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft', 'ControlRight'
]);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function label(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'creator-label';
  span.textContent = text;
  return span;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

function roundForDisplay(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}
