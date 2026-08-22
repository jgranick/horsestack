import type {
  CollisionBuiltInShape3D,
  Physics3DBallAndSocketJoint,
  Physics3DMaterial,
  Physics3DMassData,
  Physics3DWorld,
  RigidBody3D,
} from '@flighthq/sdk';
import {
  addPhysics3DBody,
  addPhysics3DJoint,
  applyPhysics3DLinearImpulseAtPoint,
  createPhysics3DBallAndSocketJoint,
  createPhysics3DCollider,
  createPhysics3DShapeCastResult,
  createPhysics3DWorld,
  createRigidBody3D,
  createUniformGridSpatialBackend3D,
  physics3DBallAndSocketJointSolver,
  Physics3DBallAndSocketJointKind,
  queryPhysics3DShapeCast,
  registerBuiltInCollisionFaceQueries3D,
  registerBuiltInCollisionSupports3D,
  registerPhysics3DJointSolver,
  removePhysics3DJoint,
  setRigidBody3DMassData,
  setPhysics3DBodyTransform,
  setQuaternionFromEuler,
  stepPhysics3D,
} from '@flighthq/sdk';

export interface HorsePlacementResult {
  centerY: number;
  contactX: number;
  contactY: number;
  contactZ: number;
  hit: boolean;
  normalX: number;
  normalY: number;
  normalZ: number;
  supportBody: RigidBody3D | null;
}

export interface HorseSupportContact {
  supportBody: RigidBody3D | null;
  x: number;
  y: number;
  z: number;
}

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
export const HORSE_HERD_SIZE = 30;
export const HORSE_SETTLE_DEADLINE_SECONDS = 2;
export const HORSE_SETTLE_QUIET_SECONDS = 0.4;
export const HORSE_SETTLE_MAX_LINEAR_SPEED = 0.05;
export const HORSE_SETTLE_MAX_ANGULAR_SPEED = 0.35;
export const HORSE_PLACEMENT_ANGLES = [
  0,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 2,
  -Math.PI / 2,
  Math.PI,
] as const;
export const HORSE_PLACEMENT_YAWS = [0, Math.PI / 2, Math.PI, -Math.PI / 2] as const;

// Match broadphase buckets to the objects that dominate this world. Flight's
// metre-scale default is several horse lengths wide and creates unnecessary
// candidate pairs in a dense pile.
const PHYSICS_GRID_CELL_SIZE = 0.22;

// One exact point-pin preserves an earned placement while leaving all three
// rotation axes free. The fixed herd size also bounds the solver graph.
export const HORSE_MAX_ACTIVE_PINS = HORSE_HERD_SIZE;

const HORSE_NORMAL_LINEAR_DAMPING = 0.12;
const HORSE_NORMAL_ANGULAR_DAMPING = 0.18;
const HORSE_MIDDLE_LINEAR_DAMPING = 0.32;
const HORSE_MIDDLE_ANGULAR_DAMPING = 1.2;
const HORSE_BASE_LINEAR_DAMPING = 0.52;
const HORSE_BASE_ANGULAR_DAMPING = 3.2;
const HORSE_MIDDLE_MASS_SCALE = 1.75;
const HORSE_BASE_MASS_SCALE = 3.2;
// Inertia intentionally grows faster than mass. This is an arcade-weighted
// foundation: lower horses can still rotate, but an impact has a much harder
// time starting a tip than it does at the loose top of the pile.
const HORSE_MIDDLE_INERTIA_SCALE = 3.6;
const HORSE_BASE_INERTIA_SCALE = 8.2;
const HORSE_MIDDLE_LEVEL_DEPTH = 2;
const HORSE_BASE_LEVEL_DEPTH = 4.5;

const HORSE_MATERIAL: Physics3DMaterial = {
  density: 1,
  friction: 0.9,
  restitution: 0.02,
};
const PASTURE_MATERIAL: Physics3DMaterial = {
  density: 0,
  friction: 0.55,
  restitution: 0.02,
};

let collisionShapesRegistered = false;
const placementOrientation = { w: 1, x: 0, y: 0, z: 0 };
const placementCast = createPhysics3DShapeCastResult();
const stabilityMassData: Physics3DMassData = {
  mass: 0,
  inertiaXX: 0,
  inertiaYY: 0,
  inertiaZZ: 0,
  inertiaXY: 0,
  inertiaXZ: 0,
  inertiaYZ: 0,
  centerX: 0,
  centerY: 0,
  centerZ: 0,
};
interface HorseArcadeState {
  baseInertiaXX: number;
  baseInertiaXY: number;
  baseInertiaXZ: number;
  baseInertiaYY: number;
  baseInertiaYZ: number;
  baseInertiaZZ: number;
  baseMass: number;
  stabilityTier: number;
}
const horseArcadeState = new WeakMap<RigidBody3D, HorseArcadeState>();
const placementShape = {
  kind: 'box',
  halfX: HORSE_HALF_DEPTH,
  halfY: HORSE_HALF_HEIGHT,
  halfZ: HORSE_COLLIDER_HALF_LENGTH,
  rotationW: 1,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  x: 0,
  y: 0,
  z: 0,
} satisfies CollisionBuiltInShape3D;

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
  // Register only the point-pin used by the game rather than Flight's complete
  // joint bank. This keeps both bundle and per-step dispatch lean.
  registerPhysics3DJointSolver(
    world,
    Physics3DBallAndSocketJointKind,
    physics3DBallAndSocketJointSolver,
  );

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
  yaw = 0,
): RigidBody3D {
  const body = createRigidBody3D('dynamic');
  setHorsePlacementOrientation(angle, yaw);
  setPhysics3DBodyTransform(
    body,
    depth,
    y,
    -lateral,
    placementOrientation.x,
    placementOrientation.y,
    placementOrientation.z,
    placementOrientation.w,
  );
  body.linearDamping = HORSE_NORMAL_LINEAR_DAMPING;
  body.angularDamping = HORSE_NORMAL_ANGULAR_DAMPING;
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
  horseArcadeState.set(body, {
    baseInertiaXX: body.inertiaXX,
    baseInertiaXY: body.inertiaXY,
    baseInertiaXZ: body.inertiaXZ,
    baseInertiaYY: body.inertiaYY,
    baseInertiaYZ: body.inertiaYZ,
    baseInertiaZZ: body.inertiaZZ,
    baseMass: body.mass,
    stabilityTier: 0,
  });
  return body;
}

export function stepHorseStack(world: Physics3DWorld): void {
  stepPhysics3D(world, PHYSICS_STEP);
}

export function attachHorseToSupport(
  world: Physics3DWorld,
  horse: RigidBody3D,
  contact: Readonly<HorseSupportContact>,
): number {
  const support = contact.supportBody;
  if (support === null || support.index < 0) return 0;
  const attached = addHorseContactPin(
    world,
    horse,
    support,
    contact.x,
    contact.y,
    contact.z,
  );
  retireOldHorsePins(world);
  return attached ? 1 : 0;
}

export function createHorseSupportContact(): HorseSupportContact {
  return { supportBody: null, x: 0, y: 0, z: 0 };
}

export function findHorseSettlementSupport(
  out: HorseSupportContact,
  world: Readonly<Physics3DWorld>,
  horse: Readonly<RigidBody3D>,
  permanentHorses: ReadonlySet<RigidBody3D>,
): boolean {
  out.supportBody = null;
  let deepest = Number.NEGATIVE_INFINITY;

  for (const contact of world.contacts) {
    if (!contact.enabled || !contact.touching || contact.sensor) continue;
    const horseIsA = contact.bodyA === horse.index;
    if (!horseIsA && contact.bodyB !== horse.index) continue;
    const support = world.bodies[horseIsA ? contact.bodyB : contact.bodyA];
    if (
      support === undefined ||
      (support.type !== 'static' && !permanentHorses.has(support))
    ) {
      continue;
    }

    const pointCount = Math.min(contact.pointCount, contact.points.length);
    for (let index = 0; index < pointCount; index++) {
      const point = contact.points[index];
      if (point === undefined || point.depth < deepest) continue;
      deepest = point.depth;
      out.supportBody = support;
      out.x = point.x;
      out.y = point.y;
      out.z = point.z;
    }
  }

  return out.supportBody !== null;
}

export function isHorseQuietForSettlement(horse: Readonly<RigidBody3D>): boolean {
  const linearSpeedSquared =
    horse.velocityX * horse.velocityX +
    horse.velocityY * horse.velocityY +
    horse.velocityZ * horse.velocityZ;
  const angularSpeedSquared =
    horse.angularVelocityX * horse.angularVelocityX +
    horse.angularVelocityY * horse.angularVelocityY +
    horse.angularVelocityZ * horse.angularVelocityZ;
  return (
    linearSpeedSquared <= HORSE_SETTLE_MAX_LINEAR_SPEED * HORSE_SETTLE_MAX_LINEAR_SPEED &&
    angularSpeedSquared <= HORSE_SETTLE_MAX_ANGULAR_SPEED * HORSE_SETTLE_MAX_ANGULAR_SPEED
  );
}

export function ejectHorseBody(horse: RigidBody3D): void {
  let directionX = horse.x;
  let directionZ = horse.z;
  let distance = Math.hypot(directionX, directionZ);
  if (distance < 0.02) {
    const angle = (horse.index * 2.399_963_229_728_653) % (Math.PI * 2);
    directionX = Math.cos(angle);
    directionZ = Math.sin(angle);
    distance = 1;
  }
  directionX /= distance;
  directionZ /= distance;
  const horizontalImpulse = horse.mass * 0.82;
  applyPhysics3DLinearImpulseAtPoint(
    horse,
    directionX * horizontalImpulse,
    horse.mass * 0.24,
    directionZ * horizontalImpulse,
    horse.x,
    horse.y + HORSE_HALF_HEIGHT,
    horse.z,
  );
}

export function stabilizeHorseStack(
  world: Readonly<Physics3DWorld>,
  horses: readonly RigidBody3D[] = world.bodies,
): void {
  let stackTop = Number.NEGATIVE_INFINITY;
  for (const body of horses) {
    if (body.type === 'dynamic') stackTop = Math.max(stackTop, getHorseTopY(body));
  }
  if (!Number.isFinite(stackTop)) return;

  const horseHeight = HORSE_HALF_HEIGHT * 2;
  for (const body of horses) {
    if (body.type !== 'dynamic') continue;
    const levelsBelowTop = Math.max(0, (stackTop - getHorseTopY(body)) / horseHeight);
    const tier =
      levelsBelowTop >= HORSE_BASE_LEVEL_DEPTH
        ? 2
        : levelsBelowTop >= HORSE_MIDDLE_LEVEL_DEPTH
          ? 1
          : 0;
    applyHorseStabilityTier(body, tier);
  }
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

export function getRandomHorsePlacementYaw(random = Math.random): number {
  const index = Math.min(
    HORSE_PLACEMENT_YAWS.length - 1,
    Math.floor(random() * HORSE_PLACEMENT_YAWS.length),
  );
  return HORSE_PLACEMENT_YAWS[index] ?? 0;
}

export function createHorsePlacementResult(): HorsePlacementResult {
  return {
    centerY: PASTURE_TOP_Y + HORSE_HALF_HEIGHT,
    contactX: 0,
    contactY: PASTURE_TOP_Y,
    contactZ: 0,
    hit: false,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    supportBody: null,
  };
}

export function resolveHorsePlacement(
  out: HorsePlacementResult,
  world: Physics3DWorld,
  lateral: number,
  depth: number,
  angle: number,
  yaw: number,
  startY: number,
): void {
  setHorsePlacementOrientation(angle, yaw);
  placementShape.x = depth;
  placementShape.y = startY;
  placementShape.z = -lateral;
  placementShape.rotationX = placementOrientation.x;
  placementShape.rotationY = placementOrientation.y;
  placementShape.rotationZ = placementOrientation.z;
  placementShape.rotationW = placementOrientation.w;

  const sweepBottomY = PASTURE_TOP_Y - HORSE_HALF_HEIGHT * 4;
  const sweepDistance = Math.max(0.01, startY - sweepBottomY);
  queryPhysics3DShapeCast(
    world,
    placementShape,
    0,
    -sweepDistance,
    0,
    placementCast,
  );

  out.hit = placementCast.hit;
  if (placementCast.hit) {
    out.centerY = startY - sweepDistance * placementCast.fraction;
    out.contactX = placementCast.x;
    out.contactY = placementCast.y;
    out.contactZ = placementCast.z;
    out.normalX = placementCast.normalX;
    out.normalY = placementCast.normalY;
    out.normalZ = placementCast.normalZ;
    out.supportBody =
      placementCast.body?.type === 'dynamic' ? placementCast.body : null;
    return;
  }

  out.centerY = PASTURE_TOP_Y + getHorseVerticalExtent(angle);
  out.contactX = depth;
  out.contactY = PASTURE_TOP_Y;
  out.contactZ = -lateral;
  out.normalX = 0;
  out.normalY = 1;
  out.normalZ = 0;
  out.supportBody = null;
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

function setHorsePlacementOrientation(angle: number, yaw: number): void {
  // YXZ applies the facing direction first, then rolls around the horse's own
  // local width axis. Visuals use the same order, so preview and collider match.
  setQuaternionFromEuler(placementOrientation, angle, yaw, 0, 'YXZ');
}

function addHorseContactPin(
  world: Physics3DWorld,
  horse: RigidBody3D,
  support: RigidBody3D,
  anchorX: number,
  anchorY: number,
  anchorZ: number,
): boolean {
  if (horse === support || horse.index < 0 || support.index < 0) return false;
  for (const joint of world.joints) {
    const samePair =
      (joint.bodyA === horse.index && joint.bodyB === support.index) ||
      (joint.bodyA === support.index && joint.bodyB === horse.index);
    if (samePair && !joint.broken) return false;
  }

  const horseAnchor = worldPointToBodyLocal(horse, anchorX, anchorY, anchorZ);
  const supportAnchor = worldPointToBodyLocal(support, anchorX, anchorY, anchorZ);
  const joint: Physics3DBallAndSocketJoint = createPhysics3DBallAndSocketJoint({
    bodyA: horse.index,
    bodyB: support.index,
    localAnchorAX: horseAnchor.x,
    localAnchorAY: horseAnchor.y,
    localAnchorAZ: horseAnchor.z,
    localAnchorBX: supportAnchor.x,
    localAnchorBY: supportAnchor.y,
    localAnchorBZ: supportAnchor.z,
    collideConnected: true,
  });
  addPhysics3DJoint(world, joint);
  return true;
}

function retireOldHorsePins(world: Physics3DWorld): void {
  // A round cannot exceed this cap, so every earned pin normally survives for
  // the result. Keeping the guard makes the low-level helper safe in longer
  // benchmark scenarios without allowing an unbounded solver graph.
  while (world.joints.length > HORSE_MAX_ACTIVE_PINS) {
    const oldest = world.joints[0];
    if (oldest === undefined) return;
    removePhysics3DJoint(world, oldest);
  }
}

function applyHorseStabilityTier(body: RigidBody3D, tier: number): void {
  const state = horseArcadeState.get(body);
  if (state === undefined || state.stabilityTier === tier) return;
  state.stabilityTier = tier;

  const massScale =
    tier === 2 ? HORSE_BASE_MASS_SCALE : tier === 1 ? HORSE_MIDDLE_MASS_SCALE : 1;
  const inertiaScale =
    tier === 2
      ? HORSE_BASE_INERTIA_SCALE
      : tier === 1
        ? HORSE_MIDDLE_INERTIA_SCALE
        : 1;
  stabilityMassData.mass = state.baseMass * massScale;
  stabilityMassData.inertiaXX = state.baseInertiaXX * inertiaScale;
  stabilityMassData.inertiaYY = state.baseInertiaYY * inertiaScale;
  stabilityMassData.inertiaZZ = state.baseInertiaZZ * inertiaScale;
  stabilityMassData.inertiaXY = state.baseInertiaXY * inertiaScale;
  stabilityMassData.inertiaXZ = state.baseInertiaXZ * inertiaScale;
  stabilityMassData.inertiaYZ = state.baseInertiaYZ * inertiaScale;
  stabilityMassData.centerX = body.centerX;
  stabilityMassData.centerY = body.centerY;
  stabilityMassData.centerZ = body.centerZ;
  setRigidBody3DMassData(body, stabilityMassData);

  body.linearDamping =
    tier === 2
      ? HORSE_BASE_LINEAR_DAMPING
      : tier === 1
        ? HORSE_MIDDLE_LINEAR_DAMPING
        : HORSE_NORMAL_LINEAR_DAMPING;
  body.angularDamping =
    tier === 2
      ? HORSE_BASE_ANGULAR_DAMPING
      : tier === 1
        ? HORSE_MIDDLE_ANGULAR_DAMPING
        : HORSE_NORMAL_ANGULAR_DAMPING;
}

function worldPointToBodyLocal(
  body: Readonly<RigidBody3D>,
  worldX: number,
  worldY: number,
  worldZ: number,
): { x: number; y: number; z: number } {
  const x = worldX - body.x;
  const y = worldY - body.y;
  const z = worldZ - body.z;
  const qx = body.orientationX;
  const qy = body.orientationY;
  const qz = body.orientationZ;
  const qw = body.orientationW;
  return {
    x:
      (1 - 2 * (qy * qy + qz * qz)) * x +
      2 * (qx * qy + qw * qz) * y +
      2 * (qx * qz - qw * qy) * z,
    y:
      2 * (qx * qy - qw * qz) * x +
      (1 - 2 * (qx * qx + qz * qz)) * y +
      2 * (qy * qz + qw * qx) * z,
    z:
      2 * (qx * qz + qw * qy) * x +
      2 * (qy * qz - qw * qx) * y +
      (1 - 2 * (qx * qx + qy * qy)) * z,
  };
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
