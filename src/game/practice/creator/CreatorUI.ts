/**
 * Creator Sandbox — local editor DOM UI.
 *
 * A single compact right-side toolbar (mode bar, settings dropdown, selected-object inspector), a
 * bottom module hotbar, a build-controls help line, a transient toast, an entry prompt, and the
 * password modal.
 * All plain DOM appended to #hud-root — it never touches the multiplayer scoreboard / overlay. Marked
 * `data-no-lock` so clicks don't grab pointer lock. Driven through the CreatorBridge implemented by the
 * editor; the UI holds no layout/scene state of its own.
 */

import {
  CREATOR_LABEL_COLORS,
  CREATOR_LABEL_SIZES,
  CREATOR_MATERIALS,
  CREATOR_MODULES,
  CREATOR_TEXTURES,
  CreatorLayoutObject,
  CreatorObjectMetadata,
  moduleDef,
  objectOpacity,
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
  showReplay: boolean;
  gizmo: 'move' | 'rotate' | 'scale' | 'off';
}

/** Everything the UI needs from the editor. The editor (CreatorEditor) implements this. */
export interface CreatorBridge {
  getMode(): 'build' | 'playtest';
  setMode(mode: 'build' | 'playtest'): void;
  togglePlaytestFly(): void;
  isPlaytestFlying(): boolean;

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

  // Movement Course persistence (localStorage-backed; the live course reads it).
  saveToCourse(): void;
  loadFromCourse(): void;
  importToCourseFile(file: File): void;

  // In-editor clipboard (Copy / Paste).
  copySelected(): void;
  paste(): void;
  hasClipboard(): boolean;

  // Outliner (object list).
  listObjects(): CreatorLayoutObject[];
  getSelectedId(): string | null;
  selectObjectById(id: string): void;
  focusObjectById(id: string): void;
  toggleObjectVisibility(id: string): void;
  deleteObjectById(id: string): void;

  // Multi-select.
  toggleSelectObjectById(id: string): void;
  getSelectedIds(): string[];
  selectionCount(): number;

  // Prefabs (saved multi-object assemblies).
  savePrefabFromSelection(): void;
  getPrefabNames(): string[];
  armPrefab(name: string | null): void;
  getArmedPrefabName(): string | null;
  deletePrefab(name: string): void;

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
  setSelectedTexture(id: string | null): void;
  setSelectedCollision(value: boolean): void;
  setSelectedOpacity(value: number): void;
  setSelectedWallrun(value: boolean): void;
  setSelectedMetadata(patch: Partial<CreatorObjectMetadata>): void;
  duplicateSelected(): void;
  deleteSelected(): void;
  destroyAllTestSpawns(): void;
  resetSelectedTransform(): void;

  getSnapSettings(): CreatorSnapSettings;
  setSnapSettings(patch: Partial<CreatorSnapSettings>): void;
}

const CATEGORY_LABELS: Record<CreatorModuleCategory, string> = {
  terrain: 'Terrain / Structure',
  pad: 'Pads & Zones',
  marker: 'Course Markers',
  optional: 'Optional Markers'
};

const LABEL_COLOR_LABELS: Record<string, string> = {
  white: 'White',
  gold: 'Gold',
  blue: 'Blue',
  green: 'Green',
  red: 'Red'
};

const LABEL_SIZE_LABELS: Record<string, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large'
};

export class CreatorUI {
  private readonly host: HTMLElement;
  private readonly toolbar: HTMLDivElement;
  private readonly modeBar: HTMLDivElement;
  private readonly hotbar: HTMLDivElement;
  private readonly inspectorEl: HTMLDivElement;
  private readonly outlinerEl: HTMLDivElement;
  private readonly snapEl: HTMLDivElement;
  private readonly helpEl: HTMLDivElement;
  private readonly playtestBar: HTMLDivElement;
  private playtestFlyBtn!: HTMLButtonElement;
  private readonly toastEl: HTMLDivElement;
  private readonly dragHint: HTMLDivElement;
  private readonly recTimer: HTMLDivElement;
  private readonly entryPrompt: HTMLDivElement;
  private readonly entryFill: HTMLDivElement;
  private readonly modal: HTMLDivElement;
  private readonly modalMessage: HTMLDivElement;
  private readonly modalInput: HTMLInputElement;
  private readonly fileInput: HTMLInputElement;
  private readonly courseFileInput: HTMLInputElement;

  // Outliner (object list) state.
  private outlinerListEl!: HTMLDivElement;
  private outlinerCountEl!: HTMLSpanElement;
  private outlinerSearch!: HTMLInputElement;
  private outlinerFilter = '';
  private outlinerSig = '';
  private outlinerSelectedId: string | null = null;
  private readonly outlinerRows = new Map<string, HTMLDivElement>();

  private readonly paletteButtons = new Map<string, HTMLButtonElement>();
  private readonly gizmoButtons = new Map<string, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private autosaveStatusEl!: HTMLSpanElement;
  private prefabGroupEl!: HTMLDivElement;
  private prefabChipsEl!: HTMLDivElement;
  private prefabSig = '';
  private hotbarUndoBtn!: HTMLButtonElement;
  private hotbarRedoBtn!: HTMLButtonElement;
  private buildBtn!: HTMLButtonElement;
  private playtestBtn!: HTMLButtonElement;
  private settingsBtn!: HTMLButtonElement;
  private settingsDropdown!: HTMLDivElement;
  private gameSettingsHost!: HTMLDivElement;

  private inspectorObjectId: string | null = null;
  // Non-numeric state of the inspected object (material/texture/toggles/metadata…). When it changes
  // (e.g. via undo/redo) the inspector is REBUILT — the in-place sync only covers the number inputs,
  // so without this the dropdowns/checkboxes would show stale values.
  private inspectorSig = '';
  private toolbarVisible = false;
  private settingsOpen = false;
  private toastTimer: number | null = null;
  private saveIndicatorEl!: HTMLDivElement;
  private saveIndicatorTimer: number | null = null;
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
    this.outlinerEl = el('div', 'creator-section creator-outliner');
    this.snapEl = el('div', 'creator-section creator-snap');
    this.helpEl = el('div', 'creator-help');
    // Bottom hotbar (Fortnite-style): the clickable + keybindable tool/module strip.
    this.hotbar = el('div', 'creator-hotbar');
    this.hotbar.setAttribute('data-no-lock', '');

    this.playtestBar = el('div', 'creator-playtest-bar');
    this.playtestBar.setAttribute('data-no-lock', '');

    this.buildModeBar();
    this.buildHotbar();
    this.buildOutliner();
    this.buildSnapPanel();
    this.buildPlaytestBar();

    this.toolbar.append(this.modeBar, this.inspectorEl, this.outlinerEl, this.helpEl);
    this.host.appendChild(this.toolbar);
    this.host.appendChild(this.hotbar);
    this.host.appendChild(this.playtestBar);

    this.toastEl = el('div', 'creator-toast');
    this.host.appendChild(this.toastEl);

    // Small top-centre "Autosaved"/"Saved" flash — quiet feedback for the constant auto/quick
    // saves; the loud toast is reserved for failures and real mode/state changes.
    this.saveIndicatorEl = el('div', 'creator-save-indicator');
    this.host.appendChild(this.saveIndicatorEl);

    this.dragHint = el('div', 'creator-drag-hint');
    this.dragHint.textContent = '🖱️ Scroll — push / pull distance';
    this.host.appendChild(this.dragHint);

    // Playtest run-recording indicator (top-left, clear of the toolbar/HUD). Press 7 to start/stop.
    this.recTimer = el('div', 'creator-rec-timer');
    this.host.appendChild(this.recTimer);

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

    // Separate hidden file input for "Import to Course" (upload a layout straight into the live course).
    this.courseFileInput = document.createElement('input');
    this.courseFileInput.type = 'file';
    this.courseFileInput.accept = 'application/json,.json';
    this.courseFileInput.style.display = 'none';
    this.courseFileInput.setAttribute('data-no-lock', '');
    this.courseFileInput.addEventListener('change', () => {
      const file = this.courseFileInput.files?.[0];
      if (file) this.bridge.importToCourseFile(file);
      this.courseFileInput.value = '';
    });
    this.host.appendChild(this.courseFileInput);

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
    this.settingsBtn = button('Settings +', 'creator-btn creator-settings-toggle', () => this.setSettingsOpen(!this.settingsOpen));
    this.settingsBtn.setAttribute('aria-expanded', 'false');
    this.settingsBtn.setAttribute('aria-haspopup', 'true');
    this.settingsDropdown = el('div', 'creator-settings-dropdown');

    // Autosave trust signal: "Autosaved HH:MM:SS" (or "Autosave unavailable"), driven by the editor.
    this.autosaveStatusEl = document.createElement('span');
    this.autosaveStatusEl.className = 'creator-autosave-status';

    const row1 = el('div', 'creator-modebar-row creator-modebar-row--primary');
    row1.append(
      modeGroup,
      button('Save', 'creator-btn', () => this.bridge.quickSave()),
      this.autosaveStatusEl,
      this.settingsBtn
    );
    // Always-visible headline row: download a layout file + publish to the live Movement Course.
    const shareRow = el('div', 'creator-modebar-row');
    shareRow.append(
      button('⤓ Export File', 'creator-btn creator-btn-primary', () => this.bridge.exportJson()),
      button('★ Save to Course', 'creator-btn creator-btn-primary', () => this.bridge.saveToCourse())
    );

    const loadRow = el('div', 'creator-modebar-row');
    loadRow.append(button('Load', 'creator-btn', () => this.bridge.quickLoad()));
    const row2 = el('div', 'creator-modebar-row');
    row2.append(
      button('Copy JSON', 'creator-btn', () => this.bridge.copyJson()),
      button('Import File', 'creator-btn', () => this.fileInput.click()),
      this.undoBtn,
      this.redoBtn
    );
    // Movement Course persistence (localStorage; survives reloads, even on the web).
    const courseRow = el('div', 'creator-modebar-row');
    courseRow.append(
      button('Load Course', 'creator-btn', () => this.bridge.loadFromCourse()),
      button('Import to Course', 'creator-btn', () => this.courseFileInput.click())
    );
    const row3 = el('div', 'creator-modebar-row');
    row3.append(
      button('Reset Player', 'creator-btn', () => this.bridge.resetPlayer()),
      button('Revert to Default Map', 'creator-btn creator-btn-warn', () => this.bridge.resetLayout())
    );
    const row4 = el('div', 'creator-modebar-row');
    row4.append(
      button('Exit Creator', 'creator-btn', () => this.bridge.exitCreator()),
      button('Lock Creator', 'creator-btn creator-btn-warn', () => this.bridge.lockCreator())
    );
    // The game's floating SettingsPanel docks in here while the editor is active, so the two
    // top-right settings surfaces never overlap (see CreatorEditorHooks.setGameSettingsDock).
    this.gameSettingsHost = el('div', 'creator-game-settings');
    this.settingsDropdown.append(loadRow, row2, courseRow, row3, row4, this.snapEl, this.gameSettingsHost);
    this.modeBar.append(row1, shareRow, this.settingsDropdown);
    this.setSettingsOpen(false);
  }

  // ---------------------------------------------------------------------------------------------
  // Playtest quick toolbar: shown only in Playtest — return to Build, or toggle free-fly.
  // ---------------------------------------------------------------------------------------------

  private buildPlaytestBar(): void {
    const buildBtn = button('◀ Build', 'creator-btn creator-btn-primary', () => this.bridge.setMode('build'));
    buildBtn.append(this.keyHint('B'));
    this.playtestFlyBtn = button('✈ Fly', 'creator-btn', () => this.bridge.togglePlaytestFly());
    this.playtestFlyBtn.append(this.keyHint('='));
    const label = el('span', 'creator-playtest-label');
    label.textContent = 'PLAYTEST';
    this.playtestBar.append(label, buildBtn, this.playtestFlyBtn);
  }

  private keyHint(key: string): HTMLSpanElement {
    const badge = el('span', 'creator-chip-key');
    badge.textContent = key;
    return badge;
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
    tools.appendChild(this.hotbarButton('Copy', 'Ctrl+C', () => this.bridge.copySelected()));
    tools.appendChild(this.hotbarButton('Paste', 'Ctrl+V', () => this.bridge.paste()));
    tools.appendChild(this.hotbarButton('Prefab+', '', () => this.bridge.savePrefabFromSelection()));
    this.hotbarUndoBtn = this.hotbarButton('Undo', 'Ctrl+Z', () => this.bridge.undo());
    this.hotbarRedoBtn = this.hotbarButton('Redo', 'Ctrl+Y', () => this.bridge.redo());
    tools.append(this.hotbarUndoBtn, this.hotbarRedoBtn);
    this.hotbar.appendChild(tools);

    // --- Module strip, grouped, with number badges on the first ten ---
    const strip = el('div', 'creator-hotbar-strip');
    for (const category of ['terrain', 'pad', 'marker', 'optional'] as CreatorModuleCategory[]) {
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

    // Prefabs group: user-saved assemblies, refreshed dynamically (see refreshPrefabChips).
    this.prefabGroupEl = el('div', 'creator-hotbar-group');
    const prefabTitle = el('div', 'creator-hotbar-grouptitle');
    prefabTitle.textContent = 'Prefabs';
    this.prefabChipsEl = el('div', 'creator-hotbar-chips');
    this.prefabGroupEl.append(prefabTitle, this.prefabChipsEl);
    this.prefabGroupEl.style.display = 'none';
    strip.appendChild(this.prefabGroupEl);

    this.hotbar.appendChild(strip);
  }

  /** Rebuild the prefab chips when the library changes; highlight the armed one. */
  private refreshPrefabChips(): void {
    const names = this.bridge.getPrefabNames();
    const armed = this.bridge.getArmedPrefabName();
    const sig = `${names.join('|')}::${armed ?? ''}`;
    if (sig === this.prefabSig) return;
    this.prefabSig = sig;
    this.prefabGroupEl.style.display = names.length > 0 ? '' : 'none';
    this.prefabChipsEl.innerHTML = '';
    for (const name of names) {
      const chip = button('', 'creator-chip', () => this.bridge.armPrefab(name));
      if (name === armed) chip.classList.add('creator-chip--armed');
      const labelSpan = el('span', 'creator-chip-label');
      labelSpan.textContent = name;
      chip.appendChild(labelSpan);
      const del = el('span', 'creator-chip-del');
      del.textContent = '✕';
      del.title = 'Delete prefab';
      del.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also arm the prefab
        this.bridge.deletePrefab(name);
      });
      chip.appendChild(del);
      this.prefabChipsEl.appendChild(chip);
    }
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

    // Texture (real in-game image textures) — applies to solid terrain modules (e.g. a long wall).
    if (def && def.category === 'terrain') {
      const texRow = el('div', 'creator-field');
      texRow.appendChild(label('Texture'));
      const texSel = document.createElement('select');
      texSel.className = 'creator-select';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'None (color)';
      texSel.appendChild(none);
      for (const t of CREATOR_TEXTURES) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        texSel.appendChild(opt);
      }
      texSel.value = obj.texture ?? '';
      texSel.addEventListener('change', () => this.bridge.setSelectedTexture(texSel.value || null));
      texRow.appendChild(texSel);
      this.inspectorEl.appendChild(texRow);
    }

    // Collision + opacity + wallrun controls
    const toggles = el('div', 'creator-field-row');
    toggles.append(
      this.checkbox('Collision', obj.collision !== false, (v) => this.bridge.setSelectedCollision(v)),
      this.checkbox('Wallrun', obj.wallrunEnabled !== false, (v) => this.bridge.setSelectedWallrun(v))
    );
    this.inspectorEl.appendChild(toggles);
    this.inspectorEl.appendChild(this.opacitySlider(objectOpacity(obj), (v) => this.bridge.setSelectedOpacity(v)));

    // Marker-specific metadata
    if (def && def.category !== 'terrain') {
      this.buildMarkerMeta(obj);
    }

    // Moving platform (solid terrain only): toggle + travel/speed/pause fields. The travel path
    // previews in Build; the runtime animates only in Playtest / the live yard.
    if (def && def.category === 'terrain') {
      this.buildMoverMeta(obj);
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

  private buildMoverMeta(obj: CreatorLayoutObject): void {
    const mover = obj.metadata?.mover;
    const wrap = el('div', 'creator-meta');
    wrap.appendChild(
      this.checkbox('Moving platform', !!mover, (v) => {
        this.bridge.setSelectedMetadata({ mover: v ? { dx: 10, dy: 0, dz: 0, speed: 4, pauseSeconds: 0.5 } : undefined });
      })
    );
    if (mover) {
      const patch = (p: Partial<NonNullable<CreatorObjectMetadata['mover']>>) =>
        this.bridge.setSelectedMetadata({ mover: { ...mover, ...p } });
      wrap.append(
        this.compactNumberRow('Move X', mover.dx, 1, (v) => patch({ dx: v })),
        this.compactNumberRow('Move Y', mover.dy, 1, (v) => patch({ dy: v })),
        this.compactNumberRow('Move Z', mover.dz, 1, (v) => patch({ dz: v })),
        this.compactNumberRow('Speed m/s', mover.speed, 0.5, (v) => patch({ speed: v })),
        this.compactNumberRow('Pause s', mover.pauseSeconds, 0.25, (v) => patch({ pauseSeconds: v }))
      );
    }
    this.inspectorEl.appendChild(wrap);
  }

  private buildMarkerMeta(obj: CreatorLayoutObject): void {
    const meta = obj.metadata ?? {};
    const wrap = el('div', 'creator-meta');

    const labelRow = el('div', 'creator-field');
    labelRow.appendChild(label('Label / Text'));
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'creator-text';
    labelInput.placeholder = 'Label';
    labelInput.value = meta.label ?? '';
    labelInput.addEventListener('change', () => this.bridge.setSelectedMetadata({ label: labelInput.value }));
    labelRow.appendChild(labelInput);
    wrap.appendChild(labelRow);

    const labelSettings = el('div', 'creator-label-settings');
    labelSettings.append(
      this.checkbox('Show label', meta.labelVisible !== false, (v) => this.bridge.setSelectedMetadata({ labelVisible: v })),
      this.optionRow('Size', CREATOR_LABEL_SIZES, meta.labelSize ?? 'medium', LABEL_SIZE_LABELS, (v) => {
        this.bridge.setSelectedMetadata({ labelSize: v as CreatorObjectMetadata['labelSize'] });
      }),
      this.optionRow('Color', CREATOR_LABEL_COLORS, meta.labelColor ?? 'white', LABEL_COLOR_LABELS, (v) => {
        this.bridge.setSelectedMetadata({ labelColor: v as CreatorObjectMetadata['labelColor'] });
      }),
      this.compactNumberRow('Height +', meta.labelOffsetY ?? 0, 0.25, (v) => this.bridge.setSelectedMetadata({ labelOffsetY: v }))
    );
    wrap.appendChild(labelSettings);

    if (obj.type === 'spawn_point') {
      wrap.appendChild(this.checkbox('Default Spawn', !!meta.defaultSpawn, (v) => this.bridge.setSelectedMetadata({ defaultSpawn: v })));
    }

    if (obj.type === 'test_spawn') {
      const note = el('div', 'creator-meta-note');
      note.textContent = 'Overrides the main spawn during playtest. The most recently placed Test Spawn wins.';
      wrap.appendChild(note);
      wrap.appendChild(
        this.holdButton('Hold to Destroy All Test Spawns', 'creator-btn creator-btn-warn creator-hold', () => this.bridge.destroyAllTestSpawns())
      );
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

    // Ability-pad power (bounce launch / speed boost). 1 = default; resize the pad itself to change
    // the trigger area. Stamina / backflip pads have no power to tune.
    if (obj.type === 'speed_pad' || obj.type === 'bounce_pad') {
      const powerRow = el('div', 'creator-field');
      powerRow.appendChild(label(obj.type === 'bounce_pad' ? 'Bounce Power ×' : 'Boost Power ×'));
      powerRow.appendChild(this.numberInput(meta.padStrength ?? 1, 0.25, (v) => this.bridge.setSelectedMetadata({ padStrength: v })));
      wrap.appendChild(powerRow);
    }

    this.inspectorEl.appendChild(wrap);
  }

  // ---------------------------------------------------------------------------------------------
  // Outliner (object list) — select / focus / hide / delete any object, incl. hidden or overlapping
  // ones that can't be clicked in the viewport.
  // ---------------------------------------------------------------------------------------------

  private buildOutliner(): void {
    const head = el('div', 'creator-outliner-head');
    const title = el('div', 'creator-section-title');
    title.textContent = 'Objects';
    this.outlinerCountEl = document.createElement('span');
    this.outlinerCountEl.className = 'creator-outliner-count';
    this.outlinerCountEl.textContent = '0';
    head.append(title, this.outlinerCountEl);

    this.outlinerSearch = document.createElement('input');
    this.outlinerSearch.type = 'text';
    this.outlinerSearch.className = 'creator-text creator-outliner-search';
    this.outlinerSearch.placeholder = 'Search objects…';
    this.outlinerSearch.addEventListener('input', () => {
      this.outlinerFilter = this.outlinerSearch.value.trim().toLowerCase();
      this.applyOutlinerFilter();
    });

    this.outlinerListEl = el('div', 'creator-outliner-list');
    this.outlinerEl.append(head, this.outlinerSearch, this.outlinerListEl);
  }

  private refreshOutliner(): void {
    const objs = this.bridge.listObjects();
    const selectedId = this.bridge.getSelectedId();
    const selectedIds = new Set(this.bridge.getSelectedIds());
    this.outlinerCountEl.textContent = String(objs.length);
    // Only rebuild the rows when the structure changes (keeps search focus + scroll position stable).
    const sig = objs.map((o) => `${o.id}:${Math.round(objectOpacity(o) * 100)}:${o.name ?? ''}:${o.type}`).join('|');
    if (sig !== this.outlinerSig) {
      this.outlinerSig = sig;
      this.rebuildOutlinerRows(objs);
    }
    for (const [id, row] of this.outlinerRows) {
      row.classList.toggle('creator-outliner-row--active', selectedIds.has(id));
      row.classList.toggle('creator-outliner-row--primary', id === selectedId);
    }
    // Selecting in the viewport should reveal the object in the (possibly long) list too.
    if (selectedId && selectedId !== this.outlinerSelectedId) {
      this.outlinerRows.get(selectedId)?.scrollIntoView({ block: 'nearest' });
    }
    this.outlinerSelectedId = selectedId;
    this.applyOutlinerFilter();
  }

  private rebuildOutlinerRows(objs: readonly CreatorLayoutObject[]): void {
    this.outlinerListEl.innerHTML = '';
    this.outlinerRows.clear();
    if (objs.length === 0) {
      const empty = el('div', 'creator-empty');
      empty.textContent = 'No objects yet. Pick a module below and click to place.';
      this.outlinerListEl.appendChild(empty);
      return;
    }
    for (const obj of objs) {
      const def = moduleDef(obj.type);
      const text = obj.name || def?.label || obj.type;
      const hidden = objectOpacity(obj) <= 0;
      const row = el('div', 'creator-outliner-row');
      row.dataset.search = text.toLowerCase();

      const eye = button(hidden ? '◌' : '◉', 'creator-outliner-eye', () => this.bridge.toggleObjectVisibility(obj.id));
      eye.title = hidden ? 'Set opacity to 100%' : 'Set opacity to 0%';
      // Shift+click a row toggles the object in/out of the multi-selection (like the viewport).
      const labelBtn = button(text, 'creator-outliner-label', () => {});
      labelBtn.addEventListener('click', (e: MouseEvent) => {
        if (e.shiftKey) this.bridge.toggleSelectObjectById(obj.id);
        else this.bridge.selectObjectById(obj.id);
      });
      labelBtn.title = def?.label ?? obj.type;
      if (hidden) labelBtn.classList.add('creator-outliner-label--hidden');
      const focusBtn = button('✛', 'creator-outliner-mini', () => this.bridge.focusObjectById(obj.id));
      focusBtn.title = 'Focus camera';
      const delBtn = button('✕', 'creator-outliner-mini creator-outliner-del', () => this.bridge.deleteObjectById(obj.id));
      delBtn.title = 'Delete';

      row.append(eye, labelBtn, focusBtn, delBtn);
      this.outlinerListEl.appendChild(row);
      this.outlinerRows.set(obj.id, row);
    }
  }

  private applyOutlinerFilter(): void {
    const f = this.outlinerFilter;
    for (const row of this.outlinerRows.values()) {
      const hay = row.dataset.search ?? '';
      row.style.display = !f || hay.includes(f) ? '' : 'none';
    }
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
      this.checkbox('Show collision bounds', s.showCollision, (v) => this.bridge.setSnapSettings({ showCollision: v })),
      this.checkbox('Show Replay', s.showReplay, (v) => this.bridge.setSnapSettings({ showReplay: v }))
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
    const canUndo = this.bridge.canUndo();
    const canRedo = this.bridge.canRedo();
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
    this.hotbarUndoBtn.disabled = !canUndo;
    this.hotbarRedoBtn.disabled = !canRedo;

    // In playtest, collapse the editing sections to the minimal overlay + hide the build hotbar.
    const editing = mode === 'build';
    // Don't leave the settings dropdown hanging open over the playtest view.
    if (!editing && this.settingsOpen) this.setSettingsOpen(false);
    this.playtestBar.classList.toggle('creator-playtest-bar--visible', this.toolbarVisible && !editing);
    const flying = this.bridge.isPlaytestFlying();
    this.playtestFlyBtn.classList.toggle('creator-mode-btn--active', flying);
    if (this.playtestFlyBtn.firstChild) this.playtestFlyBtn.firstChild.textContent = flying ? '✈ Flying' : '✈ Fly';
    this.hotbar.classList.toggle('creator-hotbar--visible', this.toolbarVisible && editing);
    this.inspectorEl.style.display = editing ? '' : 'none';
    this.outlinerEl.style.display = editing ? '' : 'none';
    this.snapEl.style.display = editing ? '' : 'none';
    this.helpEl.textContent = editing
      ? 'WASD fly · Space/Ctrl up/down · Shift faster · hold RMB look · LMB place preview/select · RMB-tap cancel · 1–0 pick module · wheel swap module (or rotate selected) · R/Shift+R rotate preview · Q/E height · [/ ] scale · C reset preview · G/R/T/V move/rotate/scale/select · arrows/PgUp/PgDn nudge selected · F focus · B duplicate · Ctrl+C/V copy/paste · Del delete · Ctrl+Z/Y undo/redo · Ctrl+S save · F1 playtest'
      : 'PLAYTEST — real movement. B / F1 / Esc → Build · = → free-fly (noclip) · Reset Player to respawn · O → no-cooldown · step on ability pads to trigger them.';

    this.refreshPaletteArmed();
    this.refreshPrefabChips();
    const selected = this.bridge.getSelectedObject();
    const multiCount = this.bridge.selectionCount();
    if (editing && multiCount > 1) {
      // Multi-selection: the inspector stays single-object by design — show the count + the shared
      // group actions instead of per-object fields.
      if (this.inspectorObjectId !== '__multi' || this.inspectorSig !== String(multiCount)) {
        this.inspectorObjectId = '__multi';
        this.inspectorSig = String(multiCount);
        this.buildMultiInspector(multiCount);
      }
      this.refreshOutliner();
    } else if (editing) {
      if (this.inspectorObjectId === '__multi') this.inspectorObjectId = null;
      const sig = selected ? inspectorSignature(selected) : '';
      if ((selected?.id ?? null) !== this.inspectorObjectId) {
        this.inspectorSig = sig;
        this.buildInspector(selected);
      } else if (sig !== this.inspectorSig) {
        this.inspectorSig = sig;
        // A sig change while focus is INSIDE the inspector came from the user's own edit — the DOM
        // already shows it, and a rebuild would steal their focus (e.g. tabbing between trigger
        // fields). Rebuild only for outside changes (undo/redo, outliner visibility toggles…).
        const active = document.activeElement;
        if (active && this.inspectorEl.contains(active)) this.syncInspectorValues(selected);
        else this.buildInspector(selected);
      } else {
        this.syncInspectorValues(selected);
      }
      this.refreshOutliner();
    }
  }

  /** Inspector panel for a MULTI-selection: the count + the shared group actions only. */
  private buildMultiInspector(count: number): void {
    this.inspectorEl.innerHTML = '';
    const header = el('div', 'creator-section-title');
    header.textContent = `${count} objects selected`;
    this.inspectorEl.appendChild(header);

    const hint = el('div', 'creator-empty');
    hint.textContent = 'Group edit: move/rotate gizmo, arrows nudge, wheel rotates around the group center. Shift+click adds/removes.';
    this.inspectorEl.appendChild(hint);

    const row = el('div', 'creator-modebar-row');
    row.append(
      button('Duplicate', 'creator-btn', () => this.bridge.duplicateSelected()),
      button('Copy', 'creator-btn', () => this.bridge.copySelected()),
      button('Save Prefab', 'creator-btn creator-btn-primary', () => this.bridge.savePrefabFromSelection()),
      button('Delete', 'creator-btn creator-btn-warn', () => this.bridge.deleteSelected())
    );
    this.inspectorEl.appendChild(row);
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
    if (!visible) this.setSettingsOpen(false);
    this.toolbar.classList.toggle('creator-ui--visible', visible);
    this.refresh();
  }

  private setSettingsOpen(open: boolean): void {
    this.settingsOpen = open;
    this.settingsDropdown.classList.toggle('creator-settings-dropdown--open', open);
    this.settingsBtn.classList.toggle('creator-settings-toggle--open', open);
    this.settingsBtn.textContent = open ? 'Settings -' : 'Settings +';
    this.settingsBtn.setAttribute('aria-expanded', String(open));
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

  /** Autosave status text beside the Save button ("Autosaved 14:03:22" / "Autosave unavailable"). */
  setAutosaveStatus(text: string): void {
    this.autosaveStatusEl.textContent = text;
  }

  /** Container in the Settings dropdown that hosts the game's docked SettingsPanel while active. */
  gameSettingsSlot(): HTMLElement {
    return this.gameSettingsHost;
  }

  /** Brief small text at the top of the screen ("Autosaved" / "Saved") — easy to ignore mid-build. */
  flashSaveIndicator(text: string): void {
    this.saveIndicatorEl.textContent = text;
    this.saveIndicatorEl.classList.add('creator-save-indicator--visible');
    if (this.saveIndicatorTimer !== null) window.clearTimeout(this.saveIndicatorTimer);
    this.saveIndicatorTimer = window.setTimeout(
      () => this.saveIndicatorEl.classList.remove('creator-save-indicator--visible'),
      1400
    );
  }

  /** Pill shown while free-dragging an object by its center handle (the wheel adjusts carry distance). */
  setDragHint(visible: boolean): void {
    this.dragHint.classList.toggle('creator-drag-hint--visible', visible);
  }

  /** Recording indicator during playtest: pass elapsed seconds while recording, or null to hide. */
  setRecordingTimer(seconds: number | null): void {
    const on = seconds !== null;
    this.recTimer.classList.toggle('creator-rec-timer--visible', on);
    if (on) {
      const total = Math.max(0, Math.floor(seconds));
      const mm = Math.floor(total / 60);
      const ss = String(total % 60).padStart(2, '0');
      this.recTimer.textContent = `● REC  ${mm}:${ss}  ·  7 to stop`;
    }
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
    // After a failed attempt the field was cleared on submit — refocus so the user can retype
    // immediately instead of having to click back into the input.
    if (this.isModalOpen() && !this.awaitingModalFocus) this.modalInput.focus();
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
    if (this.saveIndicatorTimer !== null) window.clearTimeout(this.saveIndicatorTimer);
    this.stopAwaitingModalFocus();
    this.toolbar.remove();
    this.hotbar.remove();
    this.playtestBar.remove();
    this.toastEl.remove();
    this.saveIndicatorEl.remove();
    this.entryPrompt.remove();
    this.modal.remove();
    this.fileInput.remove();
    this.courseFileInput.remove();
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

  private optionRow(
    labelText: string,
    options: readonly string[],
    value: string,
    labels: Record<string, string>,
    onChange: (value: string) => void
  ): HTMLDivElement {
    const row = el('div', 'creator-field creator-field--compact');
    row.appendChild(label(labelText));
    const sel = document.createElement('select');
    sel.className = 'creator-select';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = labels[o] ?? o;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    row.appendChild(sel);
    return row;
  }

  private compactNumberRow(labelText: string, value: number, step: number, onChange: (value: number) => void): HTMLDivElement {
    const row = el('div', 'creator-field creator-field--compact');
    row.appendChild(label(labelText));
    row.appendChild(this.numberInput(value, step, onChange));
    return row;
  }

  private opacitySlider(value: number, onChange: (value: number) => void): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'creator-field creator-opacity-control';
    row.appendChild(label('Opacity'));

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(Math.round(Math.max(0, Math.min(1, value)) * 100));

    const readout = document.createElement('span');
    readout.className = 'creator-opacity-value';
    readout.textContent = `${slider.value}%`;

    slider.addEventListener('input', () => {
      readout.textContent = `${slider.value}%`;
      onChange(Number(slider.value) / 100);
    });

    row.append(slider, readout);
    return row;
  }

  /**
   * A press-and-hold confirm button: the caller's action only fires after the pointer is held for the
   * full duration (a fill bar sweeps to show progress), so a destructive action can't be a stray click.
   * Releasing / leaving early cancels and resets.
   */
  private holdButton(text: string, className: string, onComplete: () => void): HTMLButtonElement {
    const HOLD_MS = 800; // must match the .creator-hold-fill CSS transition duration
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    const labelSpan = el('span', 'creator-hold-label');
    labelSpan.textContent = text;
    const fill = el('span', 'creator-hold-fill');
    btn.append(fill, labelSpan);

    let timer: number | null = null;
    const cancel = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      btn.classList.remove('creator-hold--active');
    };
    const start = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      btn.classList.add('creator-hold--active');
      timer = window.setTimeout(() => {
        cancel();
        onComplete();
      }, HOLD_MS);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    return btn;
  }
}

// Gameplay keys that might be physically held when the password modal opens (interact + movement);
// the field isn't focused until all of these are released so they can't auto-repeat into it.
const GAMEPLAY_HOLD_CODES = new Set<string>([
  'KeyE', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft', 'ControlRight'
]);

/**
 * Everything the inspector shows that the in-place number sync does NOT cover. Transform fields are
 * deliberately excluded so gizmo drags keep updating inputs in place without a rebuild (focus-safe).
 */
function inspectorSignature(obj: CreatorLayoutObject): string {
  return [
    obj.id,
    obj.name ?? '',
    obj.material ?? '',
    obj.texture ?? '',
    obj.collision !== false ? 1 : 0,
    Math.round(objectOpacity(obj) * 1000),
    obj.wallrunEnabled !== false ? 1 : 0,
    JSON.stringify(obj.metadata ?? {})
  ].join('|');
}

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
