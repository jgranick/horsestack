import type { Physics2DMaterial, Physics2DWorld, RigidBody2D } from '@flighthq/sdk';
import {
  addPhysics2DBody,
  createPhysics2DCollider,
  createPhysics2DWorld,
  createRigidBody2D,
  stepPhysics2D,
} from '@flighthq/sdk';

export const TOTAL_HORSES = 40;
export const HORSE_HALF_WIDTH = 0.4;
export const HORSE_HALF_HEIGHT = 0.34;
export const PLATFORM_HALF_WIDTH = 1.25;
export const PASTURE_HALF_WIDTH = 4.5;
export const PHYSICS_STEP = 1 / 60;
export const FINAL_SETTLE_SECONDS = 2.35;

const HORSE_MATERIAL: Physics2DMaterial = {
  density: 1,
  friction: 0.56,
  restitution: 0.13,
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

  // The platform is raised slightly above the farm floor. Missed horses now tumble
  // into the pasture instead of visibly falling through the scenery.
  const pasture = createRigidBody2D('static', 0, -0.18);
  pasture.colliders.push(
    createPhysics2DCollider(
      {
        kind: 'aabb',
        minX: -PASTURE_HALF_WIDTH,
        minY: -0.1,
        maxX: PASTURE_HALF_WIDTH,
        maxY: 0.1,
      },
      GROUND_MATERIAL,
    ),
  );
  addPhysics2DBody(world, pasture);
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
  body.angularDamping = 0.06;
  body.bullet = true;

  // A rounded, uneven proxy makes forty tiny horses accumulate as a pile instead
  // of clicking together into a neat tower.
  body.colliders.push(
    createPhysics2DCollider(
      {
        kind: 'polygon',
        points: [
          -0.38, -0.08, -0.27, -0.29, -0.08, -0.34, 0.26, -0.29, 0.4, 0.04, 0.3, 0.34,
          -0.28, 0.32, -0.4, 0.08,
        ],
      },
      HORSE_MATERIAL,
    ),
  );

  return addPhysics2DBody(world, body);
}

export function stepHorseStack(world: Physics2DWorld): void {
  stepPhysics2D(world, PHYSICS_STEP);
}

export function getHorseSpawnY(stackHeight: number): number {
  return Math.max(1.4, stackHeight + 1.12);
}

export function getDropWindow(horsesDropped: number): number {
  return Math.max(0.8, 2.9 - horsesDropped * 0.07);
}

export function getNextHorseDelay(horsesDropped: number): number {
  return Math.max(80, 210 - horsesDropped * 3.25);
}

export function getPaceLevel(horsesDropped: number): number {
  return Math.min(6, 1 + Math.floor(horsesDropped / 7));
}

export function getSweepSpeed(horsesDropped: number): number {
  return 1.2 + horsesDropped * 0.052;
}

export function getHorseDropMotion(
  horsesDropped: number,
  sweepDirection: number,
  horizontalJitter: number,
  spinJitter: number,
  forced: boolean,
): Pick<RigidBody2D, 'angularVelocity' | 'velocityX' | 'velocityY'> {
  const pace = getPaceLevel(horsesDropped);
  const chaos = 0.95 + pace * 0.24;
  return {
    angularVelocity: spinJitter * chaos + (forced ? sweepDirection * 0.38 : 0),
    velocityX: sweepDirection * (0.08 + pace * 0.025) + horizontalJitter * 0.16,
    velocityY: forced ? -0.95 : -0.12,
  };
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
