import * as THREE from 'three';
import { CONFIG } from '../config.js';

/** Scene + main camera. Fog colour is driven by the day/night system. */
export function createScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xbfd4e6, CONFIG.render.fogNear, CONFIG.render.fogFar);
  scene.background = new THREE.Color(0xbfd4e6);

  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    CONFIG.render.cameraFar,
  );
  camera.position.set(0, 10, -20);
  scene.add(camera);
  return { scene, camera };
}
