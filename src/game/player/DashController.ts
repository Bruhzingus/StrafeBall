import { Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';

export class DashController {
  // Explicit number type: TUNING is `as const`, so maxCharges has literal type 3
  // and would otherwise lock this field to the literal type `3`.
  public charges: number = TUNING.dash.maxCharges;
  public rechargeTimer = 0;
  private dashCooldownTimer = 0;

  update(dt: number): void {
    if (this.dashCooldownTimer > 0) {
      this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - dt);
    }

    if (this.charges >= TUNING.dash.maxCharges) return;

    this.rechargeTimer += dt;
    if (this.rechargeTimer >= TUNING.dash.rechargeSeconds) {
      this.rechargeTimer = 0;
      this.charges += 1;
    }
  }

  canDash(): boolean {
    return this.charges > 0 && this.dashCooldownTimer <= 0;
  }

  tryDash(currentVelocity: Vector3, dashDirection: Vector3): Vector3 | null {
    if (!this.canDash() || dashDirection.lengthSquared() <= 0.001) return null;

    this.charges -= 1;
    this.dashCooldownTimer = TUNING.dash.cooldownBetweenDashes;

    const currentHorizontal = currentVelocity.clone();
    currentHorizontal.y = 0;
    const currentSpeed = currentHorizontal.length();
    const normalizedCurrent = currentSpeed > 0.001 ? currentHorizontal.scale(1 / currentSpeed) : dashDirection;
    const dot = Vector3.Dot(normalizedCurrent, dashDirection);

    if (dot >= TUNING.dash.similarDirectionDot) {
      return currentVelocity.add(dashDirection.scale(TUNING.dash.impulse));
    }

    const penalized = currentVelocity.scale(TUNING.dash.oppositeDirectionMomentumPenalty);
    return penalized.add(dashDirection.scale(TUNING.dash.impulse));
  }

  addChargeFromHit(): void {
    this.charges = Math.min(TUNING.dash.maxCharges, this.charges + 1);
  }
}
