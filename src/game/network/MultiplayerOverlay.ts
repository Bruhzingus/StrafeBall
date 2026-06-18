import { GAME_CONSTANTS } from '../../../shared/constants';
import type { LobbyMode } from '../practice/LobbyModePortals';
import type { MatchMode, RoomState } from '../../../shared/types';
import { MultiplayerClient } from './MultiplayerClient';

type PendingAction = (() => Promise<void>) | null;
const LOCK_OVERLAY_SUPPRESSED_ATTR = 'data-suppress-lock-overlay';

const MODE_LABEL: Record<LobbyMode, string> = {
  '1v1': '1v1 Private Duel',
  '2v2': '2v2 Team Room'
};

export class MultiplayerOverlay {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly joinInput: HTMLInputElement;
  private readonly statusValue: HTMLSpanElement;
  private readonly roomValue: HTMLSpanElement;
  private readonly pingValue: HTMLSpanElement;
  private readonly capacityValue: HTMLSpanElement;
  private readonly rosterValue: HTMLDivElement;
  private readonly pregameValue: HTMLDivElement;
  private readonly resetValue: HTMLDivElement;
  private readonly noticeValue: HTMLDivElement;
  private readonly errorValue: HTMLDivElement;
  private readonly createButton: HTMLButtonElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly settingsDetails: HTMLDetailsElement;
  private readonly modeButtons: NodeListOf<HTMLButtonElement>;
  private readonly modeTitle: HTMLDivElement;
  private readonly modeSubtitle: HTMLDivElement;
  private readonly modeNotice: HTMLDivElement;
  private readonly fullscreenPrompt: HTMLDivElement;
  private readonly fullscreenContinue: HTMLButtonElement;
  private readonly fullscreenRequest: HTMLButtonElement;
  private readonly fullscreenCancel: HTMLButtonElement;
  private selectedMode: LobbyMode = '1v1';
  private modalOpen = false;
  private pendingAction: PendingAction = null;
  private awaitingInteractReleaseFocus = false;
  private lastRendered = {
    connected: false,
    busy: false,
    status: '',
    roomId: '',
    pingMs: undefined as number | null | undefined,
    errorMessage: '',
    selectedMode: null as LobbyMode | null,
    modalOpen: false,
    roomSummaryKey: ''
  };

  constructor(private readonly client: MultiplayerClient) {
    this.root = document.createElement('div');
    this.root.className = 'multiplayer-modal multiplayer-modal--hidden';
    this.root.setAttribute('data-no-lock', 'true');
    this.root.innerHTML = `
      <div class="multiplayer-modal__shade"></div>
      <div class="multiplayer-panel multiplayer-panel--lobby">
        <button class="multiplayer-close" type="button" aria-label="Close match menu">x</button>
        <div class="multiplayer-kicker">StrafeBall Lobby</div>
        <div class="multiplayer-title">Choose Match</div>
        <div class="multiplayer-subtitle">Use the practice court portals, then create a room or paste a code.</div>

        <details class="multiplayer-settings" open>
          <summary>Match settings</summary>
          <div class="multiplayer-mode-tabs">
            <button class="multiplayer-mode-tab" data-mode="1v1" type="button">1v1</button>
            <button class="multiplayer-mode-tab" data-mode="2v2" type="button">2v2</button>
          </div>

          <div class="multiplayer-mode-card">
            <div class="multiplayer-mode-title"></div>
            <div class="multiplayer-mode-subtitle"></div>
            <div class="multiplayer-mode-notice"></div>
          </div>

          <label class="multiplayer-field">
            <span>Player</span>
            <input class="multiplayer-name" maxlength="24" value="Player" />
          </label>
          <div class="multiplayer-actions multiplayer-actions--create">
            <button class="multiplayer-create">Create Room</button>
          </div>
          <label class="multiplayer-field multiplayer-field--join-code">
            <span>Room Code</span>
            <input class="multiplayer-join-code" placeholder="Paste code" />
          </label>
          <div class="multiplayer-actions multiplayer-actions--join">
            <button class="multiplayer-join">Join</button>
          </div>
          <div class="multiplayer-room-card">
            <div>
              <div class="multiplayer-card-label">Room Key</div>
              <div class="multiplayer-room">Practice</div>
            </div>
            <button class="multiplayer-copy" type="button">Copy</button>
          </div>
        </details>

        <div class="multiplayer-actions multiplayer-actions--leave">
          <button class="multiplayer-leave">Leave</button>
        </div>
        <div class="multiplayer-line multiplayer-line--status">Status <span class="multiplayer-status">practice</span></div>
        <div class="multiplayer-line multiplayer-line--ping">Ping <span class="multiplayer-ping">-</span></div>
        <div class="multiplayer-line">Capacity <span class="multiplayer-capacity">0 / 0</span></div>
        <div class="multiplayer-room-summary"></div>
        <div class="multiplayer-pregame"></div>
        <div class="multiplayer-reset"></div>
        <div class="multiplayer-room-notice"></div>
        <div class="multiplayer-error"></div>
      </div>

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
    this.statusValue = this.mustQuery<HTMLSpanElement>('.multiplayer-status');
    this.roomValue = this.mustQuery<HTMLSpanElement>('.multiplayer-room');
    this.pingValue = this.mustQuery<HTMLSpanElement>('.multiplayer-ping');
    this.capacityValue = this.mustQuery<HTMLSpanElement>('.multiplayer-capacity');
    this.rosterValue = this.mustQuery<HTMLDivElement>('.multiplayer-room-summary');
    this.pregameValue = this.mustQuery<HTMLDivElement>('.multiplayer-pregame');
    this.resetValue = this.mustQuery<HTMLDivElement>('.multiplayer-reset');
    this.noticeValue = this.mustQuery<HTMLDivElement>('.multiplayer-room-notice');
    this.errorValue = this.mustQuery<HTMLDivElement>('.multiplayer-error');
    this.createButton = this.mustQuery<HTMLButtonElement>('.multiplayer-create');
    this.joinButton = this.mustQuery<HTMLButtonElement>('.multiplayer-join');
    this.leaveButton = this.mustQuery<HTMLButtonElement>('.multiplayer-leave');
    this.copyButton = this.mustQuery<HTMLButtonElement>('.multiplayer-copy');
    this.closeButton = this.mustQuery<HTMLButtonElement>('.multiplayer-close');
    this.settingsDetails = this.mustQuery<HTMLDetailsElement>('.multiplayer-settings');
    this.modeButtons = this.root.querySelectorAll<HTMLButtonElement>('.multiplayer-mode-tab');
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
    this.joinInput.addEventListener('keydown', this.onJoinKeyDown);
    this.fullscreenContinue.addEventListener('click', this.continueAfterFullscreenWarning);
    this.fullscreenRequest.addEventListener('click', this.requestFullscreen);
    this.fullscreenCancel.addEventListener('click', this.cancelFullscreenWarning);
    this.root.addEventListener('click', this.onRootClick);
    for (const button of this.modeButtons) button.addEventListener('click', this.onModeClick);
    window.addEventListener('keyup', this.onPortalFocusKeyUp);
    document.body.appendChild(this.root);
    this.update();
  }

  dispose(): void {
    this.createButton.removeEventListener('click', this.createRoom);
    this.joinButton.removeEventListener('click', this.joinRoom);
    this.leaveButton.removeEventListener('click', this.leaveRoom);
    this.copyButton.removeEventListener('click', this.copyRoomCode);
    this.closeButton.removeEventListener('click', this.close);
    this.joinInput.removeEventListener('keydown', this.onJoinKeyDown);
    this.fullscreenContinue.removeEventListener('click', this.continueAfterFullscreenWarning);
    this.fullscreenRequest.removeEventListener('click', this.requestFullscreen);
    this.fullscreenCancel.removeEventListener('click', this.cancelFullscreenWarning);
    this.root.removeEventListener('click', this.onRootClick);
    for (const button of this.modeButtons) button.removeEventListener('click', this.onModeClick);
    window.removeEventListener('keyup', this.onPortalFocusKeyUp);
    this.root.remove();
  }

  openMode(mode: LobbyMode): void {
    this.selectedMode = mode;
    this.modalOpen = true;
    this.awaitingInteractReleaseFocus = true;
    this.syncLockOverlaySuppression();
    document.exitPointerLock?.();
    this.root.classList.remove('multiplayer-modal--hidden');
    this.update();
  }

  update(): void {
    const snapshot = this.client.latestSnapshot;
    if (this.client.connected && snapshot) {
      this.selectedMode = snapshot.room.match.mode;
    }
    const liveMatch = isLiveMatch(snapshot?.room ?? null);
    if (liveMatch && this.modalOpen) {
      this.modalOpen = false;
    }
    const connected = this.client.connected;
    const busy = this.client.status === 'connecting';
    const roomSummary = summarizeRoom(snapshot?.room ?? null, this.client.localPlayerId);
    if (
      this.lastRendered.connected === connected &&
      this.lastRendered.busy === busy &&
      this.lastRendered.status === this.client.status &&
      this.lastRendered.roomId === this.client.roomId &&
      this.lastRendered.pingMs === this.client.pingMs &&
      this.lastRendered.errorMessage === this.client.errorMessage &&
      this.lastRendered.selectedMode === this.selectedMode &&
      this.lastRendered.modalOpen === this.modalOpen &&
      this.lastRendered.roomSummaryKey === roomSummary.key
    ) {
      return;
    }
    const wasConnected = this.lastRendered.connected;
    this.lastRendered = {
      connected,
      busy,
      status: this.client.status,
      roomId: this.client.roomId,
      pingMs: this.client.pingMs,
      errorMessage: this.client.errorMessage,
      selectedMode: this.selectedMode,
      modalOpen: this.modalOpen,
      roomSummaryKey: roomSummary.key
    };

    const statusLabel = busy
      ? 'connecting...'
      : connected ? roomSummary.statusLabel : this.client.status === 'error' ? 'needs attention' : 'practice';
    this.statusValue.textContent = statusLabel;
    this.statusValue.dataset.status = this.client.status;
    this.roomValue.textContent = this.client.roomId || 'Practice';
    this.pingValue.textContent = this.client.pingMs === null ? '-' : `${this.client.pingMs} ms`;
    this.capacityValue.textContent = roomSummary.capacityLabel;
    this.rosterValue.innerHTML = roomSummary.rosterHtml;
    this.pregameValue.innerHTML = roomSummary.pregameHtml;
    this.resetValue.innerHTML = roomSummary.resetHtml;
    this.noticeValue.textContent = roomSummary.noticeText;
    this.errorValue.textContent = friendlyError(this.client.errorMessage);

    const supported = this.modeSupported(this.selectedMode);
    this.modeTitle.textContent = MODE_LABEL[this.selectedMode];
    this.modeSubtitle.textContent = this.selectedMode === '1v1'
      ? 'Classic private duel. Create a code or join a friend.'
      : 'Team warmup. Choose a side in the pre-game, then vote start when ready.';
    this.modeNotice.textContent = supported
      ? 'Tip: use F11 fullscreen before the match starts.'
      : '2v2 is disabled in the active build configuration.';
    this.panel.dataset.mode = this.selectedMode;
    for (const button of this.modeButtons) {
      button.classList.toggle('multiplayer-mode-tab--active', button.dataset.mode === this.selectedMode);
    }

    this.createButton.disabled = connected || busy || !supported;
    this.joinButton.disabled = connected || busy || !supported;
    this.leaveButton.disabled = !connected && !busy;
    this.copyButton.disabled = !connected || !this.client.roomId;
    this.createButton.textContent = busy ? 'Creating...' : supported ? `Create ${this.selectedMode}` : '2v2 Soon';
    this.joinButton.textContent = busy ? 'Joining...' : supported ? `Join ${this.selectedMode}` : '2v2 Soon';

    const compact = connected && !busy && this.client.status !== 'error' && (!this.modalOpen || liveMatch);
    this.root.classList.toggle('multiplayer-modal--compact', compact);
    this.root.classList.toggle('multiplayer-modal--live', liveMatch);
    this.root.classList.toggle('multiplayer-modal--connected', connected);
    if (connected && !wasConnected) this.settingsDetails.open = false;
    const shouldShow = this.modalOpen || connected || busy || this.client.status === 'error';
    this.root.classList.toggle('multiplayer-modal--hidden', !shouldShow);
    this.syncLockOverlaySuppression();
  }

  private createRoom = (): void => {
    if (!this.modeSupported(this.selectedMode)) return;
    this.runWithFullscreenCheck(() => this.client.createRoom(this.nameInput.value, this.selectedMode));
  };

  private joinRoom = (): void => {
    if (!this.modeSupported(this.selectedMode)) return;
    this.runWithFullscreenCheck(() => this.client.joinRoom(this.joinInput.value, this.nameInput.value));
  };

  private leaveRoom = (): void => {
    this.client.leave();
    this.modalOpen = true;
    this.update();
  };

  private close = (): void => {
    if (this.client.status === 'connecting') return;
    this.modalOpen = false;
    this.awaitingInteractReleaseFocus = false;
    this.hideFullscreenPrompt();
    this.update();
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

  private onJoinKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.joinRoom();
  };

  private onModeClick = (event: Event): void => {
    const target = event.currentTarget as HTMLButtonElement;
    const mode = target.dataset.mode;
    if (mode !== '1v1' && mode !== '2v2') return;
    this.selectedMode = mode;
    this.update();
  };

  private onRootClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

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

    const resetButton = target.closest<HTMLButtonElement>('.multiplayer-reset-action');
    if (!resetButton) return;
    event.preventDefault();
    const mode = resetButton.dataset.resetMode;
    if (mode !== 'same-teams' && mode !== 'reset-teams') return;
    this.client.requestReset(mode);
  };

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
    const result = document.documentElement.requestFullscreen?.();
    if (result && typeof result.then === 'function') {
      result.catch(() => undefined);
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
    const suppress = this.modalOpen || !this.fullscreenPrompt.classList.contains('fullscreen-prompt--hidden');
    document.body.setAttribute(LOCK_OVERLAY_SUPPRESSED_ATTR, suppress ? '1' : '0');
    const lockOverlay = document.getElementById('lock-overlay');
    if (!lockOverlay) return;
    if (suppress) {
      lockOverlay.classList.add('hidden');
      return;
    }
    if (!document.pointerLockElement) {
      lockOverlay.classList.remove('hidden');
    }
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
  pregameHtml: string;
  resetHtml: string;
  noticeText: string;
} {
  if (!room) {
    return {
      key: 'practice',
      statusLabel: 'practice',
      capacityLabel: '0 / 0',
      rosterHtml: '',
      pregameHtml: '',
      resetHtml: '',
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
  }

  const rosterHtml = `
    <div class="multiplayer-room-summary__line"><strong>${room.match.mode === '2v2' ? 'Your Team' : 'You'}</strong> ${formatRoster(yourTeam, room.match.playersPerTeam, localPlayerId)}</div>
    <div class="multiplayer-room-summary__line"><strong>${room.match.mode === '2v2' ? 'Opponents' : 'Opponent'}</strong> ${formatRoster(opponentTeam, room.match.playersPerTeam, localPlayerId)}</div>
  `;
  const pregameHtml = buildPregameHtml(room, localPlayerId);
  const resetHtml = buildResetControlsHtml(room, localPlayerId);

  return {
    key: [
      room.match.mode,
      room.match.status,
      room.match.countdownSeconds.toFixed(0),
      room.resetVote.mode,
      room.resetVote.voteCount,
      room.resetVote.requiredVotes,
      room.startVote.voteCount,
      room.startVote.requiredVotes,
      room.startVote.teamChoiceCount,
      room.startVote.requiredTeamChoices,
      players.length,
      maxPlayers,
      disconnected.map((player) => `${player.id}:${formatReconnectSeconds(player.reconnectDeadlineAtMs)}`).join(','),
      players.map((player) => `${player.id}:${player.connected ? 1 : 0}:${player.teamId}:${player.teamSlotIndex}:${player.name}`).join('|')
    ].join('~'),
    statusLabel,
    capacityLabel: `${players.length} / ${maxPlayers}`,
    rosterHtml,
    pregameHtml,
    resetHtml,
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

function buildPregameHtml(room: RoomState, localPlayerId: string): string {
  if (room.match.mode !== '2v2' || room.match.status !== 'warmup') return '';
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

  const choicesReady = room.startVote.requiredTeamChoices > 0 &&
    room.startVote.teamChoiceCount >= room.startVote.requiredTeamChoices;
  const choiceLine = room.startVote.requiredTeamChoices > 0
    ? `Teams chosen: ${room.startVote.teamChoiceCount}/${room.startVote.requiredTeamChoices}`
    : 'Choose teams to unlock start vote';
  const voteLine = choicesReady && room.startVote.requiredVotes > 0
    ? `Vote start: ${room.startVote.voteCount}/${room.startVote.requiredVotes}`
    : choiceLine;
  const localVoted = room.startVote.votesByPlayerId[localPlayerId] === true;
  const startEnabled = choicesReady && room.startVote.requiredVotes > 0 && !localVoted;
  const startLabel = choicesReady
    ? localVoted ? 'Voted' : 'Start Vote'
    : 'Choose Teams First';

  return `
    <div class="multiplayer-pregame-card">
      <div class="multiplayer-pregame-title">Pre-Game Teams</div>
      <div class="multiplayer-pregame-slots">${teams}</div>
      <div class="multiplayer-pregame-footer">
        <span>${voteLine}</span>
      </div>
      <button class="multiplayer-start-vote multiplayer-start-vote--big" type="button"${startEnabled ? '' : ' disabled'}>${startLabel}</button>
    </div>
  `;
}

function buildResetControlsHtml(room: RoomState, localPlayerId: string): string {
  if (room.match.mode !== '2v2') return '';
  const sameTeamsVoted = room.resetVote.mode === 'same-teams' && room.resetVote.votesByPlayerId[localPlayerId] === true;
  const resetTeamsVoted = room.resetVote.mode === 'reset-teams' && room.resetVote.votesByPlayerId[localPlayerId] === true;
  return `
    <div class="multiplayer-reset-card">
      <div class="multiplayer-pregame-title">Match Reset</div>
      <div class="multiplayer-reset-actions">
        <button class="multiplayer-reset-action" type="button" data-reset-mode="same-teams"${sameTeamsVoted ? ' disabled' : ''}>${sameTeamsVoted ? 'Voted Same Teams' : 'Reset Match'}</button>
        <button class="multiplayer-reset-action multiplayer-reset-action--alt" type="button" data-reset-mode="reset-teams"${resetTeamsVoted ? ' disabled' : ''}>${resetTeamsVoted ? 'Voted Reset Teams' : 'Reset Teams'}</button>
      </div>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
