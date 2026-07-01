import { Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { practiceCheats } from '../config/practiceCheats';

export class BackflipController {
  public active = false;
  public timer = 0;
  public cooldown = 0;

  update(dt: number): void {
    // Offline testing aid: no-cooldown clears the recovery so a backflip is always ready.
    if (practiceCheats.noCooldown) this.cooldown = 0;
    else if (this.cooldown > 0) {
      this.cooldown = Math.max(0, this.cooldown - dt);
    }

    if (!this.active) return;

    this.timer += dt;
    if (this.timer >= TUNING.backflip.durationSeconds) {
      this.active = false;
      this.timer = 0;
    }
  }

  canStart(): boolean {
    return !this.active && (this.cooldown <= 0 || practiceCheats.noCooldown);
  }

  start(backwardDirection: Vector3): Vector3 | null {
    if (!this.canStart()) return null;
    this.active = true;
    this.timer = 0;
    this.cooldown = TUNING.backflip.cooldownSeconds;
    return backwardDirection.scale(TUNING.backflip.backwardImpulse).add(new Vector3(0, TUNING.backflip.verticalImpulse, 0));
  }

  isSuperThrowWindow(): boolean {
    if (!this.active) return false;
    return this.timer >= TUNING.backflip.superWindowStart && this.timer <= TUNING.backflip.superWindowEnd;
  }
}
