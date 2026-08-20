import type { RigidBody2D } from '@flighthq/sdk';
import {
  addHorseBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getHorseDropMotion,
  getHorseSpawnY,
  getNextHorseDelay,
  getSupportedStackHeight,
  PASTURE_HALF_WIDTH,
  PHYSICS_STEP,
  stepHorseStack,
  TOTAL_HORSES,
} from '../src/horseStackPhysics';

const world = createHorseStackWorld();
const horses: RigidBody2D[] = [];
const random = mulberry32(0x484f5253);

for (let index = 0; index < TOTAL_HORSES; index++) {
  const currentHeight = getSupportedStackHeight(world, horses);
  const seed = random() * Math.PI * 2;
  const horse = addHorseBody(
    world,
    Math.sin(seed) * 0.62,
    getHorseSpawnY(currentHeight),
    (random() - 0.5) * 0.28,
  );
  const motion = getHorseDropMotion(
    index,
    Math.cos(seed),
    random() - 0.5,
    random() - 0.5,
    index % 5 === 4,
  );
  horse.velocityX = motion.velocityX;
  horse.velocityY = motion.velocityY;
  horse.angularVelocity = motion.angularVelocity;
  horses.push(horse);

  const cadenceSteps = Math.ceil(getNextHorseDelay(index + 1) / 1000 / PHYSICS_STEP);
  for (let step = 0; step < cadenceSteps; step++) {
    stepHorseStack(world);
    assertFiniteBodies(horses);
  }
}

for (let step = 0; step < Math.ceil(FINAL_SETTLE_SECONDS / PHYSICS_STEP); step++) {
  stepHorseStack(world);
  assertFiniteBodies(horses);
}

const height = getSupportedStackHeight(world, horses);
const inPasture = horses.filter(
  (horse) => Math.abs(horse.x) <= PASTURE_HALF_WIDTH && horse.y > -1,
).length;
if (inPasture < TOTAL_HORSES / 2) {
  throw new Error(`Expected at least half the herd in the pasture, received ${inPasture}`);
}
if (height < 1) throw new Error(`Expected a pile over 1m, received ${height.toFixed(2)}m`);
if (world.contacts.length === 0) throw new Error('Expected the horse stack to produce contacts');

console.log(
  `gameplay: ${inPasture}/${horses.length} horses in pasture, ${world.contacts.length} contacts, ${height.toFixed(2)}m chaotic pile`,
);

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
