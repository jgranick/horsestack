// What can be stacked, how often each kind turns up, and how fast they arrive.
// src/physics/StackObjectKind.hx in the Haxe sibling.
//
// Deliberately the leaf of the physics folder: it imports nothing, so every other module
// here (and half of scene/) can name a kind without pulling in a physics world.
export type StackObjectKind = 'horse' | 'hay' | 'cow' | 'chickens';
export const STACK_OBJECT_KINDS = ['horse', 'hay', 'cow', 'chickens'] as const;
export const STACK_OBJECT_WEIGHTS: Readonly<Record<StackObjectKind, number>> = {
  horse: 0.3,
  hay: 0.5,
  cow: 0.05,
  chickens: 0.15,
};
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
