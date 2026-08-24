import type {
  Node3D,
  Physics2DWorld,
  RigidBody2D,
} from '@flighthq/sdk';
import {
  addNodeChild,
  clamp,
  createVector3,
  easeOutCubic,
  getCamera3DWorldToScreen,
  removeNodeChildren,
  removePhysics2DBody,
} from '@flighthq/sdk';
import { createGameUi2D } from './ui/gameUi';
import type { UiScreen } from './ui/gameUi';
import {
  getRandomFarmPropVariantIndex,
} from './data/farmPropGeometry';
import {
  addStackObjectBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getNextObjectDelay,
  getRandomStackObjectKind,
  getStackBodyHalfWidth,
  getStackBodySupportExtent,
  getStackHeightHands,
  getStackHeightMeters,
  getStackObjectVerticalExtent,
  getSupportedStackHeight,
  PASTURE_HALF_WIDTH,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  STACK_OBJECT_PROFILES,
  stepHorseStack,
} from './physics/horseStackPhysics';
import type { StackObjectKind } from './physics/horseStackPhysics';
import {
  FIXED_STEP_LIMIT,
  GAME_DURATION_MS,
  MAX_RESULT_COUNT_DURATION_MS,
  MIN_RESULT_COUNT_DURATION_MS,
  STACK_BASE_Y,
  STACK_X,
  STACK_Z,
  START_INPUT_GUARD_MS,
} from './game/gameConfig';
import { createAudioManager } from './audio/audioManager';
import { createCameraRig } from './scene/cameraRig';
import { createLandingIndicator } from './scene/landingIndicator';
import { extractFarmPropTemplates, loadGltfScene, mountFarm } from './scene/modelLoader';
import type { Windmill } from './scene/windmill';
import { createWindmill } from './scene/windmill';
import { createStackObjectVisuals } from './scene/stackObjectVisual';
import { createParticleEffects } from './scene/particleEffects';
import { createSceneRenderer } from './scene/sceneRenderer';
import { createSceneGraph } from './scene/sceneGraph';
import { prefersReducedMotion } from './reducedMotion';
import './styles.css';

type GamePhase = 'loading' | 'ready' | 'playing' | 'settling' | 'finished';

interface ActiveStackObject {
  angle: number;
  kind: StackObjectKind;
  variantIndex: number;
  x: number;
}

interface StackedObject {
  body: RigidBody2D;
  kind: StackObjectKind;
  lost: boolean;
  node: Node3D;
}

let backdropFocus = 0;

const viewer = requireElement<HTMLDivElement>('viewer');
const loadingPanel = requireElement<HTMLDivElement>('loading-panel');
const loadingCopy = requireElement<HTMLParagraphElement>('loading-copy');
const errorPanel = requireElement<HTMLDivElement>('error-panel');
const retryButton = requireElement<HTMLButtonElement>('retry-button');
const statusCopy = requireElement<HTMLSpanElement>('status-copy');
// Keep these paths indirect so Vite leaves the runtime module-relative URLs untouched
// without warning. Both directories are served straight out of public/.
const modelPathFromModule = '../models/';
const modelRoot = new URL(modelPathFromModule, import.meta.url).href.replace(/\/$/, '');
const soundPathFromModule = '../sounds/';
const soundRoot = new URL(soundPathFromModule, import.meta.url).href;
const audio = createAudioManager(soundRoot);

retryButton.addEventListener('click', () => window.location.reload());
const sceneRenderer = createSceneRenderer(viewer);
const { canvas, renderState } = sceneRenderer;
const gameUi = createGameUi2D(renderState, renderState.pixelRatio);
let creditsOpen = false;
// Where the pointer is and whether it is held, so 2D controls can light up and press in.
let pointerX = -1;
let pointerY = -1;
let pointerDown = false;

// One scene, built in scene/sceneGraph.ts, and the two emitters that live in it. Both were
// ~230 lines of construction inline here; what main.ts needs from them is the handful of
// nodes below.
const sceneGraph = createSceneGraph();
const scene = sceneGraph.root;
const { camera, indicatorLight, previewLayer, stackLayer } = sceneGraph;
const particles = createParticleEffects(scene);
const cameraRig = createCameraRig();
const visuals = createStackObjectVisuals();
const indicator = createLandingIndicator(visuals, previewLayer, indicatorLight);

let phase: GamePhase = 'loading';
// Placement input is refused until this moment, measured on the INPUT clock
// (Event.timeStamp) rather than the render clock: startGame() has to build a physics
// world and clone a model, and on a slow first frame that work alone can outlast the
// guard. Comparing input to input keeps the window honest whatever the frame costs.
let placementArmedAt = 0;
let swayClock = 0;
// Bound once the farm mounts; null until then.
let windmill: Windmill | null = null;
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
// Top of the hovering drop preview, in physics Y. Only the dev framing probe reads it.
let resultAnimationStart = 0;
let resultAnimationDuration = 0;
let resultHands = 0;
let resultHandsShown = 0;
let physicsAccumulator = 0;
let previousTime = performance.now();
let isViewerVisible = true;
let renderRequested = true;
let lastImpactAt = 0;
const measurementBodies: RigidBody2D[] = [];
const inputBounds = { left: 0, width: 1 };

bindGameControls();
bindRenderingLifecycle();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

async function start(): Promise<void> {
  setLoadingState('Rounding up the farm…');

  try {
    const [farm, horse] = await Promise.all([
      loadGltfScene(`${modelRoot}/farm`),
      loadGltfScene(`${modelRoot}/horse`),
    ]);

    visuals.setTemplates(extractFarmPropTemplates(farm), horse);
    windmill = createWindmill(farm);
    mountFarm(farm, scene);
    phase = 'ready';
    cameraRig.update(camera, 1, cachedStackHeight, objectsDropped);
    renderFrame();
    loadingPanel.classList.add('is-hidden');
    statusCopy.textContent = 'Stable enough';
  } catch (error) {
    showSceneError('Unable to load Horse Stacker.', error);
  }
}


function startGame(startedFrom?: Event): void {
  if (!visuals.isReady() || phase === 'loading') return;

  const now = performance.now();
  // The credits only exist on the score screen now, so a panel left open there must not
  // still be open when the next score screen arrives.
  creditsOpen = false;
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
  renderRequested = true;
}

function spawnObject(now: number): void {
  if (phase !== 'playing' || now >= gameEndsAt) return;

  indicator.resetTeeter(now);
  lastAimAt = now;
  const kind = getRandomStackObjectKind();
  const variantIndex = kind === 'horse' ? 0 : getRandomFarmPropVariantIndex(kind);
  activeObject = {
    angle: 0,
    kind,
    variantIndex,
    x: 0,
  };
  indicator.setKind(kind, variantIndex);
  // Announced to screen readers only. The label alone: an emoji here is read aloud as its
  // own name before the word it duplicates.
  statusCopy.textContent = visuals.label(kind, variantIndex);
  updateActiveStackObject(now);
}

function updateActiveStackObject(now: number): void {
  const current = activeObject;
  if (current === null) return;

  indicator.stepTeeter(now);
  const horizontalLimit = getAimHalfWidth();
  current.x = clamp(aimOffset, -horizontalLimit, horizontalLimit);
  current.angle = indicator.angle();
  indicator.update(current.kind, current.x, current.angle, getLandingSurfaceY(current.x, current.kind), now);
}

function commitObjectPlacement(now: number): void {
  const current = activeObject;
  if (current === null || phase !== 'playing') return;

  const landingY =
    getLandingSurfaceY(current.x, current.kind) +
    getStackObjectVerticalExtent(current.kind, current.angle);
  const body = addStackObjectBody(
    physicsWorld,
    current.kind,
    current.x,
    landingY,
    current.angle,
  );
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
  renderRequested = true;
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

function beginSettling(now: number): void {
  phase = 'settling';
  audio.beginResultCount();
  activeObject = null;
  finishAt = now + FINAL_SETTLE_SECONDS * 1000;
  indicator.hide();
  renderRequested = true;
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
    : clamp(
        1_800 + resultHands * 14,
        MIN_RESULT_COUNT_DURATION_MS,
        MAX_RESULT_COUNT_DURATION_MS,
      );
  indicatorLight.intensity = 0;
  renderRequested = true;
}

function updateResultAnimation(now: number): void {
  if (resultAnimationStart === 0) return;
  const progress = clamp((now - resultAnimationStart) / resultAnimationDuration, 0, 1);
  const easedProgress = easeOutCubic(progress);
  const handsToShow = Math.min(resultHands, Math.floor(resultHands * easedProgress));
  if (advanceHorseHands(handsToShow)) audio.playResultTick(now);

  if (progress >= 1) completeResultAnimation();
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

  celebrateFinalHeight();
}

// The best height ever reached on this machine, in metres, or null before a first round
// has ever been finished here. Kept in localStorage so it survives a reload, and read
// through try/catch because storage throws outright in some private-browsing modes.
const BEST_HEIGHT_KEY = 'horse-stacker.best-height';
let bestMeters: number | null = readBestMeters();
// The record as it stood when the round began, which is what the result screen reports.
// Reading bestMeters there would be wrong: by then this round has already been folded in,
// so a first ever round would echo its own height back at the player as "BEST".
let recordBeforeRound: number | null = null;
let beatTheRecord = false;

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

function celebrateFinalHeight(): void {
  const burstY = STACK_BASE_Y + Math.max(0.8, finalHeight);
  // One popper per colour, strung out across the pile.
  particles.burstCelebration(burstY);
  renderRequested = true;
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

function handlePhysicsContacts(now: number): void {
  if (physicsWorld.events.began.length === 0 || now - lastImpactAt < 90) return;
  const contact = physicsWorld.events.began[0];
  const point = contact?.points[0];
  if (point === undefined) return;

  lastImpactAt = now;
  particles.burstDust(point.x, STACK_BASE_Y + point.y);
  audio.maybePlayCollisionWhinny(now);
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
    const phase = swayClock + body.index * 0.7;
    visuals.setTransform(
      object.node,
      body.x + Math.sin(phase) * 0.0016 * sway,
      body.y,
      body.angle + Math.sin(phase * 0.77 + 1.3) * 0.010 * sway,
    );
    stackedObjects[retainedCount++] = object;
  }
  // Fallen objects have already left the physics world and score calculation;
  // keep them out of every subsequent placement, height, and visual scan too.
  stackedObjects.length = retainedCount;
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

function bindGameControls(): void {
  // Window-level, not canvas-level: aiming and placing follow the pointer anywhere on
  // the page while a run is live. setAimFromClientX clamps against the canvas bounds, so
  // a click out in the margin simply aims at that edge.
  window.addEventListener('pointermove', (event: PointerEvent) => {
    trackPointer(event);
    renderRequested = true;
    if (phase !== 'playing' || activeObject === null) return;
    setAimFromClientX(event.clientX, performance.now());
  });
  window.addEventListener('pointerup', () => {
    pointerDown = false;
    renderRequested = true;
  });
  window.addEventListener('pointerleave', () => {
    pointerX = -1;
    pointerY = -1;
    pointerDown = false;
  });

  window.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    trackPointer(event);
    pointerDown = true;
    renderRequested = true;
    if (handleUiPress(event)) {
      event.preventDefault();
      return;
    }
    if (phase !== 'playing') return;
    // Controls and links keep their own meaning: Start over must restart, the place
    // prompt has its own handler, and a credit link must still open.
    if (isInteractiveEventTarget(event.target)) return;
    canvas.focus({ preventScroll: true });
    const now = performance.now();
    setAimFromClientX(event.clientX, now);
    placeActiveStackObject(now, event.timeStamp);
  });

  canvas.addEventListener('keydown', (event: KeyboardEvent) => {
    if (phase !== 'playing') return;
    const now = performance.now();
    if (event.key === 'ArrowLeft') {
      const horizontalLimit = getAimHalfWidth();
      setAimOffset(aimOffset - 0.08, horizontalLimit, now);
    } else if (event.key === 'ArrowRight') {
      const horizontalLimit = getAimHalfWidth();
      setAimOffset(aimOffset + 0.08, horizontalLimit, now);
    } else if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowDown') {
      placeActiveStackObject(now, event.timeStamp);
    } else {
      return;
    }
    event.preventDefault();
  });

  bindFullscreenToggle();
}

function trackPointer(event: PointerEvent): void {
  const bounds = canvas.getBoundingClientRect();
  pointerX = event.clientX - bounds.left;
  pointerY = event.clientY - bounds.top;
}

function handleUiPress(event: PointerEvent): boolean {
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return false;
  const screen = getUiScreen();
  for (const button of gameUi.buttons) {
    if (
      x < button.x || y < button.y ||
      x > button.x + button.width || y > button.y + button.height
    ) {
      continue;
    }
    if (button.id === 'credits') {
      creditsOpen = !creditsOpen;
      renderRequested = true;
      return true;
    }
    if (button.id === 'fullscreen') {
      toggleFullscreen();
      return true;
    }
    if (button.id === 'play' && screen === 'title') {
      startGame(event);
      return true;
    }
    if (button.id === 'again' && screen === 'result') {
      startGame(event);
      return true;
    }
  }
  return false;
}

function isInteractiveEventTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('a, button, input, select, textarea, summary, [role="button"]') !== null
  );
}

// document.fullscreenEnabled is false inside an iframe without allowfullscreen, and the
// method is missing entirely on iOS Safari for non-video elements, so the control is
// hidden rather than left to fail when the user presses it.
function bindFullscreenToggle(): void {
  if (typeof viewer.requestFullscreen !== 'function' || document.fullscreenEnabled !== true) {
    return;
  }
  document.addEventListener('fullscreenchange', () => {
    syncFullscreenToggle();
    // The viewer's box changes before a resize event necessarily arrives, and
    // resizeCanvas also refreshes inputBounds, which pointer aiming maps against.
    resizeCanvas();
    renderRequested = true;
  });
  syncFullscreenToggle();
}

function toggleFullscreen(): void {
  if (typeof viewer.requestFullscreen !== 'function') return;
  const request =
    document.fullscreenElement === viewer ? document.exitFullscreen() : viewer.requestFullscreen();
  request.catch((error: unknown) => {
    console.info('Fullscreen request was refused:', error);
  });
}

function syncFullscreenToggle(): void {
  const active = document.fullscreenElement === viewer;
  viewer.classList.toggle('is-fullscreen', active);
}

function placeActiveStackObject(now: number, inputAt = now): void {
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
}

function setAimFromClientX(clientX: number, now: number): void {
  const current = activeObject;
  if (current === null) return;
  const normalized = clamp((clientX - inputBounds.left) / inputBounds.width, 0, 1) * 2 - 1;
  const horizontalLimit = getAimHalfWidth();
  setAimOffset(normalized * horizontalLimit, horizontalLimit, now);
}

function setAimOffset(targetX: number, horizontalLimit: number, now: number): void {
  const nextAim = clamp(targetX, -horizontalLimit, horizontalLimit);
  const elapsed = clamp((now - lastAimAt) / 1000, 0.008, 0.08);
  const pointerVelocity = (nextAim - aimOffset) / elapsed;
  indicator.nudge(pointerVelocity);
  aimOffset = nextAim;
  lastAimAt = now;
}

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

function resizeCanvas(): void {
  const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const bounds = viewer.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  inputBounds.left = bounds.left;
  inputBounds.width = Math.max(bounds.width, 1);
  if (sceneRenderer.resize(width, height, nextPixelRatio)) {
    gameUi.resize(width, height, nextPixelRatio);
    if (camera.projection.kind === 'perspective') camera.projection.aspect = width / height;
    renderRequested = true;
  }
}

function setLoadingState(copy: string): void {
  loadingCopy.textContent = copy;
  statusCopy.textContent = copy.replace('…', '');
}

function renderFrame(): void {
  sceneRenderer.drawScene(sceneGraph, backdropFocus);
  const countProgress =
    resultAnimationStart === 0
      ? phase === 'finished' ? 1 : 0
      : clamp((performance.now() - resultAnimationStart) / resultAnimationDuration, 0, 1);
  const shownMeters = getStackHeightMeters(finalHeight) * easeOutCubic(countProgress);
  const uiWantsAnotherFrame = gameUi.update({
    // Blank on a first ever round: there is no previous best to measure this one against,
    // and echoing the number already on screen back as "BEST" says nothing.
    bestText:
      recordBeforeRound === null || beatTheRecord
        ? ''
        : `BEST ${formatMeters(recordBeforeRound)}`,
    countProgress,
    creditsOpen,
    isRecord: beatTheRecord,
    handsShown: resultHandsShown,
    now: performance.now(),
    pointerDown,
    pointerX,
    pointerY,
    heightText: countProgress >= 1 ? formatHeight(finalHeight) : formatMeters(shownMeters),
    screen: getUiScreen(),
    secondsLeft: Math.max(0, (gameEndsAt - performance.now()) / 1000),
    timeUpProgress: import.meta.env.DEV && forcedScreen === 'timeup'
      ? 1
      : finishAt === 0
        ? 0
        : clamp(1 - (finishAt - performance.now()) / (FINAL_SETTLE_SECONDS * 1000), 0, 1) * 2.6,
  });
  gameUi.render();
  if (uiWantsAnotherFrame) renderRequested = true;
}

// DEV only: pins the UI to one screen so a short-lived one (TIME UP lasts 2.35s) can be
// held still and inspected instead of raced with a screenshot.
let forcedScreen: UiScreen | null = null;

function getUiScreen(): UiScreen {
  if (import.meta.env.DEV && forcedScreen !== null) return forcedScreen;
  if (phase === 'loading') return 'loading';
  if (phase === 'playing') return 'playing';
  if (phase === 'settling') return 'timeup';
  if (phase === 'finished') return 'result';
  return 'title';
}

function enterFrame(now: number): void {
  const deltaTime = Math.min((now - previousTime) / 1000, 0.05);
  previousTime = now;

  if (phase !== 'loading' && isViewerVisible && document.visibilityState !== 'hidden') {
    const gameIsMoving = phase === 'playing' || phase === 'settling';
    if (gameIsMoving) {
      updateGame(now);
      swayClock += deltaTime * 1.6;
      stepGamePhysics(now, deltaTime);
      synchronizeStackVisuals();
      cachedStackHeight = phase === 'finished' ? finalHeight : getCurrentStackHeight();
      renderRequested = true;
    }
    if (phase === 'finished' && resultAnimationStart !== 0) {
      updateResultAnimation(now);
    }

    if (windmill?.update(deltaTime) === true) renderRequested = true;

    const screen = getUiScreen();
    const wantsBackdrop = screen === 'title' || screen === 'result' ? 1 : 0;
    const focused = backdropFocus + (wantsBackdrop - backdropFocus) * (1 - Math.exp(-deltaTime * 5.5));
    if (Math.abs(focused - backdropFocus) > 0.0005) {
      backdropFocus = focused;
      renderRequested = true;
    } else if (backdropFocus !== wantsBackdrop) {
      backdropFocus = wantsBackdrop;
      renderRequested = true;
    }

    const particlesAreMoving = particles.step(deltaTime);
    if (particlesAreMoving) renderRequested = true;

    const displayedHeight = phase === 'finished' ? finalHeight : cachedStackHeight;
    if (cameraRig.update(camera, deltaTime, displayedHeight, objectsDropped)) {
      renderRequested = true;
    }
    const cameraIsMoving = cameraRig.isMoving();
    if (renderRequested || gameIsMoving || particlesAreMoving || cameraIsMoving) {
      renderFrame();
      renderRequested = false;
    }
  }

  requestAnimationFrame(enterFrame);
}

function bindRenderingLifecycle(): void {
  canvas.addEventListener('webglcontextlost', (event: Event) => {
    event.preventDefault();
    phase = 'loading';
    showSceneError('The WebGL context was lost.', new Error('WebGL context lost'));
  });
  canvas.addEventListener('webglcontextrestored', () => window.location.reload());

  if ('IntersectionObserver' in window) {
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      isViewerVisible = entry?.isIntersecting ?? true;
      previousTime = performance.now();
      if (isViewerVisible) renderRequested = true;
    });
    visibilityObserver.observe(viewer);
  }

  document.addEventListener('visibilitychange', () => {
    previousTime = performance.now();
    physicsAccumulator = 0;
    if (document.visibilityState === 'visible') renderRequested = true;
  });
}

function showSceneError(message: string, error: unknown): void {
  audio.stopAll();
  console.error(message, error);
  loadingPanel.classList.add('is-hidden');
  errorPanel.hidden = false;
  statusCopy.textContent = 'Game unavailable';
}

function formatHeight(height: number): string {
  return formatMeters(getStackHeightMeters(height));
}

function formatMeters(meters: number): string {
  return `${meters.toFixed(2)} m`;
}

// The HUD used to double as a test surface — harnesses read the placed count and height
// out of the DOM. Those elements are gone, so dev builds expose the same few numbers
// directly. Not shipped: production has no reason to carry it.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__game = {
    get height() {
      return getStackHeightMeters(phase === 'finished' ? finalHeight : cachedStackHeight);
    },
    get phase() {
      return phase;
    },
    get placed() {
      return objectsDropped;
    },
    set screen(value: UiScreen | null) {
      forcedScreen = value;
      renderRequested = true;
    },
    // Where the pile top and the hovering preview actually land in the frame. NDC y, so
    // +1 is the top edge and anything past it is off screen. Camera framing is easy to
    // reason about wrongly on paper (the top bias scales with distance, which flatters
    // a clamped camera), so read it off the real view-projection instead.
    get frame() {
      const aspect =
        camera.projection.kind === 'perspective' ? camera.projection.aspect : 1;
      const probe = createVector3(0, 0, 0);
      const ndcY = (physicsY: number): number => {
        const point = createVector3(STACK_X, STACK_BASE_Y + physicsY, STACK_Z);
        return getCamera3DWorldToScreen(probe, camera, point, aspect) ? probe.y : NaN;
      };
      return {
        distance: cameraRig.controller.distance,
        followed: cameraRig.followedHeight(),
        measured: cachedStackHeight,
        preview: ndcY(indicator.previewTopY()),
        targetY: cameraRig.controller.target.y,
        top: ndcY(cachedStackHeight),
      };
    },
  };
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

void start();
requestAnimationFrame(enterFrame);
