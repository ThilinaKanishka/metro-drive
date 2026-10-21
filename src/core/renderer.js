import * as THREE from 'three';
import { CONFIG } from '../config.js';

/** Creates the WebGL renderer and keeps it sized to the window. */
export function createRenderer(container) {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
  const renderer = new THREE.WebGLRenderer({
    antialias: CONFIG.render.antialias && pixelRatio < 2, // MSAA is wasted on hi-dpi screens
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = CONFIG.render.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in r18x; radius gives softness
  container.appendChild(renderer.domElement);
  return renderer;
}

/** Wire window resize to renderer + camera. */
export function handleResize(renderer, camera, onResize) {
  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    onResize?.(w, h);
  };
  window.addEventListener('resize', resize);
  resize();
  return resize;
}
