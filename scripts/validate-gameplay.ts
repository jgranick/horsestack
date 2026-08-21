import type { RigidBody2D } from '@flighthq/sdk';
import {
  addHorseBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getNextHorseDelay,
  getStackHeightHands,
  getStackHeightMeters,
  getSupportedStackHeight,
  HORSE_HALF_HEIGHT,
  HORSE_HALF_WIDTH,
  PASTURE_HALF_WIDTH,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  stepHorseStack,
  TYPICAL_HORSE_WITHERS_METERS,
} from '../src/horseStackPhysics';

interface ScenarioResult {
  contacts: number;
  hands: number;
  heightMeters: number;
  inPasture: number;
  name: string;
}

const TARGET_HALF_WIDTH = 0.32;
const VALIDATION_HORSES = 64;

const scenarios = [
  runScenario('level placements', 0x4c455645, 0.04, 0.34),
  runScenario('balanced placements', 0x42414c41, 0.28, 0.2),
  runScenario('teetered placements', 0x54454554, 0.6, 0.1),
];
validateStableActivation();
validateHeightCalibration();
validateFarmEdgeFalloff();

console.log(
  `gameplay: ${scenarios
    .map(
      ({ contacts, hands, heightMeters, inPasture, name }) =>
        `${name} ${inPasture}/${VALIDATION_HORSES} in farm, ${contacts} contacts, ${heightMeters.toFixed(2)}m/${hands} hands`,
    )
    .join('; ')}; horse-height calibration and farm-edge falloff verified`,
);

function runScenario(
  name: string,
  seed: number,
  maxTilt: number,
  inputCadence: number,
): ScenarioResult {
  const world = createHorseStackWorld();
  const horses: RigidBody2D[] = [];
  const random = mulberry32(seed);
  const horizontalLimit = TARGET_HALF_WIDTH * 0.85;

  for (let index = 0; index < VALIDATION_HORSES; index++) {
    const horseSeed = random() * Math.PI * 2;
    const x = Math.sin(horseSeed) * horizontalLimit;
    const angle = (random() * 2 - 1) * maxTilt;
    const landingSurfaceY = getPlacementSurfaceY(horses, x);
    const horse = addHorseBody(
      world,
      x,
      landingSurfaceY + getVerticalExtent(angle),
      angle,
    );
    horse.velocityX = 0;
    horse.velocityY = 0;
    horse.angularVelocity = 0;
    horses.push(horse);

    if (index === VALIDATION_HORSES - 1) continue;
    const delaySeconds = getNextHorseDelay(index + 1) / 1000;
    stepForDuration(world, horses, inputCadence + delaySeconds);
  }

  stepForDuration(world, horses, FINAL_SETTLE_SECONDS);

  const stackTopY = getSupportedStackHeight(world, horses);
  const heightMeters = getStackHeightMeters(stackTopY);
  const inPasture = horses.filter(
    (horse) => Math.abs(horse.x) <= PASTURE_HALF_WIDTH && horse.y > -1,
  ).length;
  if (inPasture < VALIDATION_HORSES / 2) {
    throw new Error(`${name}: expected at least half the herd in the farm, received ${inPasture}`);
  }
  const minimumHeightMeters = 1.2;
  if (heightMeters < minimumHeightMeters) {
    throw new Error(
      `${name}: expected a pile over ${minimumHeightMeters}m, received ${heightMeters.toFixed(2)}m`,
    );
  }
  if (world.contacts.length === 0) throw new Error(`${name}: expected contacts`);

  return {
    contacts: world.contacts.length,
    hands: getStackHeightHands(stackTopY),
    heightMeters,
    inPasture,
    name,
  };
}

function validateStableActivation(): void {
  const world = createHorseStackWorld();
  const angle = 0.42;
  const horse = addHorseBody(
    world,
    0,
    PASTURE_TOP_Y + getVerticalExtent(angle),
    angle,
  );
  if (horse.velocityX !== 0 || horse.velocityY !== 0 || horse.angularVelocity !== 0) {
    throw new Error(
      'stable placement: a placed horse must activate without linear or angular impulse',
    );
  }
}

function validateHeightCalibration(): void {
  const oneHorseTopY = PASTURE_TOP_Y + HORSE_HALF_HEIGHT * 2;
  const meters = getStackHeightMeters(oneHorseTopY);
  if (Math.abs(meters - TYPICAL_HORSE_WITHERS_METERS) > 0.000_001) {
    throw new Error(
      `height calibration: one upright horse should read ${TYPICAL_HORSE_WITHERS_METERS}m, received ${meters}m`,
    );
  }
  if (getStackHeightHands(oneHorseTopY) !== 15) {
    throw new Error('height calibration: a 1.55m horse should round to 15 hands');
  }
}

function getPlacementSurfaceY(horses: readonly RigidBody2D[], x: number): number {
  let surfaceY = PASTURE_TOP_Y;
  const horizontalReach = HORSE_HALF_WIDTH * 1.85;
  for (const horse of horses) {
    if (
      horse.y < PASTURE_TOP_Y ||
      Math.abs(horse.x - x) > horizontalReach ||
      Math.abs(horse.velocityY) > 1.2
    ) {
      continue;
    }
    surfaceY = Math.max(surfaceY, horse.y + getVerticalExtent(horse.angle));
  }
  return surfaceY;
}

function getVerticalExtent(angle: number): number {
  return (
    Math.abs(Math.cos(angle)) * HORSE_HALF_HEIGHT +
    Math.abs(Math.sin(angle)) * HORSE_HALF_WIDTH
  );
}

function validateFarmEdgeFalloff(): void {
  const world = createHorseStackWorld();
  const horse = addHorseBody(world, PASTURE_HALF_WIDTH - HORSE_HALF_WIDTH, 0.2, 0);
  horse.velocityX = 1.4;
  stepForDuration(world, [horse], 1);
  if (horse.y >= -0.1) {
    throw new Error(`farm edge: expected a horse to fall into the void, received y=${horse.y}`);
  }
}

function stepForDuration(
  world: ReturnType<typeof createHorseStackWorld>,
  horses: readonly RigidBody2D[],
  seconds: number,
): void {
  for (let step = 0; step < Math.ceil(seconds / PHYSICS_STEP); step++) {
    stepHorseStack(world);
    assertFiniteBodies(horses);
  }
}

function assertFiniteBodies(bodies: readonly RigidBody2D[]): void {
  for (let index = 0; index < bodies.length; index++) {
    const horse = bodies[index];
    if (horse === undefined) continue;
    const values = [
      horse.x,
      horse.y,
      horse.angle,
      horse.velocityX,
      horse.velocityY,
      horse.angularVelocity,
    ];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Horse ${index + 1} produced non-finite physics state`);
    }
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
