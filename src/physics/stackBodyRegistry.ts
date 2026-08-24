// The per-body side tables: what kind a rigid body is, how long it has been still, the
// inertia the solver gave it, and where it settled.
//
// This file has no counterpart in the Haxe sibling, and it exists for a structural reason
// rather than a stylistic one. stackObjectProfile.ts needs a body's kind to answer questions
// about its extents, and stackPhysics.ts is what puts the kind there in the first place — so
// with only the reference's four files those two would import each other. Pulling the tables
// down into a leaf that imports nothing but the kind breaks the cycle, and it puts every
// piece of "state hanging off a body" in one place.
//
// WeakMaps rather than fields on the body: RigidBody2D is the SDK's type, and a removed body
// should take its bookkeeping with it rather than leaving entries behind for the round's
// lifetime.
import type { RigidBody2D } from '@flighthq/sdk';
import type { StackObjectKind } from './stackObjectKind';

const stackBodyKinds = new WeakMap<RigidBody2D, StackObjectKind>();
const stackBodyQuiet = new WeakMap<RigidBody2D, number>();
// The solver-computed inertia, kept so the assist always stiffens from the true value
// rather than compounding on its own previous output.
const stackBodyInertia = new WeakMap<RigidBody2D, number>();
// Where a settled piece came to rest, and what cohesion pulls it back toward.
const stackBodyAnchor = new WeakMap<RigidBody2D, number>();

/** Defaults to 'horse' for a body this never saw, which is the largest profile. */
export function getStackBodyKind(body: Readonly<RigidBody2D>): StackObjectKind {
  return stackBodyKinds.get(body as RigidBody2D) ?? 'horse';
}

/**
 * The undefaulted lookup. The solver walks every body in the world, including the pasture,
 * and uses `undefined` here to mean "not a stacked piece, skip it" — which the defaulting
 * accessor above would silently turn into a horse.
 */
export function findStackBodyKind(body: RigidBody2D): StackObjectKind | undefined {
  return stackBodyKinds.get(body);
}

export function setStackBodyKind(body: RigidBody2D, kind: StackObjectKind): void {
  stackBodyKinds.set(body, kind);
}

export function getStackBodyQuiet(body: RigidBody2D): number {
  return stackBodyQuiet.get(body) ?? 0;
}

export function setStackBodyQuiet(body: RigidBody2D, seconds: number): void {
  stackBodyQuiet.set(body, seconds);
}

export function getStackBodyInertia(body: RigidBody2D): number | undefined {
  return stackBodyInertia.get(body);
}

export function setStackBodyInertia(body: RigidBody2D, inertia: number): void {
  stackBodyInertia.set(body, inertia);
}

export function getStackBodyAnchor(body: RigidBody2D): number | undefined {
  return stackBodyAnchor.get(body);
}

export function setStackBodyAnchor(body: RigidBody2D, x: number): void {
  stackBodyAnchor.set(body, x);
}

export function deleteStackBodyAnchor(body: RigidBody2D): void {
  stackBodyAnchor.delete(body);
}
