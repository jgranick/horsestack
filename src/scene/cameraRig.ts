// How the camera frames the pile. src/scene/CameraRig.hx in the Haxe sibling.
//
// Worth its own file because it holds a piece of state nothing else may touch: the camera's
// own deadbanded, rate-limited COPY of the stack height. Scoring and the HUD read the true
// measurement; only the framing reads this one, and the whole reason it exists is that
// feeding the raw measurement to the camera made it shudder. Kept as a module-private let
// behind createCameraRig, that separation is structural rather than a convention someone has
// to remember.
import type { Camera3D, OrbitCameraController } from '@flighthq/sdk';
import {
  clamp,
  createOrbitCameraController,
  createVector3,
  updateOrbitCameraController,
} from '@flighthq/sdk';
import {
  CAMERA_HEIGHT_COLLAPSE_RATE,
  CAMERA_HEIGHT_DEADBAND,
  CAMERA_HEIGHT_FALL_RATE,
  CAMERA_HEIGHT_RISE_RATE,
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
  CAMERA_PILE_FILL,
  CAMERA_PILE_FILL_AT_HEIGHT,
  CAMERA_TOP_BIAS,
  STACK_BASE_Y,
  STACK_X,
  STACK_Z,
} from '../game/gameConfig';
import { HORSE_HALF_HEIGHT, PASTURE_TOP_Y } from '../physics/horseStackPhysics';

export interface CameraRig {
  controller: OrbitCameraController;
  /**
   * Re-aim for this frame. Returns true when the framing actually moved, which the frame
   * loop uses to decide whether another frame is owed.
   */
  update: (camera: Camera3D, deltaTime: number, measuredHeight: number, objectsDropped: number) => boolean;
  /** True while the controller is still easing toward its goals. */
  isMoving: () => boolean;
  /** Forget the followed height, so a new round frames from the pasture up. */
  resetHeight: () => void;
  /** The camera's own smoothed height, for the dev frame readout. */
  followedHeight: () => number;
}

// minDistance/maxDistance here must stay outside CAMERA_MIN_DISTANCE/CAMERA_MAX_DISTANCE:
// the fit clamps to those, then the controller clamps again on its own, and that second
// clamp is the easier one to miss.
const GAME_VIEW = {
  azimuth: Math.PI / 2,
  distance: 0.82,
  maxDistance: 7.8,
  minDistance: 0.68,
  minPolar: 0.02,
  polar: 0.08,
  smoothTime: 0.2,
  target: createVector3(STACK_X, 0.1, STACK_Z),
} as const;

export function createCameraRig(): CameraRig {
  const controller = createOrbitCameraController(GAME_VIEW);
  let cameraStackHeight = 0;

  function followStackHeight(measured: number, deltaTime: number): number {
    const difference = measured - cameraStackHeight;
    if (Math.abs(difference) <= CAMERA_HEIGHT_DEADBAND) return cameraStackHeight;
    const fallRate = CAMERA_HEIGHT_FALL_RATE + Math.abs(difference) * CAMERA_HEIGHT_COLLAPSE_RATE;
    const limit = (difference > 0 ? CAMERA_HEIGHT_RISE_RATE : fallRate) * deltaTime;
    cameraStackHeight += difference > 0 ? Math.min(difference, limit) : Math.max(difference, -limit);
    return cameraStackHeight;
  }

  return {
    controller,

    followedHeight() {
      return cameraStackHeight;
    },

    isMoving() {
      return (
        Math.abs(controller.distance - controller.goalDistance) > 0.001 ||
        Math.abs(controller.polar - controller.goalPolar) > 0.0001 ||
        Math.abs(controller.azimuth - controller.goalAzimuth) > 0.0001
      );
    },

    resetHeight() {
      cameraStackHeight = 0;
    },

    update(camera, deltaTime, measuredHeight, objectsDropped) {
      const height = followStackHeight(measuredHeight, deltaTime);
      const rise = clamp(height / 1.1, 0, 1);
      const herdProgress = clamp(objectsDropped / 50, 0, 1);
      const restingHorseTop = PASTURE_TOP_Y + HORSE_HALF_HEIGHT * 1.2;
      // Frame the whole tower, not its top. Tracking the top left the pile hanging off the
      // bottom of a frame whose upper half held nothing, and it got worse the more the pile
      // tumbled: a shorter tower simply sat lower. So the camera fits the span from the
      // pasture to the pile top into CAMERA_PILE_FILL of the frame height and centres on its
      // middle, nudged up by CAMERA_TOP_BIAS to leave the drop some room. Distance falls out
      // of the fit rather than being a curve of its own, so a collapse zooms back in.
      const tanHalfFov =
        camera.projection.kind === 'perspective' ? Math.tan(camera.projection.fovY / 2) : 1;
      const visibleHalfHeight = controller.distance * tanHalfFov;
      const pileBottomY = STACK_BASE_Y + PASTURE_TOP_Y;
      const pileTopY = STACK_BASE_Y + Math.max(restingHorseTop, height + HORSE_HALF_HEIGHT * 0.2);
      const pileSpan = Math.max(pileTopY - pileBottomY, 0.0001);
      const desiredTargetY = (pileBottomY + pileTopY) / 2 + CAMERA_TOP_BIAS * visibleHalfHeight;
      const moved = Math.abs(desiredTargetY - controller.target.y) > 0.001;
      const follow = 1 - Math.exp(-deltaTime * 2.4);
      controller.target.y += (desiredTargetY - controller.target.y) * follow;
      controller.target.x += (STACK_X - controller.target.x) * follow;
      controller.target.z = STACK_Z;
      controller.goalAzimuth = Math.PI / 2 + rise * 0.18 + herdProgress * 0.04;
      // Pitch down harder as the pile grows. A near-level camera high above a tall stack
      // frames the top and loses everything under it, which is worst exactly when the pile
      // collapses and the action moves downward. Measured over played runs, on samples with
      // a pile above 0.5 units, the base of the pile is inside the frame in 26 of 34 samples
      // at this rate against 4 of 27 at the old 0.14, and the pile top stays around a fifth
      // of the way above centre either way. At rest the tilt is unchanged.
      // Pitch down through the low and middle heights, where a level camera loses the base of
      // the pile, then ease back off once the pile is tall — otherwise the view ends up aimed
      // at the grass with the barn and silo out of frame entirely.
      controller.goalPolar = 0.06 + 0.6 * Math.min(rise, 0.45) - 0.34 * Math.max(0, rise - 0.45);
      const fill = CAMERA_PILE_FILL + (CAMERA_PILE_FILL_AT_HEIGHT - CAMERA_PILE_FILL) * rise;
      controller.goalDistance = clamp(
        pileSpan / (2 * fill) / tanHalfFov,
        CAMERA_MIN_DISTANCE,
        CAMERA_MAX_DISTANCE,
      );
      updateOrbitCameraController(controller, camera, deltaTime);
      return moved;
    },
  };
}
