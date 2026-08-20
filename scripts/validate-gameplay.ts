import type { RigidBody2D } from '@flighthq/sdk';
import {
  addHorseBody,
  createHorseStackWorld,
  getSupportedStackHeight,
  stepHorseStack,
} from '../src/horseStackPhysics';

const world = createHorseStackWorld();
const horses: RigidBody2D[] = [];

for (let index = 0; index < 6; index++) {
  const currentHeight = getSupportedStackHeight(world, horses);
  const horse = addHorseBody(
    world,
    index % 2 === 0 ? -0.08 : 0.08,
    Math.max(3.25, currentHeight + 3.25),
    index % 2 === 0 ? -0.025 : 0.025,
  );
  horse.angularVelocity = index % 2 === 0 ? -0.08 : 0.08;
  horses.push(horse);

  for (let step = 0; step < 300; step++) stepHorseStack(world);
  assertFiniteBody(horse, index);
}

const height = getSupportedStackHeight(world, horses);
const inPasture = horses.filter((horse) => Math.abs(horse.x) < 4 && horse.y > -1).length;
if (inPasture < 3) throw new Error(`Expected at least 3 horses in pasture, received ${inPasture}`);
if (height < 3) throw new Error(`Expected a stack over 3m, received ${height.toFixed(2)}m`);
if (world.contacts.length === 0) throw new Error('Expected the horse stack to produce contacts');

console.log(
  `gameplay: ${inPasture}/${horses.length} horses in pasture, ${world.contacts.length} contacts, ${height.toFixed(2)}m supported stack`,
);

function assertFiniteBody(horse: (typeof horses)[number], index: number): void {
  const values = [horse.x, horse.y, horse.angle, horse.velocityX, horse.velocityY, horse.angularVelocity];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Horse ${index + 1} produced non-finite physics state`);
  }
}
