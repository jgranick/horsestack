import type { RigidBody2D } from '@flighthq/sdk';
import {
  PASTURE_MAX_X,
  PASTURE_TOP_Y,
} from '../src/physics/pasture';
import {
  STACK_OBJECT_KINDS,
  STACK_OBJECT_WEIGHTS,
  getNextObjectDelay,
  getRandomStackObjectKind,
} from '../src/physics/stackObjectKind';
import type { StackObjectKind } from '../src/physics/stackObjectKind';
import {
  HORSE_HALF_HEIGHT,
  HORSE_SIZE_MULTIPLIER,
  HORSE_WITHERS_HEIGHT,
  STACK_OBJECT_PROFILES,
  TYPICAL_HORSE_WITHERS_METERS,
  getStackBodyHalfWidth,
  getStackBodySupportExtent,
  getStackHeightHands,
  getStackHeightMeters,
  getStackObjectSupportExtent,
  getStackObjectVerticalExtent,
} from '../src/physics/stackObjectProfile';
import {
  FINAL_SETTLE_SECONDS,
  PHYSICS_STEP,
  addStackObjectBody,
  createHorseStackWorld,
  getSupportedStackHeight,
  isStackBodyWithinPasture,
  stepHorseStack,
} from '../src/physics/stackPhysics';

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
validateSupportHeights();
validateCentredMass();
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
    .join('; ')}; weighted 50/30/15/5 hay/horse/chicken/cow selection, distinct 2D proxies, horse-height calibration, and farm-edge falloff verified`,
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

// Guards the settling fix: Flight solves centre of mass from the collider, and an
// off-centre polygon leaves centerX/centerY non-zero, which measurably slows a
// free-standing pile from settling and shows up as camera shudder. Every shape must
// solve to a centred body so no future collider edit reintroduces it silently.
function validateCentredMass(): void {
  const world = createHorseStackWorld();
  for (const kind of STACK_OBJECT_KINDS) {
    const body = addStackObjectBody(world, kind, 0, PASTURE_TOP_Y + 1, 0);
    const offset = Math.hypot(body.centerX, body.centerY);
    const tolerance = STACK_OBJECT_PROFILES[kind].halfHeight * 0.005;
    if (!(offset <= tolerance)) {
      throw new Error(
        `${kind}: collider centre of mass is ${offset.toFixed(6)} off the body origin, over the ${tolerance.toFixed(6)} tolerance`,
      );
    }
  }
}

// The head must not be a landing surface, and the drop math must still clear the whole
// silhouette — the two have to stay on opposite sides of this line or pieces get placed
// inside the horse and shoved out again.
function validateSupportHeights(): void {
  for (const kind of STACK_OBJECT_KINDS) {
    const profile = STACK_OBJECT_PROFILES[kind];
    if (profile.supportHalfHeight > profile.halfHeight) {
      throw new Error(`${kind}: support height must not exceed the body half-height`);
    }
    for (const angle of [0, 0.25, 0.6]) {
      if (getStackObjectSupportExtent(kind, angle) > getStackObjectVerticalExtent(kind, angle)) {
        throw new Error(`${kind}: support extent exceeded the full extent at angle ${angle}`);
      }
    }
  }
  const horse = STACK_OBJECT_PROFILES.horse;
  if (!(horse.supportHalfHeight < horse.halfHeight * 0.6)) {
    throw new Error(
      `horse: expected the rideable back well below the top of the head, received ${horse.supportHalfHeight} of ${horse.halfHeight}`,
    );
  }
  for (const kind of ['hay', 'cow', 'chickens'] as const) {
    if (STACK_OBJECT_PROFILES[kind].supportHalfHeight !== STACK_OBJECT_PROFILES[kind].halfHeight) {
      throw new Error(`${kind}: expected the whole shape to be a landing surface`);
    }
  }
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
    // The horse alone is a compound: a barrel-and-legs box plus a head-and-neck box, so
    // its head stays solid without acting as a shelf. Everything else stays single-shape.
    const expectedColliderKind = kind === 'chickens' ? 'circle' : 'polygon';
    const expectedColliderCount = kind === 'horse' ? 2 : 1;
    if (body.bullet || body.colliders.length !== expectedColliderCount) {
      throw new Error(
        `${kind}: expected ${expectedColliderCount} discrete collider(s), received ${body.colliders.length}`,
      );
    }
    for (const collider of body.colliders) {
      if (collider.local.kind !== expectedColliderKind) {
        throw new Error(`${kind}: expected ${expectedColliderKind} colliders`);
      }
    }
  }
}

function validateRandomObjectSelection(): void {
  const weightTotal = STACK_OBJECT_KINDS.reduce(
    (total, kind) => total + STACK_OBJECT_WEIGHTS[kind],
    0,
  );
  if (Math.abs(weightTotal - 1) > Number.EPSILON) {
    throw new Error(`random selection: weights must total 1, received ${weightTotal}`);
  }
  if (
    !(
      STACK_OBJECT_WEIGHTS.hay > STACK_OBJECT_WEIGHTS.horse &&
      STACK_OBJECT_WEIGHTS.horse > STACK_OBJECT_WEIGHTS.chickens &&
      STACK_OBJECT_WEIGHTS.chickens > STACK_OBJECT_WEIGHTS.cow
    )
  ) {
    throw new Error('random selection: expected hay > horse > chickens > cow weighting');
  }

  const selections: readonly [number, StackObjectKind][] = [
    [0.15, 'horse'],
    [0.55, 'hay'],
    [0.825, 'cow'],
    [0.925, 'chickens'],
  ];
  for (const [randomValue, expected] of selections) {
    const actual = getRandomStackObjectKind(() => randomValue);
    if (actual !== expected) {
      throw new Error(`random selection: expected ${expected}, received ${actual}`);
    }
  }
}

function validateObjectProfiles(): void {
  // Pinned because the mesh scale, the collider and the metre calibration all derive from
  // it, so a stray edit silently resizes the horse everywhere at once. The value is set by
  // measurement against the cow — see the note on the constant.
  if (Math.abs(HORSE_SIZE_MULTIPLIER - 1.35) > Number.EPSILON) {
    throw new Error(`horse profile: expected the measured 1.35 scale against the cow`);
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
  // 1.55 m is a horse's WITHERS height, so that is the line the scale hangs off — not the
  // top of its head, which stands another quarter of its height higher again.
  const withersTopY = PASTURE_TOP_Y + HORSE_WITHERS_HEIGHT;
  const meters = getStackHeightMeters(withersTopY);
  if (Math.abs(meters - TYPICAL_HORSE_WITHERS_METERS) > 0.000_001) {
    throw new Error(
      `height calibration: a horse's withers should read ${TYPICAL_HORSE_WITHERS_METERS}m, received ${meters}m`,
    );
  }
  if (getStackHeightHands(withersTopY) !== 15) {
    throw new Error('height calibration: a 1.55m horse should round to 15 hands');
  }
  // The whole horse, head included, must therefore read taller than its withers.
  const wholeHorse = getStackHeightMeters(PASTURE_TOP_Y + HORSE_HALF_HEIGHT * 2);
  if (!(wholeHorse > TYPICAL_HORSE_WITHERS_METERS * 1.2)) {
    throw new Error(
      `height calibration: a whole horse should stand well above its withers, received ${wholeHorse}m`,
    );
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
    surfaceY = Math.max(surfaceY, object.y + getStackBodySupportExtent(object));
  }
  return surfaceY;
}

function validateFarmEdgeFalloff(): void {
  const world = createHorseStackWorld();
  const hay = STACK_OBJECT_PROFILES.hay;
  const object = addStackObjectBody(
    world,
    'hay',
    PASTURE_MAX_X - hay.halfWidth,
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
