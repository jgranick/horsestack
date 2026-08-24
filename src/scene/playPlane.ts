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
// physics coordinates back.
import type { Camera3D, Vector3 } from '@flighthq/sdk';
import { createVector3, getCamera3DScreenToWorldRay } from '@flighthq/sdk';
import { STACK_BASE_Y, STACK_X, STACK_Z } from '../game/gameConfig';

export interface PlayPlanePoint {
  x: number;
  y: number;
}

// Reused across calls; this runs on every pointer move.
const ray = { direction: createVector3(0, 0, 0) as Vector3, origin: createVector3(0, 0, 0) as Vector3 };

/**
 * Writes the physics-plane coordinates under a normalized device point into `out`.
 *
 * `ndcX` and `ndcY` are -1..1 with +Y up, the convention getCamera3DScreenToWorldRay and
 * getCamera3DWorldToScreen both use. Returns false when the camera cannot produce a ray, or
 * when that ray runs parallel to the play plane and never meets it — neither happens in this
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

  // The plane is x = STACK_X, so the ray parameter falls straight out of the X component.
  // A near-zero denominator means the ray is running along the plane rather than into it.
  const denominator = ray.direction.x;
  if (Math.abs(denominator) < 1e-6) return false;
  const t = (STACK_X - ray.origin.x) / denominator;
  if (!Number.isFinite(t)) return false;

  out.x = STACK_Z - (ray.origin.z + ray.direction.z * t);
  out.y = ray.origin.y + ray.direction.y * t - STACK_BASE_Y;
  return true;
}
