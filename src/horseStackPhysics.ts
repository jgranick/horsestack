import type { Physics2DMaterial, Physics2DWorld, RigidBody2D } from '@flighthq/sdk';
import {
  addPhysics2DBody,
  createPhysics2DCollider,
  createPhysics2DWorld,
  createRigidBody2D,
  createUniformGridSpatialBackend,
  stepPhysics2D,
} from '@flighthq/sdk';

export type StackObjectKind = 'horse' | 'hay' | 'cow' | 'chickens';

export interface StackObjectProfile {
  emoji: string;
  halfHeight: number;
  halfWidth: number;
  label: string;
}

export const HORSE_SIZE_MULTIPLIER = 1.2;
export const HORSE_HALF_WIDTH = 0.09 * HORSE_SIZE_MULTIPLIER;
export const HORSE_HALF_HEIGHT = 0.0765 * HORSE_SIZE_MULTIPLIER;
export const TYPICAL_HORSE_WITHERS_METERS = 1.55;
export const METERS_PER_HAND = 0.1016;
export const STACK_OBJECT_KINDS = ['horse', 'hay', 'cow', 'chickens'] as const;
export const STACK_OBJECT_WEIGHTS: Readonly<Record<StackObjectKind, number>> = {
  horse: 0.3,
  hay: 0.5,
  cow: 0.05,
  chickens: 0.15,
};
export const STACK_OBJECT_PROFILES: Readonly<Record<StackObjectKind, StackObjectProfile>> = {
  horse: {
    emoji: '🐎',
    halfHeight: HORSE_HALF_HEIGHT,
    halfWidth: HORSE_HALF_WIDTH,
    label: 'Horse',
  },
  hay: {
    emoji: '🌾',
    halfHeight: 0.046,
    halfWidth: 0.0505,
    label: 'Hay bale',
  },
  cow: {
    emoji: '🐄',
    halfHeight: 0.097,
    halfWidth: 0.074,
    label: 'Cow',
  },
  chickens: {
    emoji: '🐔',
    halfHeight: 0.021,
    halfWidth: 0.021,
    label: 'Chicken',
  },
};

// The farm ground spans roughly 3.5 world units across the straight-on view.
// Keeping the collider inside that silhouette leaves real fall-off edges.
export const PASTURE_HALF_WIDTH = 1.75;
// STACK_BASE_Y maps physics space into the rendered scene. Its 0.015 offset
// puts this surface at world Y -0.02, level with the mounted farm terrain.
export const PASTURE_TOP_Y = -0.035;
export const PHYSICS_GRAVITY = 10.8;
export const PHYSICS_STEP = 1 / 60;
export const FINAL_SETTLE_SECONDS = 2.35;

const PHYSICS_GRID_CELL_SIZE = 0.2;
const STACK_MATERIALS: Readonly<Record<StackObjectKind, Physics2DMaterial>> = {
  horse: { density: 1, friction: 0.56, restitution: 0.13 },
  hay: { density: 0.72, friction: 0.78, restitution: 0.035 },
  cow: { density: 1.15, friction: 0.6, restitution: 0.08 },
  chickens: { density: 0.48, friction: 0.44, restitution: 0.2 },
};
const PASTURE_MATERIAL: Physics2DMaterial = {
  density: 0,
  friction: 0.38,
  restitution: 0.035,
};
const stackBodyKinds = new WeakMap<RigidBody2D, StackObjectKind>();

export function createHorseStackWorld(): Physics2DWorld {
  const world = createPhysics2DWorld(
    0,
    -PHYSICS_GRAVITY,
    createUniformGridSpatialBackend(PHYSICS_GRID_CELL_SIZE),
  );
  world.config.velocityIterations = 12;
  world.config.positionIterations = 6;
  world.config.timeToSleep = 0.65;

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

export function addStackObjectBody(
  world: Physics2DWorld,
  kind: StackObjectKind,
  x: number,
  y: number,
  angle: number,
): RigidBody2D {
  const body = createRigidBody2D('dynamic', x, y, angle);
  body.linearDamping = kind === 'chickens' ? 0.04 : 0.08;
  body.angularDamping = kind === 'hay' ? 0.12 : 0.06;
  body.bullet = false;
  body.colliders.push(
    kind === 'chickens'
      ? createPhysics2DCollider(
          { kind: 'circle', radius: STACK_OBJECT_PROFILES.chickens.halfHeight, x: 0, y: 0 },
          STACK_MATERIALS.chickens,
        )
      : createPhysics2DCollider(
          { kind: 'polygon', points: getPolygonColliderPoints(kind) },
          STACK_MATERIALS[kind],
        ),
  );
  addPhysics2DBody(world, body);
  stackBodyKinds.set(body, kind);
  return body;
}

export function stepHorseStack(world: Physics2DWorld): void {
  stepPhysics2D(world, PHYSICS_STEP);
}

export function getRandomStackObjectKind(random = Math.random): StackObjectKind {
  let totalWeight = 0;
  for (const kind of STACK_OBJECT_KINDS) totalWeight += STACK_OBJECT_WEIGHTS[kind];
  let draw = Math.min(1 - Number.EPSILON, Math.max(0, random())) * totalWeight;
  for (const kind of STACK_OBJECT_KINDS) {
    const weight = STACK_OBJECT_WEIGHTS[kind];
    if (draw < weight) return kind;
    draw -= weight;
  }
  return 'hay';
}

export function getNextObjectDelay(objectsDropped: number): number {
  return Math.max(80, 210 - objectsDropped * 3.25);
}

export function getPaceLevel(objectsDropped: number): number {
  return Math.min(6, 1 + Math.floor(objectsDropped / 7));
}

export function getStackObjectVerticalExtent(kind: StackObjectKind, angle: number): number {
  const profile = STACK_OBJECT_PROFILES[kind];
  if (kind === 'chickens') return profile.halfHeight;
  return (
    Math.abs(Math.cos(angle)) * profile.halfHeight +
    Math.abs(Math.sin(angle)) * profile.halfWidth
  );
}

export function getStackBodyVerticalExtent(body: Readonly<RigidBody2D>): number {
  return getStackObjectVerticalExtent(getStackBodyKind(body), body.angle);
}

export function getStackBodyHalfWidth(body: Readonly<RigidBody2D>): number {
  return STACK_OBJECT_PROFILES[getStackBodyKind(body)].halfWidth;
}

export function isStackBodyWithinPasture(body: Readonly<RigidBody2D>): boolean {
  return Math.abs(body.x) <= PASTURE_HALF_WIDTH + getStackBodyHalfWidth(body);
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
  objects: readonly Readonly<RigidBody2D>[],
): number {
  const touchingBodies = new Set<number>();
  for (const contact of world.contacts) {
    if (!contact.touching || contact.sensor) continue;
    touchingBodies.add(contact.bodyA);
    touchingBodies.add(contact.bodyB);
  }

  let height = 0;
  for (const body of objects) {
    const onStack = body.sleeping || touchingBodies.has(body.index);
    if (
      !onStack ||
      !isStackBodyWithinPasture(body) ||
      body.y < -STACK_OBJECT_PROFILES[getStackBodyKind(body)].halfHeight ||
      Math.abs(body.velocityY) > 1.2
    ) {
      continue;
    }
    height = Math.max(height, body.y + getStackBodyVerticalExtent(body));
  }
  return height;
}

function getStackBodyKind(body: Readonly<RigidBody2D>): StackObjectKind {
  return stackBodyKinds.get(body as RigidBody2D) ?? 'horse';
}

function getPolygonColliderPoints(kind: Exclude<StackObjectKind, 'chickens'>): number[] {
  const { halfHeight: h, halfWidth: w } = STACK_OBJECT_PROFILES[kind];
  switch (kind) {
    case 'horse':
      return [
        -w * 0.95, -h * 0.24,
        -w * 0.675, -h * 0.853,
        -w * 0.2, -h,
        w * 0.65, -h * 0.853,
        w, h * 0.118,
        w * 0.75, h,
        -w * 0.7, h * 0.941,
        -w, h * 0.235,
      ];
    case 'hay':
      return [-w, -h, w, -h, w, h, -w, h];
    case 'cow':
      return [
        -w, -h * 0.65,
        -w * 0.72, -h,
        w * 0.72, -h,
        w, -h * 0.25,
        w * 0.82, h * 0.88,
        -w * 0.75, h,
      ];
  }
}
