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
import {
  addNodeChild,
  cloneNode3DSubtree,
  createNode3D,
  invalidateNodeLocalTransform,
  Node3DKind,
  setQuaternionFromEuler,
} from '@flighthq/sdk';
import type { Material, Node3D, Scene3D } from '@flighthq/sdk';
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

// Every piece's collider is re-centred on its area centroid, which for a horse sits 15mm
// above the middle of its silhouette (head and neck). The model has to move by the same
// amount or it is drawn 15mm below the floor it is standing on. Derived rather than typed
// out, so a re-authored silhouette carries the drawing with it; see
// getColliderCentroidOffsetY. Chickens are a circle centred on the body and need nothing.
const VISUAL_OFFSET_Y: Partial<Record<StackObjectKind, number>> = {
  cow: getColliderCentroidOffsetY('cow'),
  hay: getColliderCentroidOffsetY('hay'),
  horse: getColliderCentroidOffsetY('horse'),
};

/** Replaces each source material on a clone. Null leaves the piece's own materials alone. */
export type MaterialMapper = (material: Material | null) => Material | null;

export interface StackObjectVisuals {
  setTemplates: (farmProps: FarmPropTemplates, horse: Scene3D) => void;
  /** False until the models have loaded, which is the game's "can a round start" test. */
  isReady: () => boolean;
  create: (
    kind: StackObjectKind,
    variantIndex?: number,
    materialMapper?: MaterialMapper | null,
    alpha?: number,
  ) => Node3D;
  /**
   * Place a node at a physics pose: x along the play line, physicsY above the pasture. Pass
   * the kind so the node can be lined up with its own collider — see VISUAL_OFFSET_Y.
   */
  setTransform: (node: Node3D, kind: StackObjectKind, x: number, physicsY: number, angle: number) => void;
  /** Screen-reader label for a queued piece. */
  label: (kind: StackObjectKind, variantIndex: number) => string;
}

export function createStackObjectVisuals(): StackObjectVisuals {
  let farmPropTemplates: FarmPropTemplates = {};
  let horseTemplate: Scene3D | null = null;

  return {
    setTemplates(farmProps, horse) {
      farmPropTemplates = farmProps;
      horseTemplate = horse;
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

    setTransform(node, kind, x, physicsY, angle) {
      node.position.x = STACK_X;
      node.position.y = STACK_BASE_Y + physicsY + (VISUAL_OFFSET_Y[kind] ?? 0);
      node.position.z = STACK_Z - x;
      // A chicken's collider is a CIRCLE, which has no orientation at all, so drawing the
      // hen turned reports a pose the physics is not holding: at 45 degrees the corners of
      // its silhouette reach 13mm past the circle that is actually resting on the ground,
      // and the hen's beak and feet go into the grass. Left upright, the drawing and the
      // collider agree at every angle. Nothing else here is round, so nothing else cares.
      setQuaternionFromEuler(node.rotation, kind === 'chickens' ? 0 : angle, 0, 0);
      invalidateNodeLocalTransform(node);
    },

    label(kind, variantIndex) {
      // A horse has no variants, and FARM_PROP_VARIANTS has no 'horse' key to index.
      if (kind === 'horse') return STACK_OBJECT_PROFILES.horse.label;
      return FARM_PROP_VARIANTS[kind][variantIndex]?.label ?? STACK_OBJECT_PROFILES[kind].label;
    },
  };
}
