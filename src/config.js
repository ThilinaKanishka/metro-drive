/**
 * Central tuning file. Every gameplay / rendering constant lives here so the
 * feel of the game can be adjusted without touching the systems themselves.
 * Units: metres, seconds, kilograms, radians unless noted.
 */
export const CONFIG = {
  render: {
    maxPixelRatio: 2,          // cap devicePixelRatio for performance
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    shadowRadius: 3,           // PCF blur radius (soft shadows)
    shadowArea: 70,            // half-size of the shadow camera box that follows the car
    fogNear: 120,
    fogFar: 420,
    cameraFar: 900,
  },

  city: {
    seed: 1337,                // change for a different city
    blocksX: 8,                // number of city blocks along X
    blocksZ: 8,                // number of city blocks along Z
    blockSize: 56,             // size of a block (incl. sidewalk)
    roadWidth: 14,             // full road width (2 lanes, one per direction)
    sidewalkWidth: 3.5,
    sidewalkHeight: 0.15,
    parkChance: 0.12,          // probability a block becomes a park
    minBuildingHeight: 8,
    maxBuildingHeight: 70,
    downtownFalloff: 0.55,     // how strongly building height drops away from centre
    treeSpacing: 14,           // spacing of trees along sidewalks
    streetLightSpacing: 22,    // spacing of street lights along sidewalks
  },

  car: {
    mass: 1250,                // kg
    inertiaScale: 1.0,         // multiplier on yaw inertia (higher = lazier rotation)
    wheelBase: 2.6,
    cgToFront: 1.25,           // distance from centre of gravity to front axle
    cgHeight: 0.55,            // used for weight transfer
    width: 1.9,
    length: 4.3,
    wheelRadius: 0.34,

    // Engine & gearbox (automatic)
    idleRpm: 900,
    redlineRpm: 7000,
    peakTorqueRpm: 4400,
    peakTorque: 320,           // N·m
    gearRatios: [3.4, 2.2, 1.6, 1.25, 1.0, 0.82],
    reverseRatio: 3.2,
    finalDrive: 3.7,
    drivetrainEfficiency: 0.8,
    shiftUpRpm: 6300,
    shiftDownRpm: 2600,
    shiftTime: 0.22,           // seconds of no drive during a shift
    topSpeedKmh: 210,          // hard limiter
    reverseTopSpeedKmh: 28,

    // Resistances
    dragCoefficient: 0.42,     // aero: F = c * v^2
    rollingResistance: 12,     // F = c * v
    engineBraking: 1800,       // N at high rpm with throttle released
    brakeForce: 11000,         // N total
    handbrakeForce: 4500,      // N (rear only)

    // Tyres
    corneringStiffnessFront: 70000, // N per rad of slip
    corneringStiffnessRear: 76000,
    tireGrip: 1.15,            // friction coefficient (mu)
    rearGripBias: 1.12,        // extra rear grip = stability (understeer bias)
    handbrakeRearGrip: 0.5,    // rear grip multiplier while handbrake is held
    frictionCircle: 0.5,       // how much rear drive force eats lateral grip (0..1)
    lowSpeedSlipSoftening: 2.0,// m/s added to denominator of slip angle (stability)
    yawDamping: 1500,           // extra yaw damping torque per rad/s (stability aid)

    // Steering
    maxSteerAngle: 0.62,       // at standstill
    steerSpeedFactor: 0.065,   // larger -> less steering at speed
    steerRate: 3.2,            // how fast the wheel turns toward input (rad/s)
    steerReturnRate: 5.0,
    reverseSteerSpeedFactor: 0.18, // reversing is unstable at speed: lose lock faster

    // Visual body motion
    bodyRollFactor: 0.012,     // rad per m/s^2 lateral accel
    bodyPitchFactor: 0.008,
    bodySpring: 9,             // smoothing for roll / pitch

    // Collision
    collisionRestitution: 0.25,
    collisionFriction: 0.6,    // velocity kept after hitting something (0..1)
  },

  physics: {
    fixedStep: 1 / 120,        // physics substep
    maxSubSteps: 10,
  },

  camera: {
    fov: 65,
    chaseDistance: 7.2,
    chaseHeight: 2.6,
    chaseLookAhead: 4,
    chaseStiffness: 6,         // positional smoothing
    speedFovBoost: 14,         // extra FOV at top speed
    topHeight: 70,
    cinematicRadius: 18,
    cinematicHeight: 7,
    cinematicSpeed: 0.18,      // rad/s orbit speed
  },

  dayNight: {
    autoCycle: true,
    cycleDuration: 300,        // seconds for a full 24h cycle
    startTime: 0.42,           // 0 = midnight, 0.5 = noon
    toggleTransition: 2.5,     // seconds to blend when pressing N
  },

  traffic: {
    count: 34,
    minSpeedKmh: 30,
    maxSpeedKmh: 50,
    turnSpeedKmh: 18,
    acceleration: 4,           // m/s^2
    braking: 9,
    safeDistance: 9,           // start slowing when a car is closer than this
    stopDistance: 5,
    intersectionWaitTimeout: 4,// seconds before a waiting car proceeds anyway
    colors: [0xd23a3a, 0x2f6fd6, 0xf2f2f2, 0x222428, 0xf0c419, 0x3aa856, 0x8a8f99, 0xe07b2a, 0x5b3fa8],
  },

  audio: {
    masterVolume: 0.5,
    engineVolume: 0.32,
    screechVolume: 0.22,
    cylinders: 4,
  },

  player: {
    color: 0xe23b2e,
    car: 'sedan',
  },

  /**
   * Player car catalogue. `CONFIG.car` above is the shared baseline; each
   * entry overrides it. The headline stats (mass, top speed, torque, grip,
   * braking, steering, drift) feed the physics directly (see makeCarConfig),
   * `shape` picks the procedural body and `sound` the engine voice.
   */
  cars: {
    hatchback: {
      name: 'Metro Hatch',
      shape: 'hatchback',
      mass: 1050,
      topSpeedKmh: 175,
      peakTorque: 175,
      grip: 1.12,
      brakeForce: 9500,
      steering: 1.1,           // multiplier on lock and steering rate
      drift: 0.35,             // 0 = planted, 1 = tail-happy
      wheelBase: 2.42, cgToFront: 1.1, cgHeight: 0.55,
      wheelRadius: 0.31,
      dragCoefficient: 0.4,
      sound: { cylinders: 4, pitch: 1.15, tone: 1.1, rough: 0.12, sub: 0.25 },
    },
    sedan: {
      name: 'City Sedan',
      shape: 'sedan',
      mass: 1250,
      topSpeedKmh: 210,
      peakTorque: 320,
      grip: 1.15,
      brakeForce: 11000,
      steering: 1.0,
      drift: 0.45,
      wheelBase: 2.6, cgToFront: 1.25, cgHeight: 0.55,
      dragCoefficient: 0.42,
      sound: { cylinders: 4, pitch: 1.0, tone: 1.0, rough: 0.18, sub: 0.35 },
    },
    sports: {
      name: 'Vento GT',
      shape: 'sports',
      mass: 1320,
      topSpeedKmh: 270,
      peakTorque: 520,
      grip: 1.32,
      brakeForce: 15500,
      steering: 1.08,
      drift: 0.65,
      wheelBase: 2.65, cgToFront: 1.35, cgHeight: 0.45,
      dragCoefficient: 0.32,
      shiftUpRpm: 7000, redlineRpm: 7800,
      sound: { cylinders: 6, pitch: 1.05, tone: 1.45, rough: 0.1, sub: 0.3 },
    },
    suv: {
      name: 'Ridge SUV',
      shape: 'suv',
      mass: 1950,
      topSpeedKmh: 185,
      peakTorque: 450,
      grip: 1.02,
      brakeForce: 14000,
      steering: 0.85,
      drift: 0.2,
      wheelBase: 2.85, cgToFront: 1.4, cgHeight: 0.8,
      dragCoefficient: 0.55,
      wheelRadius: 0.42,
      redlineRpm: 6200, shiftUpRpm: 5600, shiftDownRpm: 2300,
      sound: { cylinders: 6, pitch: 0.82, tone: 0.8, rough: 0.2, sub: 0.45 },
    },
    pickup: {
      name: 'Haul V8',
      shape: 'pickup',
      mass: 2100,
      topSpeedKmh: 190,
      peakTorque: 460,
      grip: 1.0,
      brakeForce: 13500,
      steering: 0.8,
      drift: 0.75,             // light rear end, big torque
      wheelBase: 3.2, cgToFront: 1.45, cgHeight: 0.75,
      dragCoefficient: 0.58,
      wheelRadius: 0.42,
      redlineRpm: 6000, shiftUpRpm: 5400, shiftDownRpm: 2200,
      sound: { cylinders: 8, pitch: 0.7, tone: 0.75, rough: 0.32, sub: 0.6 },
    },
    tuktuk: {
      name: 'Tuk-Tuk',
      shape: 'tuktuk',
      mass: 420,
      topSpeedKmh: 70,
      peakTorque: 26,
      grip: 0.95,
      brakeForce: 3600,
      steering: 1.25,
      drift: 0.5,
      wheelBase: 1.7, cgToFront: 0.95, cgHeight: 0.6,
      dragCoefficient: 0.5,
      rollingResistance: 6,
      wheelRadius: 0.25,
      gearRatios: [3.6, 2.3, 1.6, 1.15],
      finalDrive: 4.6,
      redlineRpm: 7500, shiftUpRpm: 6800, shiftDownRpm: 3000, peakTorqueRpm: 5000,
      sound: { cylinders: 1, pitch: 1.6, tone: 1.3, rough: 0.45, sub: 0.1, buzz: true },
    },
  },

  /** Preset paint colours offered in the garage. */
  paintColors: [0xe23b2e, 0xf2f2f2, 0x1d1f24, 0x2f6fd6, 0xf0c419, 0x3aa856, 0xe07b2a, 0x8a8f99],
};

/**
 * Full physics config for a car from the catalogue: CONFIG.car baseline plus
 * the car's overrides, with the headline stats translated into tyre / steering
 * parameters.
 */
export function makeCarConfig(id) {
  const def = CONFIG.cars[id] || CONFIG.cars.sedan;
  const base = CONFIG.car;
  const drift = def.drift ?? 0.45;
  const steer = def.steering ?? 1;
  const cfg = { ...base };
  for (const k in def) if (k in base) cfg[k] = def[k];
  cfg.id = id in CONFIG.cars ? id : 'sedan';
  cfg.name = def.name;
  cfg.shape = def.shape;
  cfg.sound = def.sound;
  cfg.tireGrip = def.grip ?? base.tireGrip;
  // Drift tendency: less rear bias, a looser handbrake and a stronger friction circle.
  cfg.rearGripBias = 1.2 - drift * 0.2;
  cfg.handbrakeRearGrip = 0.62 - drift * 0.3;
  cfg.frictionCircle = 0.3 + drift * 0.5;
  cfg.yawDamping = base.yawDamping * (1.2 - drift * 0.5) * (cfg.mass / base.mass);
  // Cornering stiffness scales with load so heavy cars aren't twitchy.
  const load = cfg.mass / base.mass;
  cfg.corneringStiffnessFront = base.corneringStiffnessFront * load;
  cfg.corneringStiffnessRear = base.corneringStiffnessRear * load;
  cfg.maxSteerAngle = base.maxSteerAngle * Math.min(steer, 1.1);
  cfg.steerRate = base.steerRate * steer;
  cfg.steerSpeedFactor = base.steerSpeedFactor / steer;
  cfg.engineBraking = base.engineBraking * load;
  cfg.handbrakeForce = base.handbrakeForce * load;
  return cfg;
}

// Derived helpers -----------------------------------------------------------
export const KMH = 1 / 3.6; // multiply km/h by this to get m/s
