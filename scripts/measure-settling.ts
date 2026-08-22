// Measures how a free-standing pile settles once nothing more is placed on it.
//
// This is a tuning instrument, not a pass/fail check, so it is not part of the normal
// validation run — `npm run measure:settling`. It exists because "the pile works itself
// loose and the camera shudders" is a claim about numbers, and the numbers are not
// obvious from watching: a pile can look still while the measured stack top jumps
// enough to lurch the camera, and a change can feel better while making creep worse.
//
// Reported per configuration, averaged over seeds:
//   sleptAt       when every body's island reached sleep, or how many seeds got there
//   maxJump       largest single-step change in the measured stack top — the camera
//                 follows this, so it is the shudder metric
//   jumps         how many steps moved the measured top by more than 2mm
//   drift         path length per surviving body per second — the works-itself-loose metric
//   fastest@2s    speed of the quickest body two seconds in, against the world's
//                 sleepLinearThreshold; one body over it keeps its whole island awake
import type { RigidBody2D } from '@flighthq/sdk';
import {
  addStackObjectBody,
  createHorseStackWorld,
  getNextObjectDelay,
  getRandomStackObjectKind,
  getStackBodyHalfWidth,
  getStackBodyVerticalExtent,
  getStackObjectVerticalExtent,
  getSupportedStackHeight,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  STACK_OBJECT_PROFILES,
  stepHorseStack,
} from '../src/horseStackPhysics';
import type { StackObjectKind } from '../src/horseStackPhysics';

type World = ReturnType<typeof createHorseStackWorld>;
interface Variant {
  name: string;
  world?: (world: World) => void;
}

const OBJECTS = 30;
const QUIET_SECONDS = 20;
const PLACEMENT_HALF_WIDTH = 0.34 * 0.85;
const SEEDS = Array.from({ length: 24 }, (_, index) => 0x5eed0000 + index);

// Add variants here to A/B a tuning idea against the shipped configuration.
const variants: Variant[] = [
  { name: 'shipped' },
  { name: 'ground friction 0.72', world: (w) => setGroundFriction(w, 0.72) },
  { name: 'sleep thresholds x4', world: (w) => setSleepScale(w, 4) },
];

console.log(
  `settling: ${OBJECTS} objects, then ${QUIET_SECONDS}s with nothing placed; mean of ${SEEDS.length} seeds`,
);
console.log('variant                  sleptAt   maxJump   jumps  drift/body/s  fastest@2s  kept');
for (const variant of variants) {
  const runs = SEEDS.map((seed) => measure(variant, seed));
  const mean = (pick: (run: (typeof runs)[number]) => number): number =>
    runs.reduce((total, run) => total + pick(run), 0) / runs.length;
  const slept = runs.map((run) => run.sleptAt).filter((value): value is number => value >= 0);
  const sleptLabel =
    slept.length === runs.length
      ? `${(slept.reduce((total, value) => total + value, 0) / slept.length).toFixed(2)}s`
      : `${slept.length}/${runs.length}`;
  console.log(
    `${variant.name.padEnd(24)} ${sleptLabel.padStart(7)} ${mean((r) => r.maxJump).toFixed(4).padStart(9)} ${mean((r) => r.jumps).toFixed(1).padStart(7)} ${mean((r) => r.drift).toFixed(5).padStart(13)} ${mean((r) => r.fastestAtTwoSeconds).toFixed(4).padStart(11)} ${mean((r) => r.kept).toFixed(1).padStart(5)}`,
  );
}

function measure(variant: Variant, seed: number) {
  const world = createHorseStackWorld();
  variant.world?.(world);
  const objects: RigidBody2D[] = [];
  const random = mulberry32(seed);

  for (let index = 0; index < OBJECTS; index++) {
    const x = Math.sin(random() * Math.PI * 2) * PLACEMENT_HALF_WIDTH;
    const angle = (random() * 2 - 1) * 0.28;
    const kind = getRandomStackObjectKind(random);
    const y = placementSurfaceY(objects, x, kind) + getStackObjectVerticalExtent(kind, angle);
    const body = addStackObjectBody(world, kind, x, y, angle);
    body.velocityX = 0;
    body.velocityY = 0;
    body.angularVelocity = 0;
    objects.push(body);
    if (index === OBJECTS - 1) continue;
    step(world, 0.2 + getNextObjectDelay(index + 1) / 1000);
  }

  const quietSteps = Math.ceil(QUIET_SECONDS / PHYSICS_STEP);
  const previous = objects.map((object) => ({ x: object.x, y: object.y }));
  let previousTop = getSupportedStackHeight(world, objects);
  let maxJump = 0;
  let jumps = 0;
  let drift = 0;
  let sleptAt = -1;
  let fastestAtTwoSeconds = 0;

  for (let index = 0; index < quietSteps; index++) {
    stepHorseStack(world);
    for (let body = 0; body < objects.length; body++) {
      const object = objects[body];
      const before = previous[body];
      if (object === undefined || before === undefined) continue;
      if (object.y > -1) drift += Math.hypot(object.x - before.x, object.y - before.y);
      before.x = object.x;
      before.y = object.y;
    }
    const top = getSupportedStackHeight(world, objects);
    const jump = Math.abs(top - previousTop);
    if (jump > 0.002) jumps++;
    maxJump = Math.max(maxJump, jump);
    previousTop = top;

    const awake = objects.filter((object) => !object.sleeping && object.y > -1);
    if (awake.length === 0 && sleptAt < 0) sleptAt = index * PHYSICS_STEP;
    if (index === Math.round(2 / PHYSICS_STEP)) {
      fastestAtTwoSeconds = Math.max(
        0,
        ...awake.map((object) => Math.hypot(object.velocityX, object.velocityY)),
      );
    }
  }

  const kept = objects.filter((object) => object.y > -1).length;
  return { drift: drift / Math.max(1, kept) / QUIET_SECONDS, fastestAtTwoSeconds, jumps, kept, maxJump, sleptAt };
}

function step(world: World, seconds: number): void {
  const steps = Math.ceil(seconds / PHYSICS_STEP);
  for (let index = 0; index < steps; index++) stepHorseStack(world);
}

function setGroundFriction(world: World, friction: number): void {
  const collider = world.bodies[0]?.colliders[0];
  if (collider !== undefined) collider.material = { ...collider.material, friction };
}

function setSleepScale(world: World, scale: number): void {
  world.config.sleepLinearThreshold = 0.01 * scale;
  world.config.sleepAngularThreshold = ((2 * scale) * Math.PI) / 180;
}

function placementSurfaceY(
  objects: readonly RigidBody2D[],
  x: number,
  kind: StackObjectKind,
): number {
  let surfaceY = PASTURE_TOP_Y;
  const halfWidth = STACK_OBJECT_PROFILES[kind].halfWidth;
  for (const object of objects) {
    if (
      object.y < PASTURE_TOP_Y ||
      Math.abs(object.x - x) > (halfWidth + getStackBodyHalfWidth(object)) * 0.92 ||
      Math.abs(object.velocityY) > 1.2
    ) {
      continue;
    }
    surfaceY = Math.max(surfaceY, object.y + getStackBodyVerticalExtent(object));
  }
  return surfaceY;
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
