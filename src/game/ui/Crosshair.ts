export class Crosshair {
  public readonly element: HTMLDivElement;
  private mode = 'idle';

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'crosshair';
    parent.appendChild(this.element);
  }

  setMode(mode: 'idle' | 'hold' | 'charge' | 'catch' | 'parry' | 'danger'): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.element.className = `crosshair crosshair--${mode}`;
  }

  pulse(kind: 'hit' | 'catch' | 'parry' | 'throw'): void {
    this.element.classList.remove(
      'crosshair-pulse--hit',
      'crosshair-pulse--catch',
      'crosshair-pulse--parry',
      'crosshair-pulse--throw'
    );
    void this.element.offsetWidth;
    this.element.classList.add(`crosshair-pulse--${kind}`);
  }
}
