import type { AbstractEngine } from '@babylonjs/core';
import { Camera, Matrix, Scene, Vector3 } from '@babylonjs/core';
import type { PlayerNametagInfo } from '../network/NetworkRenderer';

interface NametagEntry {
  el: HTMLDivElement;
}

/** Floating DOM nametags for remote players, projected from their head position each frame. */
export class Nametags {
  private readonly root: HTMLDivElement;
  private readonly entries = new Map<string, NametagEntry>();
  private readonly seen = new Set<string>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'nametags';
    parent.appendChild(this.root);
  }

  update(players: PlayerNametagInfo[], scene: Scene): void {
    const camera = scene.activeCamera;
    const engine = scene.getEngine();
    if (!camera) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';

    this.seen.clear();
    for (const player of players) {
      this.seen.add(player.id);
      const entry = this.ensureEntry(player.id, player.name, player.teamId);
      this.positionEntry(entry, player.headPosition, camera, engine);
    }

    for (const [id, entry] of this.entries) {
      if (this.seen.has(id)) continue;
      entry.el.remove();
      this.entries.delete(id);
    }
  }

  dispose(): void {
    this.entries.clear();
    this.root.remove();
  }

  private ensureEntry(id: string, name: string, teamId: string): NametagEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'nametag';
      this.root.appendChild(el);
      entry = { el };
      this.entries.set(id, entry);
    }
    entry.el.classList.toggle('nametag--red', teamId === 'red');
    entry.el.classList.toggle('nametag--blue', teamId !== 'red');
    if (entry.el.textContent !== name) entry.el.textContent = name;
    return entry;
  }

  private positionEntry(entry: NametagEntry, headPosition: Vector3, camera: Camera, engine: AbstractEngine): void {
    const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    const screen = Vector3.Project(headPosition, Matrix.Identity(), camera.getScene().getTransformMatrix(), viewport);

    const behindCamera = screen.z < 0 || screen.z > 1;
    if (behindCamera) {
      entry.el.style.display = 'none';
      return;
    }
    entry.el.style.display = '';
    entry.el.style.left = `${screen.x}px`;
    entry.el.style.top = `${screen.y}px`;
  }
}
