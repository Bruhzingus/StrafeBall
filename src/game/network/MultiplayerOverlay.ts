import { MultiplayerClient } from './MultiplayerClient';

export class MultiplayerOverlay {
  private readonly root: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly joinInput: HTMLInputElement;
  private readonly statusValue: HTMLSpanElement;
  private readonly roomValue: HTMLSpanElement;
  private readonly pingValue: HTMLSpanElement;
  private readonly errorValue: HTMLDivElement;
  private readonly createButton: HTMLButtonElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;

  constructor(private readonly client: MultiplayerClient) {
    this.root = document.createElement('div');
    this.root.className = 'multiplayer-panel';
    this.root.setAttribute('data-no-lock', 'true');
    this.root.innerHTML = `
      <div class="multiplayer-kicker">StrafeBall</div>
      <div class="multiplayer-title">Private Duel</div>
      <div class="multiplayer-subtitle">Warm up instantly, then share a code for 1v1.</div>
      <label class="multiplayer-field">
        <span>Player</span>
        <input class="multiplayer-name" maxlength="24" value="Player" />
      </label>
      <div class="multiplayer-actions">
        <button class="multiplayer-create">Create Room</button>
      </div>
      <label class="multiplayer-field">
        <span>Room Code</span>
        <input class="multiplayer-join-code" placeholder="Paste code" />
      </label>
      <div class="multiplayer-actions">
        <button class="multiplayer-join">Join</button>
        <button class="multiplayer-leave">Leave</button>
      </div>
      <div class="multiplayer-room-card">
        <div>
          <div class="multiplayer-card-label">Current Room</div>
          <div class="multiplayer-room">Practice</div>
        </div>
        <button class="multiplayer-copy" type="button">Copy</button>
      </div>
      <div class="multiplayer-line">Status <span class="multiplayer-status">practice</span></div>
      <div class="multiplayer-line">Ping <span class="multiplayer-ping">-</span></div>
      <div class="multiplayer-error"></div>
    `;

    this.nameInput = this.mustQuery<HTMLInputElement>('.multiplayer-name');
    this.joinInput = this.mustQuery<HTMLInputElement>('.multiplayer-join-code');
    this.statusValue = this.mustQuery<HTMLSpanElement>('.multiplayer-status');
    this.roomValue = this.mustQuery<HTMLSpanElement>('.multiplayer-room');
    this.pingValue = this.mustQuery<HTMLSpanElement>('.multiplayer-ping');
    this.errorValue = this.mustQuery<HTMLDivElement>('.multiplayer-error');
    this.createButton = this.mustQuery<HTMLButtonElement>('.multiplayer-create');
    this.joinButton = this.mustQuery<HTMLButtonElement>('.multiplayer-join');
    this.leaveButton = this.mustQuery<HTMLButtonElement>('.multiplayer-leave');
    this.copyButton = this.mustQuery<HTMLButtonElement>('.multiplayer-copy');

    this.createButton.addEventListener('click', this.createRoom);
    this.joinButton.addEventListener('click', this.joinRoom);
    this.leaveButton.addEventListener('click', this.leaveRoom);
    this.copyButton.addEventListener('click', this.copyRoomCode);
    this.joinInput.addEventListener('keydown', this.onJoinKeyDown);
    document.body.appendChild(this.root);
    this.update();
  }

  dispose(): void {
    this.createButton.removeEventListener('click', this.createRoom);
    this.joinButton.removeEventListener('click', this.joinRoom);
    this.leaveButton.removeEventListener('click', this.leaveRoom);
    this.copyButton.removeEventListener('click', this.copyRoomCode);
    this.joinInput.removeEventListener('keydown', this.onJoinKeyDown);
    this.root.remove();
  }

  update(): void {
    const connected = this.client.connected;
    const busy = this.client.status === 'connecting';
    const statusLabel = busy
      ? 'connecting...'
      : connected ? 'connected' : this.client.status === 'error' ? 'needs attention' : 'practice';
    this.statusValue.textContent = statusLabel;
    this.statusValue.dataset.status = this.client.status;
    this.roomValue.textContent = this.client.roomId || 'Practice';
    this.pingValue.textContent = this.client.pingMs === null ? '-' : `${this.client.pingMs} ms`;
    this.errorValue.textContent = friendlyError(this.client.errorMessage);
    this.createButton.disabled = connected || busy;
    this.joinButton.disabled = connected || busy;
    this.leaveButton.disabled = !connected && !busy;
    this.copyButton.disabled = !connected || !this.client.roomId;
    this.createButton.textContent = busy ? 'Creating...' : 'Create Room';
    this.joinButton.textContent = busy ? 'Joining...' : 'Join';
  }

  private createRoom = (): void => {
    void this.client.createRoom(this.nameInput.value).finally(() => this.update());
  };

  private joinRoom = (): void => {
    void this.client.joinRoom(this.joinInput.value, this.nameInput.value).finally(() => this.update());
  };

  private leaveRoom = (): void => {
    this.client.leave();
    this.update();
  };

  private copyRoomCode = (): void => {
    const code = this.client.roomId;
    if (!code) return;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code)
        .then(() => this.flashCopied())
        .catch(() => undefined);
      return;
    }
    this.flashCopied();
  };

  private onJoinKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.joinRoom();
  };

  private flashCopied(): void {
    this.copyButton.textContent = 'Copied';
    window.setTimeout(() => {
      if (this.copyButton.isConnected) this.copyButton.textContent = 'Copy';
    }, 900);
  }

  private mustQuery<T extends Element>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`Missing multiplayer overlay element: ${selector}`);
    return el;
  }
}

function friendlyError(message: string): string {
  if (!message) return '';
  if (/not found|room/i.test(message)) return 'Room not found. Check the code and try again.';
  if (/timeout|closed|abnormal|network|websocket/i.test(message)) return 'Connection hiccup. Try again or create a new room.';
  if (/full|seat/i.test(message)) return 'That room is full. Create a fresh duel.';
  return message;
}
