import type { RigidBody2D } from '@flighthq/sdk';
import {
  addHorseBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getDropWindow,
  getHorseDropMotion,
  getHorseSpawnY,
  getNextHorseDelay,
  getSupportedStackHeight,
  PASTURE_HALF_WIDTH,
  PHYSICS_STEP,
  PLATFORM_HALF_WIDTH,
  stepHorseStack,
  TOTAL_HORSES,
} from '../src/horseStackPhysics';

interface ScenarioResult {
  contacts: number;
  height: number;
  inPasture: number;
  name: string;
}

const scenarios = [
  runScenario('manual pile', 0x484f5253, false),
  runScenario('timer drops', 0x54494d45, true),
];

console.log(
  `gameplay: ${scenarios
    .map(
      ({ contacts, height, inPasture, name }) =>
        `${name} ${inPasture}/${TOTAL_HORSES} in farm, ${contacts} contacts, ${height.toFixed(2)}m`,
    )
    .join('; ')}`,
);

function runScenario(name: string, seed: number, forced: boolean): ScenarioResult {
  const world = createHorseStackWorld();
  const horses: RigidBody2D[] = [];
  const random = mulberry32(seed);
  const horizontalLimit = forced ? PASTURE_HALF_WIDTH * 0.78 : PLATFORM_HALF_WIDTH * 0.85;

  for (let index = 0; index < TOTAL_HORSES; index++) {
    const currentHeight = getSupportedStackHeight(world, horses);
    const horseSeed = random() * Math.PI * 2;
    const horse = addHorseBody(
      world,
      Math.sin(horseSeed) * horizontalLimit,
      getHorseSpawnY(currentHeight),
      (random() - 0.5) * 0.28,
    );
    const motion = getHorseDropMotion(
      index,
      Math.cos(horseSeed),
      random() - 0.5,
      random() - 0.5,
      forced,
    );
    horse.velocityX = motion.velocityX;
    horse.velocityY = motion.velocityY;
    horse.angularVelocity = motion.angularVelocity;
    horses.push(horse);

    if (index === TOTAL_HORSES - 1) continue;
    const delaySeconds = getNextHorseDelay(index + 1) / 1000;
    const cadenceSeconds = delaySeconds + (forced ? getDropWindow(index + 1) : 0);
    stepForDuration(world, horses, cadenceSeconds);
  }

  stepForDuration(world, horses, FINAL_SETTLE_SECONDS);

  const height = getSupportedStackHeight(world, horses);
  const inPasture = horses.filter(
    (horse) => Math.abs(horse.x) <= PASTURE_HALF_WIDTH && horse.y > -1,
  ).length;
  if (inPasture < TOTAL_HORSES / 2) {
    throw new Error(`${name}: expected at least half the herd in the farm, received ${inPasture}`);
  }
  if (forced && inPasture === TOTAL_HORSES) {
    throw new Error(`${name}: expected the panic cadence to send at least one horse off the farm`);
  }
  const minimumHeight = forced ? 0.05 : 0.12;
  if (height < minimumHeight) {
    throw new Error(
      `${name}: expected a pile over ${minimumHeight}m, received ${height.toFixed(2)}m`,
    );
  }
  if (world.contacts.length === 0) throw new Error(`${name}: expected contacts`);

  return { contacts: world.contacts.length, height, inPasture, name };
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
