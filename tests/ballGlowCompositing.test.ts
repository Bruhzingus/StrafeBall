import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import type { GeometryBufferRenderer } from '@babylonjs/core';
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
  it('filters the visible glow list before submesh preparation and updates it after registration/disposal', async () => {
    installWindowStub();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { addPolishedGlowMesh, addPolishedGlowOccluder, PolishedPostFX } = await import('../src/game/effects/PolishedPostFX');
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera('test_camera', Vector3.Zero(), scene);
    const plain = MeshBuilder.CreateBox('plain', {}, scene);
    const emitter = MeshBuilder.CreateBox('emitter', {}, scene);
    const occluder = MeshBuilder.CreateBox('occluder', {}, scene);
    const laterGroup = MeshBuilder.CreateBox('later_group', {}, scene);
    laterGroup.renderingGroupId = 1;
    addPolishedGlowMesh(emitter);
    addPolishedGlowOccluder(occluder);
    addPolishedGlowOccluder(laterGroup);
    const postFx = new PolishedPostFX(scene, camera);
    try {
      const glow = postFx.glowLayer!;
      const filter = glow.mainTexture.getCustomRenderList!;
      // Scene's SmartArray backing buffer may contain stale entries past its active length.
      const visible = [plain, occluder, emitter, laterGroup, emitter];
      expect(filter(0, visible, 4)).toEqual([occluder, emitter]);
      expect(filter(0, visible, 2)).toEqual([occluder]);
      addPolishedGlowMesh(plain);
      expect(filter(0, visible, 4)).toEqual([plain, occluder, emitter]);
      emitter.dispose();
      expect(filter(0, visible, 4)).toEqual([plain, occluder]);
      expect(filter(0, [], 0)).toEqual([]);
      expect(glow.mainTexture.forceLayerMaskCheck).toBe(true);
    } finally {
      postFx.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

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

describe('polished geometry-buffer ownership', () => {
  it.each([false, true])('releases its SSAO pass without removing a pre-existing buffer (shared=%s)', async (shared) => {
    installWindowStub();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { PolishedPostFX } = await import('../src/game/effects/PolishedPostFX');
    const engine = new NullEngine();
    engine._features.supportSSAO2 = true;
    const scene = new Scene(engine);
    const camera = new FreeCamera('test_camera', Vector3.Zero(), scene);
    // NullEngine cannot allocate GPU multiple-render targets. Keep real SSAO construction and
    // disposal, replacing only that resource boundary with a disposable geometry-buffer handle.
    const disposeBuffer = vi.fn();
    const buffer = { isSupported: true, dispose: disposeBuffer } as unknown as GeometryBufferRenderer;
    if (shared) scene.geometryBufferRenderer = buffer;
    vi.spyOn(scene, 'enableGeometryBufferRenderer').mockImplementation(() => {
      scene.geometryBufferRenderer = buffer;
      return buffer;
    });
    const postFx = new PolishedPostFX(scene, camera);
    try {
      expect(scene.geometryBufferRenderer).toBe(buffer);
      postFx.dispose();
      expect(scene.geometryBufferRenderer).toBe(shared ? buffer : null);
      expect(disposeBuffer).toHaveBeenCalledTimes(shared ? 0 : 1);
    } finally {
      scene.disableGeometryBufferRenderer();
      scene.dispose();
      engine.dispose();
    }
  });
});
