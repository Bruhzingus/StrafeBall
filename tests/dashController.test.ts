import { describe, it, expect } from 'vitest';
import { Vector3 } from '@babylonjs/core';
import { DashController } from '../src/game/player/DashController';
import { TUNING } from '../src/game/config/tuning';

describe('DashController', () => {
  it('starts with the maximum number of charges', () => {
    const dash = new DashController();
    expect(dash.charges).toBe(TUNING.dash.maxCharges);
    expect(dash.canDash()).toBe(true);
  });

  it('a same-direction dash adds impulse to current velocity and spends a charge', () => {
    const dash = new DashController();
    const result = dash.tryDash(new Vector3(0, 0, 10), new Vector3(0, 0, 1));
    expect(result).not.toBeNull();
    expect(result!.z).toBeCloseTo(10 + TUNING.dash.impulse, 4);
    expect(dash.charges).toBe(TUNING.dash.maxCharges - 1);
  });

  it('an opposite-direction dash penalizes existing momentum and weakens the impulse', () => {
    const dash = new DashController();
    const result = dash.tryDash(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    expect(result).not.toBeNull();
    // retained opposing momentum (10 * penalty) minus the scaled-down impulse
    expect(result!.z).toBeCloseTo(
      10 * TUNING.dash.oppositeDirectionMomentumPenalty - TUNING.dash.impulse * TUNING.dash.oppositeDirectionImpulseScale,
      4
    );
  });

  it('blocks a second dash until the between-dash cooldown elapses', () => {
    const dash = new DashController();
    expect(dash.tryDash(new Vector3(0, 0, 5), new Vector3(0, 0, 1))).not.toBeNull();
    expect(dash.canDash()).toBe(false);
    expect(dash.tryDash(new Vector3(0, 0, 5), new Vector3(0, 0, 1))).toBeNull();
    dash.update(TUNING.dash.cooldownBetweenDashes);
    expect(dash.canDash()).toBe(true);
  });

  it('returns null with no dash direction', () => {
    const dash = new DashController();
    expect(dash.tryDash(new Vector3(0, 0, 5), Vector3.Zero())).toBeNull();
    expect(dash.charges).toBe(TUNING.dash.maxCharges); // no charge spent
  });

  it('cannot dash once charges are exhausted', () => {
    const dash = new DashController();
    for (let i = 0; i < TUNING.dash.maxCharges; i += 1) {
      expect(dash.tryDash(new Vector3(0, 0, 5), new Vector3(0, 0, 1))).not.toBeNull();
      dash.update(TUNING.dash.cooldownBetweenDashes); // clear the between-dash cooldown
    }
    expect(dash.charges).toBe(0);
    expect(dash.canDash()).toBe(false);
    expect(dash.tryDash(new Vector3(0, 0, 5), new Vector3(0, 0, 1))).toBeNull();
  });

  it('recharges a charge after rechargeSeconds', () => {
    const dash = new DashController();
    dash.tryDash(new Vector3(0, 0, 5), new Vector3(0, 0, 1));
    expect(dash.charges).toBe(TUNING.dash.maxCharges - 1);
    dash.update(TUNING.dash.rechargeSeconds);
    expect(dash.charges).toBe(TUNING.dash.maxCharges);
  });

  it('addChargeFromHit grants a charge but never exceeds the maximum', () => {
    const dash = new DashController();
    dash.tryDash(new Vector3(0, 0, 5), new Vector3(0, 0, 1));
    dash.addChargeFromHit();
    expect(dash.charges).toBe(TUNING.dash.maxCharges);
    dash.addChargeFromHit(); // already full
    expect(dash.charges).toBe(TUNING.dash.maxCharges);
  });
});
