import { Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS } from '../../../shared/constants';
import type { DashState, Vec3 } from '../../../shared/types';
import { advanceDashState, canSpendDashCharge, grantDashCharge, tryDash as tryDashSim } from '../../../shared/simulation/PlayerSim';

export class DashController {
  // Explicit number type: constants are `as const`, so maxCharges has literal type 3
  // and would otherwise lock this field to the literal type `3`.
  public charges: number = GAME_CONSTANTS.dash.maxCharges;
  public rechargeTimer = 0;
  private dashCooldownTimer = 0;

  update(dt: number): void {
    this.applyDashState(advanceDashState(this.snapshotDashState(), dt));
  }

  canDash(): boolean {
    return canSpendDashCharge(this.snapshotDashState());
  }

  tryDash(currentVelocity: Vector3, dashDirection: Vector3): Vector3 | null {
    const result = tryDashSim(this.snapshotDashState(), toSharedVec3(currentVelocity), toSharedVec3(dashDirection));
    if (!result.ok) return null;
    this.applyDashState(result.dash);
    return toBabylonVector(result.velocity);
  }

  addChargeFromHit(): void {
    this.applyDashState(grantDashCharge(this.snapshotDashState()));
  }

  private snapshotDashState(): DashState {
    return {
      charges: this.charges,
      rechargeTimerSeconds: this.rechargeTimer,
      cooldownSeconds: this.dashCooldownTimer
    };
  }

  private applyDashState(state: DashState): void {
    this.charges = state.charges;
    this.rechargeTimer = state.rechargeTimerSeconds;
    this.dashCooldownTimer = state.cooldownSeconds;
  }
}

function toSharedVec3(v: Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function toBabylonVector(v: Vec3): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}
