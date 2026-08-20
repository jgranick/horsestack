import type { RigidBody2D } from '@flighthq/sdk';
import {
  addHorseBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getHorseDropMotion,
  getHorseSpawnY,
  getNextHorseDelay,
  getSupportedStackHeight,
  HORSE_HALF_HEIGHT,
  HORSE_HALF_WIDTH,
  PASTURE_HALF_WIDTH,
  PHYSICS_STEP,
  stepHorseStack,
} from '../src/horseStackPhysics';

interface ScenarioResult {
  contacts: number;
  height: number;
  inPasture: number;
  name: string;
}

const TARGET_HALF_WIDTH = 0.32;
const VALIDATION_HORSES = 64;

const scenarios = [
  runScenario('balanced cursor', 0x42414c41, 0.35, 0.34),
  runScenario('quick cursor', 0x51554943, 2.2, 0.2),
  runScenario('frantic cursor', 0x4652414e, 5.2, 0.1),
];
validateMomentumTransfer();
validateGentleDrop();
validateFarmEdgeFalloff();

console.log(
  `gameplay: ${scenarios
    .map(
      ({ contacts, height, inPasture, name }) =>
        `${name} ${inPasture}/${VALIDATION_HORSES} in farm, ${contacts} contacts, ${height.toFixed(2)}m`,
    )
    .join('; ')}; farm-edge falloff verified`,
);

function runScenario(
  name: string,
  seed: number,
  angularMomentum: number,
  inputCadence: number,
): ScenarioResult {
  const world = createHorseStackWorld();
  const horses: RigidBody2D[] = [];
  const random = mulberry32(seed);
  const horizontalLimit = TARGET_HALF_WIDTH * 0.85;

  for (let index = 0; index < VALIDATION_HORSES; index++) {
    const currentHeight = getSupportedStackHeight(world, horses);
    const spawnY = getHorseSpawnY(currentHeight);
    const horseSeed = random() * Math.PI * 2;
    const horse = addHorseBody(
      world,
      Math.sin(horseSeed) * horizontalLimit,
      spawnY,
      (random() - 0.5) * Math.min(0.65, angularMomentum * 0.12),
    );
    const motion = getHorseDropMotion((random() < 0.5 ? -1 : 1) * angularMomentum);
    horse.velocityX = motion.velocityX;
    horse.velocityY = motion.velocityY;
    horse.angularVelocity = motion.angularVelocity;
    horses.push(horse);

    if (index === VALIDATION_HORSES - 1) continue;
    const delaySeconds = getNextHorseDelay(index + 1) / 1000;
    stepForDuration(world, horses, delaySeconds + inputCadence);
  }

  stepForDuration(world, horses, FINAL_SETTLE_SECONDS);

  const height = getSupportedStackHeight(world, horses);
  const inPasture = horses.filter(
    (horse) => Math.abs(horse.x) <= PASTURE_HALF_WIDTH && horse.y > -1,
  ).length;
  if (inPasture < VALIDATION_HORSES / 2) {
    throw new Error(`${name}: expected at least half the herd in the farm, received ${inPasture}`);
  }
  const minimumHeight = 0.12;
  if (height < minimumHeight) {
    throw new Error(
      `${name}: expected a pile over ${minimumHeight}m, received ${height.toFixed(2)}m`,
    );
  }
  if (world.contacts.length === 0) throw new Error(`${name}: expected contacts`);

  return { contacts: world.contacts.length, height, inPasture, name };
}

function validateMomentumTransfer(): void {
  const still = getHorseDropMotion(0);
  const fastLeft = getHorseDropMotion(-4.2);
  const fastRight = getHorseDropMotion(4.2);
  if ([still, fastLeft, fastRight].some((motion) => motion.velocityX !== 0)) {
    throw new Error('direct aim: drops must not receive automatic lateral velocity');
  }
  if (still.angularVelocity !== 0) {
    throw new Error('indicator momentum: a still cursor should release a level horse');
  }
  if (fastLeft.angularVelocity >= 0 || fastRight.angularVelocity <= 0) {
    throw new Error('indicator momentum: pointer direction should transfer to horse spin');
  }
}

function validateGentleDrop(): void {
  const surfaceY = 0.55;
  const restingCenterY = surfaceY + HORSE_HALF_HEIGHT;
  const releaseGap = getHorseSpawnY(surfaceY) - restingCenterY;
  const horseHeight = HORSE_HALF_HEIGHT * 2;
  if (releaseGap < horseHeight * 0.5 || releaseGap > horseHeight) {
    throw new Error(`gentle drop: expected a 0.5–1 horse-height gap, received ${releaseGap}`);
  }
  const teetering = getHorseDropMotion(5.5);
  if (Math.abs(teetering.velocityY) > 0.15) {
    throw new Error(`gentle drop: release is too fast at ${teetering.velocityY}m/s`);
  }
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
