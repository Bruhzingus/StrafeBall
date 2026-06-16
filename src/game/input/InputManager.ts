export type MouseButton = 0 | 1 | 2;

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
    document.getElementById('lock-overlay')?.classList.toggle('hidden', this.pointerLocked);
  };
}
