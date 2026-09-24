import { Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS, type GameConstants } from '../../../shared/constants';
import type { DashState, Vec3 } from '../../../shared/types';
import { advanceDashState, canSpendDashCharge, grantDashCharge, tryDash as tryDashSim, tryUpwardDash as tryUpwardDashSim } from '../../../shared/simulation/PlayerSim';
import { practiceCheats } from '../config/practiceCheats';

const ADRENALINE_CONSTANTS = {
  ...GAME_CONSTANTS,
  dash: {
    ...GAME_CONSTANTS.dash,
    maxCharges: GAME_CONSTANTS.powerup.adrenalineMaxCharges,
    rechargeSeconds: GAME_CONSTANTS.powerup.adrenalineRechargeSeconds
  }
} as unknown as GameConstants;

export class DashController {
  // Explicit number type: constants are `as const`, so maxCharges has literal type 3
  // and would otherwise lock this field to the literal type `3`.
  public charges: number = GAME_CONSTANTS.dash.maxCharges;
  public rechargeTimer = 0;
  private dashCooldownTimer = 0;
  private adrenalineActive = false;

  setAdrenalineActive(active: boolean): void {
    if (active && !this.adrenalineActive) {
      this.charges = GAME_CONSTANTS.powerup.adrenalineMaxCharges;
      this.rechargeTimer = 0;
    } else if (!active && this.adrenalineActive) {
      this.charges = Math.min(GAME_CONSTANTS.dash.maxCharges, this.charges);
    }
    this.adrenalineActive = active;
  }

  update(dt: number): void {
    this.applyDashState(advanceDashState(this.snapshotDashState(), dt, this.constants()));
    // Offline testing aid: keep stamina topped up + off cooldown so dashes never run dry.
    if (practiceCheats.noCooldown) this.refill();
  }

  /** Refill stamina to full and clear all dash timers (playtest restart / stamina pad / no-cooldown). */
  refill(): void {
    this.charges = this.constants().dash.maxCharges;
    this.rechargeTimer = 0;
    this.dashCooldownTimer = 0;
  }

  canDash(): boolean {
    return canSpendDashCharge(this.snapshotDashState());
  }

  tryDash(currentVelocity: Vector3, dashDirection: Vector3): Vector3 | null {
    const result = tryDashSim(this.snapshotDashState(), toSharedVec3(currentVelocity), toSharedVec3(dashDirection), this.constants());
    if (!result.ok) return null;
    this.applyDashState(result.dash);
    return toBabylonVector(result.velocity);
  }

  tryUpwardDash(currentVelocity: Vector3): Vector3 | null {
    const result = tryUpwardDashSim(this.snapshotDashState(), toSharedVec3(currentVelocity), this.constants());
    if (!result.ok) return null;
    this.applyDashState(result.dash);
    return toBabylonVector(result.velocity);
  }

  addChargeFromHit(): void {
    this.applyDashState(grantDashCharge(this.snapshotDashState(), this.constants()));
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

  private constants(): GameConstants {
    return this.adrenalineActive ? ADRENALINE_CONSTANTS : GAME_CONSTANTS;
  }
}

function toSharedVec3(v: Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function toBabylonVector(v: Vec3): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}
