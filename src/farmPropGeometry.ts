import type { MeshGeometry } from '@flighthq/sdk';

export type FarmPropKind = 'hay' | 'cow' | 'chickens';
export const FARM_PROP_SCENE_SCALE = 0.018;

export interface FarmPropPoint {
  x: number;
  y: number;
  z: number;
}

export type FarmPropTriangleFilter =
  | { kind: 'aabb'; max: FarmPropPoint; min: FarmPropPoint }
  | { kind: 'max-x'; value: number }
  | { centers: readonly FarmPropPoint[]; kind: 'nearest-component'; selectedIndex: number };

export interface FarmPropPartSpec {
  filter?: FarmPropTriangleFilter;
  materialName: string;
  nodeName: string;
}

export interface FarmPropSpec {
  centerX: number;
  centerY: number;
  centerZ: number;
  parts: readonly FarmPropPartSpec[];
  rotationZ?: number;
}

const HAY_BALE_CENTERS: readonly FarmPropPoint[] = [
  { x: -25.51, y: 43.645, z: 1.005 },
  { x: -20.55, y: 39.51, z: 5.975 },
  { x: -25.72, y: 35.74, z: 5.975 },
  { x: -20.86, y: 31.76, z: 1.005 },
  { x: -20.14, y: 40.44, z: 1.005 },
  { x: -26.6, y: 34.91, z: 1.005 },
] as const;
const FIRST_HAY_BALE_FILTER: FarmPropTriangleFilter = {
  centers: HAY_BALE_CENTERS,
  kind: 'nearest-component',
  selectedIndex: 0,
};
const FRONT_COW_FILTER: FarmPropTriangleFilter = { kind: 'max-x', value: -20 };
const SINGLE_CHICKEN_FILTER: FarmPropTriangleFilter = {
  kind: 'aabb',
  max: { x: -6.5, y: 16.2, z: 1.4 },
  min: { x: -8.3, y: 13.5, z: -1.2 },
};

// Sketchfab flattened the farm by material. These are the complete material
// layers for each prop; filters split one bale, cow, or chicken from meshes
// containing more than one instance.
export const FARM_PROP_SPECS: Readonly<Record<FarmPropKind, FarmPropSpec>> = {
  hay: {
    centerX: -25.6,
    centerY: 43.645,
    centerZ: 1.18,
    parts: [
      { filter: FIRST_HAY_BALE_FILTER, materialName: 'HayBale2', nodeName: 'Object_22' },
      { filter: FIRST_HAY_BALE_FILTER, materialName: 'HayBale', nodeName: 'Object_25' },
    ],
    rotationZ: Math.PI / 2,
  },
  cow: {
    centerX: -29.04,
    centerY: -51.48,
    centerZ: 4.29,
    parts: [
      { filter: FRONT_COW_FILTER, materialName: 'Cow1.001', nodeName: 'Object_30' },
      { filter: FRONT_COW_FILTER, materialName: 'Cow3', nodeName: 'Object_34' },
      { filter: FRONT_COW_FILTER, materialName: 'Cow1', nodeName: 'Object_41' },
      { filter: FRONT_COW_FILTER, materialName: 'Cow2', nodeName: 'Object_42' },
    ],
  },
  chickens: {
    centerX: -7.395,
    centerY: 14.865,
    centerZ: 0.115,
    parts: [
      { filter: SINGLE_CHICKEN_FILTER, materialName: 'Hen4', nodeName: 'Object_29' },
      { filter: SINGLE_CHICKEN_FILTER, materialName: 'Hen3', nodeName: 'Object_33' },
      { filter: SINGLE_CHICKEN_FILTER, materialName: 'Hen2', nodeName: 'Object_38' },
      { filter: SINGLE_CHICKEN_FILTER, materialName: 'Hen_2', nodeName: 'Object_40' },
    ],
  },
};

export function selectFarmPropTriangleIndices(
  source: Readonly<MeshGeometry>,
  filter: Readonly<FarmPropTriangleFilter>,
): number[] {
  if (source.topology !== 'triangle-list' || source.indices === null) return [];

  const positionAttribute = source.layout.attributes.find(
    (attribute) => attribute.semantic === 'position',
  );
  if (positionAttribute === undefined) return [];

  const stride = source.layout.stride / Float32Array.BYTES_PER_ELEMENT;
  const positionOffset = positionAttribute.byteOffset / Float32Array.BYTES_PER_ELEMENT;
  const coordinate = (vertexIndex: number, axis: number): number =>
    source.vertices[vertexIndex * stride + positionOffset + axis] ?? 0;
  if (filter.kind === 'nearest-component') {
    return selectNearestComponents(source.indices, coordinate, filter);
  }

  const selectedIndices: number[] = [];
  for (let indexOffset = 0; indexOffset + 2 < source.indices.length; indexOffset += 3) {
    const a = source.indices[indexOffset] ?? 0;
    const b = source.indices[indexOffset + 1] ?? 0;
    const c = source.indices[indexOffset + 2] ?? 0;
    const center = {
      x: (coordinate(a, 0) + coordinate(b, 0) + coordinate(c, 0)) / 3,
      y: (coordinate(a, 1) + coordinate(b, 1) + coordinate(c, 1)) / 3,
      z: (coordinate(a, 2) + coordinate(b, 2) + coordinate(c, 2)) / 3,
    };
    const matches =
      filter.kind === 'max-x'
        ? center.x < filter.value
        : center.x >= filter.min.x &&
          center.x <= filter.max.x &&
          center.y >= filter.min.y &&
          center.y <= filter.max.y &&
          center.z >= filter.min.z &&
          center.z <= filter.max.z;
    if (matches) selectedIndices.push(a, b, c);
  }
  return selectedIndices;
}

function selectNearestComponents(
  indices: Uint16Array | Uint32Array,
  coordinate: (vertexIndex: number, axis: number) => number,
  filter: Extract<FarmPropTriangleFilter, { kind: 'nearest-component' }>,
): number[] {
  const triangleCount = Math.floor(indices.length / 3);
  const parents = Int32Array.from({ length: triangleCount }, (_, index) => index);
  const findRoot = (start: number): number => {
    let root = start;
    while ((parents[root] ?? root) !== root) root = parents[root] ?? root;
    let current = start;
    while ((parents[current] ?? current) !== root) {
      const next = parents[current] ?? root;
      parents[current] = root;
      current = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = findRoot(a);
    const rootB = findRoot(b);
    if (rootA !== rootB) parents[rootB] = rootA;
  };

  // The exporter duplicates vertex records at normal seams. Weld by rounded
  // source position so faces of the same authored component reconnect.
  const triangleByPosition = new Map<string, number>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = indices[triangle * 3 + corner] ?? 0;
      const key = `${Math.round(coordinate(vertexIndex, 0) * 1_000)},${Math.round(coordinate(vertexIndex, 1) * 1_000)},${Math.round(coordinate(vertexIndex, 2) * 1_000)}`;
      const matchingTriangle = triangleByPosition.get(key);
      if (matchingTriangle === undefined) triangleByPosition.set(key, triangle);
      else union(triangle, matchingTriangle);
    }
  }

  const componentBounds = new Map<
    number,
    { max: [number, number, number]; min: [number, number, number] }
  >();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const root = findRoot(triangle);
    let bounds = componentBounds.get(root);
    if (bounds === undefined) {
      bounds = {
        max: [-Infinity, -Infinity, -Infinity],
        min: [Infinity, Infinity, Infinity],
      };
      componentBounds.set(root, bounds);
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = indices[triangle * 3 + corner] ?? 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = coordinate(vertexIndex, axis);
        bounds.min[axis] = Math.min(bounds.min[axis] ?? value, value);
        bounds.max[axis] = Math.max(bounds.max[axis] ?? value, value);
      }
    }
  }

  const selectedRoots = new Set<number>();
  for (const [root, bounds] of componentBounds) {
    const center = {
      x: (bounds.min[0] + bounds.max[0]) * 0.5,
      y: (bounds.min[1] + bounds.max[1]) * 0.5,
      z: (bounds.min[2] + bounds.max[2]) * 0.5,
    };
    if (findNearestCenter(center, filter.centers) === filter.selectedIndex) {
      selectedRoots.add(root);
    }
  }

  const selectedIndices: number[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (!selectedRoots.has(findRoot(triangle))) continue;
    const offset = triangle * 3;
    selectedIndices.push(indices[offset] ?? 0, indices[offset + 1] ?? 0, indices[offset + 2] ?? 0);
  }
  return selectedIndices;
}

function findNearestCenter(
  center: Readonly<FarmPropPoint>,
  candidates: readonly FarmPropPoint[],
): number {
  let nearestIndex = 0;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const dx = center.x - candidate.x;
    const dy = center.y - candidate.y;
    const dz = center.z - candidate.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}
