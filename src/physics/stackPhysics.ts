// The physics world: building it, adding bodies to it, stepping it, and the three assists
// that make a free-standing pile of animals stay up long enough to be funny.
// src/physics/StackPhysics.hx in the Haxe sibling.
//
// The kinds, the per-kind dimensions and the collider outlines have their own files now;
// what is left here is the solver-facing half — the world, the fixed step, the settling
// assist, the cohesion that pulls a settled piece back toward where it landed, and the
// height measurement the score is read from.
import {
  addPhysics2DBody,
  createPhysics2DCollider,
  createPhysics2DWorld,
  createRigidBody2D,
  createUniformGridSpatialBackend2D,
  saturate,
  stepPhysics2D,
} from '@flighthq/sdk';
import type { Physics2DMaterial, Physics2DWorld, RigidBody2D } from '@flighthq/sdk';
import { getCentredColliderPolygons } from './colliderGeometry';
import { PASTURE_HALF_WIDTH, PASTURE_TOP_Y } from './pasture';
import {
  deleteStackBodyAnchor,
  findStackBodyKind,
  getStackBodyAnchor,
  getStackBodyKind,
  getStackBodyInertia,
  getStackBodyQuiet,
  setStackBodyAnchor,
  setStackBodyInertia,
  setStackBodyKind,
  setStackBodyQuiet,
} from './stackBodyRegistry';
import type { StackObjectKind } from './stackObjectKind';
import {
  getStackBodyHalfWidth,
  getStackBodyVerticalExtent,
  METERS_PER_WORLD_UNIT,
  STACK_OBJECT_PROFILES,
} from './stackObjectProfile';

export const PHYSICS_GRAVITY = 10.8;
export const PHYSICS_STEP = 1 / 60;
export const FINAL_SETTLE_SECONDS = 2.35;

const PHYSICS_GRID_CELL_SIZE = 0.2;
// How far the terrain colliders extend below their surface. Only has to be deeper than any
// piece could travel in one step; it is never seen.
const GROUND_SKIRT = 0.35;
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
const ASSIST_ANGULAR = 16.5;
const ASSIST_LINEAR = 3.3;
// Damping alone only removes speed; what topples a tower is torque. A settled piece also
// gets progressively harder to ROTATE, which is what "gripping the one underneath"
// actually feels like. Its real inertia is left alone — only the solver's view of it is
// stiffened, and only while the piece is quiet, so a shove still spins it.
// Deliberately NOT tripled with the rest of the assist. Tripling it to 30 makes the pile
// permanently restless — 19.5 of 30 bodies still awake five seconds after the last drop,
// against 7.8 at this value — because heavily stiffened rotation stops contacts resolving
// and they keep trading impulses. It costs height too: tripling everything gives a median
// of 9.85m, holding this back gives 10.35m. More stiffening is not more stability.
const ASSIST_INERTIA = 10;
// A pile of loose pieces always seeks its angle of repose: it spreads into a cone rather
// than rising, because nothing stops a piece sliding down the outside after it lands. What
// makes a tower instead of a heap is COHESION. A settled piece remembers where it came to
// rest and is pulled back toward that spot, so it resists being slid off what it is
// standing on. It is a soft pull, not a weld — a real collapse still overwhelms it, and
// losing quiet time drops the anchor entirely.
const COHESION_PULL = 78;
const COHESION_GRIP = 21;
// A piece already sitting on its anchor must be left completely alone. Without this the
// pull injects a little velocity every step, which holds the body above the sleep
// threshold, and because sleep is decided per island one twitching piece keeps the whole
// pile awake for ever. Measured: without the deadzone 22 of 30 bodies were still awake
// five seconds after the last drop.
const COHESION_DEADZONE = 0.0016;
// Height alone earns some of the same help: the higher a piece rides, the calmer it is
// held, so a tall pile is quietly propped up rather than honestly balanced.
const STABILITY_FULL_HEIGHT = 0.9;
const PASTURE_MATERIAL: Physics2DMaterial = {
  density: 0,
  friction: 0.38,
  restitution: 0.035,
};

/** Ground heights across the pasture, in physics coordinates. See scene/terrainProfile.ts. */
export interface GroundProfile {
  minX: number;
  step: number;
  heights: readonly number[];
}

/**
 * The ground height under a point, interpolated between samples. Without a profile this is
 * the flat pasture, which is the same fallback createHorseStackWorld makes — so every caller
 * agrees on where the floor is whether or not the farm mesh was available.
 *
 * This is what stops a piece being HELD inside the grass. The collider follows the terrain,
 * but placement, the landing indicator and the "has this fallen off" test all used to assume
 * the flat pasture, and the modelled ground runs up to 26mm above it and 55mm below: pieces
 * aimed at the "floor" over the high ground were drawn buried in it.
 */
export function getGroundY(ground: GroundProfile | undefined, x: number): number {
  if (ground === undefined || ground.heights.length === 0) return PASTURE_TOP_Y;
  const position = (x - ground.minX) / ground.step;
  const last = ground.heights.length - 1;
  if (position <= 0) return ground.heights[0] ?? PASTURE_TOP_Y;
  if (position >= last) return ground.heights[last] ?? PASTURE_TOP_Y;
  const index = Math.floor(position);
  const y0 = ground.heights[index] ?? PASTURE_TOP_Y;
  const y1 = ground.heights[index + 1] ?? PASTURE_TOP_Y;
  return y0 + (y1 - y0) * (position - index);
}

/**
 * Builds the round's physics world. `ground` makes the floor follow the modelled terrain;
 * without it the floor is the flat box this used to have, which is the right fallback for the
 * headless validation scripts (they have no farm mesh to sample) and for a model whose ground
 * cannot be found.
 */
export function createHorseStackWorld(ground?: GroundProfile): Physics2DWorld {
  const world = createPhysics2DWorld(
    0,
    -PHYSICS_GRAVITY,
    createUniformGridSpatialBackend2D(PHYSICS_GRID_CELL_SIZE),
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
  // The flat floor is built EXACTLY as it always was — body positioned at the surface, box
  // hanging below it in body-relative coordinates. Re-expressing the same geometry in
  // absolute coordinates gives the same corners to within a last bit, and over 64 placements
  // the solver amplifies that into a visibly different pile: it moved one gameplay-validation
  // scenario from 13.48m to 11.99m while the other two stayed identical. The headless scripts
  // take this path, so it is left alone and the terrain path gets its own body.
  if (ground === undefined || ground.heights.length < 2) {
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

  // Terrain-following floor: one convex quad per span, anchored at the origin so the sampled
  // heights can be used as written. Sloped rather than stepped, because a staircase of boxes
  // gives a rolling hay bale a lip to catch on at every sample and the pile creeps down it.
  //
  // The skirt is deep enough that a piece cannot tunnel under the floor in one step, and
  // neighbouring quads share their end edges exactly, so there is no seam to fall through.
  const terrain = createRigidBody2D('static', 0, 0);
  for (let index = 0; index + 1 < ground.heights.length; index += 1) {
    const x0 = ground.minX + ground.step * index;
    const x1 = x0 + ground.step;
    const y0 = ground.heights[index] ?? PASTURE_TOP_Y;
    const y1 = ground.heights[index + 1] ?? PASTURE_TOP_Y;
    const floor = Math.min(y0, y1) - GROUND_SKIRT;
    terrain.colliders.push(
      createPhysics2DCollider(
        // Counter-clockwise from the bottom-left, which is the winding the polygon collider
        // expects; reversed, every contact normal points into the ground.
        { kind: 'polygon', points: [x0, floor, x1, floor, x1, y1, x0, y0] },
        PASTURE_MATERIAL,
      ),
    );
  }
  addPhysics2DBody(world, terrain);
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
  setStackBodyKind(body, kind);
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
    const kind = findStackBodyKind(body);
    if (kind === undefined) continue;
    const base = STACK_DAMPING[kind];
    if (body.sleeping) {
      body.linearDamping = base.linear + ASSIST_LINEAR;
      body.angularDamping = base.angular + ASSIST_ANGULAR;
      applyAssistInertia(body, 1);
      setStackBodyAnchor(body, body.x);
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
        (getStackBodyQuiet(body)) + (still ? PHYSICS_STEP : -PHYSICS_STEP * 3),
      ),
    );
    setStackBodyQuiet(body, quiet);
    const settled = saturate((quiet - SETTLE_DELAY) / SETTLE_RAMP);
    const carried = saturate((body.y - PASTURE_TOP_Y) / STABILITY_FULL_HEIGHT) * 0.75;
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
    deleteStackBodyAnchor(body);
    return;
  }
  const anchor = getStackBodyAnchor(body);
  if (anchor === undefined) {
    setStackBodyAnchor(body, body.x);
    return;
  }
  const drift = anchor - body.x;
  if (Math.abs(drift) < COHESION_DEADZONE) return;
  body.velocityX += drift * COHESION_PULL * assist * PHYSICS_STEP;
  body.velocityX -= body.velocityX * COHESION_GRIP * assist * PHYSICS_STEP;
}

function applyAssistInertia(body: RigidBody2D, assist: number): void {
  const solved = getStackBodyInertia(body) ?? body.inertia;
  setStackBodyInertia(body, solved);
  if (solved <= 0) return;
  const stiffened = solved * (1 + assist * ASSIST_INERTIA);
  body.inertia = stiffened;
  body.inverseInertia = 1 / stiffened;
}









export function isStackBodyWithinPasture(body: Readonly<RigidBody2D>): boolean {
  return Math.abs(body.x) <= PASTURE_HALF_WIDTH + getStackBodyHalfWidth(body);
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
