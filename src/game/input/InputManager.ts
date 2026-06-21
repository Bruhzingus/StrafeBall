export type MouseButton = 0 | 1 | 2;

const TRACKED_MOUSE_BUTTONS: MouseButton[] = [0, 1, 2];

// While the cursor is locked (i.e. you're playing) we swallow the browser's default action for
// every key EXCEPT these, so combos like Ctrl(crouch)+D no longer fire a bookmark, Ctrl+S a
// save dialog, Space a page scroll, etc. Escape must stay free so the player can release the
// cursor; F5/F11/F12 stay free for reload/fullscreen/devtools.
const KEY_DEFAULT_ALLOWLIST = new Set(['Escape', 'F5', 'F11', 'F12']);

export class InputManager {
  private readonly canvas: HTMLCanvasElement;
  private keysDown = new Set<string>();
  private keysPressed = new Set<string>();
  private keysReleased = new Set<string>();
  private mouseDown = new Set<number>();
  private mousePressed = new Set<number>();
  private mouseReleased = new Set<number>();
  private mouseDeltaX = 0;
  private mouseDeltaY = 0;

  public pointerLocked = false;
  // Owned exclusively by setLockSuppressed (called once per frame by whatever UI needs the cursor
  // free — the multiplayer menu, settings, the postmatch report card). Reading this directly,
  // rather than relaying it through a DOM attribute someone else also writes, is what keeps the
  // overlay's hidden/shown state and the actual requestPointerLock() gating from drifting apart.
  private suppressed = false;
  private pointerLockErrorTimer: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.bind();
  }

  /**
   * Tell the input layer the cursor must stay free right now (a menu/report-card/settings panel
   * is up). Synchronously exits pointer lock if it was active and re-syncs the "Click to play"
   * overlay, instead of relying on the next pointerlockchange event (which won't fire at all if
   * the cursor was already unlocked) or a separately-written DOM attribute.
   */
  setLockSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    if (suppressed && document.pointerLockElement === this.canvas) {
      document.exitPointerLock?.();
    }
    this.syncLockOverlayVisibility();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    document.removeEventListener('visibilitychange', this.onFocusStateChange);
    window.removeEventListener('blur', this.onFocusStateChange);
    window.removeEventListener('focus', this.onFocusStateChange);
    if (this.pointerLockErrorTimer !== null) window.clearTimeout(this.pointerLockErrorTimer);
  }

  requestPointerLock(): void {
    if (this.suppressed) return;
    if (document.pointerLockElement === this.canvas) return;
    if (typeof this.canvas.requestPointerLock !== 'function') {
      this.showLockOverlayMessage('Pointer Lock is not available in this browser.');
      return;
    }
    // Newer browsers return a promise; swallow rejections (e.g. the brief re-lock cooldown
    // after pressing Esc) so a failed attempt doesn't throw — the next click will retry.
    const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (result && typeof result.then === 'function') {
      result.catch(() => {
        this.showLockOverlayMessage('Click the game area again to lock the mouse.');
      });
    }
  }

  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  wasKeyPressed(code: string): boolean {
    return this.keysPressed.has(code);
  }

  wasKeyReleased(code: string): boolean {
    return this.keysReleased.has(code);
  }

  isMouseDown(button: number): boolean {
    return this.mouseDown.has(button);
  }

  wasMousePressed(button: number): boolean {
    return this.mousePressed.has(button);
  }

  wasMouseReleased(button: number): boolean {
    return this.mouseReleased.has(button);
  }

  consumeMouseDelta(): { dx: number; dy: number } {
    const dx = this.mouseDeltaX;
    const dy = this.mouseDeltaY;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return { dx, dy };
  }

  endFrame(): void {
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
  }

  private bind(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerdown', this.onPointerDown);
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
    document.addEventListener('visibilitychange', this.onFocusStateChange);
    window.addEventListener('blur', this.onFocusStateChange);
    window.addEventListener('focus', this.onFocusStateChange);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    // Suppress browser shortcuts during play so in-game key combos can't trigger them.
    const preserveGameFocus = !this.suppressed && event.code === 'Tab' && !isEditableTarget(event.target);
    if ((this.pointerLocked && !KEY_DEFAULT_ALLOWLIST.has(event.code)) || preserveGameFocus) {
      event.preventDefault();
    }
    if (!this.keysDown.has(event.code)) {
      this.keysPressed.add(event.code);
    }
    this.keysDown.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keysDown.delete(event.code);
    this.keysReleased.add(event.code);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    if ('PointerEvent' in window) return;
    this.syncMouseButtonsFromMask(event.buttons);
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse' || !this.pointerLocked) return;
    this.syncMouseButtonsFromMask(event.buttons);
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') return;
    if (this.shouldIgnoreUiPointer(event.target)) return;
    event.preventDefault();
    if (!this.pointerLocked) this.requestPointerLock();
    this.recordMouseDown(event.button);
    this.syncMouseButtonsFromMask(event.buttons);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') return;
    this.recordMouseUp(event.button);
    this.syncMouseButtonsFromMask(event.buttons);
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (this.shouldIgnoreUiPointer(event.target)) return;
    event.preventDefault();
    if (!this.pointerLocked) this.requestPointerLock();
    this.recordMouseDown(event.button);
    this.syncMouseButtonsFromMask(event.buttons);
  };

  private onMouseUp = (event: MouseEvent): void => {
    this.recordMouseUp(event.button);
    this.syncMouseButtonsFromMask(event.buttons);
  };

  private onAuxClick = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this.clearTransientInputState();
    const lockOverlay = this.syncLockOverlayVisibility();
    if (this.pointerLocked && lockOverlay) this.resetLockOverlayMessage(lockOverlay);
  };

  // Show the "click to play" prompt whenever the cursor isn't locked and nothing is suppressing
  // it (start, or after Esc); hide it the instant either condition flips the other way.
  private syncLockOverlayVisibility(): HTMLElement | null {
    const lockOverlay = document.getElementById('lock-overlay');
    lockOverlay?.classList.toggle('hidden', this.pointerLocked || this.suppressed);
    return lockOverlay;
  }

  private onPointerLockError = (): void => {
    this.showLockOverlayMessage('Mouse lock was blocked. Click the canvas directly and try again.');
  };

  private onFocusStateChange = (): void => {
    this.onPointerLockChange();
    if (document.hidden || document.pointerLockElement !== this.canvas) {
      this.clearTransientInputState();
    }
  };

  private showLockOverlayMessage(detail: string): void {
    const lockOverlay = document.getElementById('lock-overlay');
    if (!lockOverlay) return;
    this.resetLockOverlayMessage(lockOverlay);
    const detailNode = lockOverlay.querySelector('span');
    if (detailNode) detailNode.textContent = detail;
    lockOverlay.classList.remove('hidden');
    if (this.pointerLockErrorTimer !== null) window.clearTimeout(this.pointerLockErrorTimer);
    this.pointerLockErrorTimer = window.setTimeout(() => {
      this.pointerLockErrorTimer = null;
      this.resetLockOverlayMessage(lockOverlay);
      if (document.pointerLockElement === this.canvas) lockOverlay.classList.add('hidden');
    }, 2500);
  }

  private resetLockOverlayMessage(lockOverlay: HTMLElement): void {
    lockOverlay.innerHTML = `
      Click to play
      <span>mouse = look &middot; WASD = move &middot; Esc releases the cursor</span>
    `;
  }

  private shouldIgnoreUiPointer(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-no-lock]') !== null;
  }

  private recordMouseDown(button: number): void {
    if (!this.mouseDown.has(button)) this.mousePressed.add(button);
    this.mouseDown.add(button);
  }

  private recordMouseUp(button: number): void {
    this.mouseDown.delete(button);
    this.mouseReleased.add(button);
  }

  private syncMouseButtonsFromMask(buttons: number): void {
    if (!Number.isFinite(buttons)) return;
    for (const button of TRACKED_MOUSE_BUTTONS) {
      const isDown = (buttons & mouseButtonMask(button)) !== 0;
      const wasDown = this.mouseDown.has(button);
      if (isDown && !wasDown) this.recordMouseDown(button);
      else if (!isDown && wasDown) this.recordMouseUp(button);
    }
  }

  private clearTransientInputState(): void {
    this.keysDown.clear();
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mouseDown.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
  }
}

function mouseButtonMask(button: MouseButton): number {
  // MouseEvent.buttons uses bit 0 for primary, bit 1 for secondary, bit 2 for auxiliary.
  if (button === 2) return 2;
  if (button === 1) return 4;
  return 1;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.closest('[contenteditable="true"]') !== null;
}
