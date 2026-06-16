import { Engine, Scene } from '@babylonjs/core';
import { ArenaScene } from './scenes/ArenaScene';

export class Game {
  private readonly engine: Engine;
  private scene: Scene | null = null;
  private arena: ArenaScene | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true
    });
  }

  start(): void {
    this.arena = new ArenaScene(this.engine, this.canvas);
    this.scene = this.arena.scene;

    this.engine.runRenderLoop(() => {
      this.arena?.update();
      this.scene?.render();
    });

    window.addEventListener('resize', this.onResize);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.arena?.dispose();
    this.scene?.dispose();
    this.engine.dispose();
  }

  private onResize = (): void => {
    this.engine.resize();
  };
}
