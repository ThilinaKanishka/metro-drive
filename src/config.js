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
    cockpitOffset: [-0.36, 1.12, -0.1], // relative to car (x = driver side)
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
  },
};

// Derived helpers -----------------------------------------------------------
export const KMH = 1 / 3.6; // multiply km/h by this to get m/s
