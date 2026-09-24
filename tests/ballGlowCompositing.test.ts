import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

let restoreWindow: (() => void) | undefined;

function installWindowStub(): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  });
  restoreWindow = () => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  };
}

afterEach(() => {
  restoreWindow?.();
  restoreWindow = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('ball glow compositing', () => {
  it('draws balls after the group-0 glow composite while retaining world depth', async () => {
    installWindowStub();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { createBallMesh } = await import('../src/game/ball/BallVisualFactory');
    const {
      addPolishedGlowMesh,
      BALL_POST_GLOW_RENDERING_GROUP,
      POLISHED_GLOW_COMPOSITE_RENDERING_GROUP,
      PolishedPostFX
    } = await import('../src/game/effects/PolishedPostFX');
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const ball = createBallMesh(scene, 'foreground_ball', new Vector3(0, 1, 0));
    const camera = new FreeCamera('test_camera', Vector3.Zero(), scene);
    const postFx = new PolishedPostFX(scene, camera);

    try {
      const glow = postFx.glowLayer;
      if (!glow) throw new Error('polished glow layer was not created');

      expect(BALL_POST_GLOW_RENDERING_GROUP).toBe(1);
      expect(POLISHED_GLOW_COMPOSITE_RENDERING_GROUP).toBe(0);
      expect(ball.renderingGroupId).toBe(BALL_POST_GLOW_RENDERING_GROUP);
      expect(scene.getAutoClearDepthStencilSetup(BALL_POST_GLOW_RENDERING_GROUP)).toMatchObject({
        autoClear: false,
        depth: true,
        stencil: true
      });
      expect(glow.renderingGroupId).toBe(POLISHED_GLOW_COMPOSITE_RENDERING_GROUP);
      // The ball remains registered as a pre-blur occluder, but the layer's group filter excludes
      // it from the glow RTT; its normal opaque draw is the final foreground mask.
      expect(glow.hasMesh(ball)).toBe(false);

      const lightBar = MeshBuilder.CreateBox('group_zero_light_bar', { size: 1 }, scene);
      addPolishedGlowMesh(lightBar);
      expect(lightBar.renderingGroupId).toBe(POLISHED_GLOW_COMPOSITE_RENDERING_GROUP);
      expect(glow.hasMesh(lightBar)).toBe(true);
      lightBar.dispose();
    } finally {
      postFx.dispose();
      if (!ball.isDisposed()) ball.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
