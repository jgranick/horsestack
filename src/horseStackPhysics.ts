import type { Physics2DMaterial, Physics2DWorld, RigidBody2D } from '@flighthq/sdk';
import {
  addPhysics2DBody,
  createPhysics2DCollider,
  createPhysics2DWorld,
  createRigidBody2D,
  stepPhysics2D,
} from '@flighthq/sdk';

export const HORSE_HALF_WIDTH = 0.96;
export const HORSE_HALF_HEIGHT = 0.82;
export const PLATFORM_HALF_WIDTH = 2.7;
export const PHYSICS_STEP = 1 / 60;

const HORSE_MATERIAL: Physics2DMaterial = {
  density: 1,
  friction: 0.82,
  restitution: 0.08,
};
const GROUND_MATERIAL: Physics2DMaterial = {
  density: 0,
  friction: 0.95,
  restitution: 0.02,
};

export function createHorseStackWorld(): Physics2DWorld {
  const world = createPhysics2DWorld(0, -10.8);
  world.config.velocityIterations = 12;
  world.config.positionIterations = 6;
  world.config.timeToSleep = 0.65;

  const floor = createRigidBody2D('static', 0, -0.25);
  floor.colliders.push(
    createPhysics2DCollider(
      {
        kind: 'aabb',
        minX: -PLATFORM_HALF_WIDTH,
        minY: -0.25,
        maxX: PLATFORM_HALF_WIDTH,
        maxY: 0.25,
      },
      GROUND_MATERIAL,
    ),
  );
  addPhysics2DBody(world, floor);
  return world;
}

export function addHorseBody(
  world: Physics2DWorld,
  x: number,
  y: number,
  angle: number,
): RigidBody2D {
  const body = createRigidBody2D('dynamic', x, y, angle);
  body.linearDamping = 0.08;
  body.angularDamping = 0.12;
  body.bullet = true;

  // A broad, slightly lumpy silhouette stays stackable while still producing goofy rotations.
  body.colliders.push(
    createPhysics2DCollider(
      {
        kind: 'polygon',
        points: [-0.82, -0.82, 0.62, -0.82, 0.96, 0.1, 0.74, 0.82, -0.68, 0.79, -0.96, 0.12],
      },
      HORSE_MATERIAL,
    ),
  );

  return addPhysics2DBody(world, body);
}

export function stepHorseStack(world: Physics2DWorld): void {
  stepPhysics2D(world, PHYSICS_STEP);
}

export function getSupportedStackHeight(
  world: Readonly<Physics2DWorld>,
  horses: readonly Readonly<RigidBody2D>[],
): number {
  const touchingBodies = new Set<number>();
  for (const contact of world.contacts) {
    if (!contact.touching || contact.sensor) continue;
    touchingBodies.add(contact.bodyA);
    touchingBodies.add(contact.bodyB);
  }

  let height = 0;
  for (const horse of horses) {
    const onStack = horse.sleeping || touchingBodies.has(horse.index);
    const inPasture = Math.abs(horse.x) <= PLATFORM_HALF_WIDTH + HORSE_HALF_WIDTH;
    if (!onStack || !inPasture || horse.y < -HORSE_HALF_HEIGHT || Math.abs(horse.velocityY) > 1.2) {
      continue;
    }

    const verticalExtent =
      Math.abs(Math.cos(horse.angle)) * HORSE_HALF_HEIGHT +
      Math.abs(Math.sin(horse.angle)) * HORSE_HALF_WIDTH;
    height = Math.max(height, horse.y + verticalExtent);
  }
  return height;
}
