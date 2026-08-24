// The shape of the ground the pile actually stands on.
//
// The physics floor used to be one flat box at PASTURE_TOP_Y. The modelled farm is not flat —
// along the play line the terrain runs roughly -0.045 to -0.079 in world Y, so a flat floor
// sat visibly above the grass at one end and inside it at the other, and pieces at the low
// end stood on nothing. This samples the real mesh so the collider can follow it.
//
// HOW. The pile lives on the plane world x = STACK_X, spread along world Z, so for each
// sample we want the height of the ground directly under one point on that line. A vertical
// ray against a triangle is simpler than the general case: project the triangle onto the XZ
// plane, test whether the point is inside it, and if it is, read the height back out with the
// same barycentric weights. Highest hit wins, so overlapping terrain shells resolve to the
// surface you would actually land on.
//
// Sampled once, after the farm is mounted, because it needs each mesh's WORLD matrix — the
// farm sits under a wrapper that scales it by FARM_PROP_SCENE_SCALE and moves it, and the
// glTF's own root carries an axis conversion on top of that.
import type { Mesh, Node3D, Scene3D, Vector3 } from '@flighthq/sdk';
import {
  createVector3,
  getMeshGeometryVertexCount,
  getMeshGeometryVertexPosition,
  getNodeChildren,
  getNodeWorldMatrix4,
  isMesh,
  matrix4TransformPoint,
} from '@flighthq/sdk';
import { STACK_BASE_Y, STACK_X, STACK_Z } from '../game/gameConfig';
import { PASTURE_HALF_WIDTH, PASTURE_TOP_Y } from '../physics/pasture';

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

/**
 * Samples the farm's ground along the play line. Returns null when the ground meshes cannot
 * be found, which the caller should treat as "keep the flat floor" rather than as an error —
 * a re-exported model with different materials should not stop the game running.
 */
export function sampleFarmTerrain(farm: Readonly<Scene3D>): TerrainProfile | null {
  const meshes: Mesh[] = [];
  collectGroundMeshes(farm.root, meshes);
  if (meshes.length === 0) return null;

  const minX = -PASTURE_HALF_WIDTH;
  const step = (PASTURE_HALF_WIDTH * 2) / (SAMPLE_COUNT - 1);
  // Start from the flat height so any sample the mesh does not cover keeps the old behaviour
  // rather than dropping to zero and opening a hole in the floor.
  const heights = new Array<number>(SAMPLE_COUNT).fill(PASTURE_TOP_Y);

  const a = createVector3(0, 0, 0);
  const b = createVector3(0, 0, 0);
  const c = createVector3(0, 0, 0);
  const local = createVector3(0, 0, 0);

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const indices = geometry.indices;
    if (indices === null || geometry.topology !== 'triangle-list') continue;
    const world = getNodeWorldMatrix4(mesh);
    const vertexCount = getMeshGeometryVertexCount(geometry);

    // Pre-transform every vertex once. Doing it per triangle would transform each shared
    // vertex six times over, and these meshes are the largest in the scene.
    const worldX = new Float64Array(vertexCount);
    const worldY = new Float64Array(vertexCount);
    const worldZ = new Float64Array(vertexCount);
    for (let index = 0; index < vertexCount; index += 1) {
      getMeshGeometryVertexPosition(local, geometry, index);
      matrix4TransformPoint(a, world, local);
      worldX[index] = a.x;
      worldY[index] = a.y;
      worldZ[index] = a.z;
    }

    for (let i = 0; i + 2 < indices.length; i += 3) {
      const i0 = indices[i] ?? 0;
      const i1 = indices[i + 1] ?? 0;
      const i2 = indices[i + 2] ?? 0;
      a.x = worldX[i0] ?? 0; a.y = worldY[i0] ?? 0; a.z = worldZ[i0] ?? 0;
      b.x = worldX[i1] ?? 0; b.y = worldY[i1] ?? 0; b.z = worldZ[i1] ?? 0;
      c.x = worldX[i2] ?? 0; c.y = worldY[i2] ?? 0; c.z = worldZ[i2] ?? 0;

      // Cheap reject: the play line is at a single world X, so a triangle that does not span
      // it cannot be under any sample. This is what keeps the whole scan fast.
      const triMinX = Math.min(a.x, b.x, c.x);
      const triMaxX = Math.max(a.x, b.x, c.x);
      if (STACK_X < triMinX || STACK_X > triMaxX) continue;

      const triMinZ = Math.min(a.z, b.z, c.z);
      const triMaxZ = Math.max(a.z, b.z, c.z);

      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        const physicsX = minX + step * sample;
        const pointZ = STACK_Z - physicsX;
        if (pointZ < triMinZ || pointZ > triMaxZ) continue;
        const worldHeight = heightAt(a, b, c, STACK_X, pointZ);
        if (worldHeight === null) continue;
        // heightAt answers in WORLD y; everything downstream of here is physics y, and the
        // two differ by STACK_BASE_Y (see stackObjectVisual.setTransform).
        const height = worldHeight - STACK_BASE_Y;
        const current = heights[sample] ?? PASTURE_TOP_Y;
        if (height > current) heights[sample] = height;
      }
    }
  }

  return { heights, minX, step };
}

/**
 * Height of the triangle above (x, z), or null when the point is outside it. Barycentric in
 * the XZ plane; the denominator vanishes for a triangle seen edge-on from above, which
 * carries no surface to stand on and is rejected.
 */
function heightAt(
  a: Readonly<Vector3>,
  b: Readonly<Vector3>,
  c: Readonly<Vector3>,
  x: number,
  z: number,
): number | null {
  const v0x = c.x - a.x;
  const v0z = c.z - a.z;
  const v1x = b.x - a.x;
  const v1z = b.z - a.z;
  const denominator = v0x * v1z - v1x * v0z;
  if (Math.abs(denominator) < 1e-12) return null;

  const v2x = x - a.x;
  const v2z = z - a.z;
  const u = (v2x * v1z - v1x * v2z) / denominator;
  const v = (v0x * v2z - v2x * v0z) / denominator;
  if (u < 0 || v < 0 || u + v > 1) return null;
  return a.y + (c.y - a.y) * u + (b.y - a.y) * v;
}

function collectGroundMeshes(node: Readonly<Node3D>, out: Mesh[]): void {
  if (isMesh(node) && node.materials.some((m) => m !== null && GROUND_MATERIALS.has(m.name ?? ''))) {
    out.push(node as Mesh);
  }
  for (const child of getNodeChildren(node)) collectGroundMeshes(child, out);
}
