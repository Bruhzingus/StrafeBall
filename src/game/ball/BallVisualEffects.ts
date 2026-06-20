import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial } from '@babylonjs/core';
import { settings } from '../config/Settings';

// QTE backflip tiers 4/5 are above this; normal throws and lower QTE tiers stay trail-free.
export const BALL_QTE_TRAIL_SPEED_THRESHOLD = 40;
export const BALL_TRAIL_INTERVAL_SECONDS = 0.035;

type ParticleKind = 'trail' | 'impact';

interface BallParticle {
  mesh: Mesh;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  life: number;
  maxLife: number;
  baseScale: number;
  kind: ParticleKind;
}

/**
 * Tiny pooled ball-only feedback. The pool is fixed-size, so trails/impacts overwrite the oldest
 * particle instead of growing with match duration.
 */
export class BallVisualEffects {
  private readonly particles: BallParticle[] = [];
  private readonly trailMaterial: StandardMaterial;
  private readonly impactMaterial: StandardMaterial;
  private cursor = 0;
  private rng = 0x7f4a7c15;
  private disposed = false;

  constructor(scene: Scene, maxParticles = 48) {
    this.trailMaterial = new StandardMaterial('ball_trail_particle_mat', scene);
    this.trailMaterial.diffuseColor = new Color3(0.65, 0.95, 1);
    this.trailMaterial.emissiveColor = new Color3(0.22, 0.7, 0.95);
    this.trailMaterial.alpha = 0.46;
    this.trailMaterial.disableLighting = true;

    this.impactMaterial = new StandardMaterial('ball_impact_particle_mat', scene);
    this.impactMaterial.diffuseColor = new Color3(1, 0.72, 0.24);
    this.impactMaterial.emissiveColor = new Color3(1, 0.42, 0.08);
    this.impactMaterial.alpha = 0.78;
    this.impactMaterial.disableLighting = true;

    for (let i = 0; i < maxParticles; i += 1) {
      const mesh = MeshBuilder.CreateSphere(`ball_fx_particle_${i}`, { diameter: 1, segments: 6 }, scene);
      mesh.isPickable = false;
      mesh.setEnabled(false);
      mesh.material = this.impactMaterial;
      this.particles.push({
        mesh,
        velocityX: 0,
        velocityY: 0,
        velocityZ: 0,
        life: 0,
        maxLife: 0,
        baseScale: 0.04,
        kind: 'impact'
      });
    }
  }

  spawnTrail(position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }): void {
    if (this.disposed || settings.reducedEffects) return;
    const speedSq = velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z;
    if (speedSq < BALL_QTE_TRAIL_SPEED_THRESHOLD * BALL_QTE_TRAIL_SPEED_THRESHOLD) return;

    const particle = this.takeParticle('trail');
    if (!particle) return;
    const speed = Math.sqrt(speedSq);
    particle.life = 0.16;
    particle.maxLife = 0.16;
    particle.baseScale = 0.07 + Math.min(0.055, (speed - BALL_QTE_TRAIL_SPEED_THRESHOLD) * 0.004);
    particle.velocityX = -velocity.x * 0.018 + (this.nextRandom() - 0.5) * 0.22;
    particle.velocityY = -velocity.y * 0.018 + (this.nextRandom() - 0.5) * 0.16;
    particle.velocityZ = -velocity.z * 0.018 + (this.nextRandom() - 0.5) * 0.22;
    particle.mesh.position.set(position.x, position.y, position.z);
    particle.mesh.scaling.setAll(particle.baseScale);
  }

  spawnImpact(position: { x: number; y: number; z: number }, speed: number): void {
    if (this.disposed || settings.reducedEffects) return;
    const count = Math.min(6, Math.max(3, 2 + Math.floor(speed / 10)));
    const impulse = Math.min(4.8, Math.max(1.4, speed * 0.18));

    for (let i = 0; i < count; i += 1) {
      const particle = this.takeParticle('impact');
      if (!particle) return;
      const angle = this.nextRandom() * Math.PI * 2;
      const spread = impulse * (0.38 + this.nextRandom() * 0.5);
      particle.life = 0.16 + this.nextRandom() * 0.08;
      particle.maxLife = particle.life;
      particle.baseScale = 0.045 + Math.min(0.055, speed * 0.0025);
      particle.velocityX = Math.cos(angle) * spread;
      particle.velocityY = 0.65 + this.nextRandom() * impulse * 0.35;
      particle.velocityZ = Math.sin(angle) * spread;
      particle.mesh.position.set(position.x, position.y, position.z);
      particle.mesh.scaling.setAll(particle.baseScale);
    }
  }

  update(dt: number): void {
    if (this.disposed) return;
    for (const particle of this.particles) {
      if (particle.life <= 0) continue;

      particle.life = Math.max(0, particle.life - dt);
      particle.mesh.position.x += particle.velocityX * dt;
      particle.mesh.position.y += particle.velocityY * dt;
      particle.mesh.position.z += particle.velocityZ * dt;
      particle.velocityY -= (particle.kind === 'impact' ? 7.5 : 1.6) * dt;

      const t = particle.maxLife > 0 ? particle.life / particle.maxLife : 0;
      particle.mesh.scaling.setAll(particle.baseScale * (0.25 + t * 0.75));
      if (particle.life <= 0) particle.mesh.setEnabled(false);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const particle of this.particles) {
      particle.mesh.dispose();
    }
    this.particles.length = 0;
    this.trailMaterial.dispose();
    this.impactMaterial.dispose();
  }

  private takeParticle(kind: ParticleKind): BallParticle | null {
    if (this.particles.length === 0) return null;
    const particle = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.particles.length;
    particle.kind = kind;
    particle.mesh.material = kind === 'trail' ? this.trailMaterial : this.impactMaterial;
    particle.mesh.setEnabled(true);
    return particle;
  }

  private nextRandom(): number {
    this.rng = (1664525 * this.rng + 1013904223) >>> 0;
    return this.rng / 0xffffffff;
  }
}
