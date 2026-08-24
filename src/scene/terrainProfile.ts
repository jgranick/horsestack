// The shape of the ground the pile actually stands on.
//
// The physics floor used to be one flat box at PASTURE_TOP_Y. The modelled farm is not flat —
// along the play line the terrain runs roughly -0.147 to -0.072 in world Y, so a flat floor
// sat visibly above the grass at one end and inside it at the other, and pieces at the low
// end stood on nothing. This samples the real mesh so the collider can follow it.
//
// HOW. The pile lives on the plane world x = STACK_X, spread along world Z, so for each
// sample we want the height of the ground directly under one point on that line. That is a
// ray cast straight down, which is exactly what pickScene3DWithRay3D does: it walks the
// subtree, transforms the ray into each mesh's local space, and returns the NEAREST hit —
// and a ray coming down from above meets the highest surface first, so overlapping terrain
// shells resolve to the one you would actually land on with no extra work.
//
// This used to be a hand-rolled loop over every triangle with its own barycentric test. The
// SDK already had the primitive; see the note in sampleFarmTerrain about the two filters,
// which are the only part that is actually specific to this game.
//
// Sampled once, after the farm is mounted, because picking reads each mesh's WORLD matrix —
// the farm sits under a wrapper that scales it by FARM_PROP_SCENE_SCALE and moves it, and the
// glTF's own root carries an axis conversion on top of that.
import type { Mesh, Scene3D } from '@flighthq/sdk';
import { createRay3D, createScene3DHit, pickScene3DWithRay3D, setRay3D } from '@flighthq/sdk';
import { createVector3 } from '@flighthq/sdk';
import { STACK_BASE_Y, STACK_X, STACK_Z } from '../game/gameConfig';
import { PASTURE_MIN_X, PASTURE_WIDTH } from '../physics/pasture';

/** Ground heights in PHYSICS coordinates, evenly spaced across the pasture. */
export interface TerrainProfile {
  /** Physics x of the first sample. */
  minX: number;
  /** Physics x between samples. */
  step: number;
  /** Physics y of the surface at each sample. */
  heights: number[];
}

// The two meshes that make up the modelled ground, by the material they carry. Matching on
// material rather than node name because the node names are the exporter's opaque Object_NN
// and would not survive a re-export; the material names are authored.
const GROUND_MATERIALS = new Set(['Ground', 'Ground2']);

// How many points across the pasture. Each becomes one sloped quad in the collider, so this
// trades fidelity against collider count; the terrain is gently undulating rather than
// jagged, so a step of roughly 4cm of world is already finer than anything it has to follow.
const SAMPLE_COUNT = 80;

// Where the downward ray starts, in world Y. Comfortably above the highest ground and below
// nothing that matters: the ray only ever tests the ground meshes, so the barn roof and the
// windmill sails cannot get in front of it whatever height this is.
const RAY_START_Y = 4;

// Only surfaces you could stand on. The Ground meshes include the floating island's sloping
// sides and its underside, and a downward ray near the pasture edge meets those just as
// readily as it meets the grass — without this the floor dived to the side of the island at
// the ends, an 80mm drop where the top surface ran out. 0.5 is a 60 degree slope, far
// steeper than the grass rolls and far shallower than the island's flank.
const MIN_WALKABLE_NORMAL_Y = 0.5;

function isGroundMesh(mesh: Readonly<Mesh>): boolean {
  return mesh.materials.some((material) => material !== null && GROUND_MATERIALS.has(material.name ?? ''));
}

/**
 * Samples the farm's ground along the play line. Returns null when the ground meshes cannot
 * be found, which the caller should treat as "keep the flat floor" rather than as an error —
 * a re-exported model with different materials should not stop the game running.
 */
export function sampleFarmTerrain(farm: Readonly<Scene3D>): TerrainProfile | null {
  const minX = PASTURE_MIN_X;
  const step = PASTURE_WIDTH / (SAMPLE_COUNT - 1);
  // NaN means "no ground found over this sample". Filled in from the neighbours at the end
  // rather than defaulting to the flat height: an uncovered sample sitting at PASTURE_TOP_Y
  // next to a covered one 26mm higher is a step in the floor, and a step is exactly the
  // thing a rolling hay bale catches on.
  const heights = new Array<number>(SAMPLE_COUNT).fill(Number.NaN);

  const ray = createRay3D();
  const hit = createScene3DHit();
  const origin = createVector3(STACK_X, RAY_START_Y, 0);
  const down = createVector3(0, -1, 0);
  // Backfaces stay in: the island's underside is culled by the normal test below, and
  // relying on winding instead would make the filter depend on how the model was exported.
  const options = { cullBackfaces: false, predicate: isGroundMesh } as const;

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const physicsX = minX + step * sample;
    origin.z = STACK_Z - physicsX;
    setRay3D(ray, origin, down);
    if (pickScene3DWithRay3D(farm.root, ray, hit, options) === null) continue;
    const normalLength = Math.hypot(hit.normalX, hit.normalY, hit.normalZ);
    if (normalLength < 1e-12 || Math.abs(hit.normalY) / normalLength < MIN_WALKABLE_NORMAL_Y) {
      continue;
    }
    // The hit is in WORLD y; everything downstream of here is physics y, and the two differ
    // by STACK_BASE_Y (see stackObjectVisual.setTransform).
    heights[sample] = hit.pointY - STACK_BASE_Y;
  }

  return fillGaps(heights) ? { heights, minX, step } : null;
}

/**
 * Replaces uncovered samples with the nearest covered one, so the surface runs flat out to
 * the edges instead of falling off a cliff where the modelled ground stops. Returns false if
 * nothing was covered at all, which means we did not find the ground and the caller should
 * keep its flat floor.
 */
function fillGaps(heights: number[]): boolean {
  const firstCovered = heights.findIndex((height) => !Number.isNaN(height));
  if (firstCovered === -1) return false;

  for (let index = firstCovered - 1; index >= 0; index -= 1) {
    heights[index] = heights[index + 1] ?? Number.NaN;
  }
  for (let index = firstCovered + 1; index < heights.length; index += 1) {
    if (Number.isNaN(heights[index] ?? Number.NaN)) {
      heights[index] = heights[index - 1] ?? Number.NaN;
    }
  }
  return true;
}
