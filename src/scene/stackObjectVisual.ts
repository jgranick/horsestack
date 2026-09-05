// Turning a stack-object kind into a node you can put in the scene, and placing that node at
// a physics pose. src/scene/StackObjectVisual.hx in the Haxe sibling.
//
// Two things live behind here. One is that a horse is not built like the farm props: it is
// its own glTF and needs a scale-and-centre transform the props already carry in their
// templates, so `create` has two arms that callers should not have to know about. The other
// is the physics-to-world mapping in setTransform — the 2D physics plane runs along world Z
// at a fixed X, so a body's x becomes STACK_Z - x. Every placed piece, every preview and the
// pile sync all go through this one function, which is what keeps them agreeing.
//
// The templates arrive from the network, so they are set after construction rather than
// passed in. isReady() is what the game asks instead of reaching for a template itself.
//
// INSTANCING — pieces placed in the stack are drawn via InstancedMesh. One InstancedMesh per
// mesh-part per (kind, variant) holds all placed copies of that prop, and their per-instance
// transforms are rebuilt every frame from the physics poses. The preview (landing indicator)
// still clones a regular Node3D, because there is only one of it at a time and it carries
// custom materials.
import {
  addNodeChild,
  cloneNode3DSubtree,
  composeMatrix4,
  createInstancedMesh,
  createMatrix4,
  createNode3D,
  createQuaternion,
  createVector3,
  getNodeChildren,
  getNodeLocalMatrix4,
  invalidateInstancedMesh,
  invalidateNodeLocalTransform,
  isMesh,
  multiplyMatrix4,
  Node3DKind,
  setInstancedMeshInstanceCount,
  setInstancedMeshInstanceMatrix,
  setQuaternionFromEuler,
} from '@flighthq/sdk';
import type { InstancedMesh, Material, Matrix4, Mesh, Node3D, Scene3D } from '@flighthq/sdk';
import { FARM_PROP_VARIANTS } from '../data/farmPropGeometry';
import {
  HORSE_SCALE,
  HORSE_VISUAL_CENTER_Y,
  STACK_BASE_Y,
  STACK_X,
  STACK_Z,
} from '../game/gameConfig';
import type { StackObjectKind } from '../physics/stackObjectKind';
import { getColliderCentroidOffsetY } from '../physics/colliderGeometry';
import { STACK_OBJECT_PROFILES } from '../physics/stackObjectProfile';
import type { FarmPropTemplates } from './modelLoader';

const VISUAL_OFFSET_Y: Partial<Record<StackObjectKind, number>> = {
  cow: getColliderCentroidOffsetY('cow'),
  hay: getColliderCentroidOffsetY('hay'),
  horse: getColliderCentroidOffsetY('horse'),
};

/** Replaces each source material on a clone. Null leaves the piece's own materials alone. */
export type MaterialMapper = (material: Material | null) => Material | null;

/** Opaque handle for a placed piece's instanced visual. */
export interface StackVisualHandle {
  readonly kind: StackObjectKind;
  readonly variantIndex: number;
  readonly _batchKey: string;
  _lastFrame: number;
  _frameIndex: number;
}

interface MeshPart {
  instancedMesh: InstancedMesh;
  partMatrix: Matrix4;
}

interface Batch {
  parts: MeshPart[];
  frameCount: number;
}

const INITIAL_CAPACITY = 32;

export interface StackObjectVisuals {
  setTemplates: (farmProps: FarmPropTemplates, horse: Scene3D) => void;
  isReady: () => boolean;
  create: (
    kind: StackObjectKind,
    variantIndex?: number,
    materialMapper?: MaterialMapper | null,
    alpha?: number,
  ) => Node3D;
  addPiece: (kind: StackObjectKind, variantIndex?: number) => StackVisualHandle;
  setTransform: (node: Node3D, kind: StackObjectKind, x: number, physicsY: number, angle: number) => void;
  setPieceTransform: (handle: StackVisualHandle, kind: StackObjectKind, x: number, physicsY: number, angle: number) => void;
  flush: () => void;
  clearPieces: () => void;
  readonly instancedNodes: Node3D[];
  label: (kind: StackObjectKind, variantIndex: number) => string;
}

export function createStackObjectVisuals(): StackObjectVisuals {
  let farmPropTemplates: FarmPropTemplates = {};
  let horseTemplate: Scene3D | null = null;
  const batches = new Map<string, Batch>();
  const allInstancedNodes: Node3D[] = [];
  let frameNumber = 0;

  const tmpPosition = createVector3();
  const tmpRotation = createQuaternion();
  const tmpScale = createVector3(1, 1, 1);
  const tmpWorldMatrix = createMatrix4();
  const tmpInstanceMatrix = createMatrix4();

  function batchKey(kind: StackObjectKind, variantIndex: number): string {
    return `${kind}-${variantIndex}`;
  }

  function collectMeshParts(root: Node3D): Array<{ geometry: Mesh['geometry']; materials: Mesh['materials']; localMatrix: Matrix4 }> {
    const parts: Array<{ geometry: Mesh['geometry']; materials: Mesh['materials']; localMatrix: Matrix4 }> = [];
    const matrixStack: Matrix4[] = [createMatrix4()];

    function walk(node: Node3D, depth: number): void {
      const parentMatrix = matrixStack[depth]!;
      const localMatrix = getNodeLocalMatrix4(node);
      const worldMatrix = createMatrix4();
      multiplyMatrix4(worldMatrix, parentMatrix, localMatrix as Matrix4);

      if (isMesh(node)) {
        const mesh = node as Mesh;
        parts.push({
          geometry: mesh.geometry,
          materials: [...mesh.materials],
          localMatrix: worldMatrix,
        });
      }

      const children = getNodeChildren(node);
      if (children.length > 0) {
        matrixStack[depth + 1] = worldMatrix;
        for (const child of children) {
          walk(child as Node3D, depth + 1);
        }
      }
    }

    walk(root, 0);
    return parts;
  }

  function buildBatch(templateRoot: Node3D, key: string): Batch {
    const meshParts = collectMeshParts(templateRoot);
    const parts: MeshPart[] = meshParts.map(part => {
      const im = createInstancedMesh(part.geometry, part.materials, INITIAL_CAPACITY);
      im.position.x = STACK_X;
      im.position.z = STACK_Z;
      invalidateNodeLocalTransform(im);
      return { instancedMesh: im, partMatrix: part.localMatrix };
    });
    for (const part of parts) {
      setInstancedMeshInstanceCount(part.instancedMesh, 0);
      allInstancedNodes.push(part.instancedMesh);
    }
    const batch: Batch = { parts, frameCount: 0 };
    batches.set(key, batch);
    return batch;
  }

  function buildHorseBatch(): void {
    if (horseTemplate === null) return;
    const modelTransform = createNode3D(Node3DKind);
    modelTransform.scale.x = HORSE_SCALE;
    modelTransform.scale.y = HORSE_SCALE;
    modelTransform.scale.z = HORSE_SCALE;
    modelTransform.position.y = -HORSE_VISUAL_CENTER_Y;
    setQuaternionFromEuler(modelTransform.rotation, 0, 0, 0);
    invalidateNodeLocalTransform(modelTransform);
    addNodeChild(modelTransform, cloneNode3DSubtree(horseTemplate.root, null));
    buildBatch(modelTransform, batchKey('horse', 0));
  }

  function buildFarmPropBatches(): void {
    for (const kind of ['hay', 'cow', 'chickens'] as const) {
      const templates = farmPropTemplates[kind];
      if (templates === undefined) continue;
      for (let vi = 0; vi < templates.length; vi++) {
        const template = templates[vi];
        if (template === undefined) continue;
        buildBatch(template, batchKey(kind, vi));
      }
    }
  }

  function applyPieceTransform(batch: Batch, index: number, kind: StackObjectKind, x: number, physicsY: number, angle: number): void {
    tmpPosition.x = 0;
    tmpPosition.y = STACK_BASE_Y + physicsY + (VISUAL_OFFSET_Y[kind] ?? 0);
    tmpPosition.z = -x;
    setQuaternionFromEuler(tmpRotation, kind === 'chickens' ? 0 : angle, 0, 0);
    tmpScale.x = 1;
    tmpScale.y = 1;
    tmpScale.z = 1;
    composeMatrix4(tmpWorldMatrix, tmpPosition, tmpRotation, tmpScale);

    for (const part of batch.parts) {
      multiplyMatrix4(tmpInstanceMatrix, tmpWorldMatrix, part.partMatrix);
      if (index >= part.instancedMesh.instanceCount) {
        setInstancedMeshInstanceCount(part.instancedMesh, index + 1);
      }
      setInstancedMeshInstanceMatrix(part.instancedMesh, index, tmpInstanceMatrix);
    }
  }

  return {
    instancedNodes: allInstancedNodes,

    setTemplates(farmProps, horse) {
      farmPropTemplates = farmProps;
      horseTemplate = horse;
      buildFarmPropBatches();
      buildHorseBatch();
    },

    isReady() {
      return horseTemplate !== null;
    },

    create(kind, variantIndex = 0, materialMapper = null, alpha = 1) {
      const pivot = createNode3D(Node3DKind);
      pivot.alpha = alpha;

      if (kind !== 'horse') {
        const templates = farmPropTemplates[kind];
        const template = templates?.[variantIndex] ?? templates?.[0];
        if (template === undefined) {
          throw new Error(`${STACK_OBJECT_PROFILES[kind].label} is not loaded`);
        }
        addNodeChild(pivot, cloneNode3DSubtree(template, materialMapper));
        return pivot;
      }

      if (horseTemplate === null) throw new Error('Horse model is not loaded');
      const modelTransform = createNode3D(Node3DKind);
      modelTransform.scale.x = HORSE_SCALE;
      modelTransform.scale.y = HORSE_SCALE;
      modelTransform.scale.z = HORSE_SCALE;
      modelTransform.position.y = -HORSE_VISUAL_CENTER_Y;
      setQuaternionFromEuler(modelTransform.rotation, 0, 0, 0);
      invalidateNodeLocalTransform(modelTransform);
      addNodeChild(modelTransform, cloneNode3DSubtree(horseTemplate.root, materialMapper));
      addNodeChild(pivot, modelTransform);
      return pivot;
    },

    addPiece(kind, variantIndex = 0) {
      const key = batchKey(kind, variantIndex);
      if (!batches.has(key)) {
        throw new Error(`No batch for ${key}`);
      }
      return {
        kind,
        variantIndex,
        _batchKey: key,
        _lastFrame: -1,
        _frameIndex: -1,
      };
    },

    setTransform(node, kind, x, physicsY, angle) {
      node.position.x = STACK_X;
      node.position.y = STACK_BASE_Y + physicsY + (VISUAL_OFFSET_Y[kind] ?? 0);
      node.position.z = STACK_Z - x;
      setQuaternionFromEuler(node.rotation, kind === 'chickens' ? 0 : angle, 0, 0);
      invalidateNodeLocalTransform(node);
    },

    setPieceTransform(handle, kind, x, physicsY, angle) {
      const batch = batches.get(handle._batchKey);
      if (batch === undefined) return;

      let index: number;
      if (handle._lastFrame === frameNumber) {
        index = handle._frameIndex;
      } else {
        index = batch.frameCount++;
        handle._frameIndex = index;
        handle._lastFrame = frameNumber;
      }

      applyPieceTransform(batch, index, kind, x, physicsY, angle);
    },

    flush() {
      for (const batch of batches.values()) {
        for (const part of batch.parts) {
          setInstancedMeshInstanceCount(part.instancedMesh, batch.frameCount);
          invalidateInstancedMesh(part.instancedMesh);
        }
        batch.frameCount = 0;
      }
      frameNumber++;
    },

    clearPieces() {
      for (const batch of batches.values()) {
        batch.frameCount = 0;
        for (const part of batch.parts) {
          setInstancedMeshInstanceCount(part.instancedMesh, 0);
          invalidateInstancedMesh(part.instancedMesh);
        }
      }
      frameNumber++;
    },

    label(kind, variantIndex) {
      if (kind === 'horse') return STACK_OBJECT_PROFILES.horse.label;
      return FARM_PROP_VARIANTS[kind][variantIndex]?.label ?? STACK_OBJECT_PROFILES[kind].label;
    },
  };
}
