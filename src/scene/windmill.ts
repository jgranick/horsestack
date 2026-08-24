// The farm's windmill sails, turning. Ambient scenery with three numbers of state, which is
// exactly why it is here and not in modelLoader.ts: loading assets and animating them every
// frame are different jobs, and the hub offsets only make sense next to the rotation that
// uses them.
import type { Node3D, Scene3D } from '@flighthq/sdk';
import {
  findNodeByName,
  invalidateNodeLocalTransform,
  isMesh,
  refreshMeshGeometryBounds,
  setQuaternionFromEuler,
} from '@flighthq/sdk';
import { WINDMILL_RADIANS_PER_SECOND } from '../game/gameConfig';
import { prefersReducedMotion } from '../reducedMotion';

export interface Windmill {
  /** Advance the sails. Returns true when they moved, so the frame loop knows to redraw. */
  update: (deltaTime: number) => boolean;
}

/**
 * Binds to the sail mesh inside an already-imported farm scene. Throws if the mesh or its
 * material is not what this expects — a silently unbound windmill is just a still farm, and
 * that reads as correct until someone notices the wind stopped.
 */
export function createWindmill(farm: Readonly<Scene3D>): Windmill {
  const sails = findNodeByName(farm.root, 'Object_6');
  if (sails === null || !isMesh(sails)) {
    throw new Error('Windmill sail mesh Object_6 was not imported');
  }
  const materialName = sails.materials[0]?.name;
  if (materialName !== 'Windmill2') {
    throw new Error(
      `Windmill sail mesh Object_6 uses ${materialName ?? 'no material'}, expected Windmill2`,
    );
  }
  refreshMeshGeometryBounds(sails.geometry);
  const bounds = sails.geometry.bounds;
  if (bounds === null) throw new Error('Windmill sail mesh has no bounds');

  // Y and Z extents match (a disc), and X is the shaft it turns about — so it spins around
  // mesh-space X, centred on the disc's Y/Z midpoint. Rotating about a point off the node
  // origin needs no reparenting: for a rotation R about an axis through `hub`, the plain
  // TRS position that reproduces it is hub - R*hub, and the shaft-axis component cancels.
  const hubY = (bounds.min.y + bounds.max.y) / 2;
  const hubZ = (bounds.min.z + bounds.max.z) / 2;
  let angle = 0;

  function turn(node: Node3D, deltaTime: number): boolean {
    if (prefersReducedMotion()) return false;
    angle = (angle + WINDMILL_RADIANS_PER_SECOND * deltaTime) % (Math.PI * 2);
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    setQuaternionFromEuler(node.rotation, angle, 0, 0);
    node.position.y = hubY - (hubY * cos - hubZ * sin);
    node.position.z = hubZ - (hubY * sin + hubZ * cos);
    invalidateNodeLocalTransform(node);
    return true;
  }

  // Settle the sails into their start pose immediately, so the first frame is not a jump.
  turn(sails, 0);

  return {
    update(deltaTime) {
      return turn(sails, deltaTime);
    },
  };
}
