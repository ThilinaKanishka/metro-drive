# Metro Drive

A browser-based 3D city driving game built with **Three.js** and **Vite** (vanilla JavaScript, ES modules).
The low-poly city is generated procedurally, and every car runs on a custom arcade-sim physics model. The game has six player cars, AI traffic with traffic lights, pedestrians, missions, weather, a day/night cycle and synthesised audio.
There are no external 3D models, textures or sound files: everything is generated in code.

## Getting started

Requires Node.js 18+.

```bash
npm install
npm run dev       # start the dev server, then open the printed URL
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

## How to play

The main menu has a **mode selector** (Free Roam, Taxi, Checkpoint Race) and three buttons: **Play**, **Garage** and **Settings**.
**Play** opens the garage so you can pick a car, then **Drive** starts the game.

| Mode | Goal |
| --- | --- |
| Free Roam | Drive anywhere. Drifts earn points. Running red lights, hitting pedestrians and crashing cost points. |
| Taxi | A passenger waves from the kerb under a yellow beacon. Stop next to them, then drive to the green beacon before the timer runs out. You earn a fare plus a tip for each second left. Crashes and incidents reduce the tip. |
| Checkpoint Race | A fixed 10-checkpoint route with a 3-2-1 countdown, a race timer and a saved best time. Use Pause → Restart to race again. |

A **waypoint arrow** under the mission panel always points to the current target, and the minimap shows it too (pinned to the rim when it is off-map).
**Score** is per session. **Money** is a wallet saved between sessions: you earn it from fares and race prizes and spend it on repairs.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake. Hold it at a standstill to reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Handbrake (drift) |
| `H` | Horn (pedestrians ahead jump out of the way) |
| `Q` / `E` | Left / right indicator (cancels itself after the turn) |
| `C` | Cycle camera: chase → cockpit → top-down → cinematic |
| `N` | Toggle day / night (smooth transition) |
| `T` | Pause / resume the automatic time-of-day cycle |
| `M` | Mute / unmute |
| `R` | Repair any damage (paid from your wallet when possible) and reset the car onto the nearest road |
| `P` / `Esc` | Pause menu: Resume, Garage, Settings, Traffic density, Restart, Main menu |
| `F` | Toggle FPS counter |

In the garage: `↑` `↓` choose a car, `←` `→` choose a paint colour, `Enter` drives and `Esc` goes back. Drag to spin the car.

On touch devices, on-screen buttons appear for steering, throttle, brake, handbrake, camera, day/night, mute, reset and pause. Landscape orientation works best.

## Features

### Cars and garage
- **Six player cars**, each a distinct procedural shape: Metro Hatch, City Sedan, Vento GT (sports), Ridge SUV, Haul V8 (pickup) and Tuk-Tuk (three wheels).
- **Per-car stats** in `config.cars`: mass, top speed, torque, grip, braking, steering and drift tendency. `makeCarConfig()` turns them into tyre, steering and damping parameters, so each car really drives differently.
- **Garage**: a rotating turntable preview with studio reflections and 8 paint colours. The stat bars (Speed / Acceleration / Handling / Braking) and the specs (0–100 time, top speed, braking distance) are **measured by running each car's physics offline**, so they always match the handling.
- The last car and paint colour are remembered in `localStorage` (all storage access is wrapped in try/catch).
- **Per-car engine voice**: cylinder count, pitch, filter tone, roughness, and a 2-stroke buzz for the tuk-tuk.
- **Lights**: headlights that cast real light at night and in bad weather, brake lights with a glow, reverse lights, and working indicators.
- **Damage**: heavy crashes dent the body mesh around the impact point, the engine smokes and loses power, and `R` repairs it.

### Traffic
- **Traffic lights** at every junction with three or more approaches, with green → yellow → all-red phases per axis, offset per junction. There are signal heads over each lane, pedestrian walk / flashing / don't-walk heads, and stop lines.
- **Vehicle mix**: cars, taxis, buses, trucks, motorbikes (with riders) and tuk-tuks, each with its own size, speed and acceleration.
- **Driving AI** using the Intelligent Driver Model:
  - smooth acceleration and braking with a time-headway gap
  - stops on red; on yellow, stops only if it can do so comfortably
  - left turns yield to oncoming traffic, and a "don't block the box" rule prevents gridlock
  - uses its indicators before turning, stops for pedestrians, and honks when you block it
- Traffic **spawns and despawns in a ring around the player** (avoiding the camera's view), so the city stays busy wherever you drive. Density is Low / Medium / High.
- **Parked cars** line some kerbs.
- **Red-light running** by the player is detected and penalised.

### Pedestrians
- Low-poly people (head, hair, torso, hips, arms, legs) with varied skin, hair and clothes, plus kids and long hair.
- People walk the sidewalks with a swinging walk cycle. They wait at the kerb and cross on the zebra only when their signal says walk, and hurry if it starts flashing.
- Some people stand at shop fronts, bus stops and benches, and more gather at lit shops at night.
- **Reactions**: people jump back or run when a car is about to pass close or honks. A person who is hit tips over, lies down for a few seconds, then gets up (no gore), and you lose points.

### World
- **Procedural city**: a grid of blocks with two-lane roads, markings, crosswalks, stop lines, raised sidewalks, parks with paths, benches and fountains, and buildings of varied height (taller downtown). There are also trees, street lights, bus stops, benches, trash bins, and shop signs with awnings that light up at night.
- **Weather**: clear, rain or fog (selectable, or random per session), blended over a few seconds.
  - Rain brings falling streaks, wet glossy roads that reflect the sky, less tyre grip and slower AI.
  - Both rain and fog make the sky overcast, dim the sun and switch headlights on.
- **Reflections**: car paint, glass, rims and wet roads use a PMREM environment map of the current sky, re-rendered only when the sky changes noticeably.
- **Day/night cycle**: a moving sun or moon with soft shadows, a gradient sky with stars, lit windows at night, and street lights.
- **Audio** (Web Audio API, all synthesised): engine, tyre screech, wind, impacts, horns, distant traffic, random far-off horns and rain.

### Menus
- **Main menu**: mode select, Play, Garage, Settings.
- **Settings**: Graphics (Low / Medium / High), Volume, Traffic density, Time of day (cycle / day / night) and Weather (random / clear / rain / fog). All settings are saved.
- **Pause menu**: Resume, Garage (swap cars mid-session), Settings, Traffic density, Restart, Main menu.

## Project structure

```
index.html              Page shell: canvas, HUD, touch buttons, main menu, garage, settings, pause
src/
  main.js               Entry point: creates Game, wires the main menu
  game.js               Owns all subsystems and the game state (menu / garage / settings / playing / paused)
  config.js             ALL tuning constants: cars, traffic, lights, pedestrians, missions, weather, quality presets
  style.css             UI styling
  core/
    renderer.js         WebGLRenderer setup, resize (pixel-ratio cap follows the quality setting)
    scene.js            Scene, fog and main camera
    loop.js             Fixed-timestep physics loop + variable-rate render
    input.js            Keyboard + virtual (touch) input, one-shot action events
    cameraRig.js        Chase / cockpit / top-down / cinematic cameras (adapt to car size)
    storage.js          try/catch-guarded localStorage preferences
    utils.js            Seeded RNG and math helpers
  world/
    cityLayout.js       Pure data: road grid, blocks, buildings, props, colliders, spatial lookup
    city.js             Builds all world meshes from the layout
    roads.js            Ground, asphalt, sidewalks, parks, lane markings, boundary wall
    buildings.js        Instanced buildings + window shader + rooftop details
    trees.js            Instanced low-poly trees
    streetLights.js     Instanced street lights + fake light pools at night
    props.js            Bus stops, benches, bins, shop signs, park paths and fountains
    dayNight.js         Sun/moon light, sky dome shader, fog/ambient colour, night factor
    weather.js          Clear / rain / fog: rain streaks, wet roads, grip, overcast sky
    environment.js      PMREM reflection map for cars and wet roads
    shared.js           Shared shader uniforms (night factor)
  vehicle/
    vehicleShapes.js    Procedural geometry for every vehicle type (player + AI)
    carModel.js         Player car hierarchy: wheels, lamps, glows, headlight beams, cockpit
    carPhysics.js       Tyre / engine / gearbox simulation
    carStats.js         Garage stats measured by simulating each car
    collision.js        Circle-vs-box / circle-vs-circle collision and response
    controls.js         Smooths digital key input into pedal values
    car.js              Player car: model + physics + controls + indicators, swap vehicles
    damage.js           Body dents, engine smoke, power loss, repair
    skidMarks.js        Ring-buffered instanced tyre marks
  traffic/
    trafficLights.js    Signal phases, light heads, pedestrian signals, red-light check
    traffic.js          AI driving (IDM), junction logic, spawning ring, parked cars
    trafficRenderer.js  All AI vehicles via BatchedMesh + instanced wheels / lamps
  people/
    pedestrians.js      Pedestrian simulation: sidewalks, crossings, idle, flee, fall, taxi fares
    pedestrianRenderer.js  Six InstancedMeshes, animation, culling
  gameplay/
    score.js            Score, money wallet, drift points, HUD popups
    missions.js         Free roam / taxi / checkpoint race, beacons, waypoint target
  ui/
    hud.js              Speedometer, score, mission panel, waypoint arrow, damage, indicators, toasts
    minimap.js          Heading-up minimap with traffic and mission markers
    garage.js           Garage scene + car / paint selection UI
    settings.js         Settings screen
    touch.js            On-screen touch controls
  audio/
    engineSound.js      Synthesised engine (per-car profile), screech, wind, impacts, horn
    cityAudio.js        Traffic rumble, distant horns, rain
```

### How the systems plug into the loop

`Game` owns everything. `fixedUpdate` (120 Hz) steps the player car physics and collisions, with grip scaled by the weather.
Each frame, `update` runs the following in order:
1. Traffic lights, traffic AI and the player's red-light check
2. Crash handling (damage and score)
3. Car visuals and cameras
4. Day/night, then weather, which adjusts the day/night result, then reflections
5. Traffic and pedestrian rendering
6. Missions and drift scoring
7. HUD, minimap and audio

While the garage is open, the same renderer draws the garage scene instead of the city.

## How the car physics works

`src/vehicle/carPhysics.js` simulates the car in 2D (x, z) at 120 Hz:

1. **Engine and gearbox.** RPM comes from wheel speed through the current gear ratio and final drive. Clutch slip lets the engine rev at low speed. Torque follows a curve that peaks at `peakTorqueRpm`, with a rev limiter at redline. The automatic gearbox shifts at `shiftUpRpm` / `shiftDownRpm`, with a short torque cut during each shift. Crash damage scales engine power down.
2. **Longitudinal forces.** Drive force is limited by rear-tyre grip (excess shows up as wheelspin). Aero drag, rolling resistance, engine braking, brakes and the handbrake always oppose motion and never push the car backwards.
3. **Weight transfer.** Longitudinal acceleration moves load between the axles. Braking loads the front, so the car turns in more sharply, and accelerating loads the rear.
4. **Tyres.** Each axle gets a slip angle. Lateral force is `-corneringStiffness × slipAngle`, capped at `grip × axleLoad` (grip drops on wet roads). A friction circle lets rear drive force eat into rear lateral grip. The handbrake multiplies rear grip by `handbrakeRearGrip`, so the rear steps out.
5. **Integration.** Forces are summed in the car's frame and integrated in world space, along with yaw torque from both axles. Steering lock falls with speed (`steerSpeedFactor`), but extra lock is allowed for counter-steering while sliding.

`makeCarConfig()` in `config.js` maps each car's headline stats onto these parameters. For example, `drift` lowers rear grip bias and handbrake grip and strengthens the friction circle, and `steering` scales lock and steering rate.

Collisions approximate each vehicle as a row of circles sized to its footprint. They are tested against building and wall boxes, tree, pole, prop and parked-car colliders, and AI vehicles. The car is pushed out of whatever it hits, and its velocity is reflected with restitution and friction.

## Tuning

Every tunable value lives in [`src/config.js`](src/config.js). Some useful ones:

| Setting | What it changes |
| --- | --- |
| `cars.<id>` (`mass`, `topSpeedKmh`, `peakTorque`, `grip`, `brakeForce`, `steering`, `drift`, `sound`) | Each player car's handling and engine voice |
| `paintColors` | Garage paint swatches |
| `traffic.density`, `traffic.types` | Vehicle counts per density level, and the AI vehicle mix (weights, speeds, acceleration) |
| `traffic.minGap`, `traffic.headway` | How closely AI vehicles follow |
| `trafficLights.green` / `yellow` / `allRed` | Signal timing |
| `pedestrians.count`, `pedestrians.crossChance`, `pedestrians.idleChance` | How many people there are and how they behave |
| `missions.taxi`, `missions.race` | Fares, timers, race route seed and checkpoint count |
| `weather.*` | Rain grip, fog distances, weather odds |
| `quality.low` / `medium` / `high` | What each graphics preset does |
| `city.*` | City size and layout |

## Performance notes

- Draw calls stay around 100 at Medium settings:
  - all AI vehicles of every type render with three `BatchedMesh` draw calls (with per-object frustum culling) plus instanced wheels and lamps
  - pedestrians are six `InstancedMesh` draw calls
  - each street-prop type is one instanced or merged mesh
- **LOD and culling.** Vehicles beyond the draw distance are hidden, and wheels and lamps are only written for nearby vehicles. People beyond the draw distance or behind the camera are skipped, and their limbs only animate up close.
- **Pools.** Traffic and pedestrians are fixed-size pools that respawn around the player, so the cost doesn't grow with the city.
- **Lights and shadows.** There is a single shadow-casting sun. Only at High quality does one headlight also cast shadows. Headlight intensities fade rather than toggling `visible`, because changing the light count recompiles shaders.
- **Rain** is animated in a vertex shader (no per-drop CPU work). The reflection map is rebuilt only when the sky colour changes (about 2 ms each time).
- **Measured cost.** On the test machine, total CPU time per frame (simulation + render submission) was about 4–5 ms at Low and Medium and about 9.5 ms at High with high traffic density. That is within the 16.7 ms budget for 60 FPS.
- **On a slow machine,** pick Low in Settings. It disables shadows, uses pixel ratio 1, and runs fewer people and cars over a shorter draw distance.
