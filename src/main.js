import './style.css';
import { Game } from './game.js';

// Entry point: build the game (world, car, traffic...) behind the main menu.
// Play / Garage both lead through the garage; "Drive" there starts the game
// (a user gesture, so audio can begin).
const game = new Game(document.getElementById('app'));
const startBtn = document.getElementById('start-btn');
const startScreen = document.getElementById('start');

startBtn.disabled = false;
startBtn.textContent = 'Play';

startBtn.addEventListener('click', () => game.openGarage('menu'));

// Mission mode selector.
const modeButtons = document.querySelectorAll('#mode-select button');
const showMode = () => modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === game.mode));
modeButtons.forEach((b) => b.addEventListener('click', () => {
  game.setMode(b.dataset.mode);
  showMode();
}));
showMode();
document.getElementById('menu-garage').addEventListener('click', () => game.openGarage('menu'));
document.getElementById('menu-settings').addEventListener('click', () => game.openSettings('menu'));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && game.state === 'menu' && !startScreen.classList.contains('hidden')) {
    game.openGarage('menu');
  }
});

// Expose for debugging in the console.
window.__game = game;
