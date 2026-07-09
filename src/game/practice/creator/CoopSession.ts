/**
 * Co-op Course Editing — session controller for the real-time collaborative Creator (see
 * shared/coopEdit.ts, server/src/rooms/EditRoom.ts). Owns the socket, the collaborator avatars
 * (reusing the race ghost renderer), and a minimal create/join overlay + roster panel. The editor
 * drives it (relay my edits/locks/presence; smooth avatars) and it drives the editor back through
 * CoopEditorBridge (adopt the host course, apply remote object edits, update the lock map).
 *
 * Purely additive: when no session is active, the editor behaves exactly as offline. Distinct from
 * MultiplayerClient (duels) and CourseRaceSession (races).
 */

import type { Scene } from '@babylonjs/core';
import { validateLayout, type CreatorLayout, type CreatorLayoutObject } from './CreatorLayout';
import { CourseGhosts } from '../CourseGhosts';
import { CoopEditClient } from '../../network/CoopEditClient';
import type { InputManager } from '../../input/InputManager';
import type { CoopMode, CoopRosterEntry } from '../../../../shared/coopEdit';

export interface CoopEditorBridge {
  /** The editor's current course, JSON-stringified (sent when hosting a new session). */
  currentCourseJson(): string;
  /** Remembered display name for the create/join fields. */
  storedName(): string;
  /** We JOINED a session: replace the editor's working layout with the host's validated course. */
  adoptRemoteCourse(layout: CreatorLayout): void;
  /** A collaborator upserted an object — apply it locally without relaying or touching local undo. */
  applyRemoteUpsert(object: CreatorLayoutObject): void;
  /** A collaborator deleted an object — apply locally without relaying. */
  applyRemoteDelete(id: string): void;
  /** Authoritative lock map changed (object id → owner session id). Drives red highlight + blocking. */
  setLocks(locks: Map<string, string>, selfId: string): void;
  /** Session is now live — snapshot the current layout as the sync baseline (host + joiner). */
  onSessionActive(): void;
  /** Session-level banner (e.g. "Co-op started — share the code"). */
  notify(title: string, subtitle: string): void;
  /** Session ended. `joinedRemote` = we were editing a joined host's course (offer save-a-copy). */
  onSessionEnded(joinedRemote: boolean, finalCourse: CreatorLayout | null): void;
}

const NAME_STORAGE_KEY = 'strafeball:coop:name';

export class CoopSession {
  private readonly client: CoopEditClient;
  private readonly avatars: CourseGhosts;

  private active = false;
  private joinedRemote = false;
  private selfId = '';
  private hostId = '';
  private readonly namesById = new Map<string, string>();
  private readonly locks = new Map<string, string>();
  /** The latest full course we hold — kept current so an ending joiner can save a copy. */
  private latestCourse: CreatorLayout | null = null;

  // DOM
  private readonly overlay: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly status: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly panelCode: HTMLSpanElement;
  private readonly panelRows: HTMLDivElement;

  constructor(
    scene: Scene,
    hudRoot: HTMLElement,
    private readonly input: InputManager,
    private readonly bridge: CoopEditorBridge
  ) {
    this.avatars = new CourseGhosts(scene);

    // --- Create/Join overlay (reuses the creator-modal CSS shell) ---
    this.overlay = el('div', 'creator-modal-backdrop');
    this.overlay.setAttribute('data-no-lock', '');
    const card = el('div', 'creator-modal');
    const title = el('div', 'creator-modal-title');
    title.textContent = 'Co-op Editing';
    const intro = el('div', 'creator-onboard-intro');
    intro.textContent = 'Build this course together in real time — share the room code. Everyone sees each other and each other’s edits live.';

    const nameRow = el('div', 'creator-field');
    nameRow.appendChild(fieldLabel('Name'));
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.className = 'creator-text';
    this.nameInput.maxLength = 24;
    this.nameInput.placeholder = 'Your name';
    this.nameInput.value = this.bridge.storedName() || loadStoredName();
    nameRow.appendChild(this.nameInput);

    this.createBtn = button('Host with This Course', 'creator-btn creator-btn-primary', () => {
      const name = this.commitName();
      if (!name) return this.setStatus('Enter a name first.', true);
      void this.create(name);
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

    this.joinBtn = button('Join', 'creator-btn creator-btn-primary', () => {
      const name = this.commitName();
      if (!name) return this.setStatus('Enter a name first.', true);
      const code = this.codeInput.value.trim();
      if (!code) return this.setStatus('Enter a room code to join.', true);
      void this.join(code, name);
    });

    this.status = el('div', 'race-overlay-status');
    const actions = el('div', 'creator-modal-actions');
    actions.appendChild(button('Close', 'creator-btn', () => this.closeOverlay()));
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeOverlay();
      }
    });

    card.append(title, intro, nameRow, this.createBtn, divider, joinRow, this.joinBtn, this.status, actions);
    this.overlay.appendChild(card);
    hudRoot.appendChild(this.overlay);

    // --- In-session roster panel (reuses .race-panel CSS) ---
    this.panel = el('div', 'race-panel coop-panel');
    this.panel.setAttribute('data-no-lock', '');
    const head = el('div', 'race-panel-head');
    const headTitle = el('span', 'race-panel-title');
    headTitle.textContent = 'CO-OP';
    this.panelCode = el('span', 'race-panel-code');
    const copyBtn = button('copy', 'creator-btn creator-btn-mini', () => {
      const code = this.panelCode.textContent ?? '';
      if (code) void navigator.clipboard?.writeText(code).catch(() => undefined);
    });
    copyBtn.title = 'Copy the room code';
    head.append(headTitle, this.panelCode, copyBtn);
    this.panelRows = el('div', 'race-panel-rows');
    const panelActions = el('div', 'race-panel-actions');
    panelActions.appendChild(button('Leave Co-op', 'creator-btn creator-btn-mini creator-btn-warn', () => this.leave()));
    this.panel.append(head, this.panelRows, panelActions);
    hudRoot.appendChild(this.panel);

    this.client = new CoopEditClient({
      onWelcome: (welcome) => {
        this.selfId = welcome.selfId;
        this.hostId = welcome.hostId;
        this.applyRoster(welcome.roster, welcome.hostId);
        this.applyLocks(welcome.locks);
        if (this.joinedRemote) {
          try {
            const { layout } = validateLayout(JSON.parse(welcome.courseJson));
            this.latestCourse = layout;
            this.bridge.adoptRemoteCourse(layout);
          } catch {
            this.bridge.notify('CO-OP', 'Could not read the host course — leaving');
            this.leave();
            return;
          }
        }
        this.active = true;
        this.bridge.onSessionActive();
        this.closeOverlay();
        this.panelCode.textContent = this.client.roomId;
        this.panel.classList.add('race-panel--visible');
        this.bridge.notify('CO-OP STARTED', `Room code ${this.client.roomId} — share it to build together`);
      },
      onRoster: (m) => this.applyRoster(m.roster, m.hostId),
      onEdit: (m) => {
        if (m.from === this.selfId) return;
        // Validate each object client-side (server relays them opaquely). A malformed one is skipped.
        for (const raw of m.upserts) {
          try {
            const { layout } = validateLayout({ objects: [raw] });
            const obj = layout.objects[0];
            if (obj) this.bridge.applyRemoteUpsert(obj);
          } catch {
            // ignore a single bad object
          }
        }
        for (const id of m.deletes) this.bridge.applyRemoteDelete(id);
      },
      onLocks: (m) => this.applyLocks(m.locks),
      onPresence: (m) => {
        for (const p of m.presences) {
          if (p.id === this.selfId) continue;
          this.avatars.setPose(p.id, this.namesById.get(p.id) ?? 'Builder', { x: p.x, y: p.y, z: p.z, yaw: p.yaw });
        }
      },
      onClosed: (closed) => {
        this.bridge.notify('CO-OP OVER', closed.reason === 'host-left' ? 'The host ended the session' : 'The session was closed');
        this.teardown();
      },
      onDisconnected: () => {
        if (!this.active) return;
        this.bridge.notify('CO-OP', 'Connection to the session was lost');
        this.teardown();
      }
    });
  }

  isActive(): boolean {
    return this.active;
  }

  isBusy(): boolean {
    return this.active || this.isOverlayOpen();
  }

  isOverlayOpen(): boolean {
    return this.overlay.classList.contains('creator-modal-backdrop--visible');
  }

  /** True while a host is editing their own course (autosave stays live); false while a joiner (suppress). */
  isHost(): boolean {
    return this.active && this.selfId !== '' && this.selfId === this.hostId;
  }

  toggleOverlay(): void {
    if (this.active) return;
    if (this.isOverlayOpen()) {
      this.closeOverlay();
    } else {
      this.setStatus('', false);
      this.setBusy(false);
      this.overlay.classList.add('creator-modal-backdrop--visible');
      if (!this.nameInput.value.trim()) this.nameInput.focus();
      else this.codeInput.focus();
    }
  }

  closeOverlay(): void {
    this.overlay.classList.remove('creator-modal-backdrop--visible');
  }

  // --- Editor → session ---------------------------------------------------------------------------

  /** Relay one commit's changed objects + removed ids, batched into a single message. */
  relayEdit(upserts: CreatorLayoutObject[], deletes: string[]): void {
    if (!this.active) return;
    this.client.sendEdit(upserts as unknown as Record<string, unknown>[], deletes);
  }

  relayLock(id: string): void {
    if (this.active) this.client.sendLock(id);
  }

  relayUnlock(id: string): void {
    if (this.active) this.client.sendUnlock(id);
  }

  relayUnlockAll(): void {
    if (this.active) this.client.sendUnlockAll();
  }

  /** Called each frame while active: relay the local pose and smooth the avatars. */
  updateFrame(dt: number, x: number, y: number, z: number, yaw: number, mode: CoopMode, selection: string): void {
    if (!this.active) return;
    this.client.sendPresence({ x, y, z, yaw, mode, selection });
    this.avatars.update(dt);
  }

  /** Keep the latest full course so a leaving joiner can save a copy of the shared result. */
  noteLatestCourse(layout: CreatorLayout): void {
    this.latestCourse = layout;
  }

  leave(): void {
    if (!this.active && !this.client.connected) {
      this.closeOverlay();
      return;
    }
    void this.client.leave();
    this.teardown();
  }

  forceClose(): void {
    this.closeOverlay();
    if (this.client.connected) void this.client.leave();
    if (this.active) this.teardown();
  }

  dispose(): void {
    this.forceClose();
    this.avatars.dispose();
    this.overlay.remove();
    this.panel.remove();
  }

  // ---------------------------------------------------------------------------------------------

  private async create(name: string): Promise<void> {
    this.setBusy(true);
    this.setStatus('Creating session…', false);
    this.joinedRemote = false;
    try {
      await this.client.createSession(name, this.bridge.currentCourseJson());
    } catch (err) {
      this.setBusy(false);
      this.setStatus(friendlyError(err, 'Could not host the session.'), true);
    }
  }

  private async join(code: string, name: string): Promise<void> {
    this.setBusy(true);
    this.setStatus('Joining…', false);
    this.joinedRemote = true;
    try {
      await this.client.joinSession(code, name);
    } catch (err) {
      this.joinedRemote = false;
      this.setBusy(false);
      this.setStatus(friendlyError(err, 'Could not join — check the room code.'), true);
    }
  }

  private applyRoster(roster: readonly CoopRosterEntry[], hostId: string): void {
    this.hostId = hostId;
    this.namesById.clear();
    const ids = new Set<string>();
    for (const entry of roster) {
      this.namesById.set(entry.id, entry.name);
      if (entry.id !== this.selfId) ids.add(entry.id);
    }
    this.avatars.retainOnly(ids);
    this.renderRoster(roster);
  }

  private applyLocks(record: Record<string, string>): void {
    this.locks.clear();
    for (const [id, owner] of Object.entries(record)) this.locks.set(id, owner);
    this.bridge.setLocks(this.locks, this.selfId);
  }

  private renderRoster(roster: readonly CoopRosterEntry[]): void {
    this.panelRows.innerHTML = '';
    for (const entry of roster) {
      const row = el('div', 'race-panel-row');
      if (entry.id === this.selfId) row.classList.add('race-panel-row--self');
      const name = el('span', 'race-panel-name');
      name.textContent = `${entry.host ? '★ ' : ''}${entry.name}${entry.id === this.selfId ? ' (you)' : ''}`;
      row.appendChild(name);
      this.panelRows.appendChild(row);
    }
  }

  private teardown(): void {
    const joined = this.joinedRemote;
    const finalCourse = this.latestCourse;
    this.active = false;
    this.joinedRemote = false;
    this.selfId = '';
    this.hostId = '';
    this.namesById.clear();
    this.locks.clear();
    this.avatars.clear();
    this.panel.classList.remove('race-panel--visible');
    this.panelRows.innerHTML = '';
    this.closeOverlay();
    this.latestCourse = null;
    this.bridge.setLocks(this.locks, ''); // clear locks in the editor
    this.bridge.onSessionEnded(joined, finalCourse);
  }

  private commitName(): string {
    const name = this.nameInput.value.trim().slice(0, 24);
    if (name) {
      try {
        window.localStorage.setItem(NAME_STORAGE_KEY, name);
      } catch {
        // storage unavailable
      }
    }
    return name;
  }

  private setStatus(text: string, isError: boolean): void {
    this.status.textContent = text;
    this.status.classList.toggle('race-overlay-status--error', isError);
  }

  private setBusy(busy: boolean): void {
    this.createBtn.disabled = busy;
    this.joinBtn.disabled = busy;
  }
}

function loadStoredName(): string {
  try {
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function friendlyError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  if (/not found/i.test(message)) return 'No session found with that code.';
  if (/rejected|too-large|too-many/i.test(message)) return 'The course was rejected by the server.';
  if (/full/i.test(message)) return 'That session is full.';
  return fallback;
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
