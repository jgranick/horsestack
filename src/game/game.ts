// The round itself: the phase machine, the piece being aimed, the pile, the physics step,
// the height measurement, the record, and the result count-up. src/game/Game.hx in the Haxe
// sibling.
//
// This is the line the whole split is really about. main.ts is a browser shell — DOM
// elements, pointer and key events, fullscreen, the animation frame — and none of that
// belongs to the rules of the game. What is left here is everything that would still be true
// if the game were driven by something other than a browser: the same reason the Haxe sibling
// can put Game.hx behind a lime Application without either knowing much about the other.
//
// It owns its state as closure variables rather than a class, and exposes reads as getters so
// callers see live values (`game.phase`, not `game.phase()`), which is what lets main.ts build
// the UI model each frame without game.ts knowing a UI exists.
//
// The scene, audio, camera, indicator and particles arrive as dependencies. That direction
// matters: the game drives them, they never reach back for it.
import {
  addNodeChild,
  clamp,
  easeOutCubic,
  removeNodeChildren,
  removePhysics2DBody,
} from '@flighthq/sdk';
import type { Node3D, Physics2DWorld, RigidBody2D } from '@flighthq/sdk';
import type { AudioManager } from '../audio/audioManager';
import { getRandomFarmPropVariantIndex } from '../data/farmPropGeometry';
import {
  PASTURE_HALF_WIDTH,
  PASTURE_TOP_Y,
} from '../physics/pasture';
import {
  getNextObjectDelay,
  getRandomStackObjectKind,
} from '../physics/stackObjectKind';
import type { StackObjectKind } from '../physics/stackObjectKind';
import {
  STACK_OBJECT_PROFILES,
  getStackBodyHalfWidth,
  getStackBodySupportExtent,
  getStackHeightHands,
  getStackHeightMeters,
  getStackObjectVerticalExtent,
} from '../physics/stackObjectProfile';
import {
  FINAL_SETTLE_SECONDS,
  PHYSICS_STEP,
  addStackObjectBody,
  createHorseStackWorld,
  getSupportedStackHeight,
  stepHorseStack,
} from '../physics/stackPhysics';
import { prefersReducedMotion } from '../reducedMotion';
import type { CameraRig } from '../scene/cameraRig';
import type { LandingIndicator } from '../scene/landingIndicator';
import type { ParticleEffects } from '../scene/particleEffects';
import type { SceneGraph } from '../scene/sceneGraph';
import type { StackObjectVisuals } from '../scene/stackObjectVisual';
import {
  FIXED_STEP_LIMIT,
  GAME_DURATION_MS,
  MAX_RESULT_COUNT_DURATION_MS,
  MIN_RESULT_COUNT_DURATION_MS,
  STACK_BASE_Y,
  START_INPUT_GUARD_MS,
} from './gameConfig';
import type { GamePhase } from './gamePhase';

/** The piece currently hovering, waiting to be dropped. */
interface ActiveStackObject {
  angle: number;
  kind: StackObjectKind;
  variantIndex: number;
  x: number;
}

/** A piece that has been dropped: its body, its node, and whether it has fallen off. */
interface StackedObject {
  body: RigidBody2D;
  kind: StackObjectKind;
  lost: boolean;
  node: Node3D;
}

export interface GameDeps {
  audio: AudioManager;
  cameraRig: CameraRig;
  indicator: LandingIndicator;
  particles: ParticleEffects;
  sceneGraph: SceneGraph;
  visuals: StackObjectVisuals;
  /** Announce the queued piece to screen readers. The game does not know what a DOM is. */
  announce: (text: string) => void;
}

export interface Game {
  readonly phase: GamePhase;
  /** True while the clock is running or the pile is still settling. */
  readonly isRunning: boolean;
  /** True once the models are in and a round can start. */
  readonly isReady: boolean;
  readonly objectsDropped: number;
  readonly finalHeight: number;
  /** finalHeight once the round is over, the live measurement before that. */
  readonly displayedHeight: number;
  /** 0..1 across the result count-up. 1 once it has landed, 0 before it starts. */
  readonly countProgress: number;
  /** Ramps past 1 over the TIME UP arrival, which the UI uses to overshoot the panel. */
  readonly timeUpProgress: number;
  readonly secondsLeft: number;
  readonly resultHandsShown: number;
  readonly beatTheRecord: boolean;
  /** The record as it stood when the round began, or null if there was none. */
  readonly recordBeforeRound: number | null;

  /** Models are in; leave the loading phase for the title screen. */
  markReady: () => void;
  /** The GL context went away; there is nothing to run until the page reloads. */
  markLost: () => void;
  /**
   * Begin a round. `startedFrom` is the event that asked for it, whose timeStamp arms the
   * input guard on the INPUT clock rather than the render clock.
   */
  startRound: (startedFrom?: Event) => void;
  /** Advance the round by one frame. */
  update: (now: number, deltaTime: number) => void;
  /**
   * Drop the accumulated fixed-step time. The frame loop calls this when the tab is hidden
   * or shown, so a backgrounded tab does not come back and run its catch-up steps in a
   * burst — the pile would visibly jolt.
   */
  resetStepAccumulator: () => void;
  /** Drop the queued piece. `inputAt` is on the input clock, for the start guard. */
  place: (now: number, inputAt?: number) => void;
  /** Aim at a position across the play area, -1 (far side) to 1 (near side). */
  aimAt: (normalized: number, now: number) => void;
  /** Shift the aim by a delta in world units — the keyboard's arrow keys. */
  nudgeAim: (delta: number, now: number) => void;
}

// The best height ever reached on this machine, in metres, or null before a first round has
// ever been finished here. Kept in localStorage so it survives a reload, and read through
// try/catch because storage throws outright in some private-browsing modes.
const BEST_HEIGHT_KEY = 'horse-stacker.best-height';

export function createGame(deps: GameDeps): Game {
  const { announce, audio, cameraRig, indicator, particles, sceneGraph, visuals } = deps;
  const { camera, indicatorLight, previewLayer, stackLayer } = sceneGraph;

  let phase: GamePhase = 'loading';
  // Placement input is refused until this moment, measured on the INPUT clock
  // (Event.timeStamp) rather than the render clock: startRound() has to build a physics
  // world and clone a model, and on a slow first frame that work alone can outlast the
  // guard. Comparing input to input keeps the window honest whatever the frame costs.
  let placementArmedAt = 0;
  let swayClock = 0;
  let physicsWorld: Physics2DWorld = createHorseStackWorld();
  let activeObject: ActiveStackObject | null = null;
  let stackedObjects: StackedObject[] = [];
  let objectsDropped = 0;
  let aimOffset = 0;
  let lastAimAt = performance.now();
  let nextObjectAt = 0;
  let gameEndsAt = 0;
  let finishAt = 0;
  let finalHeight = 0;
  let cachedStackHeight = 0;
  let resultAnimationStart = 0;
  let resultAnimationDuration = 0;
  let resultHands = 0;
  let resultHandsShown = 0;
  let physicsAccumulator = 0;
  let lastImpactAt = 0;
  let bestMeters: number | null = readBestMeters();
  // The record as it stood when the round began, which is what the result screen reports.
  // Reading bestMeters there would be wrong: by then this round has already been folded in,
  // so a first ever round would echo its own height back at the player as "BEST".
  let recordBeforeRound: number | null = null;
  let beatTheRecord = false;
  // Reused between measurements so the height scan allocates nothing per frame.
  const measurementBodies: RigidBody2D[] = [];

  function getAimHalfWidth(): number {
    if (camera.projection.kind !== 'perspective') return 0.36;
    const visibleHalfWidth =
      cameraRig.controller.distance *
      Math.tan(camera.projection.fovY / 2) *
      camera.projection.aspect;
    const activeHalfWidth =
      activeObject === null
        ? STACK_OBJECT_PROFILES.horse.halfWidth
        : STACK_OBJECT_PROFILES[activeObject.kind].halfWidth;
    return Math.min(PASTURE_HALF_WIDTH - activeHalfWidth * 1.2, visibleHalfWidth * 0.88);
  }

  function setAimOffset(targetX: number, horizontalLimit: number, now: number): void {
    const nextAim = clamp(targetX, -horizontalLimit, horizontalLimit);
    const elapsed = clamp((now - lastAimAt) / 1000, 0.008, 0.08);
    const pointerVelocity = (nextAim - aimOffset) / elapsed;
    indicator.nudge(pointerVelocity);
    aimOffset = nextAim;
    lastAimAt = now;
  }

  function getLandingSurfaceY(x: number, kind: StackObjectKind): number {
    let surfaceY = PASTURE_TOP_Y;
    const activeHalfWidth = STACK_OBJECT_PROFILES[kind].halfWidth;

    for (const object of stackedObjects) {
      const body = object.body;
      const horizontalReach = activeHalfWidth + getStackBodyHalfWidth(body);
      if (
        object.lost ||
        body.y < PASTURE_TOP_Y ||
        Math.abs(body.x - x) > horizontalReach * 0.92 ||
        Math.abs(body.velocityY) > 1.2
      ) {
        continue;
      }
      const objectTop = body.y + getStackBodySupportExtent(body);
      surfaceY = Math.max(surfaceY, objectTop);
    }
    return surfaceY;
  }

  function getCurrentStackHeight(): number {
    measurementBodies.length = 0;
    for (const object of stackedObjects) {
      if (!object.lost) measurementBodies.push(object.body);
    }
    return getSupportedStackHeight(physicsWorld, measurementBodies);
  }

  function updateActiveStackObject(now: number): void {
    const current = activeObject;
    if (current === null) return;

    indicator.stepTeeter(now);
    const horizontalLimit = getAimHalfWidth();
    current.x = clamp(aimOffset, -horizontalLimit, horizontalLimit);
    current.angle = indicator.angle();
    indicator.update(
      current.kind,
      current.x,
      current.angle,
      getLandingSurfaceY(current.x, current.kind),
      now,
    );
  }

  function spawnObject(now: number): void {
    if (phase !== 'playing' || now >= gameEndsAt) return;

    indicator.resetTeeter(now);
    lastAimAt = now;
    const kind = getRandomStackObjectKind();
    const variantIndex = kind === 'horse' ? 0 : getRandomFarmPropVariantIndex(kind);
    activeObject = { angle: 0, kind, variantIndex, x: 0 };
    indicator.setKind(kind, variantIndex);
    // Announced to screen readers only. The label alone: an emoji here is read aloud as its
    // own name before the word it duplicates.
    announce(visuals.label(kind, variantIndex));
    updateActiveStackObject(now);
  }

  function commitObjectPlacement(now: number): void {
    const current = activeObject;
    if (current === null || phase !== 'playing') return;

    const landingY =
      getLandingSurfaceY(current.x, current.kind) +
      getStackObjectVerticalExtent(current.kind, current.angle);
    const body = addStackObjectBody(physicsWorld, current.kind, current.x, landingY, current.angle);
    body.velocityX = 0;
    body.velocityY = 0;
    body.angularVelocity = 0;
    const node = visuals.create(current.kind, current.variantIndex);
    visuals.setTransform(node, current.x, landingY, current.angle);
    addNodeChild(stackLayer, node);
    stackedObjects.push({ body, kind: current.kind, lost: false, node });
    activeObject = null;
    // The prompt has served its purpose once the player has placed something.
    indicator.hide();
    objectsDropped++;
    audio.playStackThud();

    nextObjectAt = now + getNextObjectDelay(objectsDropped);
  }

  function beginSettling(now: number): void {
    phase = 'settling';
    audio.beginResultCount();
    activeObject = null;
    finishAt = now + FINAL_SETTLE_SECONDS * 1000;
    indicator.hide();
  }

  // Compares against the previous best, then adopts the new one. The margin is a whole
  // centimetre because the result screen shows two decimals: a win by less than that would
  // raise a NEW RECORD! badge over a number identical to the record it supposedly beat.
  // A first ever round sets the record without claiming to have broken one.
  function recordFinalHeight(meters: number): void {
    const previous = bestMeters;
    recordBeforeRound = previous;
    beatTheRecord = previous !== null && meters >= previous + 0.01;
    if (previous !== null && meters <= previous) return;
    bestMeters = meters;
    try {
      window.localStorage.setItem(BEST_HEIGHT_KEY, meters.toFixed(4));
    } catch {
      // A best height that cannot be persisted still stands for the rest of the session.
    }
  }

  function finishGame(now: number): void {
    phase = 'finished';
    finalHeight = getCurrentStackHeight();
    cachedStackHeight = finalHeight;
    recordFinalHeight(getStackHeightMeters(finalHeight));
    resultHands = getStackHeightHands(finalHeight);
    resultHandsShown = 0;
    audio.armResultTicks(now);
    resultAnimationStart = now;
    resultAnimationDuration = prefersReducedMotion()
      ? 1
      : clamp(1_800 + resultHands * 14, MIN_RESULT_COUNT_DURATION_MS, MAX_RESULT_COUNT_DURATION_MS);
    indicatorLight.intensity = 0;
  }

  // The tally itself is drawn by the 2D layer straight from resultHandsShown; this only
  // advances the count and reports whether it moved, which is what drives the tick sound.
  function advanceHorseHands(targetCount: number): boolean {
    const previousCount = resultHandsShown;
    resultHandsShown = Math.max(resultHandsShown, Math.min(targetCount, resultHands));
    return resultHandsShown > previousCount;
  }

  function completeResultAnimation(): void {
    resultAnimationStart = 0;
    audio.celebrateResult();
    advanceHorseHands(resultHands);
    const burstY = STACK_BASE_Y + Math.max(0.8, finalHeight);
    // One popper per colour, strung out across the pile.
    particles.burstCelebration(burstY);
  }

  function updateResultAnimation(now: number): void {
    if (resultAnimationStart === 0) return;
    const progress = clamp((now - resultAnimationStart) / resultAnimationDuration, 0, 1);
    const easedProgress = easeOutCubic(progress);
    const handsToShow = Math.min(resultHands, Math.floor(resultHands * easedProgress));
    if (advanceHorseHands(handsToShow)) audio.playResultTick(now);
    if (progress >= 1) completeResultAnimation();
  }

  function handlePhysicsContacts(now: number): void {
    if (physicsWorld.events.began.length === 0 || now - lastImpactAt < 90) return;
    const contact = physicsWorld.events.began[0];
    const point = contact?.points[0];
    if (point === undefined) return;

    lastImpactAt = now;
    particles.burstDust(point.x, STACK_BASE_Y + point.y);
    audio.maybePlayCollisionWhinny(now);
  }

  function stepGamePhysics(now: number, deltaTime: number): void {
    physicsAccumulator = Math.min(physicsAccumulator + deltaTime, PHYSICS_STEP * FIXED_STEP_LIMIT);
    let steps = 0;
    while (physicsAccumulator >= PHYSICS_STEP && steps < FIXED_STEP_LIMIT) {
      stepHorseStack(physicsWorld);
      physicsAccumulator -= PHYSICS_STEP;
      steps++;
      handlePhysicsContacts(now);
    }
  }

  function synchronizeStackVisuals(): void {
    let retainedCount = 0;
    for (const object of stackedObjects) {
      if (object.lost) continue;
      const body = object.body;

      // Leave enough void beyond the collider for the whole tumble to remain visible.
      if (body.y < -1 || Math.abs(body.x) > PASTURE_HALF_WIDTH + 1.5) {
        object.lost = true;
        object.node.enabled = false;
        removePhysics2DBody(physicsWorld, body);
        continue;
      }

      // A sway that exists only in the render transform. The physics never sees it, so it
      // costs the player nothing, but the pile is visibly never quite at rest — which is the
      // read we want from something this tall. Amplitude grows with how high the piece rides
      // and is nil at the pasture, so the base looks planted and the top looks precarious.
      const carried = clamp((body.y - PASTURE_TOP_Y) / 0.9, 0, 1);
      const sway = prefersReducedMotion() ? 0 : carried * carried;
      const swayPhase = swayClock + body.index * 0.7;
      visuals.setTransform(
        object.node,
        body.x + Math.sin(swayPhase) * 0.0016 * sway,
        body.y,
        body.angle + Math.sin(swayPhase * 0.77 + 1.3) * 0.010 * sway,
      );
      stackedObjects[retainedCount++] = object;
    }
    // Fallen objects have already left the physics world and score calculation;
    // keep them out of every subsequent placement, height, and visual scan too.
    stackedObjects.length = retainedCount;
  }

  function updateGame(now: number): void {
    if (phase === 'playing') {
      if (now >= gameEndsAt) {
        beginSettling(now);
        return;
      }
      if (activeObject !== null) {
        updateActiveStackObject(now);
      } else if (now >= nextObjectAt) {
        spawnObject(now);
      }
    } else if (phase === 'settling' && now >= finishAt) {
      finishGame(now);
    }
  }

  return {
    get phase() {
      return phase;
    },
    get isRunning() {
      return phase === 'playing' || phase === 'settling';
    },
    get isReady() {
      return visuals.isReady();
    },
    get objectsDropped() {
      return objectsDropped;
    },
    get finalHeight() {
      return finalHeight;
    },
    get displayedHeight() {
      return phase === 'finished' ? finalHeight : cachedStackHeight;
    },
    get countProgress() {
      if (resultAnimationStart === 0) return phase === 'finished' ? 1 : 0;
      return clamp((performance.now() - resultAnimationStart) / resultAnimationDuration, 0, 1);
    },
    get timeUpProgress() {
      if (finishAt === 0) return 0;
      // Scaled past 1 deliberately: the UI's arrival curve overshoots, and this is the input
      // it overshoots on.
      return clamp(1 - (finishAt - performance.now()) / (FINAL_SETTLE_SECONDS * 1000), 0, 1) * 2.6;
    },
    get secondsLeft() {
      return Math.max(0, (gameEndsAt - performance.now()) / 1000);
    },
    get resultHandsShown() {
      return resultHandsShown;
    },
    get beatTheRecord() {
      return beatTheRecord;
    },
    get recordBeforeRound() {
      return recordBeforeRound;
    },

    markReady() {
      phase = 'ready';
    },

    markLost() {
      phase = 'loading';
    },

    startRound(startedFrom) {
      if (!visuals.isReady() || phase === 'loading') return;

      const now = performance.now();
      audio.startRound(now);
      physicsWorld = createHorseStackWorld();
      physicsAccumulator = 0;
      activeObject = null;
      stackedObjects = [];
      objectsDropped = 0;
      aimOffset = 0;
      indicator.resetTeeter(now);
      lastAimAt = now;
      nextObjectAt = 0;
      gameEndsAt = now + GAME_DURATION_MS;
      finishAt = 0;
      finalHeight = 0;
      cachedStackHeight = 0;
      resultAnimationStart = 0;
      resultAnimationDuration = 0;
      resultHands = 0;
      resultHandsShown = 0;
      beatTheRecord = false;
      recordBeforeRound = null;
      lastImpactAt = 0;
      removeNodeChildren(stackLayer);
      removeNodeChildren(previewLayer);
      addNodeChild(stackLayer, previewLayer);
      indicator.beginRound();
      particles.reset();

      phase = 'playing';
      cameraRig.resetHeight();
      placementArmedAt = (startedFrom?.timeStamp ?? now) + START_INPUT_GUARD_MS;
      spawnObject(now);
    },

    update(now, deltaTime) {
      // Read through a local rather than testing `phase` in the `if`: updateGame can move the
      // phase on within this block (settling reaching finishAt lands in 'finished'), and the
      // cachedStackHeight line below depends on seeing that. Narrowing on `phase` directly
      // would let the compiler rule the 'finished' branch out as dead.
      const wasRunning = phase === 'playing' || phase === 'settling';
      if (wasRunning) {
        updateGame(now);
        swayClock += deltaTime * 1.6;
        stepGamePhysics(now, deltaTime);
        synchronizeStackVisuals();
        cachedStackHeight = phase === 'finished' ? finalHeight : getCurrentStackHeight();
      }
      if (phase === 'finished' && resultAnimationStart !== 0) {
        updateResultAnimation(now);
      }
    },

    resetStepAccumulator() {
      physicsAccumulator = 0;
    },

    place(now, inputAt = now) {
      if (activeObject === null) return;
      if (inputAt < placementArmedAt) return;
      if (now >= gameEndsAt) {
        beginSettling(now);
        return;
      }
      // Touch devices do not necessarily send a pointermove before pointerdown, so refresh
      // the hidden object's projected landing pose at the exact moment it is placed.
      updateActiveStackObject(now);
      commitObjectPlacement(now);
    },

    aimAt(normalized, now) {
      if (activeObject === null) return;
      const horizontalLimit = getAimHalfWidth();
      setAimOffset(normalized * horizontalLimit, horizontalLimit, now);
    },

    nudgeAim(delta, now) {
      setAimOffset(aimOffset + delta, getAimHalfWidth(), now);
    },
  };
}

function readBestMeters(): number | null {
  try {
    const stored = window.localStorage.getItem(BEST_HEIGHT_KEY);
    if (stored === null) return null;
    const value = Number.parseFloat(stored);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
