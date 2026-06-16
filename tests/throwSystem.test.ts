import { describe, it, expect } from 'vitest';
import { Vector3 } from '@babylonjs/core';
import { ThrowSystem, ThrowRequest } from '../src/game/ball/ThrowSystem';
import { TUNING } from '../src/game/config/tuning';

const system = new ThrowSystem();

function baseRequest(overrides: Partial<ThrowRequest> = {}): ThrowRequest {
  return {
    hand: 'left',
    cameraForward: new Vector3(0, 0, 1),
    playerVelocity: Vector3.Zero(),
    charge01: 0,
    isCrouching: false,
    isSliding: false,
    isWallRunning: false,
    isDashing: false,
    isBackflipSuper: false,
    fastDoubleThrowPenalty: false,
    ...overrides
  };
}

describe('ThrowSystem.calculateThrow', () => {
  it('quick (uncharged) throw uses quickThrowSpeed and a slight drop', () => {
    const r = system.calculateThrow(baseRequest({ charge01: 0 }));
    expect(r.velocity.length()).toBeCloseTo(TUNING.ball.quickThrowSpeed, 4);
    expect(r.dropScale).toBeCloseTo(TUNING.ball.quickDropScale, 6);
    expect(r.isSuper).toBe(false);
    expect(r.curveAccel.length()).toBe(0);
  });

  it('fully charged throw reaches chargedThrowSpeed and flies straight', () => {
    const r = system.calculateThrow(baseRequest({ charge01: 1 }));
    expect(r.velocity.length()).toBeCloseTo(TUNING.ball.chargedThrowSpeed, 4);
    expect(r.dropScale).toBeCloseTo(TUNING.ball.chargedDropScale, 6);
  });

  it('dashing forces a quick throw regardless of charge', () => {
    const r = system.calculateThrow(baseRequest({ charge01: 1, isDashing: true }));
    expect(r.velocity.length()).toBeCloseTo(TUNING.ball.quickThrowSpeed, 4);
  });

  it('backflip super multiplies speed and marks the throw super', () => {
    const r = system.calculateThrow(baseRequest({ charge01: 1, isBackflipSuper: true }));
    expect(r.velocity.length()).toBeCloseTo(TUNING.ball.chargedThrowSpeed * TUNING.backflip.superThrowMultiplier, 3);
    expect(r.isSuper).toBe(true);
  });

  it('fast double-throw penalty reduces speed', () => {
    const normal = system.calculateThrow(baseRequest({ charge01: 1 }));
    const rushed = system.calculateThrow(baseRequest({ charge01: 1, fastDoubleThrowPenalty: true }));
    expect(rushed.velocity.length()).toBeCloseTo(normal.velocity.length() * TUNING.ball.fastDoubleThrowPenalty, 3);
  });

  it('crouch curve accelerates opposite the throwing hand', () => {
    const left = system.calculateThrow(baseRequest({ hand: 'left', isCrouching: true }));
    const right = system.calculateThrow(baseRequest({ hand: 'right', isCrouching: true }));
    // forward = +Z, so camera-right = +X. Left hand curves +X, right hand curves -X.
    expect(left.curveAccel.x).toBeGreaterThan(0);
    expect(right.curveAccel.x).toBeLessThan(0);
    expect(left.curveAccel.x).toBeCloseTo(-right.curveAccel.x, 6);
  });

  it('adds the player velocity as a movement bonus to the throw', () => {
    const moving = system.calculateThrow(baseRequest({ charge01: 0, playerVelocity: new Vector3(0, 0, 10) }));
    const still = system.calculateThrow(baseRequest({ charge01: 0 }));
    expect(moving.velocity.z).toBeGreaterThan(still.velocity.z);
  });
});
