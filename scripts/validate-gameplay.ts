import type { RigidBody2D } from '@flighthq/sdk';
import {
  addStackObjectBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getNextObjectDelay,
  getRandomStackObjectKind,
  getStackBodyHalfWidth,
  getStackBodyVerticalExtent,
  getStackHeightHands,
  getStackHeightMeters,
  getStackObjectVerticalExtent,
  getSupportedStackHeight,
  HORSE_HALF_HEIGHT,
  HORSE_SIZE_MULTIPLIER,
  isStackBodyWithinPasture,
  PASTURE_HALF_WIDTH,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  STACK_OBJECT_KINDS,
  STACK_OBJECT_PROFILES,
  stepHorseStack,
  TYPICAL_HORSE_WITHERS_METERS,
} from '../src/horseStackPhysics';
import type { StackObjectKind } from '../src/horseStackPhysics';

interface ScenarioResult {
  contacts: number;
  hands: number;
  heightMeters: number;
  inPasture: number;
  kinds: Set<StackObjectKind>;
  name: string;
}

const TARGET_HALF_WIDTH = 0.34;
const VALIDATION_OBJECTS = 64;

const scenarios = [
  runScenario('level mixed stack', 0x4c455645, 0.04, 0.34),
  runScenario('balanced mixed stack', 0x42414c41, 0.28, 0.2),
  runScenario('teetered mixed stack', 0x54454554, 0.6, 0.1),
];
validateStableActivation();
validateRandomObjectSelection();
validateObjectProfiles();
validateHeightCalibration();
validateFarmEdgeFalloff();

console.log(
  `gameplay: ${scenarios
    .map(
      ({ contacts, hands, heightMeters, inPasture, kinds, name }) =>
        `${name} ${inPasture}/${VALIDATION_OBJECTS} in farm, ${kinds.size} prop types, ${contacts} contacts, ${heightMeters.toFixed(2)}m/${hands} hands`,
    )
    .join('; ')}; randomized horse/hay/cow/chicken selection, distinct 2D proxies, horse-height calibration, and farm-edge falloff verified`,
);

function runScenario(
  name: string,
  seed: number,
  maxTilt: number,
  inputCadence: number,
): ScenarioResult {
  const world = createHorseStackWorld();
  const objects: RigidBody2D[] = [];
  const kinds = new Set<StackObjectKind>();
  const random = mulberry32(seed);
  const horizontalLimit = TARGET_HALF_WIDTH * 0.85;

  for (let index = 0; index < VALIDATION_OBJECTS; index++) {
    const objectSeed = random() * Math.PI * 2;
    const x = Math.sin(objectSeed) * horizontalLimit;
    const angle = (random() * 2 - 1) * maxTilt;
    const kind = getRandomStackObjectKind(random);
    const landingSurfaceY = getPlacementSurfaceY(objects, x, kind);
    const body = addStackObjectBody(
      world,
      kind,
      x,
      landingSurfaceY + getStackObjectVerticalExtent(kind, angle),
      angle,
    );
    body.velocityX = 0;
    body.velocityY = 0;
    body.angularVelocity = 0;
    objects.push(body);
    kinds.add(kind);

    if (index === VALIDATION_OBJECTS - 1) continue;
    const delaySeconds = getNextObjectDelay(index + 1) / 1000;
    stepForDuration(world, objects, inputCadence + delaySeconds);
  }

  stepForDuration(world, objects, FINAL_SETTLE_SECONDS);

  const stackTopY = getSupportedStackHeight(world, objects);
  const heightMeters = getStackHeightMeters(stackTopY);
  const inPasture = objects.filter(
    (object) => isStackBodyWithinPasture(object) && object.y > -1,
  ).length;
  if (inPasture < VALIDATION_OBJECTS / 2) {
    throw new Error(`${name}: expected at least half the stack in the farm, received ${inPasture}`);
  }
  if (heightMeters < 1.2) {
    throw new Error(`${name}: expected a pile over 1.2m, received ${heightMeters.toFixed(2)}m`);
  }
  if (kinds.size !== STACK_OBJECT_KINDS.length) {
    throw new Error(`${name}: expected every farm prop type, received ${kinds.size}`);
  }
  if (world.contacts.length === 0) throw new Error(`${name}: expected contacts`);

  return {
    contacts: world.contacts.length,
    hands: getStackHeightHands(stackTopY),
    heightMeters,
    inPasture,
    kinds,
    name,
  };
}

function validateStableActivation(): void {
  for (const kind of STACK_OBJECT_KINDS) {
    const world = createHorseStackWorld();
    const angle = 0.42;
    const body = addStackObjectBody(
      world,
      kind,
      0,
      PASTURE_TOP_Y + getStackObjectVerticalExtent(kind, angle),
      angle,
    );
    if (body.velocityX !== 0 || body.velocityY !== 0 || body.angularVelocity !== 0) {
      throw new Error(`${kind}: a placed object must activate without an impulse`);
    }
    const colliderKind = body.colliders[0]?.local.kind;
    const expectedColliderKind = kind === 'chickens' ? 'circle' : 'polygon';
    if (body.bullet || body.colliders.length !== 1 || colliderKind !== expectedColliderKind) {
      throw new Error(`${kind}: expected one inexpensive discrete ${expectedColliderKind} collider`);
    }
  }
}

function validateRandomObjectSelection(): void {
  for (let index = 0; index < STACK_OBJECT_KINDS.length; index++) {
    const expected = STACK_OBJECT_KINDS[index];
    const actual = getRandomStackObjectKind(
      () => (index + 0.5) / STACK_OBJECT_KINDS.length,
    );
    if (actual !== expected) {
      throw new Error(`random selection: expected ${expected}, received ${actual}`);
    }
  }
}

function validateObjectProfiles(): void {
  if (Math.abs(HORSE_SIZE_MULTIPLIER - 1.2) > Number.EPSILON) {
    throw new Error(`horse profile: expected 20% visual/physics scale increase`);
  }
  const uniqueSizes = new Set<string>();
  for (const kind of STACK_OBJECT_KINDS) {
    const profile = STACK_OBJECT_PROFILES[kind];
    if (profile.halfHeight <= 0 || profile.halfWidth <= 0 || profile.label.length === 0) {
      throw new Error(`${kind}: invalid stack-object profile`);
    }
    uniqueSizes.add(`${profile.halfWidth}:${profile.halfHeight}`);
  }
  if (uniqueSizes.size !== STACK_OBJECT_KINDS.length) {
    throw new Error('object profiles: every farm prop should have a distinct 2D proxy');
  }
  if (STACK_OBJECT_PROFILES.cow.halfHeight <= STACK_OBJECT_PROFILES.cow.halfWidth) {
    throw new Error('cow profile: expected a tall body');
  }
  const hayAspect = STACK_OBJECT_PROFILES.hay.halfWidth / STACK_OBJECT_PROFILES.hay.halfHeight;
  if (hayAspect < 0.9 || hayAspect > 1.15) {
    throw new Error(`hay profile: expected a near-square body, received aspect ${hayAspect}`);
  }
  if (STACK_OBJECT_PROFILES.chickens.halfWidth !== STACK_OBJECT_PROFILES.chickens.halfHeight) {
    throw new Error('chicken profile: expected a circular body');
  }
}

function validateHeightCalibration(): void {
  const oneHorseTopY = PASTURE_TOP_Y + HORSE_HALF_HEIGHT * 2;
  const meters = getStackHeightMeters(oneHorseTopY);
  if (Math.abs(meters - TYPICAL_HORSE_WITHERS_METERS) > 0.000_001) {
    throw new Error(
      `height calibration: one upright horse should read ${TYPICAL_HORSE_WITHERS_METERS}m, received ${meters}m`,
    );
  }
  if (getStackHeightHands(oneHorseTopY) !== 15) {
    throw new Error('height calibration: a 1.55m horse should round to 15 hands');
  }
}

function getPlacementSurfaceY(
  objects: readonly RigidBody2D[],
  x: number,
  kind: StackObjectKind,
): number {
  let surfaceY = PASTURE_TOP_Y;
  const activeHalfWidth = STACK_OBJECT_PROFILES[kind].halfWidth;
  for (const object of objects) {
    if (
      object.y < PASTURE_TOP_Y ||
      Math.abs(object.x - x) > (activeHalfWidth + getStackBodyHalfWidth(object)) * 0.92 ||
      Math.abs(object.velocityY) > 1.2
    ) {
      continue;
    }
    surfaceY = Math.max(surfaceY, object.y + getStackBodyVerticalExtent(object));
  }
  return surfaceY;
}

function validateFarmEdgeFalloff(): void {
  const world = createHorseStackWorld();
  const hay = STACK_OBJECT_PROFILES.hay;
  const object = addStackObjectBody(
    world,
    'hay',
    PASTURE_HALF_WIDTH - hay.halfWidth,
    0.2,
    0,
  );
  object.velocityX = 1.4;
  stepForDuration(world, [object], 1);
  if (object.y >= -0.1) {
    throw new Error(`farm edge: expected a hay bale to fall into the void, received y=${object.y}`);
  }
}

function stepForDuration(
  world: ReturnType<typeof createHorseStackWorld>,
  objects: readonly RigidBody2D[],
  seconds: number,
): void {
  for (let step = 0; step < Math.ceil(seconds / PHYSICS_STEP); step++) {
    stepHorseStack(world);
    assertFiniteBodies(objects);
  }
}

function assertFiniteBodies(bodies: readonly RigidBody2D[]): void {
  for (let index = 0; index < bodies.length; index++) {
    const object = bodies[index];
    if (object === undefined) continue;
    const values = [
      object.x,
      object.y,
      object.angle,
      object.velocityX,
      object.velocityY,
      object.angularVelocity,
    ];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Object ${index + 1} produced non-finite physics state`);
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
