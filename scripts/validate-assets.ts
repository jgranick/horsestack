import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportDiagnostic, Mesh, Node3D } from '@flighthq/sdk';
import { getNodeChildren } from '@flighthq/sdk/core';
import { createScene3DFromGltf } from '@flighthq/sdk/formats';
import { MeshKind } from '@flighthq/sdk/scene3d';
import {
  FARM_PROP_SCENE_SCALE,
  FARM_PROP_VARIANTS,
  getRandomFarmPropVariantIndex,
  selectFarmPropTriangleIndices,
} from '../src/farmPropGeometry';
import { STACK_OBJECT_PROFILES } from '../src/horseStackPhysics';

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
  if (model.name === 'farm') {
    validateFarmProps(nodesByName);
    validateWindmillSails(nodesByName);
  }

  console.log(
    `${model.name}: ${meshCount} meshes, ${nodeCount} nodes, ${Math.round(vertexCount).toLocaleString('en-US')} vertices`,
  );
}

function validateFarmProps(nodesByName: ReadonlyMap<string, Node3D>): void {
  if (FARM_PROP_VARIANTS.chickens.length < 2) {
    throw new Error('farm chickens: expected multiple source-authored variants');
  }
  if (
    getRandomFarmPropVariantIndex('chickens', () => 0) !== 0 ||
    getRandomFarmPropVariantIndex('chickens', () => 0.75) !== 1
  ) {
    throw new Error('farm chickens: random variant selection did not cover both hens');
  }

  for (const kind of ['hay', 'cow', 'chickens'] as const) {
    for (const spec of FARM_PROP_VARIANTS[kind]) {
      const bounds = {
        max: [-Infinity, -Infinity, -Infinity],
        min: [Infinity, Infinity, Infinity],
        points: [] as number[],
      };
      let triangleCount = 0;
      const materials: string[] = [];
      bounds.points.length = 0;

      for (const part of spec.parts) {
        const node = nodesByName.get(part.nodeName);
        if (node === undefined || node.kind !== MeshKind) {
          throw new Error(`farm prop ${spec.label} is missing mesh ${part.nodeName}`);
        }
        const mesh = node as Mesh;
        const materialName = mesh.materials[0]?.name;
        if (materialName !== part.materialName) {
          throw new Error(
            `farm prop ${spec.label} mesh ${part.nodeName} uses ${materialName ?? 'no material'}, expected ${part.materialName}`,
          );
        }
        materials.push(materialName);

        const indices = part.filter
          ? selectFarmPropTriangleIndices(mesh.geometry, part.filter)
          : Array.from(mesh.geometry.indices ?? []);
        if (indices.length === 0 || indices.length % 3 !== 0) {
          throw new Error(`farm prop ${spec.label} mesh ${part.nodeName} has no selected triangles`);
        }
        triangleCount += indices.length / 3;
        includeGeometryBounds(bounds, mesh, indices);
      }

      if (triangleCount !== spec.expectedTriangleCount) {
        throw new Error(
          `farm prop ${spec.label} selected ${triangleCount} triangles, expected ${spec.expectedTriangleCount}`,
        );
      }

      const extents = bounds.max.map((maximum, axis) => maximum - (bounds.min[axis] ?? maximum));
      for (let axis = 0; axis < 3; axis += 1) {
        const expected = spec.expectedSourceExtents[axis] ?? 0;
        const error = Math.abs((extents[axis] ?? 0) - expected);
        if (error > 0.25) {
          throw new Error(
            `farm prop ${spec.label} extent ${axis} is ${(extents[axis] ?? 0).toFixed(2)}, expected about ${expected.toFixed(2)}`,
          );
        }
      }

      const scale = FARM_PROP_SCENE_SCALE * (spec.scaleMultiplier ?? 1);
      // rotationZ spins the prop in source X/Y, so the projected HEIGHT has to be measured
      // on the rotated points. This used to pick extent X or Y depending on whether the
      // rotation was past a quarter turn, which is only right for exact quarter turns —
      // the cow's -22 degrees would have been scored against its unrotated height and let
      // a body through that was 5% shorter than the mesh it stands for. Width is along
      // source Z, which a rotation about Z leaves alone.
      const projectedWidth = (extents[2] ?? 0) * scale;
      const projectedHeight = measureRotatedHeight(bounds.points, spec.rotationZ ?? 0) * scale;
      const profile = STACK_OBJECT_PROFILES[kind];
      if (
        Math.abs(projectedWidth - profile.halfWidth * 2) > 0.003 ||
        Math.abs(projectedHeight - profile.halfHeight * 2) > 0.003
      ) {
        throw new Error(
          `farm prop ${spec.label} projects to ${projectedWidth.toFixed(3)} x ${projectedHeight.toFixed(3)}, but its 2D body is ${(profile.halfWidth * 2).toFixed(3)} x ${(profile.halfHeight * 2).toFixed(3)}`,
        );
      }

      console.log(
        `farm ${spec.label}: ${triangleCount.toLocaleString('en-US')} triangles, materials ${materials.join(', ')}, source extents ${extents.map((extent) => extent.toFixed(2)).join(' × ')}, projected/body ${projectedWidth.toFixed(3)} × ${projectedHeight.toFixed(3)}`,
      );
    }
  }
}

// main.ts spins Object_6 about mesh-space X through the midpoint of its Y/Z bounds.
// That is only the hub if the sails really are a disc facing along X, so assert the
// shape the spin depends on rather than trusting the node name alone.
function validateWindmillSails(nodesByName: ReadonlyMap<string, Node3D>): void {
  const node = nodesByName.get('Object_6');
  if (node === undefined || node.kind !== MeshKind) {
    throw new Error('windmill sails: mesh Object_6 is missing');
  }
  const mesh = node as Mesh;
  const materialName = mesh.materials[0]?.name;
  if (materialName !== 'Windmill2') {
    throw new Error(
      `windmill sails: Object_6 uses ${materialName ?? 'no material'}, expected Windmill2`,
    );
  }
  const bounds = { max: [-Infinity, -Infinity, -Infinity], min: [Infinity, Infinity, Infinity] };
  includeGeometryBounds(bounds, mesh, Array.from(mesh.geometry.indices ?? []));
  const extents = bounds.max.map((maximum, axis) => maximum - (bounds.min[axis] ?? maximum));
  const [shaft, discY, discZ] = [extents[0] ?? 0, extents[1] ?? 0, extents[2] ?? 0];
  if (Math.abs(discY - discZ) > discY * 0.05) {
    throw new Error(
      `windmill sails: Y/Z extents ${discY.toFixed(2)} x ${discZ.toFixed(2)} are not a disc, so mesh-space X is not the spin axis`,
    );
  }
  if (shaft >= discY) {
    throw new Error(
      `windmill sails: shaft extent ${shaft.toFixed(2)} is not shorter than the disc ${discY.toFixed(2)}`,
    );
  }
  console.log(
    `farm windmill sails: disc ${discY.toFixed(2)} x ${discZ.toFixed(2)} about mesh-space X (shaft ${shaft.toFixed(2)}), hub at Y ${(((bounds.min[1] ?? 0) + (bounds.max[1] ?? 0)) / 2).toFixed(2)}, Z ${(((bounds.min[2] ?? 0) + (bounds.max[2] ?? 0)) / 2).toFixed(2)}`,
  );
}

// Height of the X/Y point cloud after spinning it by `rotationZ`, which is what the prop's
// orientation root does before the prop is scaled into the scene.
function measureRotatedHeight(points: readonly number[], rotationZ: number): number {
  const cos = Math.cos(rotationZ);
  const sin = Math.sin(rotationZ);
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < points.length; index += 2) {
    const y = (points[index] ?? 0) * sin + (points[index + 1] ?? 0) * cos;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return max - min;
}

function includeGeometryBounds(
  bounds: { max: number[]; min: number[]; points?: number[] },
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
    if (bounds.points !== undefined) {
      bounds.points.push(
        mesh.geometry.vertices[vertexIndex * stride + positionOffset] ?? 0,
        mesh.geometry.vertices[vertexIndex * stride + positionOffset + 1] ?? 0,
      );
    }
  }
}

function walk(root: Node3D, visit: (node: Node3D) => void): void {
  visit(root);
  for (const child of getNodeChildren(root)) walk(child, visit);
}
