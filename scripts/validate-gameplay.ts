import type { RigidBody3D } from '@flighthq/sdk';
import {
  addHorseBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getHorseTopY,
  getHorseVerticalExtent,
  getNextHorseDelay,
  getRandomHorsePlacementAngle,
  getStackHeightHands,
  getStackHeightMeters,
  getSupportedStackHeight,
  HORSE_COLLIDER_HALF_LENGTH,
  HORSE_HALF_DEPTH,
  HORSE_HALF_HEIGHT,
  HORSE_HALF_WIDTH,
  HORSE_PLACEMENT_ANGLES,
  HORSE_VISUAL_HALF_DEPTH,
  isHorseWithinPasture,
  PASTURE_HALF_WIDTH,
  PASTURE_FRONT_DEPTH,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  stepHorseStack,
  TYPICAL_HORSE_WITHERS_METERS,
} from '../src/horseStackPhysics';

interface ScenarioResult {
  contacts: number;
  depthSpread: number;
  hands: number;
  heightMeters: number;
  inPasture: number;
  name: string;
}

const TARGET_HALF_WIDTH = 0.32;
const TARGET_HALF_DEPTH = 0.16;
const VALIDATION_HORSES = 64;

const scenarios = [
  runScenario('level placements', 0x4c455645, 0.04, 0.34, false),
  runScenario('balanced placements', 0x42414c41, 0.28, 0.2, false),
  runScenario('random orientations', 0x52414e44, 0, 0.1, true),
];
validateStableActivation();
validatePlacementOrientations();
validateHeightCalibration();
validateFarmEdgeFalloff();
validateFarmDepthFalloff();

console.log(
  `gameplay: ${scenarios
    .map(
      ({ contacts, depthSpread, hands, heightMeters, inPasture, name }) =>
        `${name} ${inPasture}/${VALIDATION_HORSES} in farm, ${contacts} contacts, ${depthSpread.toFixed(3)} depth spread, ${heightMeters.toFixed(2)}m/${hands} hands`,
    )
    .join('; ')}; horse-height calibration and farm-edge falloff verified`,
);

function runScenario(
  name: string,
  seed: number,
  maxTilt: number,
  inputCadence: number,
  randomizeOrientation: boolean,
): ScenarioResult {
  const world = createHorseStackWorld();
  const horses: RigidBody3D[] = [];
  const random = mulberry32(seed);
  const horizontalLimit = TARGET_HALF_WIDTH * 0.85;

  for (let index = 0; index < VALIDATION_HORSES; index++) {
    const horseSeed = random() * Math.PI * 2;
    const lateral = Math.sin(horseSeed) * horizontalLimit;
    const depth = (random() * 2 - 1) * TARGET_HALF_DEPTH;
    const angle = randomizeOrientation
      ? getRandomHorsePlacementAngle(random)
      : (random() * 2 - 1) * maxTilt;
    const landingSurfaceY = getPlacementSurfaceY(horses, lateral, depth);
    const horse = addHorseBody(
      world,
      lateral,
      landingSurfaceY + getHorseVerticalExtent(angle),
      angle,
      depth,
    );
    horse.velocityX = 0;
    horse.velocityY = 0;
    horse.velocityZ = 0;
    horse.angularVelocityX = 0;
    horse.angularVelocityY = 0;
    horse.angularVelocityZ = 0;
    horses.push(horse);

    if (index === VALIDATION_HORSES - 1) continue;
    const delaySeconds = getNextHorseDelay(index + 1) / 1000;
    stepForDuration(world, horses, inputCadence + delaySeconds);
  }

  stepForDuration(world, horses, FINAL_SETTLE_SECONDS);

  const stackTopY = getSupportedStackHeight(world, horses);
  const heightMeters = getStackHeightMeters(stackTopY);
  const remainingHorses = horses.filter(
    (horse) => isHorseWithinPasture(horse) && horse.y > -1,
  );
  const inPasture = remainingHorses.length;
  const depthSpread = remainingHorses.reduce(
    (spread, horse) => Math.max(spread, Math.abs(horse.x)),
    0,
  );
  if (inPasture < VALIDATION_HORSES / 2) {
    throw new Error(`${name}: expected at least half the herd in the farm, received ${inPasture}`);
  }
  const minimumHeightMeters = 1.2;
  if (heightMeters < minimumHeightMeters) {
    throw new Error(
      `${name}: expected a pile over ${minimumHeightMeters}m, received ${heightMeters.toFixed(2)}m`,
    );
  }
  if (world.contacts.length === 0) throw new Error(`${name}: expected contacts`);

  return {
    contacts: world.contacts.length,
    depthSpread,
    hands: getStackHeightHands(stackTopY),
    heightMeters,
    inPasture,
    name,
  };
}

function validatePlacementOrientations(): void {
  if (
    HORSE_PLACEMENT_ANGLES.length < 4 ||
    !HORSE_PLACEMENT_ANGLES.includes(0) ||
    !HORSE_PLACEMENT_ANGLES.includes(Math.PI)
  ) {
    throw new Error('placement orientation: expected multiple poses including upright and upside down');
  }
  for (let index = 0; index < HORSE_PLACEMENT_ANGLES.length; index++) {
    const expected = HORSE_PLACEMENT_ANGLES[index];
    const actual = getRandomHorsePlacementAngle(
      () => (index + 0.5) / HORSE_PLACEMENT_ANGLES.length,
    );
    if (actual !== expected) {
      throw new Error(`placement orientation: expected option ${index} to remain selectable`);
    }
  }
}

function validateStableActivation(): void {
  const world = createHorseStackWorld();
  const angle = 0.42;
  const horse = addHorseBody(
    world,
    0,
    PASTURE_TOP_Y + getHorseVerticalExtent(angle),
    angle,
  );
  if (
    horse.velocityX !== 0 ||
    horse.velocityY !== 0 ||
    horse.velocityZ !== 0 ||
    horse.angularVelocityX !== 0 ||
    horse.angularVelocityY !== 0 ||
    horse.angularVelocityZ !== 0
  ) {
    throw new Error(
      'stable placement: a placed horse must activate without linear or angular impulse',
    );
  }
  if (horse.bullet) {
    throw new Error('stable placement: a gently placed horse should not enable continuous collision');
  }
  if (horse.colliders.length !== 1 || horse.colliders[0]?.local.kind !== 'box') {
    throw new Error('stable placement: each horse should use one inexpensive box collider');
  }
  const proxy = horse.colliders[0].local;
  if (
    proxy.kind !== 'box' ||
    proxy.halfX !== HORSE_HALF_DEPTH ||
    proxy.halfZ !== HORSE_COLLIDER_HALF_LENGTH ||
    proxy.halfX < HORSE_VISUAL_HALF_DEPTH * 1.8 ||
    proxy.halfX > HORSE_VISUAL_HALF_DEPTH * 2.05
  ) {
    throw new Error('stable placement: the horse proxy should be wide and nose-to-tail conservative');
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
  horses: readonly RigidBody3D[],
  lateral: number,
  depth: number,
): number {
  let surfaceY = PASTURE_TOP_Y;
  const lengthReach = HORSE_COLLIDER_HALF_LENGTH * 1.9;
  const depthReach = HORSE_HALF_DEPTH * 1.9;
  for (const horse of horses) {
    if (
      horse.y < PASTURE_TOP_Y ||
      Math.abs(horse.z + lateral) > lengthReach ||
      Math.abs(horse.x - depth) > depthReach ||
      Math.abs(horse.velocityY) > 1.2
    ) {
      continue;
    }
    surfaceY = Math.max(surfaceY, getHorseTopY(horse));
  }
  return surfaceY;
}

function validateFarmEdgeFalloff(): void {
  const world = createHorseStackWorld();
  const horse = addHorseBody(world, PASTURE_HALF_WIDTH - HORSE_HALF_WIDTH, 0.2, 0);
  horse.velocityZ = -1.4;
  stepForDuration(world, [horse], 1);
  if (horse.y >= -0.1) {
    throw new Error(`farm edge: expected a horse to fall into the void, received y=${horse.y}`);
  }
}

function validateFarmDepthFalloff(): void {
  const world = createHorseStackWorld();
  const horse = addHorseBody(world, 0, 0.2, 0, PASTURE_FRONT_DEPTH - HORSE_HALF_DEPTH);
  horse.velocityX = 1.4;
  stepForDuration(world, [horse], 1);
  if (horse.y >= -0.1) {
    throw new Error(`farm depth edge: expected a horse to fall into the void, received y=${horse.y}`);
  }
}

function stepForDuration(
  world: ReturnType<typeof createHorseStackWorld>,
  horses: readonly RigidBody3D[],
  seconds: number,
): void {
  for (let step = 0; step < Math.ceil(seconds / PHYSICS_STEP); step++) {
    stepHorseStack(world);
    assertFiniteBodies(horses);
  }
}

function assertFiniteBodies(bodies: readonly RigidBody3D[]): void {
  for (let index = 0; index < bodies.length; index++) {
    const horse = bodies[index];
    if (horse === undefined) continue;
    const values = {
      angularVelocityX: horse.angularVelocityX,
      angularVelocityY: horse.angularVelocityY,
      angularVelocityZ: horse.angularVelocityZ,
      orientationW: horse.orientationW,
      orientationX: horse.orientationX,
      orientationY: horse.orientationY,
      orientationZ: horse.orientationZ,
      velocityX: horse.velocityX,
      velocityY: horse.velocityY,
      velocityZ: horse.velocityZ,
      x: horse.x,
      y: horse.y,
      z: horse.z,
    };
    const invalidFields = Object.entries(values).filter(([, value]) => !Number.isFinite(value));
    if (invalidFields.length > 0) {
      throw new Error(
        `Horse ${index + 1} produced non-finite physics state: ${invalidFields
          .map(([field, value]) => `${field}=${value}`)
          .join(', ')}`,
      );
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
