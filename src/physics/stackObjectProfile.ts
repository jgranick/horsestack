// How big each kind is, and everything derived from that: the collider half-extents, the
// support surface a piece can be set down on, the extents once a piece is rotated, and the
// world-units-to-metres calibration the score is reported in.
// src/physics/StackObjectProfile.hx in the Haxe sibling.
//
// The calibration is the part worth reading twice. This world is not metres, and the
// conversion is pinned to a horse's WITHERS height rather than its full silhouette; the
// comments below record what the numbers looked like when it was pinned to the silhouette.
import type { RigidBody2D } from '@flighthq/sdk';
import { PASTURE_TOP_Y } from './pasture';
import { getStackBodyKind } from './stackBodyRegistry';
import type { StackObjectKind } from './stackObjectKind';

export interface StackObjectProfile {
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
export const STACK_OBJECT_PROFILES: Readonly<Record<StackObjectKind, StackObjectProfile>> = {
  horse: {
    halfHeight: HORSE_HALF_HEIGHT,
    halfWidth: HORSE_HALF_WIDTH,
    label: 'Horse',
    supportHalfHeight: HORSE_SUPPORT_HALF_HEIGHT,
  },
  hay: {
    halfHeight: 0.046,
    halfWidth: 0.0505,
    label: 'Hay bale',
    supportHalfHeight: 0.046,
  },
  cow: {
    // Measured from the RIGHTED silhouette: standing the cow up straight makes it taller
    // than the leaning one it replaced, so the scale came down to keep it a shade under
    // the horse. validate:assets checks these against the mesh.
    halfHeight: 0.0886,
    halfWidth: 0.0591,
    label: 'Cow',
    supportHalfHeight: 0.0886,
  },
  chickens: {
    // Circular on purpose — validate:game enforces it, so the two hens share one round
    // body sized between their projected width and height.
    halfHeight: 0.0309,
    halfWidth: 0.0309,
    label: 'Chicken',
    supportHalfHeight: 0.0309,
  },
};
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
export function getStackHeightMeters(stackTopY: number): number {
  if (stackTopY <= 0) return 0;
  const heightAbovePasture = Math.max(0, stackTopY - PASTURE_TOP_Y);
  return heightAbovePasture * METERS_PER_WORLD_UNIT;
}
export function getStackHeightHands(stackTopY: number): number {
  return Math.round(getStackHeightMeters(stackTopY) / METERS_PER_HAND);
}
