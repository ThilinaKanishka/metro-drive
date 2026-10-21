import './style.css';
import { Game } from './game.js';

// Entry point: build the game (world, car, traffic...) then wait for the player
// to press Start. Audio can only begin after that first user gesture.
const game = new Game(document.getElementById('app'));
const startBtn = document.getElementById('start-btn');
const startScreen = document.getElementById('start');

startBtn.disabled = false;
startBtn.textContent = 'Start Driving';

function begin() {
  if (game.started) return;
  startScreen.classList.add('hidden');
  game.start();
}
startBtn.addEventListener('click', begin);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && !startScreen.classList.contains('hidden')) begin();
});

// Expose for debugging in the console.
window.__game = game;
