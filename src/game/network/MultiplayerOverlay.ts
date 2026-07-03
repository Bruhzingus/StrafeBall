import { GAME_CONSTANTS } from '../../../shared/constants';
import type { LobbyMode } from '../practice/LobbyModePortals';
import type { MatchMode, MatchPresetId, PlayerState, RoomState } from '../../../shared/types';
import { ALLOWED_MAT_PRESETS, ROOM_SETTINGS_LIMITS, type RoomSettingsPatch, votesRequiredForPass } from '../../../shared/roomSettings';
import {
  DEFAULT_TICK_PRESET_ID,
  TICK_PRESETS,
  tickPresetById,
  tickPresetForNetMode,
  type TickPresetId
} from '../../../shared/tickPresets';
import type { InputManager } from '../input/InputManager';
import { MultiplayerClient } from './MultiplayerClient';

type PendingAction = (() => Promise<void>) | null;

const MODE_LABEL: Record<LobbyMode, string> = {
  '1v1': '1v1 Private Duel',
  '2v2': '2v2 Team Room'
};

export class MultiplayerOverlay {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly joinInput: HTMLInputElement;
  private readonly roomValue: HTMLSpanElement;
  private readonly pingValue: HTMLSpanElement;
  private readonly rosterValue: HTMLDivElement;
  private readonly controlsValue: HTMLDivElement;
  private readonly settingsEntryValue: HTMLDivElement;
  private readonly settingsValue: HTMLDivElement;
  private readonly pregameValue: HTMLDivElement;
  private readonly resetValue: HTMLDivElement;
  private readonly postmatchValue: HTMLDivElement;
  private readonly noticeValue: HTMLDivElement;
  private readonly errorValue: HTMLDivElement;
  private readonly createButton: HTMLButtonElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly modeButtons: NodeListOf<HTMLButtonElement>;
  private readonly tickPresetButtons: NodeListOf<HTMLButtonElement>;
  private readonly modeTitle: HTMLDivElement;
  private readonly modeSubtitle: HTMLDivElement;
  private readonly modeNotice: HTMLDivElement;
  private readonly fullscreenPrompt: HTMLDivElement;
  private readonly fullscreenContinue: HTMLButtonElement;
  private readonly fullscreenRequest: HTMLButtonElement;
  private readonly fullscreenCancel: HTMLButtonElement;
  private selectedMode: LobbyMode = '1v1';
  private selectedTickPresetId: TickPresetId = DEFAULT_TICK_PRESET_ID;
  private modalOpen = false;
  private settingsOpen = false;
  private wasLiveMatch = false;
  private wasReportOpen = false;
  private pendingAction: PendingAction = null;
  private awaitingInteractReleaseFocus = false;
  private lastCompletedMatchKey = '';
  private lastRendered = {
    connected: false,
    busy: false,
    status: '',
    roomId: '',
    pingMs: undefined as number | null | undefined,
    errorMessage: '',
    selectedMode: null as LobbyMode | null,
    selectedTickPresetId: null as TickPresetId | null,
    nameReady: false,
    modalOpen: false,
    settingsOpen: false,
    roomSummaryKey: ''
  };

  constructor(private readonly client: MultiplayerClient, private readonly input: InputManager) {
    this.root = document.createElement('div');
    this.root.className = 'multiplayer-modal multiplayer-modal--hidden';
    this.root.setAttribute('data-no-lock', 'true');
    this.root.innerHTML = `
      <div class="multiplayer-modal__shade"></div>
      <div class="multiplayer-panel multiplayer-panel--lobby">
        <button class="multiplayer-close" type="button" aria-label="Close match menu">x</button>
        <div class="multiplayer-kicker">StrafeBall Lobby</div>
        <div class="multiplayer-title">Private Match</div>

        <label class="multiplayer-field">
          <span>Player (required)</span>
          <input class="multiplayer-name" maxlength="24" placeholder="Enter name" />
        </label>

        <div class="multiplayer-name-warning"><span class="multiplayer-name-warning__icon" aria-hidden="true">!</span><span>Enter your name to continue</span></div>

        <div class="multiplayer-step-label">1. SELECT MODE</div>

        <div class="multiplayer-mode-tabs">
          <button class="multiplayer-mode-tab" data-mode="1v1" type="button">
            <div class="multiplayer-mode-tab__main">1v1</div>
            <div class="multiplayer-mode-tab__sub">One vs One</div>
          </button>
          <button class="multiplayer-mode-tab" data-mode="2v2" type="button">
            <div class="multiplayer-mode-tab__main">2v2</div>
            <div class="multiplayer-mode-tab__sub">Two vs Two</div>
          </button>
        </div>

        <div class="multiplayer-mode-card">
          <div class="multiplayer-mode-card__icon">ℹ</div>
          <div class="multiplayer-mode-card__content">
            <div class="multiplayer-mode-title"></div>
            <div class="multiplayer-mode-subtitle"></div>
            <div class="multiplayer-mode-notice"></div>
          </div>
        </div>

        <div class="multiplayer-step-label">2. SELECT TICK PRESET</div>

        <div class="multiplayer-tick-presets">
          ${TICK_PRESETS.map((preset) => `
            <button class="multiplayer-tick-preset" data-tick-preset="${preset.id}" type="button">
              <div class="multiplayer-tick-preset__main">${escapeHtml(preset.label)}</div>
              <div class="multiplayer-tick-preset__sub">${escapeHtml(preset.description)}</div>
            </button>
          `).join('')}
        </div>

        <div class="multiplayer-step-label">3. CREATE A MATCH OR ENTER A CODE</div>

        <div class="multiplayer-launch">
          <div class="multiplayer-launch-section">
            <div class="multiplayer-launch-option multiplayer-launch-option--create">
              <div class="multiplayer-launch-option__title">CREATE A MATCH</div>
              <div class="multiplayer-launch-option__desc">Start a new room with the selected mode and lobby settings.</div>
              <button class="multiplayer-create">CREATE ROOM</button>
            </div>
            <div class="multiplayer-launch-divider">OR</div>
            <div class="multiplayer-launch-option multiplayer-launch-option--join">
              <div class="multiplayer-launch-option__title">ENTER A CODE</div>
              <div class="multiplayer-launch-option__desc">Join a friend's room with their room code.</div>
              <div class="multiplayer-join-row">
                <input class="multiplayer-join-code" placeholder="Enter room code" aria-label="Room code" />
                <button class="multiplayer-join">JOIN</button>
              </div>
            </div>
          </div>
          <div class="multiplayer-drawer-hint">Create makes a new room with the format above. Join uses the room's existing settings — just the code.</div>
        </div>

        <div class="multiplayer-room-card">
          <div>
            <div class="multiplayer-card-label">Room Code</div>
            <div class="multiplayer-room">Practice</div>
          </div>
          <button class="multiplayer-copy" type="button">Copy</button>
        </div>

        <div class="multiplayer-actions multiplayer-actions--leave">
          <button class="multiplayer-leave">Leave</button>
        </div>
        <div class="multiplayer-line multiplayer-line--ping">Ping <span class="multiplayer-ping">-</span></div>
        <div class="multiplayer-settings-entry"></div>
        <div class="multiplayer-controls"></div>
        <div class="multiplayer-room-summary"></div>
        <div class="multiplayer-pregame"></div>
        <div class="multiplayer-reset"></div>
        <div class="multiplayer-room-notice"></div>
        <div class="multiplayer-error"></div>
      </div>

      <div class="multiplayer-settings-host"></div>
      <div class="multiplayer-postmatch multiplayer-postmatch-host"></div>

      <div class="fullscreen-prompt fullscreen-prompt--hidden">
        <div class="fullscreen-prompt__card">
          <div class="fullscreen-prompt__title">Fullscreen Check</div>
          <div class="fullscreen-prompt__body">
            StrafeBall plays best in browser fullscreen. Press <span class="key">F11</span> before joining so your aim and mouse focus feel right.
          </div>
          <div class="fullscreen-prompt__actions">
            <button class="fullscreen-request" type="button">Try Fullscreen</button>
            <button class="fullscreen-continue" type="button">Continue</button>
            <button class="fullscreen-cancel" type="button">Cancel</button>
          </div>
        </div>
      </div>
    `;

    this.panel = this.mustQuery<HTMLDivElement>('.multiplayer-panel');
    this.nameInput = this.mustQuery<HTMLInputElement>('.multiplayer-name');
    this.joinInput = this.mustQuery<HTMLInputElement>('.multiplayer-join-code');
    this.roomValue = this.mustQuery<HTMLSpanElement>('.multiplayer-room');
    this.pingValue = this.mustQuery<HTMLSpanElement>('.multiplayer-ping');
    this.rosterValue = this.mustQuery<HTMLDivElement>('.multiplayer-room-summary');
    this.controlsValue = this.mustQuery<HTMLDivElement>('.multiplayer-controls');
    this.settingsEntryValue = this.mustQuery<HTMLDivElement>('.multiplayer-settings-entry');
    this.settingsValue = this.mustQuery<HTMLDivElement>('.multiplayer-settings-host');
    this.pregameValue = this.mustQuery<HTMLDivElement>('.multiplayer-pregame');
    this.resetValue = this.mustQuery<HTMLDivElement>('.multiplayer-reset');
    this.postmatchValue = this.mustQuery<HTMLDivElement>('.multiplayer-postmatch');
    this.noticeValue = this.mustQuery<HTMLDivElement>('.multiplayer-room-notice');
    this.errorValue = this.mustQuery<HTMLDivElement>('.multiplayer-error');
    this.createButton = this.mustQuery<HTMLButtonElement>('.multiplayer-create');
    this.joinButton = this.mustQuery<HTMLButtonElement>('.multiplayer-join');
    this.leaveButton = this.mustQuery<HTMLButtonElement>('.multiplayer-leave');
    this.copyButton = this.mustQuery<HTMLButtonElement>('.multiplayer-copy');
    this.closeButton = this.mustQuery<HTMLButtonElement>('.multiplayer-close');
    this.modeButtons = this.root.querySelectorAll<HTMLButtonElement>('.multiplayer-mode-tab');
    this.tickPresetButtons = this.root.querySelectorAll<HTMLButtonElement>('.multiplayer-tick-preset');
    this.modeTitle = this.mustQuery<HTMLDivElement>('.multiplayer-mode-title');
    this.modeSubtitle = this.mustQuery<HTMLDivElement>('.multiplayer-mode-subtitle');
    this.modeNotice = this.mustQuery<HTMLDivElement>('.multiplayer-mode-notice');
    this.fullscreenPrompt = this.mustQuery<HTMLDivElement>('.fullscreen-prompt');
    this.fullscreenContinue = this.mustQuery<HTMLButtonElement>('.fullscreen-continue');
    this.fullscreenRequest = this.mustQuery<HTMLButtonElement>('.fullscreen-request');
    this.fullscreenCancel = this.mustQuery<HTMLButtonElement>('.fullscreen-cancel');

    this.createButton.addEventListener('click', this.createRoom);
    this.joinButton.addEventListener('click', this.joinRoom);
    this.leaveButton.addEventListener('click', this.leaveRoom);
    this.copyButton.addEventListener('click', this.copyRoomCode);
    this.closeButton.addEventListener('click', this.close);
    this.nameInput.addEventListener('input', this.onNameInput);
    this.joinInput.addEventListener('keydown', this.onJoinKeyDown);
    this.fullscreenContinue.addEventListener('click', this.continueAfterFullscreenWarning);
    this.fullscreenRequest.addEventListener('click', this.requestFullscreen);
    this.fullscreenCancel.addEventListener('click', this.cancelFullscreenWarning);
    this.root.addEventListener('click', this.onRootClick);
    for (const button of this.modeButtons) button.addEventListener('click', this.onModeClick);
    for (const button of this.tickPresetButtons) button.addEventListener('click', this.onTickPresetClick);
    window.addEventListener('keyup', this.onPortalFocusKeyUp);
    window.addEventListener('keydown', this.onPortalKeyDown);
    document.body.appendChild(this.root);
    this.update();
  }

  /** True while the match menu (or its settings sub-panel) is open — the portal flow owns input. */
  isMenuOpen(): boolean {
    return this.modalOpen || this.settingsOpen;
  }

  dispose(): void {
    this.createButton.removeEventListener('click', this.createRoom);
    this.joinButton.removeEventListener('click', this.joinRoom);
    this.leaveButton.removeEventListener('click', this.leaveRoom);
    this.copyButton.removeEventListener('click', this.copyRoomCode);
    this.closeButton.removeEventListener('click', this.close);
    this.nameInput.removeEventListener('input', this.onNameInput);
    this.joinInput.removeEventListener('keydown', this.onJoinKeyDown);
    this.fullscreenContinue.removeEventListener('click', this.continueAfterFullscreenWarning);
    this.fullscreenRequest.removeEventListener('click', this.requestFullscreen);
    this.fullscreenCancel.removeEventListener('click', this.cancelFullscreenWarning);
    this.root.removeEventListener('click', this.onRootClick);
    for (const button of this.modeButtons) button.removeEventListener('click', this.onModeClick);
    for (const button of this.tickPresetButtons) button.removeEventListener('click', this.onTickPresetClick);
    window.removeEventListener('keyup', this.onPortalFocusKeyUp);
    window.removeEventListener('keydown', this.onPortalKeyDown);
    this.root.remove();
  }

  openMode(mode: LobbyMode): void {
    this.selectedMode = mode;
    this.modalOpen = true;
    this.settingsOpen = false;
    this.awaitingInteractReleaseFocus = true;
    this.syncLockOverlaySuppression();
    this.root.classList.remove('multiplayer-modal--hidden');
    this.update();
  }

  update(): void {
    const snapshot = this.client.latestSnapshot;
    if (this.client.connected && snapshot) {
      this.selectedMode = snapshot.room.match.mode;
    }
    const completedKey = completedMatchKey(snapshot?.room ?? null);
    if (completedKey && completedKey !== this.lastCompletedMatchKey) {
      this.lastCompletedMatchKey = completedKey;
      this.modalOpen = true;
    }
    const liveMatch = isLiveMatch(snapshot?.room ?? null);
    const matchStatus = snapshot?.room.match.status;
    const reportOpen = this.client.connected && (matchStatus === 'complete' || matchStatus === 'intermission');
    // Auto-close the menu only at the MOMENT the match goes live (so play isn't blocked). The player
    // can deliberately reopen it mid-match — e.g. to call or agree to an early-end vote — and it stays
    // open until they close it (or the next match starts).
    if (liveMatch && !this.wasLiveMatch) {
      this.modalOpen = false;
      this.settingsOpen = false;
      this.blurInputs();
    } else if (!liveMatch && this.wasLiveMatch && matchStatus === 'warmup') {
      // A live→lobby return (early-end vote passed): pop the menu so the host can reconfigure + restart.
      this.modalOpen = true;
    } else if (this.wasReportOpen && !reportOpen && matchStatus === 'warmup') {
      // The postmatch report just closed naturally (vote/timeout back to the lobby) — return to the
      // normal compact pregame HUD instead of leaving the report-era full panel (and its pointer-lock
      // suppression, see syncLockOverlaySuppression) stuck open forever.
      this.modalOpen = false;
    }
    if (liveMatch || (snapshot?.room && snapshot.room.match.status !== 'warmup')) {
      this.settingsOpen = false;
    }
    this.wasLiveMatch = liveMatch;
    this.wasReportOpen = reportOpen;
    const connected = this.client.connected;
    const busy = this.client.status === 'connecting';
    const nameReady = this.nameInput.value.trim().length > 0;
    const roomSummary = summarizeRoom(snapshot?.room ?? null, this.client.localPlayerId);
    if (
      this.lastRendered.connected === connected &&
      this.lastRendered.busy === busy &&
      this.lastRendered.status === this.client.status &&
      this.lastRendered.roomId === this.client.roomId &&
      this.lastRendered.pingMs === this.client.pingMs &&
      this.lastRendered.errorMessage === this.client.errorMessage &&
      this.lastRendered.selectedMode === this.selectedMode &&
      this.lastRendered.selectedTickPresetId === this.selectedTickPresetId &&
      this.lastRendered.nameReady === nameReady &&
      this.lastRendered.modalOpen === this.modalOpen &&
      this.lastRendered.settingsOpen === this.settingsOpen &&
      this.lastRendered.roomSummaryKey === roomSummary.key
    ) {
      return;
    }
    this.lastRendered = {
      connected,
      busy,
      status: this.client.status,
      roomId: this.client.roomId,
      pingMs: this.client.pingMs,
      errorMessage: this.client.errorMessage,
      selectedMode: this.selectedMode,
      selectedTickPresetId: this.selectedTickPresetId,
      nameReady,
      modalOpen: this.modalOpen,
      settingsOpen: this.settingsOpen,
      roomSummaryKey: roomSummary.key
    };

    this.roomValue.textContent = this.client.roomId || 'Practice';
    this.pingValue.textContent = this.client.pingMs === null ? '-' : `${this.client.pingMs} ms`;
    this.rosterValue.innerHTML = roomSummary.rosterHtml;
    this.settingsEntryValue.innerHTML = roomSummary.settingsEntryHtml;
    this.controlsValue.innerHTML = roomSummary.controlsHtml;
    this.settingsValue.innerHTML = roomSummary.settingsHtml;
    this.pregameValue.innerHTML = roomSummary.pregameHtml;
    this.resetValue.innerHTML = roomSummary.resetHtml;
    this.postmatchValue.innerHTML = roomSummary.postmatchHtml;
    this.noticeValue.textContent = roomSummary.noticeText;
    this.errorValue.textContent = friendlyError(this.client.errorMessage);

    const supported = this.modeSupported(this.selectedMode);
    this.modeTitle.textContent = MODE_LABEL[this.selectedMode];
    this.modeSubtitle.textContent = this.selectedMode === '1v1'
      ? 'Create a 1v1 room. Tune lives, rounds and the court in the lobby, then start.'
      : 'Create a 2v2 room. Squad up and pick sides in the lobby, then start.';
    this.modeNotice.textContent = supported
      ? 'Tip: use F11 fullscreen before the match starts.'
      : '2v2 is disabled in the active build configuration.';
    this.panel.dataset.mode = this.selectedMode;
    for (const button of this.modeButtons) {
      button.classList.toggle('multiplayer-mode-tab--active', button.dataset.mode === this.selectedMode);
    }
    for (const button of this.tickPresetButtons) {
      button.classList.toggle('multiplayer-tick-preset--active', button.dataset.tickPreset === this.selectedTickPresetId);
    }

    this.createButton.disabled = connected || busy || !supported;
    // Joining is format-independent (you adopt the room's settings), so it isn't gated by `supported`.
    this.joinButton.disabled = connected || busy;
    this.leaveButton.disabled = !connected && !busy;
    this.copyButton.disabled = !connected || !this.client.roomId;
    this.root.classList.toggle('multiplayer-modal--name-ready', nameReady);
    this.createButton.textContent = busy ? 'Creating...' : supported ? `Create ${this.selectedMode}` : '2v2 Soon';
    this.joinButton.textContent = busy ? 'Joining...' : 'Join';
    this.createButton.disabled = this.createButton.disabled || !nameReady;
    this.joinButton.disabled = this.joinButton.disabled || !nameReady;
    this.joinInput.disabled = connected || busy || !nameReady;

    // Compact HUD only while the menu is CLOSED. When the player deliberately reopens it (modalOpen),
    // show the full control surface so settings/vote controls are clearly interactive — even mid-match.
    const compact = connected && !busy && this.client.status !== 'error' && !reportOpen && !liveMatch && !this.modalOpen && !this.settingsOpen;
    this.root.classList.toggle('multiplayer-modal--compact', compact);
    this.root.classList.toggle('multiplayer-modal--live', liveMatch);
    this.root.classList.toggle('multiplayer-modal--postmatch', reportOpen);
    this.root.classList.toggle('multiplayer-modal--connected', connected);
    this.root.classList.toggle('multiplayer-modal--settings-open', this.settingsOpen);
    const shouldShow = (!liveMatch && (this.settingsOpen || this.modalOpen || connected)) || busy || this.client.status === 'error' || reportOpen;
    this.root.classList.toggle('multiplayer-modal--hidden', !shouldShow);
    this.syncLockOverlaySuppression();
  }

  private createRoom = (): void => {
    if (!this.modeSupported(this.selectedMode)) return;
    if (this.nameInput.value.trim().length === 0) return;
    this.runWithFullscreenCheck(() => this.client.createRoom(this.nameInput.value, this.selectedMode, this.selectedTickPresetId));
  };

  private joinRoom = (): void => {
    if (!this.modeSupported(this.selectedMode)) return;
    if (this.nameInput.value.trim().length === 0) return;
    this.runWithFullscreenCheck(() => this.client.joinRoom(this.joinInput.value, this.nameInput.value));
  };

  private leaveRoom = (): void => {
    this.client.leave();
    this.lastCompletedMatchKey = '';
    this.modalOpen = true;
    this.settingsOpen = false;
    this.update();
  };

  private close = (): void => {
    if (this.client.status === 'connecting') return;
    if (this.client.status === 'error') this.client.leave();
    this.modalOpen = false;
    this.settingsOpen = false;
    this.awaitingInteractReleaseFocus = false;
    this.blurInputs();
    this.hideFullscreenPrompt();
    this.update();
  };

  /**
   * Drop focus from the name/code fields so closing the menu hands keyboard control back to gameplay.
   * Without this a still-focused text field would keep swallowing key presses as text entry, so
   * gameplay wouldn't resume even after the overlay is hidden.
   */
  private blurInputs(): void {
    this.nameInput.blur();
    this.joinInput.blur();
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
  }

  // Escape closes the portal overlay only (settings sub-panel first, then the menu). It never reaches
  // gameplay. Other keys are left to the focused field / the gameplay input guard in InputManager.
  private onPortalKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (this.settingsOpen) {
      event.preventDefault();
      this.settingsOpen = false;
      this.update();
      return;
    }
    if (this.modalOpen) {
      event.preventDefault();
      this.close();
    }
  };

  private copyRoomCode = (event?: MouseEvent): void => {
    event?.preventDefault();
    event?.stopPropagation();
    const code = this.client.roomId;
    if (!code) return;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code)
        .then(() => this.flashCopied())
        .catch(() => {
          if (copyTextFallback(code)) this.flashCopied();
          else this.flashCopyFailed();
        });
      return;
    }
    if (copyTextFallback(code)) this.flashCopied();
    else this.flashCopyFailed();
  };

  private copyRoomCodeToButton(button: HTMLButtonElement): void {
    const code = this.client.roomId;
    if (!code) return;
    const onSuccess = (): void => this.flashButtonText(button, 'Copied');
    const onFailure = (): void => this.flashButtonText(button, 'Copy Failed');
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code)
        .then(onSuccess)
        .catch(() => {
          if (copyTextFallback(code)) onSuccess();
          else onFailure();
        });
      return;
    }
    if (copyTextFallback(code)) onSuccess();
    else onFailure();
  }

  private onJoinKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.joinRoom();
  };

  private onNameInput = (): void => {
    this.update();
  };

  private onModeClick = (event: Event): void => {
    const target = event.currentTarget as HTMLButtonElement;
    const mode = target.dataset.mode;
    if (mode !== '1v1' && mode !== '2v2') return;
    this.selectedMode = mode;
    this.update();
  };

  private onTickPresetClick = (event: Event): void => {
    const target = event.currentTarget as HTMLButtonElement;
    this.selectedTickPresetId = tickPresetById(target.dataset.tickPreset).id;
    this.update();
  };

  private onRootClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    // Unified room-control surface: presets, host settings steppers, host start, early-end vote.
    const control = target.closest<HTMLButtonElement>('.multiplayer-control');
    if (control) {
      event.preventDefault();
      this.handleControlAction(control);
      return;
    }

    const voteButton = target.closest<HTMLButtonElement>('.multiplayer-start-vote');
    if (voteButton) {
      event.preventDefault();
      this.client.requestStartVote();
      return;
    }

    const switchButton = target.closest<HTMLButtonElement>('.multiplayer-switch');
    if (switchButton) {
      event.preventDefault();
      const teamId = switchButton.dataset.teamId;
      const slotIndex = switchButton.dataset.slotIndex;
      if (!teamId) return;
      this.client.requestSwitchTeam(teamId, slotIndex === undefined ? undefined : Number(slotIndex));
      return;
    }

    const postmatchButton = target.closest<HTMLButtonElement>('.multiplayer-postmatch-action');
    if (postmatchButton) {
      event.preventDefault();
      const action = postmatchButton.dataset.postmatchAction;
      if (action === 'copy-code') {
        this.copyRoomCodeToButton(postmatchButton);
        return;
      }
      if (action === 'leave-lobby') {
        this.client.leave();
        this.modalOpen = true;
        this.lastCompletedMatchKey = '';
        this.update();
        return;
      }
      if (action === 'rematch') {
        this.client.requestReset('same-teams');
        return;
      }
      if (action === 'reshuffle') {
        this.client.requestReset('reset-teams');
        return;
      }
      if (action === 'next-round') {
        this.client.requestIntermissionVote('next-round');
        return;
      }
      if (action === 'to-lobby') {
        this.client.requestIntermissionVote('to-lobby');
      }
      return;
    }

    const resetButton = target.closest<HTMLButtonElement>('.multiplayer-reset-action');
    if (!resetButton) return;
    event.preventDefault();
    const mode = resetButton.dataset.resetMode;
    if (mode !== 'same-teams' && mode !== 'reset-teams') return;
    this.client.requestReset(mode);
  };

  /** Dispatch a click on a room-control button (preset / setting stepper / start / end-vote). */
  private handleControlAction(control: HTMLButtonElement): void {
    const action = control.dataset.action;
    if (action === 'open-settings') {
      this.settingsOpen = true;
      this.modalOpen = false;
      this.update();
      return;
    }
    if (action === 'close-settings') {
      this.settingsOpen = false;
      this.update();
      return;
    }
    if (action === 'start-match') {
      this.settingsOpen = false;
      this.client.requestStartMatch();
      return;
    }
    if (action === 'end-vote') {
      this.client.requestEndVote();
      return;
    }
    if (action === 'preset') {
      const preset = control.dataset.preset;
      if (preset === '1v1-recommended' || preset === '2v2-recommended') this.client.requestPreset(preset);
      return;
    }

    const room = this.client.latestSnapshot?.room;
    if (!room) return;

    if (action === 'set') {
      const field = control.dataset.field as StepField | undefined;
      const delta = Number(control.dataset.delta ?? 0);
      if (!field || !(field in SETTING_FIELDS) || !delta) return;
      const cfg = SETTING_FIELDS[field];
      const current = room.settings[field];
      const next = Math.min(cfg.limit.max, Math.max(cfg.limit.min, current + delta * cfg.step));
      if (next !== current) this.client.requestRoomSettings({ [field]: next } as RoomSettingsPatch);
      return;
    }

    if (action === 'mat') {
      const delta = Number(control.dataset.delta ?? 0);
      const idx = ALLOWED_MAT_PRESETS.indexOf(room.settings.matPreset);
      const base = idx < 0 ? 0 : idx;
      const nextIdx = Math.min(ALLOWED_MAT_PRESETS.length - 1, Math.max(0, base + (delta > 0 ? 1 : -1)));
      const next = ALLOWED_MAT_PRESETS[nextIdx];
      if (next !== room.settings.matPreset) this.client.requestRoomSettings({ matPreset: next });
    }
  }

  private onPortalFocusKeyUp = (event: KeyboardEvent): void => {
    if (!this.awaitingInteractReleaseFocus || !this.modalOpen) return;
    if (event.code !== 'KeyE') return;
    this.awaitingInteractReleaseFocus = false;
    this.joinInput.focus();
    this.joinInput.select();
  };

  private runWithFullscreenCheck(action: () => Promise<void>): void {
    if (isLikelyFullscreen()) {
      void action().finally(() => {
        if (this.client.connected) this.modalOpen = false;
        this.update();
      });
      return;
    }
    this.pendingAction = action;
    this.fullscreenPrompt.classList.remove('fullscreen-prompt--hidden');
  }

  private continueAfterFullscreenWarning = (): void => {
    const action = this.pendingAction;
    this.hideFullscreenPrompt();
    if (!action) return;
    void action().finally(() => {
      if (this.client.connected) this.modalOpen = false;
      this.update();
    });
  };

  private requestFullscreen = (): void => {
    if (typeof document.documentElement.requestFullscreen !== 'function') {
      this.noticeValue.textContent = 'Fullscreen is not available in this browser. You can still continue.';
      return;
    }
    const result = document.documentElement.requestFullscreen();
    if (result && typeof result.then === 'function') {
      result.catch(() => {
        this.noticeValue.textContent = 'Fullscreen was blocked. Try again from the browser UI or continue windowed.';
      });
    }
  };

  private cancelFullscreenWarning = (): void => {
    this.hideFullscreenPrompt();
    this.update();
  };

  private hideFullscreenPrompt(): void {
    this.pendingAction = null;
    this.fullscreenPrompt.classList.add('fullscreen-prompt--hidden');
    this.syncLockOverlaySuppression();
  }

  private modeSupported(mode: LobbyMode): boolean {
    return mode === '1v1' || GAME_CONSTANTS.match.playersPerTeam >= 2;
  }

  private syncLockOverlaySuppression(): void {
    const reportOpen = this.client.connected &&
      (this.client.latestSnapshot?.room.match.status === 'complete' || this.client.latestSnapshot?.room.match.status === 'intermission');
    const suppress = this.modalOpen || this.settingsOpen || reportOpen || !this.fullscreenPrompt.classList.contains('fullscreen-prompt--hidden');
    this.input.setLockSuppressed(suppress);
  }

  private flashCopied(): void {
    this.copyButton.textContent = 'Copied';
    window.setTimeout(() => {
      if (this.copyButton.isConnected) this.copyButton.textContent = 'Copy';
    }, 900);
  }

  private flashCopyFailed(): void {
    this.copyButton.textContent = 'Copy failed';
    window.setTimeout(() => {
      if (this.copyButton.isConnected) this.copyButton.textContent = 'Copy';
    }, 1200);
  }

  private flashButtonText(button: HTMLButtonElement, text: string): void {
    const original = button.textContent ?? '';
    button.textContent = text;
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = original;
    }, 900);
  }

  private mustQuery<T extends Element>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`Missing multiplayer overlay element: ${selector}`);
    return el;
  }
}

function copyTextFallback(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }

  textarea.remove();
  if (selection) {
    selection.removeAllRanges();
    if (previousRange) selection.addRange(previousRange);
  }
  return copied;
}

function friendlyError(message: string): string {
  if (!message) return '';
  if (/not found|room/i.test(message)) return 'Room not found. Check the code and try again.';
  if (/timeout|closed|abnormal|network|websocket/i.test(message)) return 'Connection hiccup. Try again or create a new room.';
  if (/full|seat/i.test(message)) return 'That room is full. Create a fresh duel.';
  return message;
}

function isLikelyFullscreen(): boolean {
  if (document.fullscreenElement) return true;
  const widthDelta = Math.abs(window.innerWidth - screen.availWidth);
  const heightDelta = Math.abs(window.innerHeight - screen.availHeight);
  return widthDelta <= 8 && heightDelta <= 8;
}

function summarizeRoom(room: RoomState | null, localPlayerId: string): {
  key: string;
  statusLabel: string;
  capacityLabel: string;
  rosterHtml: string;
  settingsEntryHtml: string;
  controlsHtml: string;
  settingsHtml: string;
  pregameHtml: string;
  resetHtml: string;
  postmatchHtml: string;
  noticeText: string;
} {
  if (!room) {
    return {
      key: 'practice',
      statusLabel: 'practice',
      capacityLabel: '0 / 0',
      rosterHtml: '',
      settingsEntryHtml: '',
      controlsHtml: '',
      settingsHtml: '',
      pregameHtml: '',
      resetHtml: '',
      postmatchHtml: '',
      noticeText: 'Warm up in the practice court, then create or join a room.'
    };
  }

  const players = Object.values(room.players).sort(compareRosterPlayers);
  const maxPlayers = room.match.maxPlayers;
  const missingSeats = Math.max(0, maxPlayers - players.length);
  const disconnected = players.filter((player) => player.connected === false);
  const local = room.players[localPlayerId];
  const localTeamId = local?.teamId ?? room.match.teamIds[0] ?? 'blue';
  const yourTeam = players.filter((player) => player.teamId === localTeamId);
  const opponentTeam = players.filter((player) => player.teamId !== localTeamId);
  const statusLabel = disconnected.length > 0
    ? 'reconnect pending'
    : room.match.status === 'warmup'
      ? 'waiting'
      : room.match.status === 'countdown'
        ? 'countdown'
        : room.match.status === 'complete'
          ? 'complete'
          : 'connected';

  let noticeText = 'Teams ready.';
  if (disconnected.length > 0) {
    noticeText = disconnected
      .map((player) => `${player.name} ${formatReconnectSeconds(player.reconnectDeadlineAtMs)}s`)
      .join(' · ');
  } else if (room.match.mode === '2v2' && room.match.status === 'warmup') {
    const choicesReady = room.startVote.requiredTeamChoices > 0 &&
      room.startVote.teamChoiceCount >= room.startVote.requiredTeamChoices;
    noticeText = choicesReady && room.startVote.requiredVotes > 0
      ? `Start vote ${room.startVote.voteCount}/${room.startVote.requiredVotes}.`
      : `Choose teams ${room.startVote.teamChoiceCount}/${room.startVote.requiredTeamChoices}.`;
  } else if (missingSeats > 0) {
    noticeText = `Waiting for ${missingSeats} more player${missingSeats === 1 ? '' : 's'}.`;
  } else if (room.match.status === 'countdown') {
    noticeText = `Teams locked. Round starts in ${Math.max(1, Math.ceil(room.match.countdownSeconds))}s.`;
  } else if (room.match.status === 'complete') {
    noticeText = room.match.mode === '2v2'
      ? 'Review the report card, vote rematch or change teams, or head back to the lobby.'
      : 'Review the report card, vote rematch, or head back to the lobby.';
  }

  const rosterHtml = `
    <div class="multiplayer-room-summary__line"><strong>${room.match.mode === '2v2' ? 'Your Team' : 'You'}</strong> ${formatRoster(yourTeam, room.match.playersPerTeam, localPlayerId)}</div>
    <div class="multiplayer-room-summary__line"><strong>${room.match.mode === '2v2' ? 'Opponents' : 'Opponent'}</strong> ${formatRoster(opponentTeam, room.match.playersPerTeam, localPlayerId)}</div>
  `;
  const pregameHtml = buildPregameHtml(room, localPlayerId);
  const resetHtml = buildResetControlsHtml(room, localPlayerId);
  const postmatchHtml = buildPostmatchHtml(room, localPlayerId);
  const settingsEntryHtml = buildSettingsEntryHtml(room);
  const controlsHtml = buildControlsHtml(room, localPlayerId);
  const settingsHtml = buildSettingsHtml(room, localPlayerId);

  const s = room.settings;
  return {
    key: [
      room.match.mode,
      room.match.status,
      room.match.countdownSeconds.toFixed(0),
      room.netMode,
      room.phase,
      room.hostPlayerId ?? '',
      room.match.currentRound,
      room.match.roundCount,
      Object.entries(room.match.roundsWonByTeamId).map(([t, w]) => `${t}:${w}`).join(','),
      s.preset,
      s.format,
      s.livesPerPlayer,
      s.dodgeballCount,
      s.maxLiveBallBounces,
      s.matPreset,
      s.roundCount,
      s.halfCourtTimerSeconds,
      room.endVote.active ? 1 : 0,
      room.endVote.voteCount,
      room.endVote.requiredVotes,
      Object.keys(room.endVote.votesByPlayerId).sort().join(','),
      room.resetVote.mode,
      room.resetVote.voteCount,
      room.resetVote.requiredVotes,
      Object.keys(room.resetVote.votesByPlayerId).sort().join(','),
      room.startVote.voteCount,
      room.startVote.requiredVotes,
      Object.keys(room.startVote.votesByPlayerId).sort().join(','),
      room.startVote.teamChoiceCount,
      room.startVote.requiredTeamChoices,
      Object.keys(room.startVote.teamChoicesByPlayerId).sort().join(','),
      room.intermissionVote.active ? 1 : 0,
      room.intermissionVote.allowsNextRound ? 1 : 0,
      room.intermissionVote.nextRoundCount,
      room.intermissionVote.toLobbyCount,
      room.intermissionVote.requiredVotes,
      Object.keys(room.intermissionVote.nextRoundByPlayerId).sort().join(','),
      Object.keys(room.intermissionVote.toLobbyByPlayerId).sort().join(','),
      players.length,
      maxPlayers,
      disconnected.map((player) => `${player.id}:${formatReconnectSeconds(player.reconnectDeadlineAtMs)}`).join(','),
      players.map((player) =>
        [
          player.id,
          player.connected ? 1 : 0,
          player.teamId,
          player.teamSlotIndex,
          player.name,
          player.score,
          player.lives,
          player.matchStats.hits,
          player.matchStats.hitsTaken,
          player.matchStats.catches,
          player.matchStats.parries,
          player.matchStats.saves
        ].join(':')
      ).join('|')
    ].join('~'),
    statusLabel,
    capacityLabel: `${players.length} / ${maxPlayers}`,
    rosterHtml,
    settingsEntryHtml,
    controlsHtml,
    settingsHtml,
    pregameHtml,
    resetHtml,
    postmatchHtml,
    noticeText
  };
}

function formatRoster(players: RoomState['players'][string][], slotsPerTeam: number, localPlayerId: string): string {
  const names = players.map((player) => {
    const suffix = player.id === localPlayerId ? ' (You)' : player.connected === false ? ' (DC)' : '';
    return `${escapeHtml(player.name)}${suffix}`;
  });
  while (names.length < slotsPerTeam) names.push('<span class="multiplayer-room-summary__open">Open</span>');
  return names.join(' / ');
}

/** Names of the players who cast a vote, for showing who picked which option in the vote counter. */
function votersLabel(room: RoomState, votesByPlayerId: Record<string, true>): string {
  const names = Object.keys(votesByPlayerId)
    .map((playerId) => room.players[playerId]?.name)
    .filter((name): name is string => !!name);
  return names.length > 0 ? escapeHtml(names.join(', ')) : '';
}

function formatVoteTally(count: number, requiredVotes: number): string {
  return requiredVotes > 0 ? ` ${count}/${requiredVotes}` : '';
}

function formatReconnectSeconds(deadlineAtMs: number | null): number {
  if (!deadlineAtMs) return 0;
  return Math.max(0, Math.ceil((deadlineAtMs - Date.now()) / 1000));
}

function compareRosterPlayers(a: RoomState['players'][string], b: RoomState['players'][string]): number {
  if (a.teamId !== b.teamId) return a.teamId.localeCompare(b.teamId);
  if (a.teamSlotIndex !== b.teamSlotIndex) return a.teamSlotIndex - b.teamSlotIndex;
  return a.id.localeCompare(b.id);
}

function isLiveMatch(room: RoomState | null): boolean {
  if (!room) return false;
  return room.match.status === 'countdown' || room.match.status === 'playing';
}

/** Host-editable numeric settings: their validated range + UI step + unit, shared by render + click. */
type StepField = 'livesPerPlayer' | 'dodgeballCount' | 'maxLiveBallBounces' | 'roundCount' | 'halfCourtTimerSeconds';
const SETTING_FIELDS: Record<StepField, { limit: { min: number; max: number }; step: number; unit: string; label: string }> = {
  livesPerPlayer: { limit: ROOM_SETTINGS_LIMITS.lives, step: 1, unit: '', label: 'Lives' },
  dodgeballCount: { limit: ROOM_SETTINGS_LIMITS.dodgeballs, step: 1, unit: '', label: 'Dodgeballs' },
  maxLiveBallBounces: { limit: ROOM_SETTINGS_LIMITS.bounces, step: 1, unit: '', label: 'Max bounces' },
  roundCount: { limit: ROOM_SETTINGS_LIMITS.rounds, step: 1, unit: '', label: 'Rounds' },
  halfCourtTimerSeconds: { limit: ROOM_SETTINGS_LIMITS.halfCourtTimer, step: 15, unit: 's', label: 'Half timer' }
};

function presetLabel(preset: MatchPresetId): string {
  return preset === 'custom' ? 'Custom' : 'Recommended';
}

function tickPresetDisplay(netMode: RoomState['netMode']): string {
  const preset = tickPresetForNetMode(netMode);
  return preset ? escapeHtml(preset.label) : escapeHtml(netMode);
}

function textRow(label: string, text: string): string {
  return `<div class="multiplayer-controls__row"><span class="multiplayer-controls__label">${label}</span><span class="multiplayer-controls__field"><span class="multiplayer-controls__val">${text}</span></span></div>`;
}

function stepRow(label: string, value: number, field: StepField | null, editable: boolean, unit: string): string {
  const display = `<span class="multiplayer-controls__val">${value}${unit}</span>`;
  if (!editable || !field) {
    return `<div class="multiplayer-controls__row"><span class="multiplayer-controls__label">${label}</span><span class="multiplayer-controls__field">${display}</span></div>`;
  }
  const cfg = SETTING_FIELDS[field];
  const minOff = value <= cfg.limit.min ? 'disabled' : '';
  const maxOff = value >= cfg.limit.max ? 'disabled' : '';
  const controls =
    `<button class="multiplayer-control multiplayer-step" data-action="set" data-field="${field}" data-delta="-1" type="button" ${minOff}>−</button>` +
    display +
    `<button class="multiplayer-control multiplayer-step" data-action="set" data-field="${field}" data-delta="1" type="button" ${maxOff}>+</button>`;
  return `<div class="multiplayer-controls__row"><span class="multiplayer-controls__label">${label}</span><span class="multiplayer-controls__field">${controls}</span></div>`;
}

function matRow(value: number, editable: boolean): string {
  const text = `${value} mat${value === 1 ? '' : 's'}`;
  const display = `<span class="multiplayer-controls__val">${text}</span>`;
  if (!editable) {
    return `<div class="multiplayer-controls__row"><span class="multiplayer-controls__label">Mats</span><span class="multiplayer-controls__field">${display}</span></div>`;
  }
  const controls =
    `<button class="multiplayer-control multiplayer-step" data-action="mat" data-delta="-1" type="button">−</button>` +
    display +
    `<button class="multiplayer-control multiplayer-step" data-action="mat" data-delta="1" type="button">+</button>`;
  return `<div class="multiplayer-controls__row"><span class="multiplayer-controls__label">Mats</span><span class="multiplayer-controls__field">${controls}</span></div>`;
}

function buildSettingsEntryHtml(room: RoomState): string {
  if (room.match.status !== 'warmup') return '';
  return `
    <button class="multiplayer-control multiplayer-settings-entry__button" data-action="open-settings" type="button">
      Match Settings
    </button>
  `;
}

/**
 * Unified room control surface (Stage 4): the authoritative settings, host identity, room code, round
 * progress, and the lifecycle actions (host start, host/guest early-end vote). The host sees editable
 * steppers + a preset button when between games; guests see the same values read-only. The server is
 * the source of truth — every control just sends a request that the server validates.
 */
function buildControlsHtml(room: RoomState, localPlayerId: string): string {
  const isHost = !!room.hostPlayerId && room.hostPlayerId === localPlayerId;
  const hostName = room.hostPlayerId ? (room.players[room.hostPlayerId]?.name ?? '—') : '—';
  const s = room.settings;
  const live = room.match.status === 'countdown' || room.match.status === 'playing';
  const connectedCount = Object.values(room.players).filter((player) => player.connected !== false).length;
  const endVoteRequirement = votesRequiredForPass(connectedCount);
  // Settings may be edited only between games (lobby / match summary), mirroring the server gate.
  const editable = isHost && (room.match.status === 'warmup' || room.match.status === 'complete');

  const permission = isHost
    ? `<span class="multiplayer-host-badge">You are the host</span>`
    : `<span class="multiplayer-guest-badge">Host: ${escapeHtml(hostName)} · view only</span>`;

  const rows = [
    textRow('Format', escapeHtml(s.format.toUpperCase())),
    textRow('Preset', presetLabel(s.preset)),
    textRow('Tick preset', tickPresetDisplay(room.netMode)),
    stepRow(SETTING_FIELDS.livesPerPlayer.label, s.livesPerPlayer, 'livesPerPlayer', editable, ''),
    stepRow(SETTING_FIELDS.dodgeballCount.label, s.dodgeballCount, 'dodgeballCount', editable, ''),
    stepRow(SETTING_FIELDS.maxLiveBallBounces.label, s.maxLiveBallBounces, 'maxLiveBallBounces', editable, ''),
    stepRow(SETTING_FIELDS.roundCount.label, s.roundCount, 'roundCount', editable, ''),
    stepRow(SETTING_FIELDS.halfCourtTimerSeconds.label, s.halfCourtTimerSeconds, 'halfCourtTimerSeconds', editable, 's'),
    matRow(s.matPreset, editable)
  ].join('');

  const presetId: MatchPresetId = s.format === '2v2' ? '2v2-recommended' : '1v1-recommended';
  const presetBtn = editable && s.preset === 'custom'
    ? `<button class="multiplayer-control" data-action="preset" data-preset="${presetId}" type="button">Reset to ${escapeHtml(s.format)} recommended</button>`
    : '';

  const startBtn = isHost && room.match.status === 'warmup'
    ? `<button class="multiplayer-control multiplayer-control--primary" data-action="start-match" type="button">Start Match</button>`
    : '';

  let endVoteHtml = '';
  if (live) {
    if (!room.endVote.active) {
      endVoteHtml = isHost
        ? `<button class="multiplayer-control multiplayer-control--danger" data-action="end-vote" type="button">Call End Vote${formatVoteTally(0, endVoteRequirement)}</button>`
        : `<div class="multiplayer-controls__hint">The host can call a vote to end the game early.</div>`;
    } else {
      const hasVoted = !!room.endVote.votesByPlayerId[localPlayerId];
      const tally = `End-game vote ${room.endVote.voteCount}/${room.endVote.requiredVotes}`;
      const action = hasVoted
        ? `<span class="multiplayer-controls__hint">You voted to end — waiting for the rest.</span>`
        : `<button class="multiplayer-control multiplayer-control--danger" data-action="end-vote" type="button">Agree to End${formatVoteTally(room.endVote.voteCount, room.endVote.requiredVotes)}</button>`;
      endVoteHtml = `<div class="multiplayer-controls__vote">${tally} ${action}</div>`;
    }
  }

  const lockNote = isHost && live
    ? `<div class="multiplayer-controls__hint">Settings are locked during a live game.</div>`
    : !isHost
      ? `<div class="multiplayer-controls__hint">Only the host can change settings.</div>`
      : '';

  const roundInfo = `Round ${room.match.currentRound} / ${room.match.roundCount}`;
  const compactSummary = `${escapeHtml(s.format.toUpperCase())} - ${tickPresetDisplay(room.netMode)} - ${s.livesPerPlayer} lives - ${s.dodgeballCount} balls - ${s.roundCount} round${s.roundCount === 1 ? '' : 's'}`;

  return `
    <div class="multiplayer-controls__panel multiplayer-controls__panel--compact" data-editable="${editable ? '1' : '0'}">
      <div class="multiplayer-controls__head">
        <span class="multiplayer-controls__title">Match Controls</span>
        ${permission}
      </div>
      <div class="multiplayer-controls__meta">Code <strong>${escapeHtml(room.id)}</strong> · ${roundInfo}</div>
      <div class="multiplayer-controls__summary">${compactSummary}</div>
      <div class="multiplayer-controls__actions">${startBtn}${endVoteHtml}</div>
      ${lockNote}
    </div>
  `;
}

function buildSettingsHtml(room: RoomState, localPlayerId: string): string {
  if (room.match.status !== 'warmup') return '';
  const isHost = !!room.hostPlayerId && room.hostPlayerId === localPlayerId;
  const hostName = room.hostPlayerId ? (room.players[room.hostPlayerId]?.name ?? '—') : '—';
  const s = room.settings;
  const editable = isHost;
  const permission = isHost
    ? `<span class="multiplayer-host-badge">You are the host</span>`
    : `<span class="multiplayer-guest-badge">Host: ${escapeHtml(hostName)} · view only</span>`;
  const rows = [
    textRow('Format', escapeHtml(s.format.toUpperCase())),
    textRow('Preset', presetLabel(s.preset)),
    textRow('Tick preset', tickPresetDisplay(room.netMode)),
    stepRow(SETTING_FIELDS.livesPerPlayer.label, s.livesPerPlayer, 'livesPerPlayer', editable, ''),
    stepRow(SETTING_FIELDS.dodgeballCount.label, s.dodgeballCount, 'dodgeballCount', editable, ''),
    stepRow(SETTING_FIELDS.maxLiveBallBounces.label, s.maxLiveBallBounces, 'maxLiveBallBounces', editable, ''),
    stepRow(SETTING_FIELDS.roundCount.label, s.roundCount, 'roundCount', editable, ''),
    stepRow(SETTING_FIELDS.halfCourtTimerSeconds.label, s.halfCourtTimerSeconds, 'halfCourtTimerSeconds', editable, 's'),
    matRow(s.matPreset, editable)
  ].join('');
  const presetId: MatchPresetId = s.format === '2v2' ? '2v2-recommended' : '1v1-recommended';
  const presetBtn = editable && s.preset === 'custom'
    ? `<button class="multiplayer-control" data-action="preset" data-preset="${presetId}" type="button">Reset to ${escapeHtml(s.format)} recommended</button>`
    : '';
  const startBtn = isHost
    ? `<button class="multiplayer-control multiplayer-control--primary" data-action="start-match" type="button">Start Match</button>`
    : '';
  const lockNote = !isHost
    ? `<div class="multiplayer-controls__hint">Only the host can change settings.</div>`
    : '';
  return buildSettingsMenuHtml({
    room,
    permission,
    rows,
    presetBtn,
    startBtn,
    lockNote,
    roundInfo: `Round ${room.match.currentRound} / ${room.match.roundCount}`,
    editable
  });
}

function buildSettingsMenuHtml(args: {
  room: RoomState;
  permission: string;
  rows: string;
  presetBtn: string;
  startBtn: string;
  lockNote: string;
  roundInfo: string;
  editable: boolean;
}): string {
  const { room, permission, rows, presetBtn, startBtn, lockNote, roundInfo, editable } = args;
  return `
    <div class="multiplayer-settings-menu" role="dialog" aria-modal="true" aria-label="Match settings">
      <div class="multiplayer-settings-menu__shade"></div>
      <div class="multiplayer-settings-menu__panel" data-editable="${editable ? '1' : '0'}">
        <div class="multiplayer-settings-menu__header">
          <div>
            <div class="multiplayer-settings-menu__kicker">Private Match</div>
            <div class="multiplayer-settings-menu__title">Match Settings</div>
          </div>
          <button class="multiplayer-control multiplayer-settings-menu__close" data-action="close-settings" type="button" aria-label="Close settings">x</button>
        </div>
        <div class="multiplayer-settings-menu__meta">
          <span>Code <strong>${escapeHtml(room.id)}</strong></span>
          <span>${roundInfo}</span>
          ${permission}
        </div>
        <div class="multiplayer-controls__grid multiplayer-settings-menu__grid">${rows}</div>
        <div class="multiplayer-controls__actions multiplayer-settings-menu__actions">${presetBtn}${startBtn}</div>
        ${lockNote}
      </div>
    </div>
  `;
}

/**
 * Single, simple centered "Start Game" button shared by both formats — every connected player
 * clicks it to cast a start vote; the server is authoritative on when the threshold is met.
 */
function buildStartButtonHtml(room: RoomState, localPlayerId: string): string {
  const choicesReady = room.startVote.requiredTeamChoices === 0 ||
    room.startVote.teamChoiceCount >= room.startVote.requiredTeamChoices;
  const localVoted = room.startVote.votesByPlayerId[localPlayerId] === true;
  const startEnabled = choicesReady && room.startVote.requiredVotes > 0 && !localVoted;
  const startLabel = localVoted ? 'Waiting...' : 'Start Game';
  const hint = !choicesReady
    ? 'Choose teams to unlock Start Game.'
    : room.startVote.requiredVotes === 0
      ? 'Waiting for an opponent...'
      : localVoted
        ? `Waiting on ${Math.max(0, room.startVote.requiredVotes - room.startVote.voteCount)} more player${room.startVote.requiredVotes - room.startVote.voteCount === 1 ? '' : 's'}...`
        : '';
  return `
    <div class="multiplayer-start-vote-wrap">
      <button class="multiplayer-start-vote multiplayer-start-vote--big" type="button"${startEnabled ? '' : ' disabled'}>${startLabel}</button>
      ${hint ? `<div class="multiplayer-start-vote-hint">${escapeHtml(hint)}</div>` : ''}
    </div>
  `;
}

function buildPregameHtml(room: RoomState, localPlayerId: string): string {
  if (room.match.status !== 'warmup') return '';

  if (room.match.mode !== '2v2') {
    return `
      <div class="multiplayer-pregame-card multiplayer-pregame-card--solo">
        ${buildStartButtonHtml(room, localPlayerId)}
      </div>
    `;
  }

  const teams = room.match.teamIds.map((teamId) => {
    const rows: string[] = [];
    for (let slotIndex = 0; slotIndex < room.match.playersPerTeam; slotIndex += 1) {
      const occupant = Object.values(room.players).find((player) => player.teamId === teamId && player.teamSlotIndex === slotIndex);
      const chosen = occupant ? room.startVote.teamChoicesByPlayerId[occupant.id] === true : false;
      const status = occupant
        ? occupant.connected === false
          ? 'Disconnected'
          : occupant.combatState === 'eliminated'
            ? 'Eliminated'
            : chosen
              ? 'Chosen'
              : 'Choose team'
        : 'Open';
      const buttonLabel = occupant?.id === localPlayerId
        ? chosen ? 'Chosen' : 'Choose'
        : occupant ? 'Swap' : 'Join';
      rows.push(`
        <div class="multiplayer-slot-row${chosen ? ' multiplayer-slot-row--chosen' : ''}">
          <div>
            <strong>${escapeHtml(teamId.toUpperCase())} ${slotIndex + 1}</strong>
            <span>${occupant ? `${escapeHtml(occupant.name)} · ${status}` : 'Open slot'}</span>
          </div>
          <button class="multiplayer-switch" type="button" data-team-id="${escapeHtml(teamId)}" data-slot-index="${slotIndex}">${buttonLabel}</button>
        </div>
      `);
    }
    return rows.join('');
  }).join('');

  return `
    <div class="multiplayer-pregame-card">
      <div class="multiplayer-pregame-title">Pre-Game Teams</div>
      <div class="multiplayer-pregame-slots">${teams}</div>
      ${buildStartButtonHtml(room, localPlayerId)}
    </div>
  `;
}

function buildResetControlsHtml(room: RoomState, localPlayerId: string): string {
  if (room.match.mode !== '2v2' || room.match.status === 'complete') return '';
  const sameTeamsVoted = room.resetVote.mode === 'same-teams' && room.resetVote.votesByPlayerId[localPlayerId] === true;
  const resetTeamsVoted = room.resetVote.mode === 'reset-teams' && room.resetVote.votesByPlayerId[localPlayerId] === true;
  const sameTeamsCount = room.resetVote.mode === 'same-teams' ? room.resetVote.voteCount : 0;
  const resetTeamsCount = room.resetVote.mode === 'reset-teams' ? room.resetVote.voteCount : 0;
  const resetVoters = votersLabel(room, room.resetVote.votesByPlayerId);
  const voteLabel = room.resetVote.requiredVotes > 0
    ? `Vote ${room.resetVote.voteCount}/${room.resetVote.requiredVotes} for ${room.resetVote.mode === 'reset-teams' ? 'reset teams' : 'reset match'}${resetVoters ? ` (${resetVoters})` : ''}`
    : 'Vote to reset';
  const sameTeamsLabel = sameTeamsVoted
    ? `Voted${formatVoteTally(sameTeamsCount, room.resetVote.requiredVotes)}`
    : `Match${formatVoteTally(sameTeamsCount, room.resetVote.requiredVotes)}`;
  const resetTeamsLabel = resetTeamsVoted
    ? `Voted${formatVoteTally(resetTeamsCount, room.resetVote.requiredVotes)}`
    : `Teams${formatVoteTally(resetTeamsCount, room.resetVote.requiredVotes)}`;
  return `
    <div class="multiplayer-reset-card">
      <div class="multiplayer-reset-copy">
        <div class="multiplayer-pregame-title">Reset Vote</div>
        <div class="multiplayer-reset-status">${voteLabel}</div>
      </div>
      <div class="multiplayer-reset-actions">
        <button class="multiplayer-reset-action" type="button" data-reset-mode="same-teams" aria-label="Vote reset match"${sameTeamsVoted ? ' disabled' : ''}>${sameTeamsLabel}</button>
        <button class="multiplayer-reset-action multiplayer-reset-action--alt" type="button" data-reset-mode="reset-teams" aria-label="Vote reset teams"${resetTeamsVoted ? ' disabled' : ''}>${resetTeamsLabel}</button>
      </div>
    </div>
  `;
}

/**
 * The report card, shown BOTH between rounds (status 'intermission') and after the match
 * (status 'complete'). Between rounds it offers a "Next Round" vote and a "Back to Lobby" vote;
 * after the match it offers Rematch / (Change Teams) / "To Lobby". Every vote button shows its live
 * tally and needs a 70% supermajority — the server is authoritative for the transition.
 */
function buildPostmatchHtml(room: RoomState, localPlayerId: string): string {
  const status = room.match.status;
  if (status !== 'complete' && status !== 'intermission') return '';
  const isFinal = status === 'complete';

  const players = Object.values(room.players).sort(compareRosterPlayers);
  const local = room.players[localPlayerId];
  const localTeamId = local?.teamId ?? room.match.teamIds[0] ?? 'blue';
  // Final match → the match winner; between rounds → the team that won THIS round (the side still
  // with an alive fighter; the loser is fully eliminated until the next round rebuilds the world).
  const roundWinnerTeamId = room.match.teamIds.find((teamId) =>
    players.some((player) => player.teamId === teamId && player.combatState !== 'eliminated' && player.lives > 0)
  ) ?? null;
  const winnerTeamId = (isFinal ? room.match.winnerTeamId : roundWinnerTeamId) ?? localTeamId;
  const localWon = local ? local.teamId === winnerTeamId : winnerTeamId === localTeamId;

  const eyebrow = isFinal ? 'Match Complete' : `Round ${room.match.currentRound} / ${room.match.roundCount}`;
  const title = isFinal ? (localWon ? 'Victory' : 'Defeat') : (localWon ? 'Round Won' : 'Round Lost');
  const subtitle = isFinal
    ? `${escapeHtml(winnerTeamId.toUpperCase())} team won the dodgeball match.`
    : `${escapeHtml(winnerTeamId.toUpperCase())} took the round. Series ${formatRoundLine(room)}.`;

  const iv = room.intermissionVote;
  const req = iv.requiredVotes;
  const nextRoundTally = formatVoteTally(iv.nextRoundCount, req);
  const toLobbyTally = formatVoteTally(iv.toLobbyCount, req);
  const nextVoted = iv.nextRoundByPlayerId[localPlayerId] === true;
  const lobbyVoted = iv.toLobbyByPlayerId[localPlayerId] === true;

  let actions: string;
  if (isFinal) {
    const rematchVoted = room.resetVote.mode === 'same-teams' && room.resetVote.votesByPlayerId[localPlayerId] === true;
    const rematchCount = room.resetVote.mode === 'same-teams' ? room.resetVote.voteCount : 0;
    actions = `
      <button class="multiplayer-postmatch-action" type="button" data-postmatch-action="rematch"${rematchVoted ? ' disabled' : ''}>${rematchVoted ? 'Rematch Voted' : 'Rematch'}${formatVoteTally(rematchCount, room.resetVote.requiredVotes)}</button>
      <button class="multiplayer-postmatch-action multiplayer-postmatch-action--paper" type="button" data-postmatch-action="to-lobby"${lobbyVoted ? ' disabled' : ''}>${lobbyVoted ? `Pregame Voted${toLobbyTally}` : `Pregame Lobby${toLobbyTally}`}</button>
      <button class="multiplayer-postmatch-action multiplayer-postmatch-action--copy" type="button" data-postmatch-action="copy-code">Copy Code</button>
    `;
  } else {
    actions = `
      <button class="multiplayer-postmatch-action" type="button" data-postmatch-action="next-round"${nextVoted ? ' disabled' : ''}>${nextVoted ? `Round Voted${nextRoundTally}` : `Next Round${nextRoundTally}`}</button>
      <button class="multiplayer-postmatch-action multiplayer-postmatch-action--paper" type="button" data-postmatch-action="to-lobby"${lobbyVoted ? ' disabled' : ''}>${lobbyVoted ? `Pregame Voted${toLobbyTally}` : `Pregame Lobby${toLobbyTally}`}</button>
      <button class="multiplayer-postmatch-action multiplayer-postmatch-action--copy" type="button" data-postmatch-action="copy-code">Copy Code</button>
    `;
  }

  const connectedCount = players.filter((player) => player.connected !== false).length;
  const voteHint = req > 0 ? `A vote passes at ${req} of ${connectedCount} players (70%).` : '';

  return `
    <div class="multiplayer-report-card multiplayer-report-card--compact multiplayer-report-card--${localWon ? 'win' : 'loss'}" data-mode="${room.match.mode}">
      <div class="multiplayer-report-card__top">
        <div>
          <div class="multiplayer-report-card__eyebrow">${eyebrow}</div>
          <div class="multiplayer-report-card__title">${title}</div>
          <div class="multiplayer-report-card__subtitle">${subtitle}</div>
        </div>
      </div>
      <div class="multiplayer-report-card__summary">
        <span><em>Room Code</em><strong>${escapeHtml(room.id)}</strong></span>
        <span><em>Series</em><strong>${formatRoundLine(room)}</strong></span>
        <span><em>${isFinal ? 'Winner' : 'Round'}</em><strong>${escapeHtml(winnerTeamId.toUpperCase())}</strong></span>
      </div>
      <div class="multiplayer-report-card__actions">${actions}</div>
      <div class="multiplayer-report-card__vote">${escapeHtml(voteHint)}</div>
    </div>
  `;
}

function buildReportTeamHtml(
  room: RoomState,
  teamId: string,
  localPlayerId: string,
  winnerTeamId: string,
  players: PlayerState[],
  isFinal: boolean
): string {
  const totals = players.reduce((acc, player) => {
    acc.hits += player.matchStats.hits;
    acc.hitsTaken += player.matchStats.hitsTaken;
    acc.catches += player.matchStats.catches;
    acc.parries += player.matchStats.parries;
    acc.lives += Math.max(0, player.lives);
    return acc;
  }, { hits: 0, hitsTaken: 0, catches: 0, parries: 0, lives: 0 });
  const isWinner = teamId === winnerTeamId;
  const teamMetric = room.match.roundsWonByTeamId[teamId] ?? 0;
  const teamLabel = room.match.mode === '2v2'
    ? `${escapeHtml(teamId.toUpperCase())} Team`
    : teamId === room.players[localPlayerId]?.teamId ? 'You' : 'Opponent';

  return `
    <div class="multiplayer-report-team multiplayer-report-team--${isWinner ? 'winner' : 'loser'}">
      <div class="multiplayer-report-team__header">
        <div>
          <strong>${teamLabel}</strong>
          <span>${isWinner ? (isFinal ? 'Won Match' : 'Won Round') : (isFinal ? 'Lost Match' : 'Lost Round')}</span>
        </div>
        <div class="multiplayer-report-team__score">${teamMetric}</div>
      </div>
      <div class="multiplayer-report-team__totals">
        <span><em>Hits</em><strong>${totals.hits}</strong></span>
        <span><em>Catches</em><strong>${totals.catches}</strong></span>
        <span><em>Parries</em><strong>${totals.parries}</strong></span>
        <span><em>Lives Lost</em><strong>${totals.hitsTaken}</strong></span>
        <span><em>Lives Left</em><strong>${totals.lives}</strong></span>
      </div>
      <div class="multiplayer-report-team__players">
        ${players.map((player) => buildReportPlayerHtml(room, player, localPlayerId, winnerTeamId)).join('')}
      </div>
    </div>
  `;
}

function buildReportPlayerHtml(room: RoomState, player: PlayerState, localPlayerId: string, winnerTeamId: string): string {
  const suffix = player.id === localPlayerId ? ' (You)' : player.connected === false ? ' (DC)' : '';
  // Both formats are lives-based now: show remaining lives (or Out), not the legacy 1v1 point count.
  const status = player.combatState === 'eliminated'
    ? 'Out'
    : `${player.lives} life${player.lives === 1 ? '' : 's'} left`;
  const grade = calculatePlayerReportGrade(room, player, winnerTeamId);

  return `
    <div class="multiplayer-report-player">
      <div class="multiplayer-report-player__main">
        <div>
          <strong>${escapeHtml(player.name)}${suffix}</strong>
          <span>${escapeHtml(status)}</span>
        </div>
        <div class="multiplayer-report-player__grade multiplayer-report-player__grade--${grade.band}" aria-label="Player grade ${grade.letter}, ${grade.percent} percent">
          <em>Grade</em>
          <strong>${grade.letter}</strong>
          <span>${grade.percent}%</span>
        </div>
      </div>
      <div class="multiplayer-report-player__stats">
        <span><em>Hits</em><strong>${player.matchStats.hits}</strong></span>
        <span><em>Catches</em><strong>${player.matchStats.catches}</strong></span>
        <span><em>Parries</em><strong>${player.matchStats.parries}</strong></span>
        <span><em>Lives Lost</em><strong>${player.matchStats.hitsTaken}</strong></span>
      </div>
    </div>
  `;
}

type ReportGradeBand = 'excellent' | 'good' | 'fair' | 'poor';

interface ReportGrade {
  letter: string;
  percent: number;
  band: ReportGradeBand;
}

function calculatePlayerReportGrade(room: RoomState, player: PlayerState, winnerTeamId: string): ReportGrade {
  const roundsWon = room.match.roundsWonByTeamId[player.teamId] ?? 0;
  const winningRounds = Math.max(1, ...room.match.teamIds.map((teamId) => room.match.roundsWonByTeamId[teamId] ?? 0));
  const scoreRatio = player.teamId === winnerTeamId ? 1 : Math.min(1, roundsWon / winningRounds);
  const scorePoints = scoreRatio * 60;
  const statRaw =
    player.matchStats.hits * 8 +
    player.matchStats.parries * 2 +
    player.matchStats.catches * 1 -
    player.matchStats.hitsTaken * 5;
  const statPoints = clampNumber(statRaw, 0, 40);
  const percent = Math.round(clampNumber(scorePoints + statPoints, 0, 100));
  return {
    letter: letterGrade(percent),
    percent,
    band: gradeBand(percent)
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function letterGrade(percent: number): string {
  if (percent >= 97) return 'A+';
  if (percent >= 93) return 'A';
  if (percent >= 90) return 'A-';
  if (percent >= 87) return 'B+';
  if (percent >= 83) return 'B';
  if (percent >= 80) return 'B-';
  if (percent >= 77) return 'C+';
  if (percent >= 73) return 'C';
  if (percent >= 70) return 'C-';
  if (percent >= 67) return 'D+';
  if (percent >= 63) return 'D';
  if (percent >= 60) return 'D-';
  return 'F';
}

function gradeBand(percent: number): ReportGradeBand {
  if (percent >= 90) return 'excellent';
  if (percent >= 80) return 'good';
  if (percent >= 70) return 'fair';
  return 'poor';
}

function describeResetVote(room: RoomState): string {
  const vote = room.resetVote;
  if (vote.requiredVotes <= 0 || vote.voteCount <= 0) {
    return 'All connected players need to agree before the next match begins.';
  }
  const voters = votersLabel(room, vote.votesByPlayerId);
  return `${vote.mode === 'reset-teams' ? 'Change teams' : 'Rematch'} vote: ${vote.voteCount}/${vote.requiredVotes}${voters ? ` (${voters})` : ''}.`;
}

/** Series result as rounds won per team (the unified win metric for both formats). */
function formatRoundLine(room: RoomState): string {
  return room.match.teamIds
    .map((teamId) => `${teamId.toUpperCase()} ${room.match.roundsWonByTeamId[teamId] ?? 0}`)
    .join(' - ');
}

/**
 * A key identifying "a report card the player should see": it changes on match completion AND on
 * each round end (intermission), so the menu auto-opens to show the round/match result each time.
 */
function completedMatchKey(room: RoomState | null): string | null {
  if (!room) return null;
  if (room.match.status === 'complete') {
    return `complete:${room.id}:${room.resetVote.resetSerial}:${room.match.winnerTeamId ?? 'none'}:${room.match.mode}`;
  }
  if (room.match.status === 'intermission') {
    return `intermission:${room.id}:${room.resetVote.resetSerial}:${room.match.currentRound}`;
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
