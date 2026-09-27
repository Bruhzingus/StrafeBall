import { expect, it } from 'vitest';
import { NullEngine, Scene } from '@babylonjs/core';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { CoachGlassesGuide } from '../src/game/effects/CoachGlassesGuide';

it('reuses local guide meshes, shows a rebound, and hides them on state loss', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const guide = new CoachGlassesGuide(scene);
  const meshCount = scene.meshes.length;
  guide.update({
    origin: { x: C.map.halfWidth - 2, y: 3, z: 0 },
    velocity: { x: 42, y: 0, z: 0 },
    curveAccel: { x: 0, y: 0, z: 0 }, dropScale: 0,
    boxes: [], maxSeconds: 0.5
  });
  expect(scene.getMeshByName('coach_glasses_direct')?.isEnabled()).toBe(true);
  expect(scene.getMeshByName('coach_glasses_after')?.isEnabled()).toBe(true);
  expect(scene.getMeshByName('coach_glasses_bounce')?.isEnabled()).toBe(true);
  guide.update({
    origin: { x: C.map.halfWidth - 2, y: 3, z: 0 },
    velocity: { x: 42, y: 0, z: 0 },
    curveAccel: { x: 0, y: 0, z: 0 }, dropScale: 0,
    boxes: [], maxSeconds: 0.5
  });
  expect(scene.meshes.length).toBe(meshCount);
  guide.update(null);
  expect(scene.getMeshByName('coach_glasses_direct')?.isEnabled()).toBe(false);
  guide.dispose();
  expect(scene.getMeshByName('coach_glasses_direct')).toBeNull();
  scene.dispose();
  engine.dispose();
});
