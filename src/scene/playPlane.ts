// Turning a point on screen into a point in the physics plane.
//
// THE BUG THIS EXISTS TO FIX. Aiming used to map the pointer's fraction across the viewer
// (0..1) straight onto the play area (-limit..+limit). That is a linear map onto what is
// actually a PROJECTIVE one: the play line runs across the world under a perspective camera,
// so equal steps in world space are not equal steps on screen. Near the middle the error is
// invisible; toward the edges the piece drifts away from the cursor, and the further the
// camera pulls back for a tall tower the worse it gets. It felt like the aim was lagging.
//
// So the pointer is unprojected properly instead: a ray through the cursor, intersected with
// the plane the pieces actually live in. Exact everywhere, at any zoom, and it falls out of
// the same call whether the caller wants one axis or both.
//
// THE PLANE. Every piece sits at world x = STACK_X and spreads along world Z, which is what
// stackObjectVisual.setTransform encodes:
//     world = (STACK_X, STACK_BASE_Y + physicsY, STACK_Z - physicsX)
// so the plane is the constant-X plane through the pile, and inverting that mapping gives the
// physics coordinates back. In the ax + by + cz + d = 0 form the SDK's plane primitives take,
// that is normal (1, 0, 0) with d = -STACK_X.
import { createPlane, createRay3D, getCamera3DScreenToWorldRay, getRay3DPointAt, createVector3, intersectRay3DPlane } from '@flighthq/sdk';
import type { Camera3D } from '@flighthq/sdk';
import { STACK_BASE_Y, STACK_X, STACK_Z } from '../game/gameConfig';

export interface PlayPlanePoint {
  x: number;
  y: number;
}

// Reused across calls; this runs on every pointer move.
const ray = createRay3D();
const point = createVector3(0, 0, 0);
const playPlane = createPlane(1, 0, 0, -STACK_X);

/**
 * Writes the physics-plane coordinates under a normalized device point into `out`.
 *
 * `ndcX` and `ndcY` are -1..1 with +Y up, the convention getCamera3DScreenToWorldRay and
 * getCamera3DWorldToScreen both use. Returns false when the camera cannot produce a ray, or
 * when that ray never meets the play plane ahead of the camera — neither happens in this
 * game's framing, but a caller that ignored it would silently aim at stale coordinates.
 */
export function unprojectToPlayPlane(
  out: PlayPlanePoint,
  camera: Readonly<Camera3D>,
  ndcX: number,
  ndcY: number,
  aspect: number,
): boolean {
  if (!getCamera3DScreenToWorldRay(ray, camera, ndcX, ndcY, aspect)) return false;

  // -1 is the miss: the ray runs along the plane, or meets it behind the camera.
  const t = intersectRay3DPlane(ray, playPlane);
  if (t < 0) return false;

  getRay3DPointAt(point, ray, t);
  out.x = STACK_Z - point.z;
  out.y = point.y - STACK_BASE_Y;
  return true;
}
