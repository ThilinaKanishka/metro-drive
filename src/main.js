import './style.css';
import { Game } from './game.js';
import { loadTextures, manager, assets } from './core/assets.js';
import { loadModels } from './core/models.js';

// Entry point: build the game (world, car, traffic...) behind the main menu.
// Play / Garage both lead through the garage; "Drive" there starts the game
// (a user gesture, so audio can begin).
const startBtn = document.getElementById('start-btn');
const startScreen = document.getElementById('start');
// Loading screen: textures and glTF models share one LoadingManager.
const bar = document.getElementById('loading-bar');
const text = document.getElementById('loading-text');
manager.onProgress = (url, loaded, total) => {
  const pct = Math.round((loaded / Math.max(total, 1)) * 100);
  bar.style.width = `${pct}%`;
  text.textContent = `Loading assets… ${pct}%`;
};
await Promise.all([loadTextures(), loadModels()]);
if (assets.failed.length) console.warn('Assets that failed to load (procedural fallbacks used):', assets.failed);
text.textContent = 'Building the city…';
await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const game = new Game(document.getElementById('app'));
document.getElementById('loading').classList.add('hidden');

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
