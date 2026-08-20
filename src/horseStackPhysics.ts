import type { Physics2DMaterial, Physics2DWorld, RigidBody2D } from '@flighthq/sdk';
import {
  addPhysics2DBody,
  createPhysics2DCollider,
  createPhysics2DWorld,
  createRigidBody2D,
  stepPhysics2D,
} from '@flighthq/sdk';

export const TOTAL_HORSES = 80;
export const HORSE_HALF_WIDTH = 0.04;
export const HORSE_HALF_HEIGHT = 0.034;
// The farm ground spans roughly 3.5 world units across the new straight-on view.
// Keeping the collider inside that silhouette leaves real fall-off edges.
export const PASTURE_HALF_WIDTH = 1.75;
export const PASTURE_TOP_Y = -0.015;
export const PHYSICS_GRAVITY = 10.8;
export const PHYSICS_STEP = 1 / 60;
export const FINAL_SETTLE_SECONDS = 2.35;

const HORSE_MATERIAL: Physics2DMaterial = {
  density: 1,
  friction: 0.56,
  restitution: 0.13,
};
const PASTURE_MATERIAL: Physics2DMaterial = {
  density: 0,
  friction: 0.38,
  restitution: 0.035,
};

export function createHorseStackWorld(): Physics2DWorld {
  const world = createPhysics2DWorld(0, -PHYSICS_GRAVITY);
  world.config.velocityIterations = 12;
  world.config.positionIterations = 6;
  world.config.timeToSleep = 0.65;

  // The farm's green pasture is the only landing surface, with real fall-off edges
  // at the limits of the floating island.
  const pasture = createRigidBody2D('static', 0, PASTURE_TOP_Y - 0.02);
  pasture.colliders.push(
    createPhysics2DCollider(
      {
        kind: 'aabb',
        minX: -PASTURE_HALF_WIDTH,
        minY: -0.02,
        maxX: PASTURE_HALF_WIDTH,
        maxY: 0.02,
      },
      PASTURE_MATERIAL,
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

  // A rounded, uneven proxy makes the tiny horses accumulate as a pile instead
  // of clicking together into a neat tower.
  body.colliders.push(
    createPhysics2DCollider(
      {
        kind: 'polygon',
        points: [
          -0.038, -0.008, -0.027, -0.029, -0.008, -0.034, 0.026, -0.029, 0.04,
          0.004, 0.03, 0.034, -0.028, 0.032, -0.04, 0.008,
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
  return Math.max(0.7, stackHeight + 0.5);
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

export function getHorseDropMotion(
  horsesDropped: number,
  spinJitter: number,
  forced: boolean,
  placementProgress = 1,
): Pick<RigidBody2D, 'angularVelocity' | 'velocityX' | 'velocityY'> {
  const pace = getPaceLevel(horsesDropped);
  const chaos = 0.95 + pace * 0.24;
  const progress = Math.max(0, Math.min(1, placementProgress));
  const rush = Math.max(0, (0.35 - progress) / 0.35);
  const deadlinePanic = Math.max(0, (progress - 0.72) / 0.28);
  const spinDirection = spinJitter < 0 ? -1 : 1;
  const motion = {
    angularVelocity: forced
      ? spinJitter * chaos + spinDirection * 1.5
      : spinJitter * chaos * (0.5 + rush * 1.5) + spinDirection * deadlinePanic * 1.2,
    velocityX: 0,
    velocityY: forced ? -0.95 : -0.12 - deadlinePanic * 0.62,
  };
  return motion;
}

export function getTempoPoints(placementProgress: number): number {
  const rush = 1 - Math.max(0, Math.min(1, placementProgress));
  return Math.round(rush * 12);
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
    const inPasture = Math.abs(horse.x) <= PASTURE_HALF_WIDTH + HORSE_HALF_WIDTH;
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
