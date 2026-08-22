import type { Physics3DBallAndSocketJoint, RigidBody3D } from '@flighthq/sdk';
import {
  addHorseBody,
  attachHorseToPile,
  createHorsePlacementResult,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getHorseTopY,
  getHorseVerticalExtent,
  getNextHorseDelay,
  getRandomHorsePlacementAngle,
  getRandomHorsePlacementYaw,
  getStackHeightHands,
  getStackHeightMeters,
  getSupportedStackHeight,
  HORSE_COLLIDER_HALF_LENGTH,
  HORSE_HALF_DEPTH,
  HORSE_HALF_HEIGHT,
  HORSE_HALF_WIDTH,
  HORSE_MAX_ACTIVE_PINS,
  HORSE_PLACEMENT_ANGLES,
  HORSE_PLACEMENT_YAWS,
  HORSE_VISUAL_HALF_DEPTH,
  isHorseWithinPasture,
  PASTURE_HALF_WIDTH,
  PASTURE_FRONT_DEPTH,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  resolveHorsePlacement,
  stabilizeHorseStack,
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
  pins: number;
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
validateContactPinPhysics();
validatePlacementOrientations();
validateExactPlacementPreview();
validateHeightCalibration();
validateFarmEdgeFalloff();
validateFarmDepthFalloff();

console.log(
  `gameplay: ${scenarios
    .map(
      ({ contacts, depthSpread, hands, heightMeters, inPasture, name, pins }) =>
        `${name} ${inPasture}/${VALIDATION_HORSES} in farm, ${pins} exact pins, ${contacts} contacts, ${depthSpread.toFixed(3)} depth spread, ${heightMeters.toFixed(2)}m/${hands} hands`,
    )
    .join('; ')}; exact contact pins, progressive stability, placement preview, yaw poses, horse-height calibration, and farm-edge falloff verified`,
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
  const placement = createHorsePlacementResult();
  let pins = 0;

  for (let index = 0; index < VALIDATION_HORSES; index++) {
    const horseSeed = random() * Math.PI * 2;
    const lateral = Math.sin(horseSeed) * horizontalLimit;
    const depth = (random() * 2 - 1) * TARGET_HALF_DEPTH;
    const angle = randomizeOrientation
      ? getRandomHorsePlacementAngle(random)
      : (random() * 2 - 1) * maxTilt;
    const yaw = getRandomHorsePlacementYaw(random);
    let startY = PASTURE_TOP_Y + 0.5;
    for (const horse of horses) startY = Math.max(startY, getHorseTopY(horse) + 0.24);
    resolveHorsePlacement(placement, world, lateral, depth, angle, yaw, startY);
    if (!placement.hit) throw new Error(`${name}: placement preview missed the pasture`);
    const horse = addHorseBody(
      world,
      lateral,
      placement.centerY,
      angle,
      depth,
      yaw,
    );
    horse.velocityX = 0;
    horse.velocityY = 0;
    horse.velocityZ = 0;
    horse.angularVelocityX = 0;
    horse.angularVelocityY = 0;
    horse.angularVelocityZ = 0;
    pins += attachHorseToPile(world, horse, placement);
    stabilizeHorseStack(world);
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
  if (pins < VALIDATION_HORSES / 2 || pins >= VALIDATION_HORSES) {
    throw new Error(`${name}: expected one exact pin for most stacked horses, received ${pins}`);
  }
  if (world.joints.length > HORSE_MAX_ACTIVE_PINS) {
    throw new Error(
      `${name}: active pin cap exceeded (${world.joints.length}/${HORSE_MAX_ACTIVE_PINS})`,
    );
  }

  return {
    contacts: world.contacts.length,
    depthSpread,
    hands: getStackHeightHands(stackTopY),
    heightMeters,
    inPasture,
    name,
    pins,
  };
}

function validateContactPinPhysics(): void {
  const world = createHorseStackWorld();
  const placement = createHorsePlacementResult();
  resolveHorsePlacement(placement, world, 0, 0, 0, 0, 0.5);
  const support = addHorseBody(world, 0, placement.centerY, 0);
  resolveHorsePlacement(placement, world, 0, 0, 0, 0, 0.5);
  const horse = addHorseBody(world, 0, placement.centerY, 0);
  const attached = attachHorseToPile(world, horse, placement);
  const pin = world.joints[0] as Physics3DBallAndSocketJoint | undefined;
  if (
    attached !== 1 ||
    world.joints.length !== 1 ||
    pin === undefined ||
    pin.kind !== 'BallAndSocket' ||
    !pin.collideConnected ||
    Number.isFinite(pin.breakForce)
  ) {
    throw new Error('contact pin: expected one freely rotating, colliding, unbreakable point joint');
  }

  const highHorse = addHorseBody(world, 0, support.y + HORSE_HALF_HEIGHT * 12, 0);
  stabilizeHorseStack(world);
  const supportInertiaPerMass = support.inertiaXX / support.mass;
  const highHorseInertiaPerMass = highHorse.inertiaXX / highHorse.mass;
  if (
    support.mass <= highHorse.mass ||
    support.angularDamping < 3 ||
    supportInertiaPerMass < highHorseInertiaPerMass * 2.4 ||
    support.fixedRotation
  ) {
    throw new Error(
      'arcade pile: lower horses should strongly resist rotation without fixed rotation',
    );
  }
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
  if (
    !HORSE_PLACEMENT_YAWS.includes(Math.PI / 2) ||
    !HORSE_PLACEMENT_YAWS.includes(-Math.PI / 2)
  ) {
    throw new Error('placement orientation: expected front- and back-facing yaw poses');
  }
  for (let index = 0; index < HORSE_PLACEMENT_YAWS.length; index++) {
    const expected = HORSE_PLACEMENT_YAWS[index];
    const actual = getRandomHorsePlacementYaw(
      () => (index + 0.5) / HORSE_PLACEMENT_YAWS.length,
    );
    if (actual !== expected) {
      throw new Error(`placement orientation: expected yaw option ${index} to remain selectable`);
    }
  }
  const yawedHorse = addHorseBody(createHorseStackWorld(), 0, 0.3, 0, 0, Math.PI / 2);
  if (Math.abs(Math.abs(yawedHorse.orientationY) - Math.SQRT1_2) > 0.000_01) {
    throw new Error('placement orientation: expected yaw to reach the rigid body transform');
  }
}

function validateExactPlacementPreview(): void {
  const world = createHorseStackWorld();
  const placement = createHorsePlacementResult();
  resolveHorsePlacement(placement, world, 0, 0, 0, Math.PI / 2, 0.5);
  const expectedCenterY = PASTURE_TOP_Y + HORSE_HALF_HEIGHT;
  if (
    !placement.hit ||
    Math.abs(placement.centerY - expectedCenterY) > 0.000_01 ||
    Math.abs(placement.contactY - PASTURE_TOP_Y) > 0.000_01 ||
    placement.normalY < 0.99
  ) {
    throw new Error(
      `placement preview: expected exact pasture contact at ${expectedCenterY}, received ${placement.centerY}`,
    );
  }
  addHorseBody(world, 0, placement.centerY, 0, 0, Math.PI / 2);
  resolveHorsePlacement(placement, world, 0, 0, 0, Math.PI / 2, 0.5);
  if (!placement.hit || placement.centerY <= expectedCenterY + HORSE_HALF_HEIGHT) {
    throw new Error('placement preview: expected the exact cast to find a horse already in the pile');
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
