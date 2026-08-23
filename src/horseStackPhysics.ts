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
  // How far above the body's centre something can actually be set down. For most props
  // that is simply the top of the shape, but a horse's head and neck are not a surface:
  // they occupy the top quarter of its height at 7-43% of its width, so treating the
  // whole silhouette as a platform left pieces balanced a quarter of a horse too high.
  supportHalfHeight: number;
}

// Sized against the cow, which is left as authored. Measured off both meshes as rendered,
// comparing the height at which each body is still broad — the withers line — rather than
// the full silhouette, because a horse is measured at the withers and its head and neck
// carry another 27% above that. At 1.2 the horse's back sat at 0.1337 against the cow's
// 0.1408: the horse was SHORTER than the cow, where a 1.55m horse should stand about 1.07x
// a 1.45m dairy cow. 1.35 puts the ratio right.
export const HORSE_SIZE_MULTIPLIER = 1.35;
export const HORSE_HALF_WIDTH = 0.09 * HORSE_SIZE_MULTIPLIER;
export const HORSE_HALF_HEIGHT = 0.0765 * HORSE_SIZE_MULTIPLIER;
// Measured off the horse glTF projected into collider space: the back of the barrel sits
// at about 0.447 of the half-height, and only head and neck are above it.
export const HORSE_BACK_RATIO = 0.447;
export const HORSE_SUPPORT_HALF_HEIGHT = HORSE_HALF_HEIGHT * HORSE_BACK_RATIO;
export const TYPICAL_HORSE_WITHERS_METERS = 1.55;
// How tall a horse stands at the withers, which is the line 1.55 m actually refers to.
// HORSE_HALF_HEIGHT covers the full silhouette, and this model carries better than a
// quarter of that in head and neck above the back, so the two must not be confused.
export const HORSE_WITHERS_HEIGHT = HORSE_HALF_HEIGHT * (1 + HORSE_BACK_RATIO);
// This world is not metres. Calibrating on the WITHERS rather than the full silhouette:
// mapping 1.55 m onto the top of a raised head made every reported height about 27% short,
// and made a dairy cow standing beside a "1.55 m" horse read as 1.11 m.
export const METERS_PER_WORLD_UNIT = TYPICAL_HORSE_WITHERS_METERS / HORSE_WITHERS_HEIGHT;
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
    supportHalfHeight: HORSE_SUPPORT_HALF_HEIGHT,
  },
  hay: {
    emoji: '🌾',
    halfHeight: 0.046,
    halfWidth: 0.0505,
    label: 'Hay bale',
    supportHalfHeight: 0.046,
  },
  cow: {
    emoji: '🐄',
    halfHeight: 0.097,
    halfWidth: 0.074,
    label: 'Cow',
    supportHalfHeight: 0.097,
  },
  chickens: {
    emoji: '🐔',
    halfHeight: 0.021,
    halfWidth: 0.021,
    label: 'Chicken',
    supportHalfHeight: 0.021,
  },
};

// Measured off the farm glTF's Ground/Ground2 triangles along the play line: the modelled
// ground runs from about -1.61 to +1.71 in physics X at world x=1.55, and closes in to
// +/-1.60 across the depth a piece actually occupies. At 1.75 the platform hung 0.14 past
// the left edge of the floating map, so pieces rested on nothing. This sits inside it.
export const PASTURE_HALF_WIDTH = 1.55;
// STACK_BASE_Y maps physics space into the rendered scene. Its 0.015 offset
// puts this surface at world Y -0.02, level with the mounted farm terrain.
export const PASTURE_TOP_Y = -0.035;
export const PHYSICS_GRAVITY = 10.8;
export const PHYSICS_STEP = 1 / 60;
export const FINAL_SETTLE_SECONDS = 2.35;

const PHYSICS_GRID_CELL_SIZE = 0.2;
// The pile is meant to be improbable, not fair. Restitution is effectively nil so nothing
// keeps bouncing after it lands, and friction is generous so a piece shifts and leans
// rather than sliding straight off.
const STACK_MATERIALS: Readonly<Record<StackObjectKind, Physics2DMaterial>> = {
  horse: { density: 1, friction: 0.82, restitution: 0.01 },
  hay: { density: 0.72, friction: 0.9, restitution: 0 },
  cow: { density: 1.15, friction: 0.84, restitution: 0.01 },
  chickens: { density: 0.48, friction: 0.72, restitution: 0.02 },
};

// Damping a piece starts with, before any assist is layered on.
const STACK_DAMPING: Readonly<Record<StackObjectKind, { angular: number; linear: number }>> = {
  horse: { angular: 0.5, linear: 0.16 },
  hay: { angular: 0.6, linear: 0.18 },
  cow: { angular: 0.5, linear: 0.16 },
  chickens: { angular: 0.45, linear: 0.12 },
};

// A piece that has been near-still for SETTLE_DELAY starts behaving as though it were
// gripping whatever is under it, reaching full assist SETTLE_RAMP later. It is never
// welded — it can still be shoved loose — but it stops drifting out from under the pile.
const STILL_LINEAR = 0.35;
const STILL_ANGULAR = 1.1;
const SETTLE_DELAY = 0.5;
const SETTLE_RAMP = 1.6;
const ASSIST_ANGULAR = 5.5;
const ASSIST_LINEAR = 1.1;
// Damping alone only removes speed; what topples a tower is torque. A settled piece also
// gets progressively harder to ROTATE, which is what "gripping the one underneath"
// actually feels like. Its real inertia is left alone — only the solver's view of it is
// stiffened, and only while the piece is quiet, so a shove still spins it.
const ASSIST_INERTIA = 10;
// A pile of loose pieces always seeks its angle of repose: it spreads into a cone rather
// than rising, because nothing stops a piece sliding down the outside after it lands. What
// makes a tower instead of a heap is COHESION. A settled piece remembers where it came to
// rest and is pulled back toward that spot, so it resists being slid off what it is
// standing on. It is a soft pull, not a weld — a real collapse still overwhelms it, and
// losing quiet time drops the anchor entirely.
const COHESION_PULL = 26;
const COHESION_GRIP = 7;
// Height alone earns some of the same help: the higher a piece rides, the calmer it is
// held, so a tall pile is quietly propped up rather than honestly balanced.
const STABILITY_FULL_HEIGHT = 0.9;
const PASTURE_MATERIAL: Physics2DMaterial = {
  density: 0,
  friction: 0.38,
  restitution: 0.035,
};
const stackBodyKinds = new WeakMap<RigidBody2D, StackObjectKind>();
const stackBodyQuiet = new WeakMap<RigidBody2D, number>();
// The solver-computed inertia, kept so the assist always stiffens from the true value
// rather than compounding on its own previous output.
const stackBodyInertia = new WeakMap<RigidBody2D, number>();
// Where a settled piece came to rest, and what cohesion pulls it back toward.
const stackBodyAnchor = new WeakMap<RigidBody2D, number>();

export function createHorseStackWorld(): Physics2DWorld {
  const world = createPhysics2DWorld(
    0,
    -PHYSICS_GRAVITY,
    createUniformGridSpatialBackend(PHYSICS_GRID_CELL_SIZE),
  );
  world.config.velocityIterations = 18;
  world.config.positionIterations = 9;
  world.config.timeToSleep = 0.3;
  // Flight's default sleepLinearThreshold is Box2D's 0.01, which is tuned for a world
  // measured in metres. Ours is measured in ~8.44 m units, so the metre default is about
  // 8x too tight for the speeds it is judging, and a pile that has visually stopped keeps
  // one body above it — which, because sleeping is decided per island, keeps the whole
  // pile awake and creeping. Translating the threshold into this world's units is the fix
  // Flight recommended after A/B-ing it on their side (never sleeps at 0.01; 162 frames at
  // this value, with centred colliders either way).
  //
  // Only the LINEAR threshold scales. sleepAngularThreshold is in rad/s, and an angle is
  // dimensionless, so its default is already correct at any world scale.
  world.config.sleepLinearThreshold = 0.01 * METERS_PER_WORLD_UNIT;

  // Softer, better-converged contacts: pieces are allowed to sink into one another a
  // little and settle instead of being shoved apart every step.
  world.config.penetrationSlop = 0.009;
  world.config.positionCorrection = 0.28;
  world.config.restitutionThreshold = 2.5;
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
  body.linearDamping = STACK_DAMPING[kind].linear;
  body.angularDamping = STACK_DAMPING[kind].angular;
  body.bullet = false;
  if (kind === 'chickens') {
    body.colliders.push(
      createPhysics2DCollider(
        { kind: 'circle', radius: STACK_OBJECT_PROFILES.chickens.halfHeight, x: 0, y: 0 },
        STACK_MATERIALS.chickens,
      ),
    );
  } else {
    // One shape for every prop but the horse, which is a compound; see
    // getHorseColliderPolygons.
    for (const points of getCentredColliderPolygons(kind)) {
      body.colliders.push(
        createPhysics2DCollider({ kind: 'polygon', points }, STACK_MATERIALS[kind]),
      );
    }
  }
  addPhysics2DBody(world, body);
  stackBodyKinds.set(body, kind);
  return body;
}

export function stepHorseStack(world: Physics2DWorld): void {
  applyStackAssist(world);
  stepPhysics2D(world, PHYSICS_STEP);
}

// The thumb on the scale. Runs before every step and only ever raises damping, so it can
// calm a piece but never move it: no teleporting, no joints, nothing that would read as
// the pile snapping rigid.
function applyStackAssist(world: Physics2DWorld): void {
  for (const body of world.bodies) {
    if (body.type !== 'dynamic') continue;
    const kind = stackBodyKinds.get(body);
    if (kind === undefined) continue;
    const base = STACK_DAMPING[kind];
    if (body.sleeping) {
      body.linearDamping = base.linear + ASSIST_LINEAR;
      body.angularDamping = base.angular + ASSIST_ANGULAR;
      applyAssistInertia(body, 1);
      stackBodyAnchor.set(body, body.x);
      continue;
    }
    const still =
      Math.hypot(body.velocityX, body.velocityY) < STILL_LINEAR &&
      Math.abs(body.angularVelocity) < STILL_ANGULAR;
    // Quiet time accrues at real time but is spent three times as fast when a piece is
    // knocked about again, so a genuine disturbance loses the assist quickly.
    const quiet = Math.max(
      0,
      Math.min(
        SETTLE_DELAY + SETTLE_RAMP,
        (stackBodyQuiet.get(body) ?? 0) + (still ? PHYSICS_STEP : -PHYSICS_STEP * 3),
      ),
    );
    stackBodyQuiet.set(body, quiet);
    const settled = clamp01((quiet - SETTLE_DELAY) / SETTLE_RAMP);
    const carried = clamp01((body.y - PASTURE_TOP_Y) / STABILITY_FULL_HEIGHT) * 0.75;
    const assist = Math.max(settled, carried);
    body.linearDamping = base.linear + assist * ASSIST_LINEAR;
    body.angularDamping = base.angular + assist * ASSIST_ANGULAR;
    applyAssistInertia(body, assist);
    applyCohesion(body, assist, still);
  }
}

// Holds a settled piece over the spot it settled on. Horizontal only: vertical motion is
// the game, sideways motion is the pile giving up.
function applyCohesion(body: RigidBody2D, assist: number, still: boolean): void {
  if (assist <= 0 || !still) {
    stackBodyAnchor.delete(body);
    return;
  }
  const anchor = stackBodyAnchor.get(body);
  if (anchor === undefined) {
    stackBodyAnchor.set(body, body.x);
    return;
  }
  const drift = anchor - body.x;
  body.velocityX += drift * COHESION_PULL * assist * PHYSICS_STEP;
  body.velocityX -= body.velocityX * COHESION_GRIP * assist * PHYSICS_STEP;
}

function applyAssistInertia(body: RigidBody2D, assist: number): void {
  const solved = stackBodyInertia.get(body) ?? body.inertia;
  stackBodyInertia.set(body, solved);
  if (solved <= 0) return;
  const stiffened = solved * (1 + assist * ASSIST_INERTIA);
  body.inertia = stiffened;
  body.inverseInertia = 1 / stiffened;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
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

// How high above a body's centre the next piece may rest. Same rotation blend as the full
// extent, so it degrades to the half-width as a piece tips onto its side; only the upright
// term differs. Placement of the piece being dropped still uses the FULL extent, so a new
// object can never be spawned intersecting what it lands on.
export function getStackObjectSupportExtent(kind: StackObjectKind, angle: number): number {
  const profile = STACK_OBJECT_PROFILES[kind];
  if (kind === 'chickens') return profile.supportHalfHeight;
  return (
    Math.abs(Math.cos(angle)) * profile.supportHalfHeight +
    Math.abs(Math.sin(angle)) * profile.halfWidth
  );
}

export function getStackBodySupportExtent(body: Readonly<RigidBody2D>): number {
  return getStackObjectSupportExtent(getStackBodyKind(body), body.angle);
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
  return heightAbovePasture * METERS_PER_WORLD_UNIT;
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

// Flight solves each body's centre of mass from its colliders, so shapes authored
// off-centre leave centerX/centerY non-zero. Offset centres of mass settle measurably
// worse in a free-standing pile: A/B over 24 seeded 30-object piles, otherwise identical,
// cut the worst stack-top jump from 0.080 to 0.044 and creep from 0.0037 to 0.0028
// units/body/s. For a compound the whole GROUP has to be centred, area-weighted, not each
// shape on its own — density is uniform, so area weighting is mass weighting. Translating
// changes no extent, so the silhouette stays put.
function getCentredColliderPolygons(kind: Exclude<StackObjectKind, 'chickens'>): number[][] {
  const polygons = kind === 'horse' ? getHorseColliderPolygons() : [getPolygonColliderPoints(kind)];
  let totalArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (const points of polygons) {
    const [area, x, y] = getPolygonAreaCentroid(points);
    totalArea += area;
    centroidX += area * x;
    centroidY += area * y;
  }
  if (totalArea === 0) return polygons;
  centroidX /= totalArea;
  centroidY /= totalArea;
  return polygons.map((points) =>
    points.map((value, index) => value - (index % 2 === 0 ? centroidX : centroidY)),
  );
}

function getPolygonAreaCentroid(points: readonly number[]): [number, number, number] {
  let twiceArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < points.length; index += 2) {
    const x0 = points[index] ?? 0;
    const y0 = points[index + 1] ?? 0;
    const x1 = points[(index + 2) % points.length] ?? 0;
    const y1 = points[(index + 3) % points.length] ?? 0;
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    centroidX += (x0 + x1) * cross;
    centroidY += (y0 + y1) * cross;
  }
  if (twiceArea === 0) return [0, 0, 0];
  const scale = 1 / (3 * twiceArea);
  return [twiceArea / 2, centroidX * scale, centroidY * scale];
}

// The horse is the one prop whose silhouette is not one blob. Measuring the model in
// collider space: barrel and legs fill the lower 0.447 of the height across most of the
// length, and head and neck rise above that over only the front third. Two shapes keep the
// head solid without making it a shelf, and leave a real notch in front of the chest for
// other pieces to nestle into.
function getHorseColliderPolygons(): number[][] {
  const w = HORSE_HALF_WIDTH;
  const h = HORSE_HALF_HEIGHT;
  const backY = HORSE_SUPPORT_HALF_HEIGHT;
  return [
    getBoxPoints(-0.667 * w, -h, 0.926 * w, backY),
    getBoxPoints(-0.944 * w, backY, -0.278 * w, h),
  ];
}

function getBoxPoints(minX: number, minY: number, maxX: number, maxY: number): number[] {
  return [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
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
