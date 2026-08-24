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
  getStackBodyVerticalExtent,
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
  HORSE_DROP_FALL,
  STEADY_HANDS_ALLOWANCE,
} from './gameConfig';
import type { GameMode } from './gameMode';
import type { GamePhase } from './gamePhase';

/** The piece currently hovering, waiting to be dropped. */
interface ActiveStackObject {
  angle: number;
  kind: StackObjectKind;
  variantIndex: number;
  x: number;
  /** Height in the play plane. The player sets this now; it is not derived from the pile. */
  y: number;
}

/** A piece that has been placed: its body, its node, and how it has fared since. */
interface StackedObject {
  body: RigidBody2D;
  kind: StackObjectKind;
  /** Left the pasture entirely; removed from the world and hidden. */
  lost: boolean;
  /**
   * Counted against the player as a dropped horse. Separate from `lost` because a horse that
   * falls onto the grass is still physically in the pile — it has been dropped, not removed —
   * and because the count must happen exactly once however far it goes on to roll.
   */
  dropped: boolean;
  node: Node3D;
  /** Where it was let go, which is what a fall is measured against. */
  placedY: number;
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
  /** Which game the current (or most recent) round is. */
  readonly mode: GameMode;
  /** True while the clock is running or the pile is still settling. */
  readonly isRunning: boolean;
  /** True once the models are in and a round can start. */
  readonly isReady: boolean;
  readonly objectsDropped: number;
  readonly finalHeight: number;
  /** finalHeight once the round is over, the live measurement before that. */
  readonly displayedHeight: number;
  /**
   * The best settled height reached this run, which is what the round will score. Shown live
   * rather than the current height: the current height is already on screen as a tower, and
   * this is the number the player is actually playing for. It only ever goes up, so a run
   * that peaks at 30m and then collapses still scores 30m — losing the tower ends your chance
   * to add to it, it does not take back what you built.
   */
  readonly peakHeight: number;
  /** The piece that will be handed over next, so the player can plan for it. */
  readonly nextKind: StackObjectKind;
  /** 0..1 across the result count-up. 1 once it has landed, 0 before it starts. */
  readonly countProgress: number;
  /** Ramps past 1 over the TIME UP arrival, which the UI uses to overshoot the panel. */
  readonly timeUpProgress: number;
  readonly secondsLeft: number;
  readonly resultHandsShown: number;
  /** Horses dropped this round, for the STEADY HANDS strike dots. */
  readonly horsesDropped: number;
  readonly beatTheRecord: boolean;
  /** The record as it stood when the round began, or null if there was none. */
  readonly recordBeforeRound: number | null;

  /** Models are in; leave the loading phase for the title screen. */
  markReady: () => void;
  /** The GL context went away; there is nothing to run until the page reloads. */
  markLost: () => void;
  /**
   * Begin a round in `nextMode`. `startedFrom` is the event that asked for it, whose
   * timeStamp arms the input guard on the INPUT clock rather than the render clock.
   */
  startRound: (nextMode: GameMode, startedFrom?: Event) => void;
  /**
   * Abandon the round and go back to the title. STEADY HANDS has no clock to wait out, so
   * this is how a player who is done with a tower leaves it.
   */
  leaveRound: () => void;
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
  /**
   * Hold the piece at this point in the physics plane. The caller unprojects the pointer onto
   * the play plane (scene/playPlane.ts) rather than passing a screen fraction — see the note
   * there for why a screen fraction was wrong.
   */
  aimAt: (physicsX: number, physicsY: number, now: number) => void;
  /** Shift the held piece by a delta in world units — the keyboard's arrow keys. */
  nudgeAim: (deltaX: number, deltaY: number, now: number) => void;
}

// The best height ever reached on this machine, in metres, or null before a first round has
// ever been finished here. Kept in localStorage so it survives a reload, and read through
// try/catch because storage throws outright in some private-browsing modes.
//
// One record PER MODE. Endless has no clock, so its heights dwarf a timed round's; a single
// shared record would mean Time Challenge could never post a BEST again after one long
// endless run. The timed key is left at its original name so existing records survive.
const BEST_HEIGHT_KEYS: Readonly<Record<GameMode, string>> = {
  time: 'horse-stacker.best-height',
  // Deliberately NOT the '.endless' key the sandbox build wrote. Those numbers came from a
  // mode that never ended, so they are however long someone kept clicking rather than a
  // score — carrying them over would leave an unbeatable record on a game they never played.
  steady: 'horse-stacker.best-height.steady',
};

export function createGame(deps: GameDeps): Game {
  const { announce, audio, cameraRig, indicator, particles, sceneGraph, visuals } = deps;
  const { indicatorLight, previewLayer, stackLayer } = sceneGraph;

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
  // Where the piece is being held, in physics coordinates. Both axes now: placement is free
  // within the plane rather than a horizontal aim over a top-down drop.
  let aimX = 0;
  let aimY = 0;
  // True when the held piece overlaps something already placed, so it cannot be put down.
  let aimBlocked = false;
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
  let mode: GameMode = 'time';
  // The tallest the pile reached during the round, which is what an endless run scores: a
  // collapse leaves the measured height at zero, and the run was still worth what it built.
  // A timed round finishes with the pile standing, so for it this equals the final height.
  let peakHeight = 0;
  // Horses dropped this round. STEADY HANDS ends when this passes its allowance; the timed
  // round counts them too, but only so the HUD has nothing special to do, and never acts on
  // the number.
  //
  // HORSES ONLY, deliberately. Hay, cows and chickens are scaffolding you are meant to spend:
  // making everything count would punish the very thing that lets you build a base worth
  // standing a horse on. It is called Horse Stacker.
  let horsesDropped = 0;
  // Drawn one ahead so the HUD can show what is coming. Planning is the whole point of
  // STEADY HANDS, and you cannot plan a structure for a piece you have not been told about;
  // the timed mode gets it too, where it buys a moment of preparation instead.
  let queued = drawPiece();
  const bestMeters: Record<GameMode, number | null> = {
    time: readBestMeters('time'),
    steady: readBestMeters('steady'),
  };
  // The record as it stood when the round began, which is what the result screen reports.
  // Reading bestMeters there would be wrong: by then this round has already been folded in,
  // so a first ever round would echo its own height back at the player as "BEST".
  let recordBeforeRound: number | null = null;
  let beatTheRecord = false;
  // Reused between measurements so the height scan allocates nothing per frame.
  const measurementBodies: RigidBody2D[] = [];

  // How far from the middle a piece of this kind may be held. Only the pasture constrains it
  // now: the pointer is unprojected onto the play plane (scene/playPlane.ts), so the piece is
  // wherever the cursor is, and anything on screen is reachable by definition. The old
  // "visible half width" term existed to stop a LINEAR screen-to-world map running the piece
  // off the edge, and that map is gone.
  function getAimHalfWidth(): number {
    const activeHalfWidth =
      activeObject === null
        ? STACK_OBJECT_PROFILES.horse.halfWidth
        : STACK_OBJECT_PROFILES[activeObject.kind].halfWidth;
    return PASTURE_HALF_WIDTH - activeHalfWidth * 1.2;
  }

  /** The lowest a piece of this kind can be held: resting on the bare pasture. */
  function getFloorY(kind: StackObjectKind, angle: number): number {
    return PASTURE_TOP_Y + getStackObjectVerticalExtent(kind, angle);
  }

  /**
   * Does a piece held here overlap something already placed? Extents are the same ones the
   * colliders and the landing scan use, so "roughly where it would fit" means the same thing
   * to the preview as it will to the solver a moment later.
   */
  function isPlacementBlocked(kind: StackObjectKind, x: number, y: number, angle: number): boolean {
    const halfWidth = STACK_OBJECT_PROFILES[kind].halfWidth;
    const vertical = getStackObjectVerticalExtent(kind, angle);
    for (const object of stackedObjects) {
      if (object.lost) continue;
      const body = object.body;
      if (Math.abs(body.x - x) >= halfWidth + getStackBodyHalfWidth(body)) continue;
      if (Math.abs(body.y - y) >= vertical + getStackBodyVerticalExtent(body)) continue;
      return true;
    }
    return false;
  }

  function setAim(targetX: number, targetY: number, now: number): void {
    const current = activeObject;
    const kind = current === null ? 'horse' : current.kind;
    const angle = current === null ? 0 : current.angle;
    const horizontalLimit = getAimHalfWidth();
    const nextX = clamp(targetX, -horizontalLimit, horizontalLimit);
    // No ceiling: holding a piece high and letting it fall is a legitimate (and destructive)
    // choice. The floor is real though — nothing may be placed inside the pasture.
    const nextY = Math.max(targetY, getFloorY(kind, angle));
    // The teeter reads horizontal speed only. Raising and lowering a piece is a deliberate,
    // careful motion and should not set it swinging.
    const elapsed = clamp((now - lastAimAt) / 1000, 0.008, 0.08);
    indicator.nudge((nextX - aimX) / elapsed);
    aimX = nextX;
    aimY = nextY;
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
    current.x = clamp(aimX, -horizontalLimit, horizontalLimit);
    current.angle = indicator.angle();
    // Re-clamp against the floor here as well as in setAim: the teeter keeps turning the
    // piece after the pointer stops, and a rotating piece's vertical extent grows, so a pose
    // that cleared the grass a moment ago may not now.
    current.y = Math.max(aimY, getFloorY(current.kind, current.angle));
    aimBlocked = isPlacementBlocked(current.kind, current.x, current.y, current.angle);
    indicator.update(current.kind, current.x, current.y, current.angle, aimBlocked, now);
  }

  function spawnObject(now: number): void {
    if (phase !== 'playing' || now >= gameEndsAt) return;

    indicator.resetTeeter(now);
    lastAimAt = now;
    const { kind, variantIndex } = queued;
    queued = drawPiece();
    // Opens resting on whatever is under the middle of the pasture, so the first frame shows
    // a plausible pose before the pointer has said anything.
    aimX = 0;
    aimY = getLandingSurfaceY(0, kind) + getStackObjectVerticalExtent(kind, 0);
    aimBlocked = false;
    activeObject = { angle: 0, kind, variantIndex, x: aimX, y: aimY };
    indicator.setKind(kind, variantIndex);
    // Announced to screen readers only. The label alone: an emoji here is read aloud as its
    // own name before the word it duplicates.
    announce(visuals.label(kind, variantIndex));
    updateActiveStackObject(now);
  }

  function commitObjectPlacement(now: number): void {
    const current = activeObject;
    if (current === null || phase !== 'playing') return;
    // A pose that overlaps something already placed is refused rather than resolved. Letting
    // the solver push the two apart would fire pieces out of the pile at speed.
    if (isPlacementBlocked(current.kind, current.x, current.y, current.angle)) return;

    // Exactly where it was being held. It is not dropped onto a surface any more, so it may
    // well be unsupported — and then it falls, which is the player's problem.
    const landingY = current.y;
    const body = addStackObjectBody(physicsWorld, current.kind, current.x, landingY, current.angle);
    body.velocityX = 0;
    body.velocityY = 0;
    body.angularVelocity = 0;
    const node = visuals.create(current.kind, current.variantIndex);
    visuals.setTransform(node, current.x, landingY, current.angle);
    addNodeChild(stackLayer, node);
    stackedObjects.push({
      body,
      dropped: false,
      kind: current.kind,
      lost: false,
      node,
      placedY: landingY,
    });
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
    const previous = bestMeters[mode];
    recordBeforeRound = previous;
    beatTheRecord = previous !== null && meters >= previous + 0.01;
    if (previous !== null && meters <= previous) return;
    bestMeters[mode] = meters;
    try {
      window.localStorage.setItem(BEST_HEIGHT_KEYS[mode], meters.toFixed(4));
    } catch {
      // A best height that cannot be persisted still stands for the rest of the session.
    }
  }

  function finishGame(now: number): void {
    phase = 'finished';
    // Put the queued piece away HERE rather than trusting the caller. The timed round comes
    // in through beginSettling, which already did it; a STEADY HANDS run comes straight here,
    // and without this the hovering ghost and its halo hang over the result screen.
    activeObject = null;
    indicator.hide();
    // The peak, not the height at this instant. They are the same for a timed round, which
    // ends with the pile standing; a STEADY HANDS run ends BECAUSE pieces fell, often taking
    // the top of the tower with them, and scoring the rubble would throw away the whole run.
    finalHeight = Math.max(peakHeight, getCurrentStackHeight());
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
    // TIME CHALLENGE only. The whinny fires at random off collisions, which is a nice bit of
    // life over a thirty second scramble and an irritant over a long careful build — the same
    // reason STEADY HANDS runs without the soundtrack. The dust still puffs on every impact,
    // so a landing is not silent, it just stops editorialising.
    if (mode === 'time') audio.maybePlayCollisionWhinny(now);
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

      // A horse that has fallen a full horse-height below where it was let go has been
      // dropped, wherever it ends up — onto the grass is as bad as off the map, because the
      // thing that went wrong is the same. Counted the moment it has fallen that far rather
      // than once it settles, so the strike lands while the tumble is on screen.
      //
      // This also covers releasing one in mid-air: placement is free, so a horse let go above
      // the pile and allowed to drop IS a dropped horse. That is the rule doing its job.
      if (!object.dropped && object.kind === 'horse' && body.y < object.placedY - HORSE_DROP_FALL) {
        object.dropped = true;
        horsesDropped++;
      }

      // Leave enough void beyond the collider for the whole tumble to remain visible.
      if (body.y < -1 || Math.abs(body.x) > PASTURE_HALF_WIDTH + 1.5) {
        object.lost = true;
        object.node.enabled = false;
        removePhysics2DBody(physicsWorld, body);
        // A horse can leave sideways without ever falling far — off the edge of the pasture
        // at the height it was placed — so the fall test above will not have caught it.
        if (object.kind === 'horse' && !object.dropped) {
          object.dropped = true;
          horsesDropped++;
        }
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
      // gameEndsAt is Infinity in endless, so this never fires there.
      if (now >= gameEndsAt) {
        beginSettling(now);
        return;
      }
      // What ends a STEADY HANDS run: one piece too many has gone off the pasture.
      //
      // This replaced a "every piece has fallen off" rule, which sounded equivalent and was
      // not. A collapse scatters pieces across the grass where they stay stackable, and each
      // run ACCUMULATES that clutter, so the pasture emptying got less likely the longer you
      // played — measured over a 40 placement run that built to 11.5m and collapsed, it never
      // fired once. Counting what leaves fires cleanly and reads off the HUD.
      if (mode === 'steady' && horsesDropped > STEADY_HANDS_ALLOWANCE) {
        // Straight to the result. Nothing is waiting to settle, and the TIME UP beat would be
        // the wrong words over a round that had nothing to do with a clock. The fanfare still
        // fires, because the count-up is starting either way.
        audio.beginResultCount();
        finishGame(now);
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
    get mode() {
      return mode;
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
    get peakHeight() {
      return phase === 'finished' ? finalHeight : peakHeight;
    },
    get nextKind() {
      return queued.kind;
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
      // STEADY HANDS sets gameEndsAt to Infinity, and an Infinity reaching the UI model would
      // be formatted and shown. There is no clock to report, so report none.
      if (!Number.isFinite(gameEndsAt)) return 0;
      return Math.max(0, (gameEndsAt - performance.now()) / 1000);
    },
    get resultHandsShown() {
      return resultHandsShown;
    },
    get horsesDropped() {
      return horsesDropped;
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

    startRound(nextMode, startedFrom) {
      if (!visuals.isReady() || phase === 'loading') return;

      mode = nextMode;
      const now = performance.now();
      audio.startRound(now, mode);
      physicsWorld = createHorseStackWorld();
      physicsAccumulator = 0;
      activeObject = null;
      stackedObjects = [];
      objectsDropped = 0;
      aimX = 0;
      aimY = 0;
      aimBlocked = false;
      indicator.resetTeeter(now);
      lastAimAt = now;
      queued = drawPiece();
      nextObjectAt = 0;
      // STEADY HANDS has no clock at all rather than a very long one: the timer HUD reads
      // gameEndsAt, and Infinity keeps every "is the round over" test honest without a
      // second flag to forget.
      gameEndsAt = mode === 'steady' ? Infinity : now + GAME_DURATION_MS;
      finishAt = 0;
      finalHeight = 0;
      cachedStackHeight = 0;
      peakHeight = 0;
      horsesDropped = 0;
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
        peakHeight = Math.max(peakHeight, cachedStackHeight);
      }
      if (phase === 'finished' && resultAnimationStart !== 0) {
        updateResultAnimation(now);
      }
    },

    resetStepAccumulator() {
      physicsAccumulator = 0;
    },

    leaveRound() {
      if (phase === 'loading') return;
      phase = 'ready';
      activeObject = null;
      indicator.hide();
      audio.leaveRound();
      removeNodeChildren(stackLayer);
      removeNodeChildren(previewLayer);
      particles.reset();
      // The pile is gone, so the camera must not keep framing where it used to be.
      cachedStackHeight = 0;
      peakHeight = 0;
      horsesDropped = 0;
      objectsDropped = 0;
      stackedObjects = [];
      physicsWorld = createHorseStackWorld();
      cameraRig.resetHeight();
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

    aimAt(physicsX, physicsY, now) {
      if (activeObject === null) return;
      setAim(physicsX, physicsY, now);
    },

    nudgeAim(deltaX, deltaY, now) {
      setAim(aimX + deltaX, aimY + deltaY, now);
    },
  };
}

/** One weighted draw: the kind, and which of that kind's variants. */
function drawPiece(): { kind: StackObjectKind; variantIndex: number } {
  const kind = getRandomStackObjectKind();
  return { kind, variantIndex: kind === 'horse' ? 0 : getRandomFarmPropVariantIndex(kind) };
}

function readBestMeters(mode: GameMode): number | null {
  try {
    const stored = window.localStorage.getItem(BEST_HEIGHT_KEYS[mode]);
    if (stored === null) return null;
    const value = Number.parseFloat(stored);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
