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
  PASTURE_MAX_X,
  PASTURE_MIN_X,
  PASTURE_TOP_Y,
} from '../physics/pasture';
import {
  getNextObjectDelay,
  getRandomStackObjectKind,
} from '../physics/stackObjectKind';
import type { StackObjectKind } from '../physics/stackObjectKind';
import type { GroundProfile } from '../physics/stackPhysics';
import { getGroundY } from '../physics/stackPhysics';
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
  doesStackPlacementOverlap,
  getSupportedStackHeight,
  STACK_CONTACT_GROUND,
  STACK_CONTACT_PIECE,
  getStackBodyContacts,
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
  HORSE_DROP_GRACE_MS,
  PLACEMENT_LIFT_LIMIT,
  PLACEMENT_LIFT_STEP,
  MAX_RESULT_COUNT_DURATION_MS,
  MIN_RESULT_COUNT_DURATION_MS,
  STACK_BASE_Y,
  START_INPUT_GUARD_MS,
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
  /** When it was placed, on the game clock. Half of the dropped-horse test; see below. */
  placedAt: number;
  /**
   * Set the first time it meets the floor. The test that follows is an EVENT — it asks what
   * the piece had been doing when it arrived — so it must be asked once, on arrival, and
   * never again while the piece sits there. Without the latch, every horse standing on the
   * grass would trip the rule a moment later.
   */
  touchedGround: boolean;
  /** Set once it has touched another piece. Half of the dropped-horse test; see below. */
  touchedPiece: boolean;
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
  /** Horses that have gone off the map this round; one ends a STEADY HANDS run. */
  readonly horsesDropped: number;
  readonly beatTheRecord: boolean;
  /** The record as it stood when the round began, or null if there was none. */
  readonly recordBeforeRound: number | null;

  /**
   * Models are in; leave the loading phase for the title screen. `ground` is the sampled
   * terrain the floor should follow — omitted, the floor stays flat.
   */
  markReady: (ground?: GroundProfile) => void;
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
  // Undefined until the farm has loaded and been sampled; see markReady.
  let groundProfile: GroundProfile | undefined;
  let physicsWorld: Physics2DWorld = createHorseStackWorld();
  let activeObject: ActiveStackObject | null = null;
  let stackedObjects: StackedObject[] = [];
  let objectsDropped = 0;
  // Where the piece is being held, in physics coordinates. Both axes now: placement is free
  // within the plane rather than a horizontal aim over a top-down drop.
  let aimX = 0;
  let aimY = 0;
  // Reused by isPlacementBlocked, which runs on every pointer move.
  const nearbyBodies: RigidBody2D[] = [];
  // True when the held piece overlaps something already placed, so it cannot be put down.
  let aimBlocked = false;
  // Whether the player has said where they want the piece yet, this round. Until they have,
  // there is nothing sensible to hover: a device with no pointer has no "where the mouse is",
  // and parking the piece in the middle of the pasture invents an intent nobody expressed.
  let aimKnown = false;
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
  function getAimLimits(): [number, number] {
    const activeHalfWidth =
      activeObject === null
        ? STACK_OBJECT_PROFILES.horse.halfWidth
        : STACK_OBJECT_PROFILES[activeObject.kind].halfWidth;
    // A pair rather than a half width: the pasture is not centred on the origin, so the two
    // ends have to be insetted separately or the shorter one sets the limit for both.
    const inset = activeHalfWidth * 1.2;
    return [PASTURE_MIN_X + inset, PASTURE_MAX_X - inset];
  }

  /**
   * The lowest a piece of this kind can be held: resting on the bare ground under it. The
   * ground is the sampled terrain, not the flat pasture — see getGroundY for why holding a
   * piece at a flat floor over sloping ground drew it buried in the grass.
   */
  function getFloorY(kind: StackObjectKind, angle: number, x: number): number {
    return getGroundY(groundProfile, x) + getStackObjectVerticalExtent(kind, angle);
  }

  /**
   * Does a piece held here overlap something already placed?
   *
   * Two passes. The extent comparison is a broad phase that throws out everything nowhere
   * near the pose, and then the real collider shapes settle the survivors — which is what
   * this always claimed to do and did not. See doesStackPlacementOverlap for what the box
   * test alone was costing.
   */
  function isPlacementBlocked(kind: StackObjectKind, x: number, y: number, angle: number): boolean {
    const halfWidth = STACK_OBJECT_PROFILES[kind].halfWidth;
    const vertical = getStackObjectVerticalExtent(kind, angle);
    nearbyBodies.length = 0;
    for (const object of stackedObjects) {
      if (object.lost) continue;
      const body = object.body;
      if (Math.abs(body.x - x) >= halfWidth + getStackBodyHalfWidth(body)) continue;
      if (Math.abs(body.y - y) >= vertical + getStackBodyVerticalExtent(body)) continue;
      nearbyBodies.push(body);
    }
    if (nearbyBodies.length === 0) return false;
    return doesStackPlacementOverlap(kind, x, y, angle, nearbyBodies);
  }

  /**
   * Where a piece aimed here can actually go: the pose itself if it fits, otherwise the
   * first one above it that does, within PLACEMENT_LIFT_LIMIT. Null when nothing in that
   * reach fits, which is the only case where a click does nothing.
   *
   * Lifting rather than refusing is the answer to "what should a click that cannot place
   * do". A click that silently does nothing reads as the game being broken, and the cursor
   * under free placement is a request rather than an instruction — you are saying "here",
   * and just above here is the honest reading of that when here is full.
   *
   * But only just above. Two ceilings, and the lower one wins: the top of the pile under
   * the cursor, which always fits, and the lift limit, which is what stops a piece aimed
   * into a gap under the pile from climbing out at the summit.
   */
  function findPlaceableY(
    kind: StackObjectKind,
    x: number,
    fromY: number,
    angle: number,
  ): number | null {
    if (!isPlacementBlocked(kind, x, fromY, angle)) return fromY;
    const extent = getStackObjectVerticalExtent(kind, angle);
    const ceiling = Math.min(
      getLandingSurfaceY(x, kind) + extent + PLACEMENT_LIFT_STEP,
      fromY + PLACEMENT_LIFT_LIMIT,
    );
    // Never below the cursor. getLandingSurfaceY ignores anything still moving fast, so a
    // piece knocked loose mid-fall can leave the pile-top ceiling UNDER the pose being
    // aimed — and a lift that resolves downward is not a lift.
    if (ceiling <= fromY) return null;
    const step = extent * 0.25;
    for (let y = fromY + step; y < ceiling; y += step) {
      if (!isPlacementBlocked(kind, x, y, angle)) return y;
    }
    return isPlacementBlocked(kind, x, ceiling, angle) ? null : ceiling;
  }

  function setAim(targetX: number, targetY: number, now: number): void {
    aimKnown = true;
    const current = activeObject;
    const kind = current === null ? 'horse' : current.kind;
    const angle = current === null ? 0 : current.angle;
    const [minAimX, maxAimX] = getAimLimits();
    const nextX = clamp(targetX, minAimX, maxAimX);
    // No ceiling: holding a piece high and letting it fall is a legitimate (and destructive)
    // choice. The floor is real though — nothing may be placed inside the pasture.
    const nextY = Math.max(targetY, getFloorY(kind, angle, nextX));
    // The teeter reads horizontal speed only. Raising and lowering a piece is a deliberate,
    // careful motion and should not set it swinging.
    const elapsed = clamp((now - lastAimAt) / 1000, 0.008, 0.08);
    indicator.nudge((nextX - aimX) / elapsed);
    aimX = nextX;
    aimY = nextY;
    lastAimAt = now;
  }

  function getLandingSurfaceY(x: number, kind: StackObjectKind): number {
    let surfaceY = getGroundY(groundProfile, x);
    const activeHalfWidth = STACK_OBJECT_PROFILES[kind].halfWidth;

    for (const object of stackedObjects) {
      const body = object.body;
      const horizontalReach = activeHalfWidth + getStackBodyHalfWidth(body);
      if (
        object.lost ||
        // Below the ground UNDER IT, not below the flat pasture. The terrain dips 55mm under
        // the old flat height at the low end, so a piece resting perfectly well down there
        // read as "fallen through" and could not be stacked on.
        body.y < getGroundY(groundProfile, body.x) ||
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
    return getSupportedStackHeight(physicsWorld, measurementBodies, groundProfile);
  }

  function updateActiveStackObject(now: number): void {
    const current = activeObject;
    if (current === null) return;
    if (!aimKnown) {
      // Nothing has been aimed yet this round. Hold the piece off screen rather than guessing.
      indicator.hide();
      return;
    }

    indicator.stepTeeter(now);
    const [minAimX, maxAimX] = getAimLimits();
    current.x = clamp(aimX, minAimX, maxAimX);
    current.angle = indicator.angle();
    // Re-clamp against the floor here as well as in setAim: the teeter keeps turning the
    // piece after the pointer stops, and a rotating piece's vertical extent grows, so a pose
    // that cleared the grass a moment ago may not now.
    const heldY = Math.max(aimY, getFloorY(current.kind, current.angle, aimX));
    // The preview shows where the piece will GO, not where the cursor is, so a click always
    // puts it exactly where you were looking at it. Without this the marker sits refused
    // inside the pile and the piece then appears somewhere else.
    const placeableY = findPlaceableY(current.kind, current.x, heldY, current.angle);
    current.y = placeableY ?? heldY;
    aimBlocked = placeableY === null;
    indicator.update(current.kind, current.x, current.y, current.angle, now);
  }

  function spawnObject(now: number): void {
    if (phase !== 'playing' || now >= gameEndsAt) return;

    indicator.resetTeeter(now);
    lastAimAt = now;
    const { kind, variantIndex } = queued;
    queued = drawPiece();
    // The aim is NOT reset. A new piece appears wherever the pointer already is, which is
    // where the player is looking — resetting it to the middle made every piece jump away
    // from the cursor and have to be dragged back.
    //
    // The floor still has to be re-checked, because the new piece may be taller than the one
    // that just left and the old height could now be inside the grass.
    aimY = Math.max(aimY, getFloorY(kind, 0, aimX));
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
    // current.y is already the lifted pose the preview has been showing (see
    // updateActiveStackObject), so this only catches the case where nothing fits at all.
    // Placing an overlapping pose anyway would have the solver push the two apart and fire
    // pieces out of the pile at speed.
    if (aimBlocked || isPlacementBlocked(current.kind, current.x, current.y, current.angle)) return;

    // Exactly where it was being held. It is not dropped onto a surface any more, so it may
    // well be unsupported — and then it falls, which is the player's problem.
    const landingY = current.y;
    const body = addStackObjectBody(physicsWorld, current.kind, current.x, landingY, current.angle);
    body.velocityX = 0;
    body.velocityY = 0;
    body.angularVelocity = 0;
    const node = visuals.create(current.kind, current.variantIndex);
    visuals.setTransform(node, current.kind, current.x, landingY, current.angle);
    addNodeChild(stackLayer, node);
    stackedObjects.push({
      body,
      dropped: false,
      kind: current.kind,
      lost: false,
      node,
      placedAt: now,
      touchedGround: false,
      touchedPiece: false,
    });
    activeObject = null;
    // The prompt has served its purpose once the player has placed something.
    indicator.hide();
    objectsDropped++;
    audio.playStackThud();
    // Both modes. It is tied to the horse rather than to the impact now, so it no longer
    // chatters through a long build the way a collision-driven one did.
    if (current.kind === 'horse') audio.maybePlayHorseWhinny(now);

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

  function synchronizeStackVisuals(now: number): void {
    let retainedCount = 0;
    for (const object of stackedObjects) {
      if (object.lost) continue;
      const body = object.body;

      // THE RULE: a horse that had been resting on something and then reaches the floor
      // has been dropped.
      //
      // Two conditions, and it needs both. It must have touched ANOTHER PIECE at some
      // point — that is what says it was part of the pile rather than standing on the grass
      // — and it must not have arrived at the floor in the same breath as being placed.
      //
      // The collision is what does the real work here. Timing alone was tried and it was
      // far too blunt: it had to allow a whole second, because that was the only way to be
      // sure a horse set down on the grass was not counted, and a second is an age. Put
      // half a horse on a bale and let its other end swing down and it is on the ground in
      // a third of that, plainly dropped and plainly not counted. With the collision doing
      // the discriminating, the window only has to outlast the frame a piece is placed in,
      // so it can be short enough to catch those short falls.
      //
      // Two earlier rules for the record. "Must stay on the map" never fired at all — 34
      // placements aimed at the rim over two runs, piles of 5.09m and 9.03m, no horse ever
      // left. "Ends up on bare grass, if placed above the ground" fired constantly, because
      // placement follows the cursor and setting a horse down leaves it a centimetre up.
      const contacts = getStackBodyContacts(physicsWorld, body);
      if ((contacts & STACK_CONTACT_PIECE) !== 0) object.touchedPiece = true;
      if (!object.touchedGround && (contacts & STACK_CONTACT_GROUND) !== 0) {
        object.touchedGround = true;
        if (
          object.kind === 'horse' &&
          !object.dropped &&
          object.touchedPiece &&
          now - object.placedAt > HORSE_DROP_GRACE_MS
        ) {
          object.dropped = true;
          horsesDropped++;
        }
      }

      // Leave enough void beyond the collider for the whole tumble to remain visible.
      if (body.y < -1 || body.x < PASTURE_MIN_X - 1.5 || body.x > PASTURE_MAX_X + 1.5) {
        object.lost = true;
        object.node.enabled = false;
        removePhysics2DBody(physicsWorld, body);
        // A horse can also leave sideways without ever touching down — over the edge at the
        // height it was placed — so the grass test above will not have caught it. Off the
        // map is off the pile too.
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
        object.kind,
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
      // What ends a STEADY HANDS run: a horse has gone off the map. One is enough.
      //
      // It ran on a three-strike allowance first. Three strikes made the mode forgiving in
      // the one place it should not be: the whole proposition is "how high can you go
      // without dropping a horse", and an allowance answers a different question — how high
      // can you go having dropped two. With one horse ending it, every placement near the
      // edge is a decision, which is the tension the mode exists for.
      //
      // It also replaced a "every piece has fallen off" rule, which sounded equivalent and
      // was not. A collapse scatters pieces across the grass where they stay stackable, and
      // each run ACCUMULATES that clutter, so the pasture emptying got less likely the
      // longer you played — measured over a 40 placement run that built to 11.5m and
      // collapsed, it never fired once.
      if (mode === 'steady' && horsesDropped > 0) {
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

    markReady(ground) {
      groundProfile = ground;
      // The world built at construction has the flat floor; rebuild it now the real one is
      // known, so the title screen and the first round both stand on the modelled terrain.
      physicsWorld = createHorseStackWorld(groundProfile);
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
      physicsWorld = createHorseStackWorld(groundProfile);
      physicsAccumulator = 0;
      activeObject = null;
      stackedObjects = [];
      objectsDropped = 0;
      aimX = 0;
      aimY = 0;
      aimBlocked = false;
      aimKnown = false;
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
        synchronizeStackVisuals(now);
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
      physicsWorld = createHorseStackWorld(groundProfile);
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
      // The arrows are how a keyboard player says where they want it, so the first press has
      // to seed a pose — the middle of the pasture, resting on whatever is under it.
      if (!aimKnown && activeObject !== null) {
        aimX = 0;
        aimY = getLandingSurfaceY(0, activeObject.kind)
          + getStackObjectVerticalExtent(activeObject.kind, 0);
      }
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
