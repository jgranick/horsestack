import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportDiagnostic, Mesh, Node3D } from '@flighthq/sdk';
import { getNodeChildren } from '@flighthq/sdk/core';
import { createScene3DFromGltf } from '@flighthq/sdk/formats';
import { MeshKind } from '@flighthq/sdk/scene3d';
import {
  FARM_PROP_SPECS,
  selectFarmPropTriangleIndices,
} from '../src/farmPropGeometry';
import type { FarmPropKind } from '../src/farmPropGeometry';

const models = [
  {
    name: 'farm',
    expectedMeshes: 41,
  },
  { name: 'horse', expectedMeshes: 5 },
] as const;

for (const model of models) {
  const basePath = join(process.cwd(), 'public', 'models', model.name);
  const diagnostics: ImportDiagnostic[] = [];
  const scene = createScene3DFromGltf(
    readFileSync(join(basePath, 'scene.gltf'), 'utf8'),
    diagnostics,
    {
      basePath: `/models/${model.name}/`,
      externalBuffers: {
        'scene.bin': new Uint8Array(readFileSync(join(basePath, 'scene.bin'))),
      },
    },
  );

  let meshCount = 0;
  let nodeCount = 0;
  let vertexCount = 0;
  const nodesByName = new Map<string, Node3D>();

  walk(scene.root, (node) => {
    nodeCount += 1;
    if (node.name !== null) nodesByName.set(node.name, node);
    if (node.kind !== MeshKind) return;
    const mesh = node as Mesh;
    meshCount += 1;
    vertexCount += mesh.geometry.vertices.length / (mesh.geometry.layout.stride / 4);
  });

  if (diagnostics.length > 0) {
    throw new Error(`${model.name} generated ${diagnostics.length} import diagnostic(s)`);
  }
  if (meshCount !== model.expectedMeshes || vertexCount === 0) {
    throw new Error(
      `${model.name} imported ${meshCount} meshes and ${vertexCount} vertices; expected ${model.expectedMeshes} non-empty meshes`,
    );
  }
  if (model.name === 'farm') validateFarmProps(nodesByName);

  console.log(
    `${model.name}: ${meshCount} meshes, ${nodeCount} nodes, ${Math.round(vertexCount).toLocaleString('en-US')} vertices`,
  );
}

function validateFarmProps(nodesByName: ReadonlyMap<string, Node3D>): void {
  const expectedExtents: Readonly<Record<FarmPropKind, readonly [number, number, number]>> = {
    hay: [5.2, 8.7, 5.6],
    cow: [8.8, 10.8, 8.3],
    chickens: [11.3, 12.7, 3.4],
  };

  for (const kind of ['hay', 'cow', 'chickens'] as const) {
    const spec = FARM_PROP_SPECS[kind];
    const bounds = {
      max: [-Infinity, -Infinity, -Infinity],
      min: [Infinity, Infinity, Infinity],
    };
    let triangleCount = 0;
    const materials: string[] = [];

    for (const part of spec.parts) {
      const node = nodesByName.get(part.nodeName);
      if (node === undefined || node.kind !== MeshKind) {
        throw new Error(`farm prop ${kind} is missing mesh ${part.nodeName}`);
      }
      const mesh = node as Mesh;
      const materialName = mesh.materials[0]?.name;
      if (materialName !== part.materialName) {
        throw new Error(
          `farm prop ${kind} mesh ${part.nodeName} uses ${materialName ?? 'no material'}, expected ${part.materialName}`,
        );
      }
      materials.push(materialName);

      const indices = part.filter
        ? selectFarmPropTriangleIndices(mesh.geometry, part.filter)
        : Array.from(mesh.geometry.indices ?? []);
      if (indices.length === 0 || indices.length % 3 !== 0) {
        throw new Error(`farm prop ${kind} mesh ${part.nodeName} has no selected triangles`);
      }
      triangleCount += indices.length / 3;
      includeGeometryBounds(bounds, mesh, indices);
    }

    const extents = bounds.max.map((maximum, axis) => maximum - (bounds.min[axis] ?? maximum));
    const expected = expectedExtents[kind];
    for (let axis = 0; axis < 3; axis += 1) {
      const error = Math.abs((extents[axis] ?? 0) - (expected[axis] ?? 0));
      if (error > 0.25) {
        throw new Error(
          `farm prop ${kind} extent ${axis} is ${(extents[axis] ?? 0).toFixed(2)}, expected about ${(expected[axis] ?? 0).toFixed(2)}`,
        );
      }
    }

    console.log(
      `farm ${kind}: ${triangleCount.toLocaleString('en-US')} triangles, materials ${materials.join(', ')}, source extents ${extents.map((extent) => extent.toFixed(2)).join(' × ')}`,
    );
  }
}

function includeGeometryBounds(
  bounds: { max: number[]; min: number[] },
  mesh: Readonly<Mesh>,
  indices: readonly number[],
): void {
  const positionAttribute = mesh.geometry.layout.attributes.find(
    (attribute) => attribute.semantic === 'position',
  );
  if (positionAttribute === undefined) throw new Error(`${mesh.name ?? 'mesh'} has no positions`);
  const stride = mesh.geometry.layout.stride / Float32Array.BYTES_PER_ELEMENT;
  const positionOffset = positionAttribute.byteOffset / Float32Array.BYTES_PER_ELEMENT;

  for (const vertexIndex of indices) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.geometry.vertices[vertexIndex * stride + positionOffset + axis];
      if (value === undefined) throw new Error(`${mesh.name ?? 'mesh'} has an invalid vertex index`);
      bounds.min[axis] = Math.min(bounds.min[axis] ?? value, value);
      bounds.max[axis] = Math.max(bounds.max[axis] ?? value, value);
    }
  }
}

function walk(root: Node3D, visit: (node: Node3D) => void): void {
  visit(root);
  for (const child of getNodeChildren(root)) walk(child, visit);
}
