import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportDiagnostic, Mesh, Node3D } from '@flighthq/sdk';
import { getNodeChildren } from '@flighthq/sdk/core';
import { createScene3DFromGltf } from '@flighthq/sdk/formats';
import { MeshKind } from '@flighthq/sdk/scene3d';

const models = [
  { name: 'farm', expectedMeshes: 41 },
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

  walk(scene.root, (node) => {
    nodeCount += 1;
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

  console.log(
    `${model.name}: ${meshCount} meshes, ${nodeCount} nodes, ${Math.round(vertexCount).toLocaleString('en-US')} vertices`,
  );
}

function walk(root: Node3D, visit: (node: Node3D) => void): void {
  visit(root);
  for (const child of getNodeChildren(root)) walk(child, visit);
}
