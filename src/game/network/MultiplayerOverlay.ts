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

  constructor(private readonly client: MultiplayerClient) {
    this.root = document.createElement('div');
    this.root.className = 'multiplayer-panel';
    this.root.setAttribute('data-no-lock', 'true');
    this.root.innerHTML = `
      <div class="multiplayer-title">Private Duel</div>
      <label class="multiplayer-field">
        <span>Name</span>
        <input class="multiplayer-name" maxlength="24" value="Player" />
      </label>
      <div class="multiplayer-actions">
        <button class="multiplayer-create">Create</button>
      </div>
      <label class="multiplayer-field">
        <span>Room Code</span>
        <input class="multiplayer-join-code" placeholder="room id" />
      </label>
      <div class="multiplayer-actions">
        <button class="multiplayer-join">Join</button>
        <button class="multiplayer-leave">Leave</button>
      </div>
      <div class="multiplayer-line">Status <span class="multiplayer-status">offline</span></div>
      <div class="multiplayer-line">Room <span class="multiplayer-room">-</span></div>
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

    this.createButton.addEventListener('click', this.createRoom);
    this.joinButton.addEventListener('click', this.joinRoom);
    this.leaveButton.addEventListener('click', this.leaveRoom);
    document.body.appendChild(this.root);
    this.update();
  }

  dispose(): void {
    this.createButton.removeEventListener('click', this.createRoom);
    this.joinButton.removeEventListener('click', this.joinRoom);
    this.leaveButton.removeEventListener('click', this.leaveRoom);
    this.root.remove();
  }

  update(): void {
    const connected = this.client.connected;
    const busy = this.client.status === 'connecting';
    this.statusValue.textContent = this.client.status;
    this.roomValue.textContent = this.client.roomId || '-';
    this.pingValue.textContent = this.client.pingMs === null ? '-' : `${this.client.pingMs} ms`;
    this.errorValue.textContent = this.client.errorMessage;
    this.createButton.disabled = connected || busy;
    this.joinButton.disabled = connected || busy;
    this.leaveButton.disabled = !connected && !busy;
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

  private mustQuery<T extends Element>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`Missing multiplayer overlay element: ${selector}`);
    return el;
  }
}
