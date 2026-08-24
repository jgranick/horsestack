// The collider outlines: how each kind's silhouette becomes convex polygons the 2D solver
// can use, and the area-centroid maths that re-centres them on their own middle.
// src/physics/ColliderGeometry.hx in the Haxe sibling.
//
// Pure geometry — no world, no bodies, no state. It is the one part of the physics folder
// that could be checked with a pencil, which is why it reads better away from the solver.
import type { StackObjectKind } from './stackObjectKind';
import {
  HORSE_HALF_HEIGHT,
  HORSE_HALF_WIDTH,
  HORSE_SUPPORT_HALF_HEIGHT,
  STACK_OBJECT_PROFILES,
} from './stackObjectProfile';

// Flight solves each body's centre of mass from its colliders, so shapes authored
// off-centre leave centerX/centerY non-zero. Offset centres of mass settle measurably
// worse in a free-standing pile: A/B over 24 seeded 30-object piles, otherwise identical,
// cut the worst stack-top jump from 0.080 to 0.044 and creep from 0.0037 to 0.0028
// units/body/s. For a compound the whole GROUP has to be centred, area-weighted, not each
// shape on its own — density is uniform, so area weighting is mass weighting. Translating
// changes no extent, so the silhouette stays put.
export function getCentredColliderPolygons(kind: Exclude<StackObjectKind, 'chickens'>): number[][] {
  const polygons = getRawColliderPolygons(kind);
  const [centroidX, centroidY] = getColliderCentroid(polygons);
  return polygons.map((points) =>
    points.map((value, index) => value - (index % 2 === 0 ? centroidX : centroidY)),
  );
}

function getRawColliderPolygons(kind: Exclude<StackObjectKind, 'chickens'>): number[][] {
  return kind === 'horse' ? getHorseColliderPolygons() : [getPolygonColliderPoints(kind)];
}

function getColliderCentroid(polygons: readonly (readonly number[])[]): [number, number] {
  let totalArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (const points of polygons) {
    const [area, x, y] = getPolygonAreaCentroid(points);
    totalArea += area;
    centroidX += area * x;
    centroidY += area * y;
  }
  if (totalArea === 0) return [0, 0];
  return [centroidX / totalArea, centroidY / totalArea];
}

/**
 * How far the centring above moved the collider up, which the VISUAL has to move with it.
 *
 * This is the horse's sunk feet. The silhouette is authored around the model's own middle,
 * then re-centred on its AREA centroid so the body's mass sits where its shape does — and
 * for a horse those are 15mm apart, because the head and neck stand well above the barrel
 * and pull the centroid up. The collider moved and the model did not, so the horse rested on
 * a floor 15mm above its hooves and its feet disappeared into the grass. The cow is the same
 * story at 3mm.
 *
 * Returned from the same numbers the centring uses rather than written down as a constant,
 * so re-authoring a silhouette cannot put the two back out of step.
 */
export function getColliderCentroidOffsetY(kind: Exclude<StackObjectKind, 'chickens'>): number {
  // Negated because the centring SUBTRACTS the centroid: a silhouette whose centroid sits
  // below its middle is moved up, and this reports that displacement, not the centroid.
  return -getColliderCentroid(getRawColliderPolygons(kind))[1];
}
export function getPolygonAreaCentroid(points: readonly number[]): [number, number, number] {
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
export function getHorseColliderPolygons(): number[][] {
  const w = HORSE_HALF_WIDTH;
  const h = HORSE_HALF_HEIGHT;
  const backY = HORSE_SUPPORT_HALF_HEIGHT;
  return [
    getBoxPoints(-0.667 * w, -h, 0.926 * w, backY),
    getBoxPoints(-0.944 * w, backY, -0.278 * w, h),
  ];
}
export function getBoxPoints(minX: number, minY: number, maxX: number, maxY: number): number[] {
  return [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
}
export function getPolygonColliderPoints(kind: Exclude<StackObjectKind, 'chickens'>): number[] {
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
