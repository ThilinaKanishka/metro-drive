import { createRenderer, handleResize } from './core/renderer.js';
import { createScene } from './core/scene.js';
import { Loop } from './core/loop.js';
import { Input } from './core/input.js';
import { City } from './world/city.js';
import { DayNight } from './world/dayNight.js';

/** Step 1 scaffold: world only, orbiting camera. */
export class Game {
  constructor(container) {
    this.renderer = createRenderer(container);
    const { scene, camera } = createScene();
    this.scene = scene;
    this.camera = camera;
    this.input = new Input();
    this.city = new City(scene);
    this.dayNight = new DayNight(scene, this.renderer);
    this.t = 0;
    handleResize(this.renderer, camera);
    this.loop = new Loop({
      fixedUpdate: () => {},
      update: (dt) => {
        this.t += dt;
        camera.position.set(Math.cos(this.t * 0.1) * 120, 60, Math.sin(this.t * 0.1) * 120);
        camera.lookAt(0, 0, 0);
        this.dayNight.update(dt, camera.position.clone().setY(0), camera);
        this.city.update(this.dayNight.night);
      },
      render: () => this.renderer.render(scene, camera),
    });
    this.loop.start();
  }

  start() {
    this.started = true;
  }
}
