import './style.css';
import { Game } from './game/Game';

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;

if (!canvas) {
  throw new Error('Missing canvas element with id="gameCanvas".');
}

const game = new Game(canvas);
game.start();

window.addEventListener('beforeunload', () => {
  game.dispose();
});
