/**
 * Course Race — DOM UI: the create/join overlay (opened at the yard's RACE ONLINE sign) and the
 * in-race panel (room code, racer roster with session best times, host restart, leave).
 *
 * Reuses the creator UI's card/button CSS language (.creator-modal / .creator-btn). Plain DOM
 * under #hud-root, all marked data-no-lock so clicks never grab pointer lock. Holds no session
 * state of its own — CourseRaceSession drives it and receives its button callbacks.
 */

import type { RaceRosterEntry } from '../../../shared/courseRace';
import { formatRunTime } from './creator/CourseRunHud';

const NAME_STORAGE_KEY = 'strafeball:race:name';

export interface CourseRaceUICallbacks {
  onCreate(name: string): void;
  onJoin(code: string, name: string): void;
  onLeaveRace(): void;
  onRestartAll(): void;
  /** Dismiss the create/join overlay. Routed through the session so pointer-lock suppression (set
   *  when the overlay opened) is released — hiding the overlay alone would softlock the player. */
  onCloseOverlay(): void;
}

export class CourseRaceUI {
  private readonly overlay: HTMLDivElement;
  private readonly overlayStatus: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly joinBtn: HTMLButtonElement;

  private readonly panel: HTMLDivElement;
  private readonly panelCode: HTMLSpanElement;
  private readonly panelRows: HTMLDivElement;
  private readonly panelEvent: HTMLDivElement;
  private readonly restartBtn: HTMLButtonElement;
  private panelEventTimer: number | null = null;

  constructor(host: HTMLElement, private readonly callbacks: CourseRaceUICallbacks) {
    // --- Create/Join overlay ---
    this.overlay = el('div', 'creator-modal-backdrop');
    this.overlay.setAttribute('data-no-lock', '');
    const card = el('div', 'creator-modal');
    const title = el('div', 'creator-modal-title');
    title.textContent = 'Race Online';
    const intro = el('div', 'creator-onboard-intro');
    intro.textContent = 'Race your course with friends — private session, share the room code. Everyone runs together as ghosts.';

    const nameRow = el('div', 'creator-field');
    nameRow.appendChild(fieldLabel('Name'));
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.className = 'creator-text';
    this.nameInput.maxLength = 24;
    this.nameInput.placeholder = 'Your name';
    this.nameInput.value = loadStoredName();
    nameRow.appendChild(this.nameInput);

    this.createBtn = button('Create Race with This Course', 'creator-btn creator-btn-primary', () => {
      const name = this.commitName();
      if (!name) return this.setStatus('Enter a name first.', true);
      this.callbacks.onCreate(name);
    });

    const divider = el('div', 'race-overlay-divider');
    divider.textContent = 'or join a friend';

    const joinRow = el('div', 'creator-field');
    joinRow.appendChild(fieldLabel('Room code'));
    this.codeInput = document.createElement('input');
    this.codeInput.type = 'text';
    this.codeInput.className = 'creator-text';
    this.codeInput.maxLength = 16;
    this.codeInput.placeholder = 'e.g. AbCd12';
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinBtn.click();
    });
    joinRow.appendChild(this.codeInput);

    this.joinBtn = button('Join Race', 'creator-btn creator-btn-primary', () => {
      const name = this.commitName();
      if (!name) return this.setStatus('Enter a name first.', true);
      const code = this.codeInput.value.trim();
      if (!code) return this.setStatus('Enter a room code to join.', true);
      this.callbacks.onJoin(code, name);
    });

    this.overlayStatus = el('div', 'race-overlay-status');

    const actions = el('div', 'creator-modal-actions');
    actions.appendChild(button('Close', 'creator-btn', () => this.callbacks.onCloseOverlay()));

    // Escape dismisses the overlay too (keydown bubbles up from the focused inputs), matching the
    // game's other modals. Routed through the session callback so suppression is released.
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.callbacks.onCloseOverlay();
      }
    });

    card.append(title, intro, nameRow, this.createBtn, divider, joinRow, this.joinBtn, this.overlayStatus, actions);
    this.overlay.appendChild(card);
    host.appendChild(this.overlay);

    // --- In-race panel ---
    this.panel = el('div', 'race-panel');
    this.panel.setAttribute('data-no-lock', '');
    const head = el('div', 'race-panel-head');
    const headTitle = el('span', 'race-panel-title');
    headTitle.textContent = 'RACE';
    this.panelCode = el('span', 'race-panel-code');
    const copyBtn = button('copy', 'creator-btn creator-btn-mini', () => {
      const code = this.panelCode.textContent ?? '';
      if (code) void navigator.clipboard?.writeText(code).catch(() => undefined);
      this.showEvent('Room code copied');
    });
    copyBtn.title = 'Copy the room code';
    head.append(headTitle, this.panelCode, copyBtn);

    this.panelRows = el('div', 'race-panel-rows');
    this.panelEvent = el('div', 'race-panel-event');

    const panelActions = el('div', 'race-panel-actions');
    this.restartBtn = button('Restart All', 'creator-btn creator-btn-mini', () => this.callbacks.onRestartAll());
    this.restartBtn.title = 'Teleport every racer to the start (host only)';
    const leaveBtn = button('Leave Race', 'creator-btn creator-btn-mini creator-btn-warn', () => this.callbacks.onLeaveRace());
    panelActions.append(this.restartBtn, leaveBtn);

    this.panel.append(head, this.panelRows, this.panelEvent, panelActions);
    host.appendChild(this.panel);
  }

  // --- Overlay ---

  openOverlay(): void {
    this.setStatus('', false);
    this.setBusy(false);
    this.overlay.classList.add('creator-modal-backdrop--visible');
    // Focus whichever field needs attention first.
    if (!this.nameInput.value.trim()) this.nameInput.focus();
    else this.codeInput.focus();
  }

  closeOverlay(): void {
    this.overlay.classList.remove('creator-modal-backdrop--visible');
  }

  isOverlayOpen(): boolean {
    return this.overlay.classList.contains('creator-modal-backdrop--visible');
  }

  /** Overlay status line ("Connecting…" / errors). */
  setStatus(text: string, isError: boolean): void {
    this.overlayStatus.textContent = text;
    this.overlayStatus.classList.toggle('race-overlay-status--error', isError);
  }

  /** Disable the create/join buttons while a connection attempt is in flight. */
  setBusy(busy: boolean): void {
    this.createBtn.disabled = busy;
    this.joinBtn.disabled = busy;
  }

  // --- In-race panel ---

  showPanel(roomCode: string): void {
    this.panelCode.textContent = roomCode;
    this.panelEvent.textContent = '';
    this.panel.classList.add('race-panel--visible');
  }

  hidePanel(): void {
    this.panel.classList.remove('race-panel--visible');
    this.panelRows.innerHTML = '';
    this.panelEvent.textContent = '';
  }

  updateRoster(roster: readonly RaceRosterEntry[], selfId: string, isHost: boolean): void {
    this.restartBtn.style.display = isHost ? '' : 'none';
    this.panelRows.innerHTML = '';
    // Finished racers first (best ascending), then the rest by name.
    const sorted = [...roster].sort((a, b) => {
      if (a.bestMs !== null && b.bestMs !== null) return a.bestMs - b.bestMs;
      if (a.bestMs !== null) return -1;
      if (b.bestMs !== null) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of sorted) {
      const row = el('div', 'race-panel-row');
      if (entry.id === selfId) row.classList.add('race-panel-row--self');
      const name = el('span', 'race-panel-name');
      name.textContent = `${entry.host ? '★ ' : ''}${entry.name}${entry.id === selfId ? ' (you)' : ''}`;
      const time = el('span', 'race-panel-time');
      time.textContent = entry.bestMs !== null ? formatRunTime(entry.bestMs) : '—';
      row.append(name, time);
      this.panelRows.appendChild(row);
    }
  }

  /** Transient event line in the panel ("Bob finished 0:41.20"). */
  showEvent(text: string): void {
    this.panelEvent.textContent = text;
    this.panelEvent.classList.add('race-panel-event--visible');
    if (this.panelEventTimer !== null) window.clearTimeout(this.panelEventTimer);
    this.panelEventTimer = window.setTimeout(() => this.panelEvent.classList.remove('race-panel-event--visible'), 3200);
  }

  dispose(): void {
    if (this.panelEventTimer !== null) window.clearTimeout(this.panelEventTimer);
    this.overlay.remove();
    this.panel.remove();
  }

  // ---------------------------------------------------------------------------------------------

  /** Persist + return the trimmed name (empty string when blank). */
  private commitName(): string {
    const name = this.nameInput.value.trim().slice(0, 24);
    if (name) {
      try {
        window.localStorage.setItem(NAME_STORAGE_KEY, name);
      } catch {
        // Storage unavailable — the name just isn't remembered.
      }
    }
    return name;
  }
}

function loadStoredName(): string {
  try {
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function fieldLabel(text: string): HTMLSpanElement {
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
