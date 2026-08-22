import type { Physics3DMaterial, Physics3DWorld, RigidBody3D } from '@flighthq/sdk';
import {
  addPhysics3DBody,
  createPhysics3DCollider,
  createPhysics3DWorld,
  createRigidBody3D,
  createUniformGridSpatialBackend3D,
  registerBuiltInCollisionFaceQueries3D,
  registerBuiltInCollisionSupports3D,
  setPhysics3DBodyTransform,
  stepPhysics3D,
} from '@flighthq/sdk';

export const HORSE_HALF_WIDTH = 0.09;
export const HORSE_HALF_HEIGHT = 0.0765;
// The horse is viewed broadside, so X is its hidden cross-field thickness and
// Z is its visible nose-to-tail length. The wide hidden base is deliberately
// close to twice the model's apparent thickness, making a toy horse less eager
// to roll out of the pile in full 3D.
// This visual half-depth is the shipped horse bounds at its 0.00279 scene scale.
export const HORSE_VISUAL_HALF_DEPTH = 0.0215;
export const HORSE_HALF_DEPTH = HORSE_VISUAL_HALF_DEPTH * 1.95;
// Keep the collision footprint inside the rendered nose and tail. A second
// head collider would make horse pairs more expensive and add a small ledge,
// so the performant single-body proxy remains intentionally conservative.
export const HORSE_COLLIDER_HALF_LENGTH = 0.064;
export const TYPICAL_HORSE_WITHERS_METERS = 1.55;
export const METERS_PER_HAND = 0.1016;

// The farm island spans roughly 3.5 world units across the straight-on view.
// Its stack sits in the front third, so the depth limits are intentionally
// asymmetric around the pile: more pasture toward the barn, less toward camera.
export const PASTURE_HALF_WIDTH = 1.75;
export const PASTURE_BACK_DEPTH = -2.65;
export const PASTURE_FRONT_DEPTH = 0.85;
export const PASTURE_TOP_Y = -0.015;
export const PHYSICS_GRAVITY = 10.8;
export const PHYSICS_STEP = 1 / 60;
export const FINAL_SETTLE_SECONDS = 2.35;
export const HORSE_PLACEMENT_ANGLES = [
  0,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 2,
  -Math.PI / 2,
  Math.PI,
] as const;

// Match broadphase buckets to the objects that dominate this world. Flight's
// metre-scale default is several horse lengths wide and creates unnecessary
// candidate pairs in a dense pile.
const PHYSICS_GRID_CELL_SIZE = 0.22;

const HORSE_MATERIAL: Physics3DMaterial = {
  density: 1,
  friction: 0.68,
  restitution: 0.04,
};
const PASTURE_MATERIAL: Physics3DMaterial = {
  density: 0,
  friction: 0.55,
  restitution: 0.02,
};

let collisionShapesRegistered = false;

export function createHorseStackWorld(): Physics3DWorld {
  registerCollisionShapes();

  const world = createPhysics3DWorld(
    createUniformGridSpatialBackend3D(PHYSICS_GRID_CELL_SIZE),
  );
  world.gravityY = -PHYSICS_GRAVITY;
  world.config.sequentialImpulse.velocityIterations = 8;
  world.config.sequentialImpulse.positionIterations = 4;
  world.config.sequentialImpulse.penetrationSlop = 0.0015;
  world.config.sleepLinearThreshold = 0.018;
  world.config.sleepAngularThreshold = 0.04;
  world.config.timeToSleep = 0.45;

  // A finite three-dimensional box follows the floating pasture silhouette.
  // Horses may now roll toward/away from camera as well as off either side.
  const pastureDepth = (PASTURE_FRONT_DEPTH - PASTURE_BACK_DEPTH) / 2;
  const pastureCenterDepth = (PASTURE_FRONT_DEPTH + PASTURE_BACK_DEPTH) / 2;
  const pasture = createRigidBody3D('static');
  setPhysics3DBodyTransform(
    pasture,
    pastureCenterDepth,
    PASTURE_TOP_Y - 0.02,
    0,
    0,
    0,
    0,
    1,
  );
  pasture.colliders.push(
    createPhysics3DCollider(
      {
        kind: 'aabb',
        minX: -pastureDepth,
        minY: -0.02,
        minZ: -PASTURE_HALF_WIDTH,
        maxX: pastureDepth,
        maxY: 0.02,
        maxZ: PASTURE_HALF_WIDTH,
      },
      PASTURE_MATERIAL,
    ),
  );
  addPhysics3DBody(world, pasture);
  return world;
}

export function addHorseBody(
  world: Physics3DWorld,
  lateral: number,
  y: number,
  angle: number,
  depth = 0,
): RigidBody3D {
  const body = createRigidBody3D('dynamic');
  const halfAngle = angle / 2;
  setPhysics3DBodyTransform(
    body,
    depth,
    y,
    -lateral,
    Math.sin(halfAngle),
    0,
    0,
    Math.cos(halfAngle),
  );
  body.linearDamping = 0.12;
  body.angularDamping = 0.18;
  // Horses appear directly at the previewed landing pose with no launch
  // velocity. The body is genuinely 3D, but still uses discrete collision for
  // this gentle placement path.
  body.bullet = false;

  // One broad, flat-bottomed collider is intentional. The earlier torso/head/
  // leg compound multiplied every horse-pair narrow phase and balanced the
  // animal on four tiny rounded contacts. This proxy makes one pair one test,
  // gives the pile a stable base, and still rotates freely on all three axes.
  body.colliders.push(
    createPhysics3DCollider(
      {
        kind: 'box',
        x: 0,
        y: 0,
        z: 0,
        halfX: HORSE_HALF_DEPTH,
        halfY: HORSE_HALF_HEIGHT,
        halfZ: HORSE_COLLIDER_HALF_LENGTH,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
        rotationW: 1,
      },
      HORSE_MATERIAL,
    ),
  );

  addPhysics3DBody(world, body);
  return body;
}

export function stepHorseStack(world: Physics3DWorld): void {
  stepPhysics3D(world, PHYSICS_STEP);
}

export function getNextHorseDelay(horsesDropped: number): number {
  return Math.max(80, 210 - horsesDropped * 3.25);
}

export function getRandomHorsePlacementAngle(random = Math.random): number {
  const index = Math.min(
    HORSE_PLACEMENT_ANGLES.length - 1,
    Math.floor(random() * HORSE_PLACEMENT_ANGLES.length),
  );
  return HORSE_PLACEMENT_ANGLES[index] ?? 0;
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

export function getHorseVerticalExtent(angle: number): number {
  return (
    Math.abs(Math.cos(angle)) * HORSE_HALF_HEIGHT +
    Math.abs(Math.sin(angle)) * HORSE_COLLIDER_HALF_LENGTH
  );
}

export function getHorseTopY(horse: Readonly<RigidBody3D>): number {
  let top = Number.NEGATIVE_INFINITY;
  for (const collider of horse.colliders) {
    top = Math.max(top, getColliderTopY(collider.world));
  }
  return Number.isFinite(top) ? top : horse.y + HORSE_HALF_HEIGHT;
}

export function isHorseWithinPasture(horse: Readonly<RigidBody3D>, margin = 0): boolean {
  return (
    horse.x >= PASTURE_BACK_DEPTH - margin &&
    horse.x <= PASTURE_FRONT_DEPTH + margin &&
    Math.abs(horse.z) <= PASTURE_HALF_WIDTH + margin
  );
}

export function getSupportedStackHeight(
  world: Readonly<Physics3DWorld>,
  horses: readonly Readonly<RigidBody3D>[],
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
    if (
      !onStack ||
      !isHorseWithinPasture(horse, HORSE_HALF_WIDTH) ||
      horse.y < -HORSE_HALF_HEIGHT ||
      Math.abs(horse.velocityY) > 1.2
    ) {
      continue;
    }

    height = Math.max(height, getHorseTopY(horse));
  }
  return height;
}

function registerCollisionShapes(): void {
  if (collisionShapesRegistered) return;
  registerBuiltInCollisionSupports3D();
  registerBuiltInCollisionFaceQueries3D();
  collisionShapesRegistered = true;
}

function getColliderTopY(shape: RigidBody3D['colliders'][number]['world']): number {
  switch (shape.kind) {
    case 'aabb':
      return shape.maxY;
    case 'box': {
      const { rotationW: w, rotationX: x, rotationY: y, rotationZ: z } = shape;
      const verticalExtent =
        Math.abs(2 * (x * y + w * z)) * shape.halfX +
        Math.abs(1 - 2 * (x * x + z * z)) * shape.halfY +
        Math.abs(2 * (y * z - w * x)) * shape.halfZ;
      return shape.y + verticalExtent;
    }
    case 'capsule':
      return Math.max(shape.y0, shape.y1) + shape.radius;
    case 'cone':
      return Math.max(shape.apexY, shape.baseY + shape.radius);
    case 'convex': {
      let top = Number.NEGATIVE_INFINITY;
      for (let index = 1; index < shape.points.length; index += 3) {
        top = Math.max(top, shape.points[index] ?? Number.NEGATIVE_INFINITY);
      }
      return top;
    }
    case 'cylinder':
      return Math.max(shape.y0, shape.y1) + shape.radius;
    case 'sphere':
      return shape.y + shape.radius;
    default:
      return Number.NEGATIVE_INFINITY;
  }
}
