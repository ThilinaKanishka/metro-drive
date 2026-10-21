# Metro Drive

A browser-based 3D city driving game built with **Three.js** and **Vite** (vanilla JavaScript, ES modules).
The low-poly city is generated procedurally, and the car runs on a custom arcade-sim physics model. AI traffic, a day/night cycle and synthesised engine audio are included.
There are no external 3D models, textures or sound files: everything is generated in code.

## Getting started

Requires Node.js 18+.

```bash
npm install
npm run dev       # start the dev server, then open the printed URL
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake. Hold it at a standstill to reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Handbrake (drift) |
| `C` | Cycle camera: chase → cockpit → top-down → cinematic |
| `N` | Toggle day / night (smooth transition) |
| `T` | Pause / resume the automatic time-of-day cycle |
| `M` | Mute / unmute |
| `R` | Reset the car onto the nearest road |
| `P` / `Esc` | Pause |
| `F` | Toggle FPS counter |

On touch devices, on-screen buttons appear for steering, throttle, brake, handbrake, camera, day/night, mute, reset and pause. Landscape orientation works best.

## Features

- **Procedural city.** A grid of blocks with two-lane roads, dashed centre lines, edge lines, crosswalks, stop lines, raised sidewalks, parks, and buildings of varied height and colour (taller downtown, some with towers on podiums). It also has rooftop clutter, trees, street lights and a boundary wall. Repeated objects are `InstancedMesh`, so the whole city is about 25 draw calls.
- **Night windows without geometry.** A small shader patch draws a world-space window grid on every building wall and lights a random subset of the windows at night.
- **Car physics.** A custom bicycle-model simulation (details below) with an automatic gearbox, speed-sensitive steering, weight transfer, tyre slip, handbrake drifts, body roll and pitch, and collisions with buildings, trees, poles, walls and AI cars.
- **Cameras.** Chase (spring follow, speed-based FOV, pulls in to avoid walls), cockpit (interior with dashboard, wheel and A-pillars), top-down (heading-up) and a cinematic orbit.
- **Day/night cycle.** A moving sun (or moon) with soft shadows that follow the car, a gradient sky dome with stars, and fog and ambient light that change through the day. Street lights and headlights turn on at dusk.
- **HUD.** Analog speedometer with an RPM ring, digital speed and gear, a heading-up minimap showing traffic, a toggleable FPS counter, and a status line.
- **AI traffic.** Cars follow lanes on the road graph, turn at intersections on Bézier curves, keep their distance from cars ahead (including you), and take turns at intersections through a reservation system.
- **Audio (Web Audio API).** The engine is synthesised from oscillators, a waveshaper and a filter, with pitch following RPM. There is also band-passed noise for tyre screech, wind noise and collision thumps. Audio starts after the first click.

## Project structure

```
index.html              Page shell: canvas container, HUD, touch buttons, start/pause screens
vite.config.js
public/favicon.svg
src/
  main.js               Entry point: creates Game, handles the Start button
  game.js               Owns all subsystems and runs fixedUpdate / update / render
  config.js             ALL tuning constants (car, city, traffic, camera, audio, rendering)
  style.css             UI styling
  core/
    renderer.js         WebGLRenderer setup (pixel-ratio cap, shadows, tone mapping), resize
    scene.js            Scene, fog and main camera
    loop.js             Fixed-timestep physics loop + variable-rate render
    input.js            Keyboard + virtual (touch) input, one-shot action events
    cameraRig.js        Chase / cockpit / top-down / cinematic camera modes
    utils.js            Seeded RNG and math helpers
  world/
    cityLayout.js       Pure data: road grid, blocks, buildings, props, colliders, spatial lookup
    city.js             Builds all world meshes from the layout
    roads.js            Ground, asphalt, sidewalks, parks, lane markings, boundary wall
    buildings.js        Instanced buildings + window shader + rooftop details
    trees.js            Instanced low-poly trees (round + conifer)
    streetLights.js     Instanced street lights + fake light pools at night
    dayNight.js         Sun/moon light, sky dome shader, fog/ambient colour, night factor
    shared.js           Shared shader uniforms (night factor)
  vehicle/
    carModel.js         Procedural car geometry (shared with traffic), player car hierarchy
    carPhysics.js       Tyre / engine / gearbox simulation
    collision.js        Circle-vs-box / circle-vs-circle collision and response
    controls.js         Smooths digital key input into pedal values
    car.js              Player car: model + physics + controls + visual sync
    skidMarks.js        Ring-buffered instanced tyre marks
  traffic/
    traffic.js          AI driving: lane graph, turns, car following, intersection reservations
    trafficRenderer.js  Draws all AI cars with ~8 instanced draw calls
  ui/
    hud.js              Speedometer, gear, FPS, status line, toasts
    minimap.js          Pre-rendered city map, rotated heading-up each frame
    touch.js            On-screen touch controls
  audio/
    engineSound.js      Synthesised engine, screech, wind and impact sounds
```

## How the car physics works

`src/vehicle/carPhysics.js` simulates the car in 2D (x, z) at 120 Hz:

1. **Engine and gearbox.** RPM comes from wheel speed through the current gear ratio and final drive. Clutch slip lets the engine rev at low speed. Torque follows a curve that peaks at `peakTorqueRpm`, with a rev limiter at redline. The automatic gearbox shifts at `shiftUpRpm` / `shiftDownRpm`, with a short torque cut during each shift.
2. **Longitudinal forces.** Drive force is limited by rear-tyre grip (excess shows up as wheelspin). Aero drag, rolling resistance, engine braking, brakes and the handbrake always oppose motion and never push the car backwards.
3. **Weight transfer.** Longitudinal acceleration moves load between the axles. Braking loads the front, so the car turns in more sharply, and accelerating loads the rear.
4. **Tyres.** Each axle gets a slip angle. Lateral force is `-corneringStiffness × slipAngle`, capped at `grip × axleLoad`. A friction circle lets rear drive force eat into rear lateral grip. The handbrake multiplies rear grip by `handbrakeRearGrip`, so the rear steps out.
5. **Integration.** Forces are summed in the car's frame and integrated in world space, along with yaw torque from both axles. Steering lock falls with speed (`steerSpeedFactor`), but extra lock is allowed for counter-steering while sliding.

Collisions approximate the car as three circles along its length. They are tested against building and wall boxes, tree and pole circles, and AI car circles. The car is pushed out of whatever it hits, and its velocity is reflected with restitution and friction. Off-centre hits add a little spin.

## Tuning

Every tunable value lives in [`src/config.js`](src/config.js). Some useful ones:

| Setting | What it changes |
| --- | --- |
| `car.mass`, `car.peakTorque`, `car.gearRatios`, `car.topSpeedKmh` | Acceleration and top speed |
| `car.tireGrip`, `car.rearGripBias`, `car.corneringStiffness*` | Cornering grip and balance |
| `car.handbrakeRearGrip`, `car.frictionCircle` | How easily the car drifts |
| `car.steerSpeedFactor`, `car.maxSteerAngle` | Steering response |
| `city.blocksX`, `city.blocksZ`, `city.blockSize`, `city.seed` | City size and layout |
| `traffic.count`, `traffic.maxSpeedKmh` | Traffic density and speed |
| `dayNight.cycleDuration`, `dayNight.autoCycle` | Day length |
| `render.shadowMapSize`, `render.maxPixelRatio`, `render.fogFar` | Performance and quality trade-offs |

## Performance notes

- Instancing is used everywhere: the whole city plus all traffic is about 60 draw calls.
- There is a single shadow-casting light. Its shadow box (`render.shadowArea`) follows the car and snaps to shadow-map texels so edges don't shimmer.
- Street lights use emissive heads and additive ground decals, not real lights. Headlight lights never toggle `visible`, because changing the light count forces a shader recompile.
- Fog hides the far city, and the pixel ratio is capped at 2.
- On a slow machine, lower `render.shadowMapSize`, set `render.maxPixelRatio` to 1, or reduce `traffic.count` or the city size.
