// Getting the two glTF models off the network and turning the farm into things the game can
// stack. src/scene/ModelLoader.hx in the Haxe sibling.
//
// The interesting half is extractFarmPropTemplates. The hay bales, cows and hens are not
// separate assets — they are meshes inside the single farm scene, so each stackable prop is
// carved out of it: the named source mesh is cloned, optionally filtered down to a subset of
// its triangles, re-centred on its own middle, then wrapped in the four nested nodes that
// undo the farm's own axis convention and scale. That is a self-contained asset-authoring
// step with nothing to do with playing the game, which is why it reads better on its own.
//
// Every mismatch here throws rather than degrading. A prop that silently fails to resolve
// gives an invisible piece that still has physics, and that is much harder to diagnose from
// the symptom than a load-time error naming the mesh.
import {
  addNodeChild,
  cloneMesh,
  cloneMeshGeometry,
  compactMeshGeometryVertices,
  createNode3D,
  findNodeByName,
  getNodeLocalMatrix4,
  invalidateNodeLocalTransform,
  isMesh,
  isNodeLocalMatrix4Detached,
  Node3DKind,
  refreshMeshGeometryBounds,
  setMeshGeometrySubsets,
  setNodeLocalMatrix4,
  setNodeTransform3D,
  setQuaternionFromEuler,
} from '@flighthq/sdk';
import type {
  ImportDiagnostic,
  Mesh,
  MeshGeometry,
  Node3D,
  Scene3D,
} from '@flighthq/sdk';
import { createScene3DFromGltf } from '@flighthq/sdk/formats';
import {
  FARM_PROP_SCENE_SCALE,
  FARM_PROP_VARIANTS,
  selectFarmPropTriangleIndices,
} from '../data/farmPropGeometry';
import type { FarmPropPartSpec, FarmPropTriangleFilter } from '../data/farmPropGeometry';
import type { StackObjectKind } from '../physics/stackObjectKind';

/** One entry per variant of each non-horse kind, ready to be cloned per placed piece. */
export type FarmPropTemplates = Partial<Record<StackObjectKind, Node3D[]>>;

export async function loadGltfScene(basePath: string): Promise<Scene3D> {
  const [documentResponse, bufferResponse] = await Promise.all([
    fetch(`${basePath}/scene.gltf`),
    fetch(`${basePath}/scene.bin`),
  ]);

  if (!documentResponse.ok || !bufferResponse.ok) {
    throw new Error(`Model download failed for ${basePath}`);
  }

  const diagnostics: ImportDiagnostic[] = [];
  const document = await documentResponse.text();
  const buffer = new Uint8Array(await bufferResponse.arrayBuffer());
  const imported = createScene3DFromGltf(document, diagnostics, {
    basePath: `${basePath}/`,
    externalBuffers: { 'scene.bin': buffer },
  });

  if (diagnostics.length > 0) {
    console.info(`Flight imported ${basePath} with diagnostics:`, diagnostics);
  }
  return imported;
}

export function mountFarm(model: Scene3D, sceneRoot: Node3D): void {
  const wrapper = createNode3D(Node3DKind);
  const scale = FARM_PROP_SCENE_SCALE;
  wrapper.scale.x = scale;
  wrapper.scale.y = scale;
  wrapper.scale.z = scale;
  wrapper.position.x = 0.5;
  wrapper.position.y = -0.043;
  wrapper.position.z = -2.2;
  invalidateNodeLocalTransform(wrapper);
  addNodeChild(wrapper, model.root);
  addNodeChild(sceneRoot, wrapper);
}

export function extractFarmPropTemplates(farm: Readonly<Scene3D>): FarmPropTemplates {
  const result: FarmPropTemplates = {};
  for (const kind of ['hay', 'cow', 'chickens'] as const) {
    const templates: Node3D[] = [];
    for (let variantIndex = 0; variantIndex < FARM_PROP_VARIANTS[kind].length; variantIndex += 1) {
      const spec = FARM_PROP_VARIANTS[kind][variantIndex];
      if (spec === undefined) continue;
      const template = createNode3D(Node3DKind, { name: `${kind}-${variantIndex}-template` });
      const scaleRoot = createNode3D(Node3DKind);
      const scale = FARM_PROP_SCENE_SCALE * (spec.scaleMultiplier ?? 1);
      scaleRoot.scale.x = scale;
      scaleRoot.scale.y = scale;
      scaleRoot.scale.z = scale;
      invalidateNodeLocalTransform(scaleRoot);

      const axisRoot = createNode3D(Node3DKind);
      setNodeTransform3D(axisRoot, farm.root);
      if (isNodeLocalMatrix4Detached(farm.root)) {
        setNodeLocalMatrix4(axisRoot, getNodeLocalMatrix4(farm.root));
      }

      const centeredSource = createNode3D(Node3DKind);
      centeredSource.position.x = -spec.centerX;
      centeredSource.position.y = -spec.centerY;
      centeredSource.position.z = -spec.centerZ;
      invalidateNodeLocalTransform(centeredSource);
      for (const part of spec.parts) {
        const source = findNodeByName(farm.root, part.nodeName);
        if (source === null || !isMesh(source)) {
          throw new Error(`Farm prop mesh ${part.nodeName} was not imported`);
        }
        const materialName = source.materials[0]?.name;
        if (materialName !== part.materialName) {
          throw new Error(
            `Farm prop mesh ${part.nodeName} uses ${materialName ?? 'no material'}, expected ${part.materialName}`,
          );
        }
        addNodeChild(centeredSource, cloneFarmPropPart(source, part));
      }
      const orientationRoot = createNode3D(Node3DKind);
      setQuaternionFromEuler(orientationRoot.rotation, 0, 0, spec.rotationZ ?? 0);
      invalidateNodeLocalTransform(orientationRoot);
      addNodeChild(orientationRoot, centeredSource);
      addNodeChild(axisRoot, orientationRoot);
      addNodeChild(scaleRoot, axisRoot);
      addNodeChild(template, scaleRoot);
      templates.push(template);
    }
    result[kind] = templates;
  }
  return result;
}

function cloneFarmPropPart(source: Readonly<Mesh>, part: Readonly<FarmPropPartSpec>): Mesh {
  const clone = cloneMesh(source);
  if (part.filter !== undefined) {
    clone.geometry = filterFarmPropGeometry(source.geometry, part.filter, part.nodeName);
  }
  return clone;
}

function filterFarmPropGeometry(
  source: Readonly<MeshGeometry>,
  filter: Readonly<FarmPropTriangleFilter>,
  nodeName: string,
): MeshGeometry {
  if (source.topology !== 'triangle-list' || source.indices === null) {
    throw new Error(`Farm prop mesh ${nodeName} is not an indexed triangle list`);
  }

  const selectedIndices = selectFarmPropTriangleIndices(source, filter);

  if (selectedIndices.length === 0) {
    throw new Error(`Farm prop mesh ${nodeName} produced no selected triangles`);
  }

  const filtered = cloneMeshGeometry(source);
  filtered.indices =
    source.indices instanceof Uint32Array
      ? new Uint32Array(selectedIndices)
      : new Uint16Array(selectedIndices);
  setMeshGeometrySubsets(filtered, [{ indexCount: selectedIndices.length, indexOffset: 0 }]);
  const compact = compactMeshGeometryVertices(filtered);
  refreshMeshGeometryBounds(compact);
  return compact;
}
