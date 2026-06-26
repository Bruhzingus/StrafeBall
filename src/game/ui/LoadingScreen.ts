import type { Scene } from '@babylonjs/core';

/**
 * First-load splash. The markup lives in index.html so the banner + bar paint before any
 * module JS runs (instant feedback); this class only drives the progress bar and fades the
 * overlay out once the scene's assets have finished downloading.
 *
 * Progress is real, not faked: Babylon exposes the number of still-pending async loads
 * (mostly textures here) via `scene.getWaitingItemsCount()`. We sample the peak count to get
 * a denominator, report `(peak - remaining) / peak`, and gate the final fade on
 * `scene.executeWhenReady` so the bar only hits 100% when the gym is actually drawable.
 *
 * The shown value is monotonic (never goes backwards) and eased toward its target each frame
 * so the bar glides instead of snapping as batches of textures resolve.
 */
export class LoadingScreen {
  private readonly root: HTMLElement | null;
  private readonly fill: HTMLElement | null;
  private readonly status: HTMLElement | null;

  private scene: Scene | null = null;
  private peakPending = 0;
  private displayed = 0; // 0..1, eased value actually shown on the bar
  private target = 0;     // 0..1, latest measured progress (monotonic)
  private ready = false;
  private done = false;
  private rafId = 0;
  private firstRenderableAtMs = 0;
  private fallbackReadyAtMs = 0;
  private framesSinceRenderable = 0;

  // If Babylon never flips executeWhenReady() because of one stubborn late resource, but the scene
  // is already rendering/interactable underneath, don't leave the splash stranded forever.
  private static readonly FALLBACK_RENDERABLE_HOLD_MS = 300;
  private static readonly FALLBACK_RENDERABLE_FRAME_COUNT = 10;

  private static readonly MESSAGES: ReadonlyArray<readonly [number, string]> = [
    [0, 'Warming up the gym…'],
    [0.35, 'Inflating the dodgeballs…'],
    [0.7, 'Hanging the banners…'],
    [0.95, 'Tip-off!']
  ];

  constructor() {
    this.root = document.getElementById('loading-screen');
    this.fill = document.getElementById('loading-bar-fill');
    this.status = document.getElementById('loading-status');
  }

  /**
   * Begin tracking a scene. Drives the bar from the scene's pending-asset count and hides the
   * overlay once everything is loaded. Safe to call even if the overlay markup is absent.
   */
  track(scene: Scene): void {
    if (!this.root) return;
    this.scene = scene;
    scene.executeWhenReady(() => {
      this.ready = true;
    });
    this.tick();
  }

  private tick = (): void => {
    if (this.done) return;

    if (this.scene) {
      const pending = this.scene.getWaitingItemsCount();
      this.peakPending = Math.max(this.peakPending, pending);
      const measured = this.peakPending > 0 ? (this.peakPending - pending) / this.peakPending : 0;
      // Hold a hair under full until the scene reports ready, so the bar doesn't sit at 100%
      // while the first frame is still compiling shaders.
      this.target = Math.max(this.target, this.ready ? 1 : Math.min(measured, 0.97));

      if (pending === 0 && this.scene.isReady()) {
        if (this.firstRenderableAtMs === 0) this.firstRenderableAtMs = performance.now();
        this.framesSinceRenderable += 1;
        if (
          this.ready === false &&
          this.framesSinceRenderable >= LoadingScreen.FALLBACK_RENDERABLE_FRAME_COUNT &&
          performance.now() - this.firstRenderableAtMs >= LoadingScreen.FALLBACK_RENDERABLE_HOLD_MS
        ) {
          this.fallbackReadyAtMs = this.firstRenderableAtMs;
          this.ready = true;
        }
      } else {
        this.firstRenderableAtMs = 0;
        this.framesSinceRenderable = 0;
      }
    }

    // Ease the shown value toward the target; snap the last sliver so it always completes.
    this.displayed += (this.target - this.displayed) * 0.18;
    if (this.target - this.displayed < 0.005) this.displayed = this.target;

    const pct = Math.round(this.displayed * 100);
    if (this.fill) this.fill.style.width = `${pct}%`;
    if (this.status) {
      const message = LoadingScreen.messageFor(this.displayed);
      if (this.status.textContent !== message) this.status.textContent = message;
    }

    if (this.ready && this.displayed >= 0.999) {
      this.finish();
      return;
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  private static messageFor(progress: number): string {
    let message = LoadingScreen.MESSAGES[0][1];
    for (const [threshold, text] of LoadingScreen.MESSAGES) {
      if (progress >= threshold) message = text;
    }
    return message;
  }

  private finish(): void {
    this.done = true;
    cancelAnimationFrame(this.rafId);
    if (this.fill) this.fill.style.width = '100%';
    if (!this.root) return;
    this.root.classList.add('hidden');
    // Remove from the DOM after the fade so it never intercepts clicks (the lock overlay sits
    // beneath it and needs the very first click to request pointer lock).
    const root = this.root;
    window.setTimeout(() => root.remove(), 600);
  }
}
