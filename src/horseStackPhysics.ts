import type { Physics2DMaterial, Physics2DWorld, RigidBody2D } from '@flighthq/sdk';
import {
  addPhysics2DBody,
  createPhysics2DCollider,
  createPhysics2DWorld,
  createRigidBody2D,
  createUniformGridSpatialBackend,
  stepPhysics2D,
} from '@flighthq/sdk';

export const HORSE_HALF_WIDTH = 0.09;
export const HORSE_HALF_HEIGHT = 0.0765;
export const TYPICAL_HORSE_WITHERS_METERS = 1.55;
export const METERS_PER_HAND = 0.1016;
// The farm ground spans roughly 3.5 world units across the new straight-on view.
// Keeping the collider inside that silhouette leaves real fall-off edges.
export const PASTURE_HALF_WIDTH = 1.75;
export const PASTURE_TOP_Y = -0.015;
export const PHYSICS_GRAVITY = 10.8;
export const PHYSICS_STEP = 1 / 60;
export const FINAL_SETTLE_SECONDS = 2.35;

// Match broadphase buckets to the objects that dominate this world. The SDK's
// one-unit default is several horse lengths wide and produces many unrelated
// candidate pairs in a dense pile.
const PHYSICS_GRID_CELL_SIZE = 0.2;

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
  const world = createPhysics2DWorld(
    0,
    -PHYSICS_GRAVITY,
    createUniformGridSpatialBackend(PHYSICS_GRID_CELL_SIZE),
  );
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
  // Horses appear directly at the previewed landing pose with no launch
  // velocity. Discrete collision is sufficient and avoids putting the entire
  // awake pile through the continuous-collision path every step.
  body.bullet = false;

  // A rounded, uneven proxy makes the horses accumulate as a pile instead
  // of clicking together into a neat tower.
  body.colliders.push(
    createPhysics2DCollider(
      {
        kind: 'polygon',
        points: [
          -0.0855, -0.018, -0.06075, -0.06525, -0.018, -0.0765, 0.0585,
          -0.06525, 0.09, 0.009, 0.0675, 0.0765, -0.063, 0.072, -0.09, 0.018,
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

export function getNextHorseDelay(horsesDropped: number): number {
  return Math.max(80, 210 - horsesDropped * 3.25);
}

export function getPaceLevel(horsesDropped: number): number {
  return Math.min(6, 1 + Math.floor(horsesDropped / 7));
}

export function getStackHeightMeters(stackTopY: number): number {
  if (stackTopY <= 0) return 0;
  const heightAbovePasture = Math.max(0, stackTopY - PASTURE_TOP_Y);
  return heightAbovePasture * (TYPICAL_HORSE_WITHERS_METERS / (HORSE_HALF_HEIGHT * 2));
}

export function getStackHeightHands(stackTopY: number): number {
  return Math.round(getStackHeightMeters(stackTopY) / METERS_PER_HAND);
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
