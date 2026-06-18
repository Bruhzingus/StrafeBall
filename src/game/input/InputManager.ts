export type MouseButton = 0 | 1 | 2;

const LOCK_OVERLAY_SUPPRESSED_ATTR = 'data-suppress-lock-overlay';

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.bind();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  requestPointerLock(): void {
    if (document.pointerLockElement === this.canvas) return;
    // Newer browsers return a promise; swallow rejections (e.g. the brief re-lock cooldown
    // after pressing Esc) so a failed attempt doesn't throw — the next click will retry.
    const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (result && typeof result.then === 'function') {
      result.catch(() => undefined);
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
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    // Suppress browser shortcuts during play so in-game key combos can't trigger them.
    const preserveGameFocus = event.code === 'Tab' && !isEditableTarget(event.target);
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
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
  };

  private onMouseDown = (event: MouseEvent): void => {
    // Clicks on interactive UI marked [data-no-lock] (e.g. the settings slider) must not grab
    // pointer lock, otherwise the cursor vanishes the instant you try to use the control.
    const onUi = event.target instanceof Element && event.target.closest('[data-no-lock]') !== null;
    if (onUi) return;

    if (!this.pointerLocked) {
      this.requestPointerLock();
    }
    if (!this.mouseDown.has(event.button)) {
      this.mousePressed.add(event.button);
    }
    this.mouseDown.add(event.button);
  };

  private onMouseUp = (event: MouseEvent): void => {
    this.mouseDown.delete(event.button);
    this.mouseReleased.add(event.button);
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    // Show the "click to play" prompt whenever the cursor isn't locked (start, or after Esc).
    const suppressOverlay = document.body.getAttribute(LOCK_OVERLAY_SUPPRESSED_ATTR) === '1';
    document.getElementById('lock-overlay')?.classList.toggle('hidden', this.pointerLocked || suppressOverlay);
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.closest('[contenteditable="true"]') !== null;
}
