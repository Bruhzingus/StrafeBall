import { TUNING } from '../config/tuning';

/**
 * Backflip QTE timing bar. A small, non-interactive popup placed BELOW the crosshair (it never
 * overlaps the center reticle or the aim point). A pointer sweeps left→right across a banded bar
 * over the QTE window; the player clicks when it's nearest the center. Banding (center = best tier,
 * edges = slowest, beyond the hit zone = miss) is purely visual — scoring lives in shared ThrowMath.
 *
 * Colors are on-theme (cream/navy comic sticker look, school gold→blue→red bands), NOT the red/green
 * reference palette.
 */
export class BackflipQteHud {
  private readonly root: HTMLDivElement;
  private readonly pointer: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private visible = false;
  private hideTimer = 0;
  private flashing = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'qte';

    const bar = document.createElement('div');
    bar.className = 'qte-bar';

    // Hit zone (lighter inset) spans |offset| <= hitHalfWidth. Width as a % of the full bar.
    const hitPct = Math.round(TUNING.backflip.qte.hitHalfWidth * 100);
    const hit = document.createElement('div');
    hit.className = 'qte-hit';
    hit.style.width = `${hitPct}%`;

    // Center sweet-spot marker.
    const center = document.createElement('div');
    center.className = 'qte-center';

    this.pointer = document.createElement('div');
    this.pointer.className = 'qte-pointer';

    this.flash = document.createElement('div');
    this.flash.className = 'qte-flash';

    bar.appendChild(hit);
    bar.appendChild(center);
    bar.appendChild(this.pointer);
    bar.appendChild(this.flash);

    const label = document.createElement('div');
    label.className = 'qte-label';
    label.textContent = 'CLICK CENTER';

    this.root.appendChild(bar);
    this.root.appendChild(label);
    parent.appendChild(this.root);
    this.hide();
  }

  show(): void {
    if (!this.visible) {
      this.visible = true;
      this.root.classList.add('qte--visible');
      // Restart the pop-in animation each time it appears.
      void this.root.offsetWidth;
    }
  }

  hide(): void {
    this.visible = false;
    this.flashing = false;
    this.root.classList.remove('qte--visible');
    this.flash.classList.remove('qte-flash--show');
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** True while a result flash is still playing (so callers don't hide the popup out from under it). */
  isFlashing(): boolean {
    return this.flashing;
  }

  /** Position the sweeping pointer. `offset` is signed −1..+1 (−1 = left end, +1 = right end). */
  setPointer(offset: number): void {
    const pct = (offset * 0.5 + 0.5) * 100;
    this.pointer.style.left = `${pct}%`;
  }

  /**
   * Brief result flash colored by outcome (gold = good tier, red = miss), then auto-hide. Keeps the
   * popup on screen for the flash even though the QTE state has already deactivated.
   */
  flashResult(good: boolean): void {
    this.show();
    this.flashing = true;
    this.flash.classList.remove('qte-flash--show');
    this.flash.style.setProperty('--qte-flash-color', good ? 'var(--school-gold)' : 'var(--school-red)');
    void this.flash.offsetWidth;
    this.flash.classList.add('qte-flash--show');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), 320);
  }
}
